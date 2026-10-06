import { randomUUID } from "node:crypto";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cookieState,
  createUser,
  requestRoute,
} from "./document-route-test-helpers";
import { makePdf } from "./pdf-fixture";

const enabled = Boolean(process.env.FOUNDATION_DB_TEST);
const roles = ["STUDENT", "FACULTY_ADVISOR", "HOD"] as const;

async function prepareWorkflow(label: string, unsupportedRequired = false) {
  const owner = await createUser(`${label}-owner`);
  const users = await Promise.all(
    roles.map((role) => createUser(`${label}-${role}`)),
  );
  cookieState.value = owner.cookie;
  const createdResponse = await requestRoute("POST", "/api/documents", {
    fields: { title: `${label} request`, letterType: "OD" },
    file: makePdf(1),
  });
  expect(createdResponse.status).toBe(201);
  const created = await createdResponse.json();
  const assignedResponse = await requestRoute(
    "PUT",
    `/api/documents/${created.documentId}/signers`,
    {
      json: {
        signers: users.map((user, index) => ({
          sequence: index + 1,
          role: roles[index],
          email: user.email,
        })),
      },
    },
  );
  expect(assignedResponse.status).toBe(200);
  const assigned = (await assignedResponse.json()).signers as Array<{
    id: string;
    sequence: number;
    role: string;
    status: string;
  }>;
  const fieldInputs = assigned.map((signer, index) => ({
    signerId: signer.id,
    pageNumber: 1,
    x: 0.08 + index * 0.29,
    y: 0.72,
    width: 0.2,
    height: 0.06,
    fieldType: "SIGNATURE",
    required: true,
  }));
  if (unsupportedRequired)
    fieldInputs.push({
      signerId: assigned[0]!.id,
      pageNumber: 1,
      x: 0.08,
      y: 0.55,
      width: 0.2,
      height: 0.06,
      fieldType: "TEXT",
      required: true,
    });
  const fieldsResponse = await requestRoute(
    "PUT",
    `/api/documents/${created.documentId}/fields`,
    { json: { fields: fieldInputs } },
  );
  expect(fieldsResponse.status).toBe(200);
  const fields = (await fieldsResponse.json()).fields as Array<{
    id: string;
    assigned_signer_id: string;
    field_type: string;
  }>;
  return {
    owner,
    users,
    documentId: created.documentId as string,
    signers: assigned,
    fields,
  };
}

async function send(workflow: Awaited<ReturnType<typeof prepareWorkflow>>) {
  cookieState.value = workflow.owner.cookie;
  return requestRoute("POST", `/api/documents/${workflow.documentId}/send`);
}

async function signAs(
  user: { cookie: string },
  documentId: string,
  fieldId: string,
) {
  cookieState.value = user.cookie;
  return requestRoute("PUT", `/api/sign/${documentId}/fields/${fieldId}`, {
    json: {
      requestId: randomUUID(),
      method: "TYPED",
      value: "Typed test signature",
    },
  });
}

async function completeAs(user: { cookie: string }, documentId: string) {
  cookieState.value = user.cookie;
  return requestRoute("POST", `/api/sign/${documentId}/complete`, {
    json: { requestId: randomUUID() },
  });
}

describe.skipIf(!enabled)("Phase 3 live PostgreSQL validation", () => {
  it("rejects invalid, expired, and revoked signer sessions at the signing API", async () => {
    const { pool } = await import("@/db/client");
    const { config } = await import("@/config/env");
    const workflow = await prepareWorkflow("session-revocation-live");
    expect((await send(workflow)).status).toBe(200);
    const fieldId = workflow.fields[0]!.id;
    const path = `/api/sign/${workflow.documentId}/fields/${fieldId}`;
    const body = { requestId: randomUUID(), method: "TYPED", value: "Student" };

    cookieState.value = "invalid.session";
    expect((await requestRoute("PUT", path, { json: body })).status).toBe(401);

    const payload = Buffer.from(
      JSON.stringify({
        userId: workflow.users[0]!.userId,
        email: workflow.users[0]!.email,
        displayName: "expired",
        expiresAt: Date.now() - 1,
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", config.SESSION_SECRET)
      .update(payload)
      .digest("base64url");
    cookieState.value = `${payload}.${signature}`;
    expect((await requestRoute("PUT", path, { json: body })).status).toBe(401);

    await pool.query("update signers set status='REVOKED' where id=$1", [
      workflow.signers[0]!.id,
    ]);
    cookieState.value = workflow.users[0]!.cookie;
    const revoked = await requestRoute("PUT", path, {
      json: { ...body, requestId: randomUUID() },
    });
    expect(revoked.status).toBe(409);
    expect((await revoked.json()).error.code).toBe("OUT_OF_TURN");
    expect(
      (
        await pool.query("select id from signatures where field_id=$1", [
          fieldId,
        ])
      ).rows,
    ).toHaveLength(0);
  });

  it("has all required application tables, constraints, and protection triggers", async () => {
    const { pool } = await import("@/db/client");
    const tables = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`,
    );
    for (const table of [
      "users",
      "documents",
      "document_versions",
      "signers",
      "signature_fields",
      "signatures",
      "document_views",
      "audit_events",
      "integrity_manifests",
      "outbox_jobs",
    ])
      expect(tables.rows.map((row) => row.table_name)).toContain(table);
    const constraints = await pool.query<{ conname: string }>(
      `select conname from pg_constraint where connamespace='public'::regnamespace`,
    );
    for (const name of [
      "signers_sequence_check",
      "signatures_field_signer_doc_fk",
      "fields_assigned_signer_doc_fk",
      "fields_doc_source_version_fk",
      "signatures_method_value_check",
      "audit_signature_doc_fk",
    ])
      expect(constraints.rows.map((row) => row.conname)).toContain(name);
    const indexes = await pool.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname='public'`,
    );
    for (const name of [
      "signers_doc_sequence_uq",
      "signers_doc_role_uq",
      "signers_one_active_per_doc_uq",
      "signatures_field_uq",
      "audit_doc_sequence_uq",
    ])
      expect(indexes.rows.map((row) => row.indexname)).toContain(name);
    const triggers = await pool.query<{ tgname: string }>(
      `select tgname from pg_trigger where not tgisinternal`,
    );
    for (const name of [
      "audit_events_append_only",
      "document_views_append_only",
      "signers_draft_configuration",
      "signature_fields_draft_only",
      "document_versions_immutable",
      "integrity_manifests_append_only",
    ])
      expect(triggers.rows.map((row) => row.tgname)).toContain(name);
  });

  it("enforces Student → Advisor → HoD through direct APIs and preserves frozen configuration", async () => {
    const { pool } = await import("@/db/client");
    const workflow = await prepareWorkflow("ordered-live");
    const sent = await send(workflow);
    expect(sent.status).toBe(200);
    const state = async () =>
      pool.query(
        "select sequence,status,signed_at from signers where document_id=$1 order by sequence",
        [workflow.documentId],
      );
    expect((await state()).rows.map((row) => row.status)).toEqual([
      "ACTIVE",
      "PENDING",
      "PENDING",
    ]);

    // Call the mutation route directly without loading the signing page.
    const earlyAdvisor = await signAs(
      workflow.users[1]!,
      workflow.documentId,
      workflow.fields[1]!.id,
    );
    const earlyHod = await signAs(
      workflow.users[2]!,
      workflow.documentId,
      workflow.fields[2]!.id,
    );
    expect(earlyAdvisor.status).toBe(409);
    expect((await earlyAdvisor.json()).error.code).toBe("OUT_OF_TURN");
    expect(earlyHod.status).toBe(409);
    expect((await earlyHod.json()).error.code).toBe("OUT_OF_TURN");
    const persisted = await pool.query(
      `select sig.signer_id,e.actor_signer_id,e.event_type from signatures sig left join audit_events e on e.signature_id=sig.id where sig.document_id=$1`,
      [workflow.documentId],
    );
    expect(persisted.rows).toHaveLength(0);
    expect((await state()).rows.map((row) => row.status)).toEqual([
      "ACTIVE",
      "PENDING",
      "PENDING",
    ]);

    const studentSigned = await signAs(
      workflow.users[0]!,
      workflow.documentId,
      workflow.fields[0]!.id,
    );
    expect(studentSigned.status).toBe(200);
    const duplicateStudentSignature = await signAs(
      workflow.users[0]!,
      workflow.documentId,
      workflow.fields[0]!.id,
    );
    expect(duplicateStudentSignature.status).toBe(409);
    expect((await duplicateStudentSignature.json()).error.code).toBe(
      "ALREADY_SIGNED",
    );
    const earlyCompletion = await completeAs(
      workflow.users[0]!,
      workflow.documentId,
    );
    expect(earlyCompletion.status).toBe(200);
    expect((await state()).rows.map((row) => row.status)).toEqual([
      "SIGNED",
      "ACTIVE",
      "PENDING",
    ]);

    const wrongField = await signAs(
      workflow.users[1]!,
      workflow.documentId,
      workflow.fields[0]!.id,
    );
    expect(wrongField.status).toBe(404);
    expect(
      (
        await pool.query("select id from signatures where document_id=$1", [
          workflow.documentId,
        ])
      ).rows,
    ).toHaveLength(1);
    const advisorSigned = await signAs(
      workflow.users[1]!,
      workflow.documentId,
      workflow.fields[1]!.id,
    );
    expect(advisorSigned.status).toBe(200);
    const hodStillEarly = await signAs(
      workflow.users[2]!,
      workflow.documentId,
      workflow.fields[2]!.id,
    );
    expect(hodStillEarly.status).toBe(409);
    expect((await hodStillEarly.json()).error.code).toBe("OUT_OF_TURN");

    const advisorCompleted = await completeAs(
      workflow.users[1]!,
      workflow.documentId,
    );
    expect(advisorCompleted.status).toBe(200);
    expect((await state()).rows.map((row) => row.status)).toEqual([
      "SIGNED",
      "SIGNED",
      "ACTIVE",
    ]);
    const hodSigned = await signAs(
      workflow.users[2]!,
      workflow.documentId,
      workflow.fields[2]!.id,
    );
    expect(hodSigned.status).toBe(200);
    const hodCompleted = await completeAs(
      workflow.users[2]!,
      workflow.documentId,
    );
    expect(hodCompleted.status).toBe(200);
    expect((await state()).rows.map((row) => row.status)).toEqual([
      "SIGNED",
      "SIGNED",
      "SIGNED",
    ]);
    expect(
      (
        await pool.query("select status from documents where id=$1", [
          workflow.documentId,
        ])
      ).rows[0].status,
    ).toBe("COMPLETED");
    const events = await pool.query(
      "select event_type,actor_signer_id,signature_id,occurred_at,sequence,previous_hash,event_hash,event_signature,kms_key_version from audit_events where document_id=$1 order by sequence",
      [workflow.documentId],
    );
    expect(
      events.rows.filter((row) => row.event_type === "FIELD_SIGNED"),
    ).toHaveLength(3);
    expect(
      events.rows.filter(
        (row) => row.event_type === "DOCUMENT_RECIPIENT_COMPLETED",
      ),
    ).toHaveLength(3);
    expect(
      events.rows.every(
        (row) =>
          row.occurred_at instanceof Date &&
          row.event_signature.length > 0 &&
          row.kms_key_version,
      ),
    ).toBe(true);
    const [{ auditService }, { signingProvider }] = await Promise.all([
      import("@/services/audit"),
      import("@/services/signing-provider"),
    ]);
    const completeChain = await pool.query(
      `select id,document_id,sequence::text,actor_type,actor_user_id,actor_signer_id,view_id,signature_id,event_type,occurred_at,details,encode(previous_hash,'hex') previous_hash,encode(event_hash,'hex') event_hash,encode(event_signature,'base64') event_signature,kms_key_version from audit_events where document_id=$1 order by sequence::bigint`,
      [workflow.documentId],
    );
    const auditRecords = completeChain.rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      sequence: row.sequence,
      actorType: row.actor_type,
      actorUserId: row.actor_user_id,
      actorSignerId: row.actor_signer_id,
      viewId: row.view_id,
      signatureId: row.signature_id,
      eventType: row.event_type,
      occurredAt: row.occurred_at.toISOString(),
      details: row.details,
      previousHash: row.previous_hash,
      eventHash: row.event_hash,
      eventSignature: row.event_signature.trim(),
      kmsKeyVersion: row.kms_key_version,
    }));
    const verifiedPrefixes = auditRecords.map((_, index) =>
      auditService.verifyChain(
        auditRecords.slice(0, index + 1),
        signingProvider,
      ),
    );
    expect(verifiedPrefixes).toEqual(auditRecords.map(() => true));
    await expect(
      pool.query(
        "update audit_events set details='{}'::jsonb where document_id=$1",
        [workflow.documentId],
      ),
    ).rejects.toThrow(/append-only/i);
    const duplicateCompletion = await completeAs(
      workflow.users[0]!,
      workflow.documentId,
    );
    expect(duplicateCompletion.status).toBe(409);
    expect((await duplicateCompletion.json()).error.code).toBe(
      "ALREADY_SIGNED",
    );

    await expect(
      pool.query(
        "update signers set email='changed@example.test' where id=$1",
        [workflow.signers[0]!.id],
      ),
    ).rejects.toThrow(/frozen/i);
    await expect(
      pool.query("update signature_fields set x_norm=0.3 where id=$1", [
        workflow.fields[0]!.id,
      ]),
    ).rejects.toThrow(/frozen/i);
    await expect(
      pool.query("delete from signature_fields where id=$1", [
        workflow.fields[0]!.id,
      ]),
    ).rejects.toThrow(/frozen/i);
    await expect(
      pool.query(
        "update document_versions set sha256=decode(repeat('01',32),'hex') where id=$1",
        [
          (
            await pool.query(
              "select current_version_id from documents where id=$1",
              [workflow.documentId],
            )
          ).rows[0].current_version_id,
        ],
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it("fails closed for unsupported required fields and unsigned required signature fields", async () => {
    const unsupported = await prepareWorkflow("unsupported-live", true);
    const unsupportedSent = await send(unsupported);
    expect(unsupportedSent.status).toBe(422);
    expect((await unsupportedSent.json()).error.code).toBe(
      "REQUIRED_FIELDS_MISSING",
    );
    const { pool } = await import("@/db/client");
    expect(
      (
        await pool.query("select status from documents where id=$1", [
          unsupported.documentId,
        ])
      ).rows[0].status,
    ).toBe("DRAFT");

    const incomplete = await prepareWorkflow("missing-live");
    expect((await send(incomplete)).status).toBe(200);
    const blocked = await completeAs(
      incomplete.users[0]!,
      incomplete.documentId,
    );
    expect(blocked.status).toBe(422);
    expect((await blocked.json()).error.code).toBe("REQUIRED_FIELDS_MISSING");
    expect(
      (
        await pool.query("select status from signers where id=$1", [
          incomplete.signers[0]!.id,
        ])
      ).rows[0].status,
    ).toBe("ACTIVE");
  });

  it("rolls back a signature when PostgreSQL rejects its required audit insert", async () => {
    const { pool } = await import("@/db/client");
    const workflow = await prepareWorkflow("audit-rollback-live");
    expect((await send(workflow)).status).toBe(200);
    await pool.query(
      `create function phase3_reject_field_signed_audit() returns trigger language plpgsql as $$ begin if new.event_type='FIELD_SIGNED' then raise exception 'forced test audit failure'; end if; return new; end $$`,
    );
    await pool.query(
      `create trigger phase3_reject_field_signed_audit before insert on audit_events for each row execute function phase3_reject_field_signed_audit()`,
    );
    try {
      const response = await signAs(
        workflow.users[0]!,
        workflow.documentId,
        workflow.fields[0]!.id,
      );
      expect(response.status).toBe(503);
      expect(
        (
          await pool.query("select id from signatures where document_id=$1", [
            workflow.documentId,
          ])
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await pool.query("select status from signers where id=$1", [
            workflow.signers[0]!.id,
          ])
        ).rows[0].status,
      ).toBe("ACTIVE");
      expect(
        (
          await pool.query(
            "select id from audit_events where document_id=$1 and event_type='FIELD_SIGNED'",
            [workflow.documentId],
          )
        ).rows,
      ).toHaveLength(0);
    } finally {
      await pool.query(
        "drop trigger if exists phase3_reject_field_signed_audit on audit_events",
      );
      await pool.query(
        "drop function if exists phase3_reject_field_signed_audit()",
      );
    }
  });

  it("serializes concurrent Student completion and Advisor signing without an out-of-turn commit", async () => {
    const { pool } = await import("@/db/client");
    const { completeSigner, submitSignature, SigningError } =
      await import("@/services/sequential-signing");
    const workflow = await prepareWorkflow("concurrent-live");
    expect((await send(workflow)).status).toBe(200);
    const studentSign = await submitSignature({
      documentId: workflow.documentId,
      userId: workflow.users[0]!.userId,
      fieldId: workflow.fields[0]!.id,
      requestId: randomUUID(),
      method: "TYPED",
      value: "Student signer",
    });
    expect(studentSign.signatureId).toBeTruthy();

    const [completion, advisorAttempt] = await Promise.allSettled([
      completeSigner(
        workflow.documentId,
        workflow.users[0]!.userId,
        randomUUID(),
      ),
      submitSignature({
        documentId: workflow.documentId,
        userId: workflow.users[1]!.userId,
        fieldId: workflow.fields[1]!.id,
        requestId: randomUUID(),
        method: "TYPED",
        value: "Advisor signer",
      }),
    ]);
    expect(completion.status).toBe("fulfilled");
    const advisorSignature = await pool.query(
      "select id from signatures where field_id=$1",
      [workflow.fields[1]!.id],
    );
    const finalState = await pool.query(
      "select sequence,status from signers where document_id=$1 order by sequence",
      [workflow.documentId],
    );
    expect(finalState.rows.map((row) => row.status)).toEqual([
      "SIGNED",
      "ACTIVE",
      "PENDING",
    ]);
    if (advisorAttempt.status === "fulfilled") {
      expect(advisorSignature.rows).toHaveLength(1);
      const sequence = await pool.query(
        `select e.event_type,e.sequence from audit_events e left join signatures sig on sig.id=e.signature_id where e.document_id=$1 and ((e.actor_signer_id=$2 and e.event_type='DOCUMENT_RECIPIENT_COMPLETED') or (sig.signer_id=$3 and e.event_type='FIELD_SIGNED')) order by e.sequence`,
        [workflow.documentId, workflow.signers[0]!.id, workflow.signers[1]!.id],
      );
      const studentCompletedSequence = BigInt(
        sequence.rows.find(
          (row) => row.event_type === "DOCUMENT_RECIPIENT_COMPLETED",
        )!.sequence,
      );
      const advisorSignedSequence = BigInt(
        sequence.rows.find((row) => row.event_type === "FIELD_SIGNED")!
          .sequence,
      );
      expect(studentCompletedSequence).toBeLessThan(advisorSignedSequence);
    } else {
      expect(advisorAttempt.reason).toBeInstanceOf(SigningError);
      expect(advisorAttempt.reason.code).toBe("OUT_OF_TURN");
      expect(advisorSignature.rows).toHaveLength(0);
    }
  });
});
