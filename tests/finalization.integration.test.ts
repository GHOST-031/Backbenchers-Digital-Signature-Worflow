import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { config } from "@/config/env";
import {
  cookieState,
  createUser,
  requestRoute,
} from "./document-route-test-helpers";
import { makePdf } from "./pdf-fixture";

const enabled = Boolean(process.env.FOUNDATION_DB_TEST);
const roles = ["STUDENT", "FACULTY_ADVISOR", "HOD"] as const;

async function prepare(label: string) {
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
  const assigned = await assignedResponse.json();
  const signers = assigned.signers as Array<{
    id: string;
    sequence: number;
    role: string;
  }>;
  const fieldsResponse = await requestRoute(
    "PUT",
    `/api/documents/${created.documentId}/fields`,
    {
      json: {
        fields: signers.map((signer, index) => ({
          signerId: signer.id,
          pageNumber: 1,
          x: 0.08 + index * 0.29,
          y: 0.72,
          width: 0.2,
          height: 0.07,
          fieldType: "SIGNATURE",
          required: true,
        })),
      },
    },
  );
  expect(fieldsResponse.status).toBe(200);
  const fieldRows = (await fieldsResponse.json()).fields as Array<{
    id: string;
  }>;
  const sent = await requestRoute(
    "POST",
    `/api/documents/${created.documentId}/send`,
  );
  expect(sent.status).toBe(200);
  return {
    owner,
    users,
    documentId: created.documentId as string,
    signers,
    fields: fieldRows,
  };
}

async function sign(
  workflow: Awaited<ReturnType<typeof prepare>>,
  index: number,
  method: "TYPED" | "DRAWN" = "TYPED",
) {
  cookieState.value = workflow.users[index]!.cookie;
  const response = await requestRoute(
    "PUT",
    `/api/sign/${workflow.documentId}/fields/${workflow.fields[index]!.id}`,
    {
      json: {
        requestId: randomUUID(),
        method,
        value:
          method === "DRAWN"
            ? "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
            : `Signer ${index + 1} Example`,
      },
    },
  );
  const body = await response.text();
  expect(response.status, body).toBe(200);
}

async function completeDirect(
  workflow: Awaited<ReturnType<typeof prepare>>,
  index: number,
) {
  const { completeSigner } = await import("@/services/sequential-signing");
  return completeSigner(
    workflow.documentId,
    workflow.users[index]!.userId,
    randomUUID(),
  );
}

async function readyWithQueuedJob(label: string) {
  const workflow = await prepare(label);
  await sign(workflow, 0);
  await completeDirect(workflow, 0);
  await sign(workflow, 1);
  await completeDirect(workflow, 1);
  await sign(workflow, 2);
  const completion = await completeDirect(workflow, 2);
  if (!completion.sealJobId)
    throw new Error("HoD completion did not queue a seal job");
  return { ...workflow, sealJobId: completion.sealJobId };
}

describe.skipIf(!enabled)("Phase 4 finalization with PostgreSQL", () => {
  async function registerAndLogin(label: string) {
    const email = `${label}-${randomUUID()}@phase5.example.test`;
    const password = "PhaseFive-validation-password-2026!";
    const registered = await requestRoute("POST", "/api/auth/register", {
      json: { email, displayName: label, password },
    });
    expect(registered.status).toBe(201);
    const login = await requestRoute("POST", "/api/auth/login", {
      json: { email, password },
    });
    expect(login.status).toBe(200);
    const user = (await login.json()).user as {
      userId: string;
      email: string;
      displayName: string;
    };
    const cookie = login.headers
      .get("set-cookie")
      ?.match(/od_session=([^;]+)/)?.[1];
    expect(cookie).toBeTruthy();
    return { ...user, cookie: cookie! };
  }

  it("runs authentication, document APIs, ordered signatures, sealing, verified retrieval, and audit history end to end", async () => {
    const { pool } = await import("@/db/client");
    const { documentStorage } = await import("@/services/storage");
    const owner = await registerAndLogin("phase5-owner");
    const users = await Promise.all(
      roles.map((role) => registerAndLogin(`phase5-${role.toLowerCase()}`)),
    );

    cookieState.value = owner.cookie;
    const createdResponse = await requestRoute("POST", "/api/documents", {
      fields: { title: "Phase 5 multi-page OD", letterType: "OD" },
      file: makePdf(3),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    const sourceVersion = await pool.query<{
      object_key: string;
      sha256: Buffer;
      state: string;
    }>("select object_key,sha256,state from document_versions where id=$1", [
      created.initialVersionId,
    ]);
    const sourceBefore = await documentStorage.get(
      sourceVersion.rows[0]!.object_key,
    );

    const assignment = await requestRoute(
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
    expect(assignment.status).toBe(200);
    const signers = (await assignment.json()).signers as Array<{
      id: string;
      sequence: number;
      role: string;
    }>;
    const fieldResponse = await requestRoute(
      "PUT",
      `/api/documents/${created.documentId}/fields`,
      {
        json: {
          fields: [
            {
              signerId: signers[0]!.id,
              pageNumber: 1,
              x: 0.1,
              y: 0.7,
              width: 0.2,
              height: 0.06,
              fieldType: "SIGNATURE",
              required: true,
            },
            {
              signerId: signers[0]!.id,
              pageNumber: 1,
              x: 0.4,
              y: 0.7,
              width: 0.2,
              height: 0.06,
              fieldType: "SIGNATURE",
              required: true,
            },
            {
              signerId: signers[1]!.id,
              pageNumber: 2,
              x: 0.1,
              y: 0.7,
              width: 0.2,
              height: 0.06,
              fieldType: "SIGNATURE",
              required: true,
            },
            {
              signerId: signers[2]!.id,
              pageNumber: 3,
              x: 0.1,
              y: 0.7,
              width: 0.2,
              height: 0.06,
              fieldType: "SIGNATURE",
              required: true,
            },
          ],
        },
      },
    );
    expect(fieldResponse.status).toBe(200);
    const fields = (await fieldResponse.json()).fields as Array<{ id: string }>;
    expect(fields).toHaveLength(4);
    expect(
      (await requestRoute("POST", `/api/documents/${created.documentId}/send`))
        .status,
    ).toBe(200);

    const outsider = await registerAndLogin("phase5-outsider");
    cookieState.value = outsider.cookie;
    expect(
      (await requestRoute("GET", `/api/documents/${created.documentId}`))
        .status,
    ).toBe(403);
    expect(
      (await requestRoute("GET", `/api/documents/${created.documentId}/source`))
        .status,
    ).toBe(403);
    expect(
      (
        await requestRoute(
          "GET",
          `/api/documents/${created.documentId}/audit-events`,
        )
      ).status,
    ).toBe(403);
    for (const session of [outsider, owner]) {
      cookieState.value = session.cookie;
      const impersonation = await requestRoute(
        "PUT",
        `/api/sign/${created.documentId}/fields/${fields[0]!.id}`,
        {
          json: {
            requestId: randomUUID(),
            method: "TYPED",
            value: "Unauthorized identity",
          },
        },
      );
      expect(impersonation.status).toBe(404);
    }

    const completionIds = [randomUUID(), randomUUID(), randomUUID()];
    for (let signerIndex = 0; signerIndex < 3; signerIndex++) {
      cookieState.value = users[signerIndex]!.cookie;
      const context = await requestRoute(
        "GET",
        `/api/sign/${created.documentId}`,
      );
      expect(context.status).toBe(200);
      const viewed = await requestRoute(
        "GET",
        `/api/documents/${created.documentId}/source`,
      );
      expect(viewed.status).toBe(200);
      const myFields = signerIndex === 0 ? [0, 1] : [signerIndex + 1];
      for (const fieldIndex of myFields) {
        const requestId = randomUUID();
        const signatureValue = `Phase 5 signer ${signerIndex + 1} field ${fieldIndex + 1}`;
        const signed = await requestRoute(
          "PUT",
          `/api/sign/${created.documentId}/fields/${fields[fieldIndex]!.id}`,
          {
            json: { requestId, method: "TYPED", value: signatureValue },
          },
        );
        expect(signed.status).toBe(200);
        if (signerIndex === 0 && fieldIndex === 0) {
          const replay = await requestRoute(
            "PUT",
            `/api/sign/${created.documentId}/fields/${fields[fieldIndex]!.id}`,
            {
              json: { requestId, method: "TYPED", value: signatureValue },
            },
          );
          expect(replay.status).toBe(200);
          expect(await replay.json()).toMatchObject({
            signature: { replay: true },
          });
          const duplicateWithNewId = await requestRoute(
            "PUT",
            `/api/sign/${created.documentId}/fields/${fields[fieldIndex]!.id}`,
            {
              json: {
                requestId: randomUUID(),
                method: "TYPED",
                value: signatureValue,
              },
            },
          );
          expect(duplicateWithNewId.status).toBe(409);
          expect((await duplicateWithNewId.json()).error.code).toBe(
            "ALREADY_SIGNED",
          );
          const conflict = await requestRoute(
            "PUT",
            `/api/sign/${created.documentId}/fields/${fields[fieldIndex]!.id}`,
            {
              json: {
                requestId,
                method: "TYPED",
                value: "different signature",
              },
            },
          );
          expect(conflict.status).toBe(409);
          expect((await conflict.json()).error.code).toBe("REPLAY_CONFLICT");
        }
      }
      const completed = await requestRoute(
        "POST",
        `/api/sign/${created.documentId}/complete`,
        { json: { requestId: completionIds[signerIndex] } },
      );
      expect(completed.status).toBe(200);
      const replay = await requestRoute(
        "POST",
        `/api/sign/${created.documentId}/complete`,
        { json: { requestId: completionIds[signerIndex] } },
      );
      expect(replay.status).toBe(200);
      expect((await replay.json()).retry).toBe(true);
      if (signerIndex === 0) {
        const duplicateWithNewId = await requestRoute(
          "POST",
          `/api/sign/${created.documentId}/complete`,
          { json: { requestId: randomUUID() } },
        );
        expect(duplicateWithNewId.status).toBe(409);
        expect((await duplicateWithNewId.json()).error.code).toBe(
          "ALREADY_SIGNED",
        );
      }
    }

    cookieState.value = owner.cookie;
    const detail = await requestRoute(
      "GET",
      `/api/documents/${created.documentId}`,
    );
    expect((await detail.json()).document.status).toBe("COMPLETED");
    const finalVersion = await pool.query<{
      id: string;
      object_key: string;
      sha256: Buffer;
      state: string;
    }>(
      "select id,object_key,sha256,state from document_versions where document_id=$1 and state='SEALED'",
      [created.documentId],
    );
    expect(finalVersion.rows).toHaveLength(1);
    expect(finalVersion.rows[0]!.object_key).not.toBe(
      sourceVersion.rows[0]!.object_key,
    );
    expect(sourceVersion.rows[0]!.state).toBe("SOURCE");
    expect(
      (await documentStorage.get(sourceVersion.rows[0]!.object_key)).equals(
        sourceBefore,
      ),
    ).toBe(true);
    const auditPage = await requestRoute(
      "GET",
      `/api/documents/${created.documentId}/audit-events?afterSequence=2`,
    );
    expect(auditPage.status).toBe(200);
    expect(
      (await auditPage.json()).events.every(
        (event: { sequence: string }) => BigInt(event.sequence) > 2n,
      ),
    ).toBe(true);
    const finalBytes = await documentStorage.get(
      finalVersion.rows[0]!.object_key,
    );
    const retrieved = await requestRoute(
      "GET",
      `/api/documents/${created.documentId}/source`,
    );
    expect(retrieved.status).toBe(200);
    expect(Buffer.from(await retrieved.arrayBuffer()).equals(finalBytes)).toBe(
      true,
    );

    const auditResponse = await requestRoute(
      "GET",
      `/api/documents/${created.documentId}/audit-events`,
    );
    expect(auditResponse.status).toBe(200);
    const auditBody = await auditResponse.json();
    expect(auditBody.integrity).toBe("VALID");
    cookieState.value = users[2]!.cookie;
    expect(
      (
        await requestRoute(
          "GET",
          `/api/documents/${created.documentId}/audit-events`,
        )
      ).status,
    ).toBe(200);
    cookieState.value = owner.cookie;
    const eventTypes = (auditBody.events as Array<{ eventType: string }>).map(
      (event) => event.eventType,
    );
    for (const eventType of [
      "DOCUMENT_CREATED",
      "SIGNERS_ASSIGNED",
      "DOCUMENT_SENT",
      "DOCUMENT_VIEWED",
      "FIELD_SIGNED",
      "DOCUMENT_RECIPIENT_COMPLETED",
      "DOCUMENT_SEALED",
      "INTEGRITY_VERIFIED",
    ])
      expect(eventTypes).toContain(eventType);
    expect(
      eventTypes.filter((eventType) => eventType === "FIELD_SIGNED"),
    ).toHaveLength(4);
    expect(
      eventTypes.filter(
        (eventType) => eventType === "DOCUMENT_RECIPIENT_COMPLETED",
      ),
    ).toHaveLength(3);
    expect(
      eventTypes.filter((eventType) => eventType === "DOCUMENT_SEALED"),
    ).toHaveLength(1);
    expect(
      (
        auditBody.events as Array<{ sequence: string; occurredAt: string }>
      ).every(
        (event, index, all) =>
          event.sequence === String(index + 1) &&
          Number.isFinite(Date.parse(event.occurredAt)) &&
          (index === 0 ||
            BigInt(event.sequence) > BigInt(all[index - 1]!.sequence)),
      ),
    ).toBe(true);

    cookieState.value = users[2]!.cookie;
    const completedDuplicate = await requestRoute(
      "POST",
      `/api/sign/${created.documentId}/complete`,
      { json: { requestId: completionIds[2] } },
    );
    expect(completedDuplicate.status).toBe(200);
    expect((await completedDuplicate.json()).reused).toBe(true);
    expect(
      (
        await pool.query(
          "select count(*) from audit_events where document_id=$1 and event_type='DOCUMENT_SEALED'",
          [created.documentId],
        )
      ).rows[0]?.count,
    ).toBe("1");

    cookieState.value = owner.cookie;
    const lateFieldEdit = await requestRoute(
      "PUT",
      `/api/documents/${created.documentId}/fields`,
      { json: { fields: [] } },
    );
    expect(lateFieldEdit.status).toBe(409);
    const lateSignerEdit = await requestRoute(
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
    expect(lateSignerEdit.status).toBe(409);
    expect(
      (
        await pool.query("select status from documents where id=$1", [
          created.documentId,
        ])
      ).rows[0]?.status,
    ).toBe("COMPLETED");
  });

  async function completedWorkflow(label: string) {
    const workflow = await readyWithQueuedJob(label);
    const { finalizationService } = await import("@/services/finalization");
    const finalized = await finalizationService.processJob(workflow.sealJobId);
    expect(finalized.versionId).toBeTruthy();
    return { ...workflow, finalVersionId: finalized.versionId };
  }

  it("retrieves an untouched sealed PDF only after verifying its hash and signed manifest", async () => {
    const { pool } = await import("@/db/client");
    const { documentStorage } = await import("@/services/storage");
    const workflow = await completedWorkflow("verified-retrieval");
    const version = await pool.query<{ object_key: string; sha256: Buffer }>(
      "select object_key,sha256 from document_versions where id=$1",
      [workflow.finalVersionId],
    );
    cookieState.value = workflow.owner.cookie;
    const response = await requestRoute(
      "GET",
      `/api/documents/${workflow.documentId}/source`,
    );
    expect(response.status).toBe(200);
    const returned = Buffer.from(await response.arrayBuffer());
    const stored = await documentStorage.get(version.rows[0]!.object_key);
    expect(returned.equals(stored)).toBe(true);
    const { integrityService } = await import("@/services/integrity");
    expect(
      integrityService.hash(returned).equals(version.rows[0]!.sha256),
    ).toBe(true);
    const verification = await pool.query<{ count: string }>(
      "select count(*) from audit_events where document_id=$1 and event_type='INTEGRITY_VERIFIED'",
      [workflow.documentId],
    );
    expect(verification.rows[0]?.count).toBe("1");
  });

  it("detects a one-byte stored-PDF edit, records failure, preserves evidence, and remains failed on retry", async () => {
    const { pool } = await import("@/db/client");
    const { documentStorage } = await import("@/services/storage");
    const workflow = await completedWorkflow("one-byte-tamper");
    const version = await pool.query<{ object_key: string }>(
      "select object_key from document_versions where id=$1",
      [workflow.finalVersionId],
    );
    const key = version.rows[0]!.object_key;
    const stored = await documentStorage.get(key);
    const tampered = Buffer.from(stored);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    await writeFile(path.join(config.STORAGE_ROOT, key), tampered);

    cookieState.value = workflow.owner.cookie;
    const first = await requestRoute(
      "GET",
      `/api/documents/${workflow.documentId}/source`,
    );
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({
      error: { code: "INTEGRITY_FAILED" },
    });
    expect((await documentStorage.get(key)).equals(tampered)).toBe(true);
    expect(
      (
        await pool.query("select status from documents where id=$1", [
          workflow.documentId,
        ])
      ).rows[0]?.status,
    ).toBe("INTEGRITY_FAILED");
    const auditBeforeRetry = await pool.query<{ count: string }>(
      "select count(*) from audit_events where document_id=$1 and event_type='INTEGRITY_FAILED'",
      [workflow.documentId],
    );
    expect(auditBeforeRetry.rows[0]?.count).toBe("1");

    const second = await requestRoute(
      "GET",
      `/api/documents/${workflow.documentId}/source`,
    );
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      error: { code: "INTEGRITY_FAILED" },
    });
    const auditAfterRetry = await pool.query<{ count: string }>(
      "select count(*) from audit_events where document_id=$1 and event_type='INTEGRITY_FAILED'",
      [workflow.documentId],
    );
    expect(auditAfterRetry.rows[0]?.count).toBe("1");
  });

  it("does not serve a replaced final artifact as valid", async () => {
    const { pool } = await import("@/db/client");
    const { documentStorage } = await import("@/services/storage");
    const workflow = await completedWorkflow("replaced-final-artifact");
    const version = await pool.query<{ object_key: string }>(
      "select object_key from document_versions where id=$1",
      [workflow.finalVersionId],
    );
    const replacement = await documentStorage.put(makePdf(1), "sealed");
    await writeFile(
      path.join(config.STORAGE_ROOT, version.rows[0]!.object_key),
      await documentStorage.get(replacement),
    );
    cookieState.value = workflow.owner.cookie;
    const response = await requestRoute(
      "GET",
      `/api/documents/${workflow.documentId}/source`,
    );
    expect(response.status).toBe(409);
    expect(
      (
        await pool.query("select status from documents where id=$1", [
          workflow.documentId,
        ])
      ).rows[0]?.status,
    ).toBe("INTEGRITY_FAILED");
  });

  it("marks a corrupted SOURCE artifact failed and audited before serving it", async () => {
    const { pool } = await import("@/db/client");
    const { documentStorage } = await import("@/services/storage");
    const workflow = await prepare("source-artifact-tamper");
    const version = await pool.query<{ object_key: string }>(
      "select object_key from document_versions where id=(select current_version_id from documents where id=$1)",
      [workflow.documentId],
    );
    const key = version.rows[0]!.object_key;
    const original = await documentStorage.get(key);
    const tampered = Buffer.from(original);
    tampered[0] = tampered[0]! ^ 1;
    await writeFile(path.join(config.STORAGE_ROOT, key), tampered);
    cookieState.value = workflow.users[0]!.cookie;
    const response = await requestRoute(
      "GET",
      `/api/documents/${workflow.documentId}/source`,
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("INTEGRITY_FAILED");
    expect((await documentStorage.get(key)).equals(tampered)).toBe(true);
    expect(
      (
        await pool.query("select status from documents where id=$1", [
          workflow.documentId,
        ])
      ).rows[0]?.status,
    ).toBe("INTEGRITY_FAILED");
    expect(
      (
        await pool.query(
          "select count(*) from audit_events where document_id=$1 and event_type='INTEGRITY_FAILED'",
          [workflow.documentId],
        )
      ).rows[0]?.count,
    ).toBe("1");
  });

  it("detects a cryptographically invalid persisted manifest signature", async () => {
    const { pool } = await import("@/db/client");
    const workflow = await completedWorkflow("manifest-tamper");
    try {
      await pool.query(
        "alter table integrity_manifests disable trigger integrity_manifests_append_only",
      );
      await pool.query(
        "alter table document_versions disable trigger document_versions_immutable",
      );
      await pool.query(
        "update integrity_manifests set signature=decode(repeat('00',64),'hex') where version_id=$1",
        [workflow.finalVersionId],
      );
      await pool.query(
        "update document_versions set manifest_signature=decode(repeat('00',64),'hex') where id=$1",
        [workflow.finalVersionId],
      );
    } finally {
      await pool.query(
        "alter table integrity_manifests enable trigger integrity_manifests_append_only",
      );
      await pool.query(
        "alter table document_versions enable trigger document_versions_immutable",
      );
    }

    cookieState.value = workflow.owner.cookie;
    const response = await requestRoute(
      "GET",
      `/api/documents/${workflow.documentId}/source`,
    );
    expect(response.status).toBe(409);
    expect(
      (
        await pool.query("select status from documents where id=$1", [
          workflow.documentId,
        ])
      ).rows[0]?.status,
    ).toBe("INTEGRITY_FAILED");
    expect(
      (
        await pool.query(
          "select count(*) from audit_events where document_id=$1 and event_type='INTEGRITY_FAILED'",
          [workflow.documentId],
        )
      ).rows[0]?.count,
    ).toBe("1");
  });

  it("enforces signature append-only, completion evidence, and source-version transition invariants in PostgreSQL", async () => {
    const { pool } = await import("@/db/client");
    const workflow = await prepare("db-guards");
    await sign(workflow, 0);
    const signed = await pool.query<{ id: string }>(
      "select id from signatures where document_id=$1 and signer_id=$2",
      [workflow.documentId, workflow.signers[0]!.id],
    );
    await expect(
      pool.query("update signatures set value='rewritten' where id=$1", [
        signed.rows[0]!.id,
      ]),
    ).rejects.toThrow(/append-only/i);
    await expect(
      pool.query("delete from signatures where id=$1", [signed.rows[0]!.id]),
    ).rejects.toThrow(/append-only/i);
    await expect(
      pool.query(
        "update documents set status='COMPLETED',completed_at=clock_timestamp() where id=$1",
        [workflow.documentId],
      ),
    ).rejects.toThrow(
      /invalid document status transition|sealed final version/i,
    );
    await expect(
      pool.query(
        `update document_versions set state='SEALED',sealed_at=clock_timestamp(),
         integrity_manifest='{}'::jsonb,manifest_signature=decode(repeat('00',64),'hex'),kms_key_version='fake'
         where id=(select current_version_id from documents where id=$1)`,
        [workflow.documentId],
      ),
    ).rejects.toThrow(/version evidence is immutable/i);
    expect(
      (
        await pool.query("select status from documents where id=$1", [
          workflow.documentId,
        ])
      ).rows[0]?.status,
    ).toBe("PENDING");
  });

  it("rejects completed-state rewinds and prevents INTEGRITY_FAILED from returning to COMPLETED", async () => {
    const { pool } = await import("@/db/client");
    const { documentStorage } = await import("@/services/storage");
    const workflow = await completedWorkflow("terminal-document-state");
    await expect(
      pool.query("update documents set status='INTEGRITY_FAILED' where id=$1", [
        workflow.documentId,
      ]),
    ).rejects.toThrow(
      /integrity failure status requires matching audit evidence/i,
    );
    expect(
      (
        await pool.query("select status from documents where id=$1", [
          workflow.documentId,
        ])
      ).rows[0]?.status,
    ).toBe("COMPLETED");
    await expect(
      pool.query("update documents set status='DRAFT' where id=$1", [
        workflow.documentId,
      ]),
    ).rejects.toThrow(/invalid document status transition/i);
    await expect(
      pool.query("update documents set status='PROCESSING' where id=$1", [
        workflow.documentId,
      ]),
    ).rejects.toThrow(/invalid document status transition/i);

    const version = await pool.query<{ object_key: string }>(
      "select object_key from document_versions where id=$1",
      [workflow.finalVersionId],
    );
    const key = version.rows[0]!.object_key;
    const bytes = Buffer.from(await documentStorage.get(key));
    bytes[0] = bytes[0]! ^ 1;
    await writeFile(path.join(config.STORAGE_ROOT, key), bytes);
    cookieState.value = workflow.owner.cookie;
    const failedRetrieval = await requestRoute(
      "GET",
      `/api/documents/${workflow.documentId}/source`,
    );
    expect(failedRetrieval.status).toBe(409);
    expect(
      (
        await pool.query("select status from documents where id=$1", [
          workflow.documentId,
        ])
      ).rows[0]?.status,
    ).toBe("INTEGRITY_FAILED");
    await expect(
      pool.query("update documents set status='COMPLETED' where id=$1", [
        workflow.documentId,
      ]),
    ).rejects.toThrow(/invalid document status transition/i);
    expect(
      (
        await pool.query(
          "select count(*) from audit_events where document_id=$1 and event_type='INTEGRITY_FAILED'",
          [workflow.documentId],
        )
      ).rows[0]?.count,
    ).toBe("1");
  });

  it("renders, stores, signs a manifest for exact stored bytes, and completes idempotently", async () => {
    const { pool } = await import("@/db/client");
    const workflow = await prepare("finalized-live");
    await sign(workflow, 0, "DRAWN");
    await completeDirect(workflow, 0);
    await sign(workflow, 1);
    await completeDirect(workflow, 1);
    await sign(workflow, 2);
    cookieState.value = workflow.users[2]!.cookie;
    const { documentStorage } = await import("@/services/storage");
    const originalPut = documentStorage.put.bind(documentStorage);
    let generatedBytes: Buffer | undefined;
    const putSpy = vi
      .spyOn(documentStorage, "put")
      .mockImplementation(async (bytes, kind) => {
        generatedBytes = Buffer.from(bytes);
        return originalPut(bytes, kind);
      });
    const response = await requestRoute(
      "POST",
      `/api/sign/${workflow.documentId}/complete`,
      {
        json: { requestId: randomUUID() },
      },
    );
    putSpy.mockRestore();
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.documentStatus).toBe("COMPLETED");
    const versionResult = await pool.query<{
      id: string;
      object_key: string;
      sha256: Buffer;
      byte_length: number;
      page_count: number;
      state: string;
      integrity_manifest: Record<string, unknown>;
      manifest_signature: Buffer;
    }>("select * from document_versions where id=$1", [result.finalVersionId]);
    const version = versionResult.rows[0]!;
    expect(version.state).toBe("SEALED");
    const bytes = await documentStorage.get(version.object_key);
    expect(generatedBytes?.equals(bytes)).toBe(true);
    const signatureEvidence = await pool.query<{
      method: string;
      value: string | null;
      image_object_key: string | null;
      field_id: string;
      signer_id: string;
    }>(
      "select method,value,image_object_key,field_id,signer_id from signatures where document_id=$1 order by signed_at",
      [workflow.documentId],
    );
    expect(signatureEvidence.rows).toHaveLength(3);
    expect(signatureEvidence.rows[0]).toMatchObject({
      method: "DRAWN",
      value: null,
      field_id: workflow.fields[0]!.id,
      signer_id: workflow.signers[0]!.id,
    });
    const drawnBytes = await documentStorage.get(
      signatureEvidence.rows[0]!.image_object_key!,
    );
    expect(
      drawnBytes.equals(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
          "base64",
        ),
      ),
    ).toBe(true);
    const { integrityService } = await import("@/services/integrity");
    expect(integrityService.hash(bytes)).toEqual(version.sha256);
    expect(bytes.byteLength).toBe(Number(version.byte_length));
    expect(
      integrityService.verifyManifest(
        bytes,
        version.integrity_manifest as never,
        version.manifest_signature,
      ),
    ).toBe(true);
    const { createPublicKey, verify } = await import("node:crypto");
    const { config } = await import("@/config/env");
    const manifest = version.integrity_manifest as {
      documentId: string;
      versionId: string;
      sha256: string;
      signingTime: string;
      keyVersion: string;
    };
    const canonicalBytes = Buffer.from(
      JSON.stringify({
        documentId: manifest.documentId,
        versionId: manifest.versionId,
        sha256: manifest.sha256,
        signingTime: manifest.signingTime,
        keyVersion: manifest.keyVersion,
      }),
    );
    const localPublicKey = createPublicKey(
      Buffer.from(config.SIGNING_PUBLIC_KEY_B64, "base64"),
    );
    expect(
      verify(null, canonicalBytes, localPublicKey, version.manifest_signature),
    ).toBe(true);
    const altered = { ...version.integrity_manifest, sha256: "00".repeat(32) };
    expect(
      integrityService.verifyManifest(
        bytes,
        altered as never,
        version.manifest_signature,
      ),
    ).toBe(false);
    const changedBytes = Buffer.from(bytes);
    changedBytes[changedBytes.length - 1] ^= 1;
    expect(integrityService.hash(changedBytes)).not.toEqual(version.sha256);
    const { pdfService } = await import("@/services/pdf");
    expect((await pdfService.validate(bytes)).pageCount).toBe(1);
    expect(bytes.byteLength).toBeGreaterThan(makePdf(1).byteLength);
    const { getDocument, OPS } =
      await import("pdfjs-dist/legacy/build/pdf.mjs");
    const parsedPdf = getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
    });
    const parsedDoc = await parsedPdf.promise;
    const parsedPage = await parsedDoc.getPage(1);
    const text = await parsedPage.getTextContent();
    const textItems = text.items.filter(
      (item): item is typeof item & { str: string; transform: number[] } =>
        "str" in item,
    );
    expect(
      textItems.filter((item) => item.str === "Signer 2 Example"),
    ).toHaveLength(1);
    expect(
      textItems.filter((item) => item.str === "Signer 3 Example"),
    ).toHaveLength(1);
    const advisorText = textItems.find(
      (item) => item.str === "Signer 2 Example",
    );
    expect(advisorText).toBeTruthy();
    expect(Math.abs(advisorText!.transform[4]! - 230.112)).toBeLessThan(1);
    const operators = await parsedPage.getOperatorList();
    expect(
      operators.fnArray.filter(
        (operation) => operation === OPS.paintImageXObject,
      ),
    ).toHaveLength(1);
    await parsedPdf.destroy();
    const manifestRow = await pool.query(
      "select digest,canonical_manifest,signature,signing_time,key_version from integrity_manifests where version_id=$1",
      [version.id],
    );
    expect(manifestRow.rows).toHaveLength(1);
    expect(manifestRow.rows[0]?.digest).toEqual(version.sha256);
    expect(new Date(manifestRow.rows[0]!.signing_time).toISOString()).toBe(
      (version.integrity_manifest as { signingTime: string }).signingTime,
    );
    await expect(
      pool.query(
        "update integrity_manifests set digest=decode(repeat('00',32),'hex') where version_id=$1",
        [version.id],
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      pool.query("delete from integrity_manifests where version_id=$1", [
        version.id,
      ]),
    ).rejects.toThrow(/append-only/i);
    await expect(
      pool.query(
        "update document_versions set sha256=decode(repeat('00',32),'hex') where id=$1",
        [version.id],
      ),
    ).rejects.toThrow(/immutable/i);
    const sealedEvents = await pool.query(
      "select id from audit_events where document_id=$1 and event_type='DOCUMENT_SEALED'",
      [workflow.documentId],
    );
    expect(sealedEvents.rows).toHaveLength(1);
    cookieState.value = workflow.users[2]!.cookie;
    const duplicateCompletion = await requestRoute(
      "POST",
      `/api/sign/${workflow.documentId}/complete`,
      { json: { requestId: randomUUID() } },
    );
    expect(duplicateCompletion.status).toBe(200);
    expect(await duplicateCompletion.json()).toMatchObject({
      finalVersionId: version.id,
      reused: true,
      documentStatus: "COMPLETED",
    });
    const { finalizationService } = await import("@/services/finalization");
    const jobId = await pool.query<{ id: string }>(
      "select id from outbox_jobs where type='SEAL_DOCUMENT' and payload->>'documentId'=$1 order by created_at desc limit 1",
      [workflow.documentId],
    );
    expect(jobId.rows[0]?.id).toBeTruthy();
    const replay = await finalizationService.processJob(jobId.rows[0]!.id);
    expect(replay).toEqual({ versionId: version.id, reused: true });
    expect(
      (
        await pool.query(
          "select id from document_versions where document_id=$1 and state='SEALED'",
          [workflow.documentId],
        )
      ).rows,
    ).toHaveLength(1);
  });

  it("rejects a direct early finalization job without publishing a completed version", async () => {
    const { pool } = await import("@/db/client");
    const workflow = await prepare("early-finalization");
    const job = await pool.query<{ id: string }>(
      "insert into outbox_jobs(type,payload) values ('SEAL_DOCUMENT',$1) returning id",
      [
        {
          documentId: workflow.documentId,
          finalSignerId: workflow.signers[2]!.id,
          idempotencyKey: randomUUID(),
        },
      ],
    );
    const { finalizationService } = await import("@/services/finalization");
    await expect(
      finalizationService.processJob(job.rows[0]!.id),
    ).rejects.toMatchObject({ code: "NOT_READY" });
    expect(
      (
        await pool.query("select status from documents where id=$1", [
          workflow.documentId,
        ])
      ).rows[0]?.status,
    ).toBe("PENDING");
    expect(
      (
        await pool.query(
          "select id from document_versions where document_id=$1 and state='SEALED'",
          [workflow.documentId],
        )
      ).rows,
    ).toHaveLength(0);
  });

  it("keeps the document processing when PDF sealing fails", async () => {
    const { pool } = await import("@/db/client");
    const workflow = await readyWithQueuedJob("pdf-failure");
    const { FinalizationService } = await import("@/services/finalization");
    const { documentStorage } = await import("@/services/storage");
    const { pdfService } = await import("@/services/pdf");
    const { integrityService } = await import("@/services/integrity");
    const failingPdf = {
      validate: (...args: Parameters<typeof pdfService.validate>) =>
        pdfService.validate(...args),
      pageDimensions: (...args: Parameters<typeof pdfService.pageDimensions>) =>
        pdfService.pageDimensions(...args),
      prepareForRendering: (
        ...args: Parameters<typeof pdfService.prepareForRendering>
      ) => pdfService.prepareForRendering(...args),
      renderSignatures: (
        ...args: Parameters<typeof pdfService.renderSignatures>
      ) => pdfService.renderSignatures(...args),
      seal: async () => {
        throw new Error("forced PDF sealing failure");
      },
    };
    const service = new FinalizationService({
      pool,
      storage: documentStorage,
      pdf: failingPdf,
      integrity: integrityService,
    });
    await expect(service.processJob(workflow.sealJobId)).rejects.toThrow(
      "forced PDF sealing failure",
    );
    expect(
      (
        await pool.query("select status from documents where id=$1", [
          workflow.documentId,
        ])
      ).rows[0]?.status,
    ).toBe("PROCESSING");
    expect(
      (
        await pool.query(
          "select id from document_versions where document_id=$1 and state='SEALED'",
          [workflow.documentId],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await pool.query(
          "select id from audit_events where document_id=$1 and event_type='DOCUMENT_SEALED'",
          [workflow.documentId],
        )
      ).rows,
    ).toHaveLength(0);
  });

  it("does not publish when PDF rendering fails", async () => {
    const { pool } = await import("@/db/client");
    const workflow = await readyWithQueuedJob("render-failure");
    const { FinalizationService } = await import("@/services/finalization");
    const { documentStorage } = await import("@/services/storage");
    const { pdfService } = await import("@/services/pdf");
    const { integrityService } = await import("@/services/integrity");
    const failingPdf = {
      validate: (...args: Parameters<typeof pdfService.validate>) =>
        pdfService.validate(...args),
      pageDimensions: (...args: Parameters<typeof pdfService.pageDimensions>) =>
        pdfService.pageDimensions(...args),
      prepareForRendering: (
        ...args: Parameters<typeof pdfService.prepareForRendering>
      ) => pdfService.prepareForRendering(...args),
      renderSignatures: async () => {
        throw new Error("forced PDF rendering failure");
      },
      seal: (...args: Parameters<typeof pdfService.seal>) =>
        pdfService.seal(...args),
    };
    const service = new FinalizationService({
      pool,
      storage: documentStorage,
      pdf: failingPdf,
      integrity: integrityService,
    });
    await expect(service.processJob(workflow.sealJobId)).rejects.toThrow(
      "forced PDF rendering failure",
    );
    expect(
      (
        await pool.query("select status from documents where id=$1", [
          workflow.documentId,
        ])
      ).rows[0]?.status,
    ).toBe("PROCESSING");
    expect(
      (
        await pool.query(
          "select id from document_versions where document_id=$1 and state='SEALED'",
          [workflow.documentId],
        )
      ).rows,
    ).toHaveLength(0);
  });

  it("rejects a concurrent duplicate job promptly without disturbing the active worker", async () => {
    const { pool } = await import("@/db/client");
    const workflow = await readyWithQueuedJob("concurrent-job");
    const { FinalizationService, finalizationService } =
      await import("@/services/finalization");
    const { documentStorage } = await import("@/services/storage");
    const { pdfService } = await import("@/services/pdf");
    const { integrityService } = await import("@/services/integrity");
    let notifyRendering!: () => void;
    let releaseRendering!: () => void;
    const rendering = new Promise<void>((resolve) => {
      notifyRendering = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseRendering = resolve;
    });
    const blockingPdf = {
      validate: (...args: Parameters<typeof pdfService.validate>) =>
        pdfService.validate(...args),
      pageDimensions: (...args: Parameters<typeof pdfService.pageDimensions>) =>
        pdfService.pageDimensions(...args),
      prepareForRendering: (
        ...args: Parameters<typeof pdfService.prepareForRendering>
      ) => pdfService.prepareForRendering(...args),
      renderSignatures: async (
        ...args: Parameters<typeof pdfService.renderSignatures>
      ) => {
        notifyRendering();
        await gate;
        return pdfService.renderSignatures(...args);
      },
      seal: (...args: Parameters<typeof pdfService.seal>) =>
        pdfService.seal(...args),
    };
    const firstWorker = new FinalizationService({
      pool,
      storage: documentStorage,
      pdf: blockingPdf,
      integrity: integrityService,
    });
    const firstRun = firstWorker.processJob(workflow.sealJobId);
    await rendering;
    const startedAt = Date.now();
    await expect(
      finalizationService.processJob(workflow.sealJobId),
    ).rejects.toMatchObject({ code: "JOB_IN_PROGRESS" });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(
      (
        await pool.query("select status from outbox_jobs where id=$1", [
          workflow.sealJobId,
        ])
      ).rows[0]?.status,
    ).toBe("PROCESSING");
    releaseRendering();
    const result = await firstRun;
    expect(result.reused).toBe(false);
    expect(
      (
        await pool.query(
          "select id from document_versions where document_id=$1 and state='SEALED'",
          [workflow.documentId],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await pool.query(
          "select id from audit_events where document_id=$1 and event_type='DOCUMENT_SEALED'",
          [workflow.documentId],
        )
      ).rows,
    ).toHaveLength(1);
  });

  it("leaves a storage failure retryable and creates only one final version on retry", async () => {
    const { pool } = await import("@/db/client");
    const workflow = await readyWithQueuedJob("storage-failure");
    const { FinalizationService, finalizationService } =
      await import("@/services/finalization");
    const { documentStorage } = await import("@/services/storage");
    const { pdfService } = await import("@/services/pdf");
    const { integrityService } = await import("@/services/integrity");
    const failedStorage = {
      put: async (bytes: Uint8Array, kind: "source" | "sealed") => {
        if (kind === "sealed") throw new Error("forced storage failure");
        return documentStorage.put(bytes, kind);
      },
      putSignature: (
        ...args: Parameters<typeof documentStorage.putSignature>
      ) => documentStorage.putSignature(...args),
      get: (...args: Parameters<typeof documentStorage.get>) =>
        documentStorage.get(...args),
      removeSource: (
        ...args: Parameters<typeof documentStorage.removeSource>
      ) => documentStorage.removeSource(...args),
      removeSealed: (
        ...args: Parameters<typeof documentStorage.removeSealed>
      ) => documentStorage.removeSealed(...args),
      removeSignature: (
        ...args: Parameters<typeof documentStorage.removeSignature>
      ) => documentStorage.removeSignature(...args),
    };
    const failingService = new FinalizationService({
      pool,
      storage: failedStorage,
      pdf: pdfService,
      integrity: integrityService,
    });
    await expect(failingService.processJob(workflow.sealJobId)).rejects.toThrow(
      "forced storage failure",
    );
    expect(
      (
        await pool.query("select status from documents where id=$1", [
          workflow.documentId,
        ])
      ).rows[0]?.status,
    ).toBe("PROCESSING");
    expect(
      (
        await pool.query("select status from outbox_jobs where id=$1", [
          workflow.sealJobId,
        ])
      ).rows[0]?.status,
    ).toBe("FAILED");
    await expect(
      finalizationService.processJob(workflow.sealJobId),
    ).resolves.toMatchObject({ reused: false });
    expect(
      (
        await pool.query(
          "select id from document_versions where document_id=$1 and state='SEALED'",
          [workflow.documentId],
        )
      ).rows,
    ).toHaveLength(1);
  });

  it("does not publish a final version when local manifest signing fails", async () => {
    const { pool } = await import("@/db/client");
    const workflow = await readyWithQueuedJob("manifest-failure");
    const { FinalizationService } = await import("@/services/finalization");
    const { documentStorage } = await import("@/services/storage");
    const { pdfService } = await import("@/services/pdf");
    const { integrityService } = await import("@/services/integrity");
    const failedIntegrity = {
      hash: (bytes: Uint8Array) => integrityService.hash(bytes),
      createManifest: () => {
        throw new Error("forced manifest signing failure");
      },
      verifyManifest: (
        ...args: Parameters<typeof integrityService.verifyManifest>
      ) => integrityService.verifyManifest(...args),
    };
    const service = new FinalizationService({
      pool,
      storage: documentStorage,
      pdf: pdfService,
      integrity: failedIntegrity,
    });
    await expect(service.processJob(workflow.sealJobId)).rejects.toThrow(
      "forced manifest signing failure",
    );
    expect(
      (
        await pool.query("select status from documents where id=$1", [
          workflow.documentId,
        ])
      ).rows[0]?.status,
    ).toBe("PROCESSING");
    expect(
      (
        await pool.query(
          "select id from document_versions where document_id=$1 and state='SEALED'",
          [workflow.documentId],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await pool.query(
          "select id from audit_events where document_id=$1 and event_type='DOCUMENT_SEALED'",
          [workflow.documentId],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await pool.query("select status from outbox_jobs where id=$1", [
          workflow.sealJobId,
        ])
      ).rows[0]?.status,
    ).toBe("FAILED");
  });

  it("retries a worker after storage readback is unavailable and publishes one final version", async () => {
    const { pool } = await import("@/db/client");
    const workflow = await readyWithQueuedJob("storage-readback-failure");
    const { FinalizationService, finalizationService } =
      await import("@/services/finalization");
    const { documentStorage } = await import("@/services/storage");
    const { pdfService } = await import("@/services/pdf");
    const { integrityService } = await import("@/services/integrity");
    let failedOnce = false;
    const flakyStorage = {
      put: (...args: Parameters<typeof documentStorage.put>) =>
        documentStorage.put(...args),
      putSignature: (
        ...args: Parameters<typeof documentStorage.putSignature>
      ) => documentStorage.putSignature(...args),
      get: async (key: string) => {
        if (key.startsWith("sealed/") && !failedOnce) {
          failedOnce = true;
          throw new Error("forced storage readback failure");
        }
        return documentStorage.get(key);
      },
      removeSource: (
        ...args: Parameters<typeof documentStorage.removeSource>
      ) => documentStorage.removeSource(...args),
      removeSealed: (
        ...args: Parameters<typeof documentStorage.removeSealed>
      ) => documentStorage.removeSealed(...args),
      removeSignature: (
        ...args: Parameters<typeof documentStorage.removeSignature>
      ) => documentStorage.removeSignature(...args),
    };
    const failingService = new FinalizationService({
      pool,
      storage: flakyStorage,
      pdf: pdfService,
      integrity: integrityService,
    });
    await expect(failingService.processJob(workflow.sealJobId)).rejects.toThrow(
      "forced storage readback failure",
    );
    expect(
      (
        await pool.query("select status from documents where id=$1", [
          workflow.documentId,
        ])
      ).rows[0]?.status,
    ).toBe("PROCESSING");
    expect(
      (
        await pool.query("select status from outbox_jobs where id=$1", [
          workflow.sealJobId,
        ])
      ).rows[0]?.status,
    ).toBe("FAILED");
    expect(
      (
        await pool.query(
          "select id from document_versions where document_id=$1 and state='SEALED'",
          [workflow.documentId],
        )
      ).rows,
    ).toHaveLength(0);
    await expect(
      finalizationService.processJob(workflow.sealJobId),
    ).resolves.toMatchObject({ reused: false });
    expect(
      (
        await pool.query(
          "select id from document_versions where document_id=$1 and state='SEALED'",
          [workflow.documentId],
        )
      ).rows,
    ).toHaveLength(1);
  });

  it("fails a PDF view when its required view audit event cannot be persisted", async () => {
    const { pool } = await import("@/db/client");
    const workflow = await prepare("view-audit-failure");
    await pool.query(
      `create function phase5_reject_view_audit() returns trigger language plpgsql as $$ begin if new.event_type='DOCUMENT_VIEWED' then raise exception 'forced view audit failure'; end if; return new; end $$`,
    );
    await pool.query(
      "create trigger phase5_reject_view_audit before insert on audit_events for each row execute function phase5_reject_view_audit()",
    );
    try {
      cookieState.value = workflow.users[0]!.cookie;
      const response = await requestRoute(
        "GET",
        `/api/documents/${workflow.documentId}/source`,
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(
        (
          await pool.query(
            "select id from document_views where document_id=$1",
            [workflow.documentId],
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await pool.query(
            "select id from audit_events where document_id=$1 and event_type='DOCUMENT_VIEWED'",
            [workflow.documentId],
          )
        ).rows,
      ).toHaveLength(0);
    } finally {
      await pool.query(
        "drop trigger if exists phase5_reject_view_audit on audit_events",
      );
      await pool.query("drop function if exists phase5_reject_view_audit()");
    }
  });

  it("rejects audit history whose persisted chain has been altered", async () => {
    const { pool } = await import("@/db/client");
    const workflow = await completedWorkflow("audit-chain-tamper");
    try {
      await pool.query(
        "alter table audit_events disable trigger audit_events_append_only",
      );
      await pool.query(
        "update audit_events set details=details || '{\"tampered\":true}'::jsonb where document_id=$1 and sequence=1",
        [workflow.documentId],
      );
    } finally {
      await pool.query(
        "alter table audit_events enable trigger audit_events_append_only",
      );
    }
    cookieState.value = workflow.owner.cookie;
    const response = await requestRoute(
      "GET",
      `/api/documents/${workflow.documentId}/audit-events`,
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("AUDIT_INTEGRITY_FAILED");
  });

  it("preserves evidence and fails the document when stored final bytes mismatch", async () => {
    const { pool } = await import("@/db/client");
    const workflow = await readyWithQueuedJob("storage-mismatch");
    const { FinalizationService } = await import("@/services/finalization");
    const { documentStorage } = await import("@/services/storage");
    const { pdfService } = await import("@/services/pdf");
    const { integrityService } = await import("@/services/integrity");
    const storage = {
      put: (...args: Parameters<typeof documentStorage.put>) =>
        documentStorage.put(...args),
      putSignature: (
        ...args: Parameters<typeof documentStorage.putSignature>
      ) => documentStorage.putSignature(...args),
      get: async (key: string) => {
        const bytes = await documentStorage.get(key);
        if (key.startsWith("sealed/")) bytes[bytes.length - 1] ^= 1;
        return bytes;
      },
      removeSource: (
        ...args: Parameters<typeof documentStorage.removeSource>
      ) => documentStorage.removeSource(...args),
      removeSealed: (
        ...args: Parameters<typeof documentStorage.removeSealed>
      ) => documentStorage.removeSealed(...args),
      removeSignature: (
        ...args: Parameters<typeof documentStorage.removeSignature>
      ) => documentStorage.removeSignature(...args),
    };
    const service = new FinalizationService({
      pool,
      storage,
      pdf: pdfService,
      integrity: integrityService,
    });
    await expect(service.processJob(workflow.sealJobId)).rejects.toMatchObject({
      code: "FINAL_INTEGRITY_FAILED",
    });
    expect(
      (
        await pool.query("select status from documents where id=$1", [
          workflow.documentId,
        ])
      ).rows[0]?.status,
    ).toBe("INTEGRITY_FAILED");
    const event = await pool.query<{
      details: {
        artifactKey?: string;
        generatedSha256?: string;
        storedSha256?: string;
      };
    }>(
      "select details from audit_events where document_id=$1 and event_type='INTEGRITY_FAILED'",
      [workflow.documentId],
    );
    expect(event.rows[0]?.details.artifactKey).toMatch(/^sealed\//);
    expect(event.rows[0]?.details.generatedSha256).not.toBe(
      event.rows[0]?.details.storedSha256,
    );
    expect(
      (
        await pool.query(
          "select id from document_versions where document_id=$1 and state='SEALED'",
          [workflow.documentId],
        )
      ).rows,
    ).toHaveLength(0);
    const evidenceBytes = await documentStorage.get(
      event.rows[0]!.details.artifactKey!,
    );
    expect(evidenceBytes.byteLength).toBeGreaterThan(0);
  });

  it("rolls publication back when DOCUMENT_SEALED audit persistence fails", async () => {
    const { pool } = await import("@/db/client");
    const workflow = await readyWithQueuedJob("audit-failure");
    await pool.query(
      `create function phase4_reject_seal_audit() returns trigger language plpgsql as $$ begin if new.event_type='DOCUMENT_SEALED' then raise exception 'forced seal audit failure'; end if; return new; end $$`,
    );
    await pool.query(
      "create trigger phase4_reject_seal_audit before insert on audit_events for each row execute function phase4_reject_seal_audit()",
    );
    const { documentStorage } = await import("@/services/storage");
    const originalPut = documentStorage.put.bind(documentStorage);
    let finalKey: string | undefined;
    const putSpy = vi
      .spyOn(documentStorage, "put")
      .mockImplementation(async (bytes, kind) => {
        const key = await originalPut(bytes, kind);
        if (kind === "sealed") finalKey = key;
        return key;
      });
    try {
      const { finalizationService } = await import("@/services/finalization");
      await expect(
        finalizationService.processJob(workflow.sealJobId),
      ).rejects.toThrow(/forced seal audit failure/i);
      expect(
        (
          await pool.query(
            "select status,current_version_id,completed_at from documents where id=$1",
            [workflow.documentId],
          )
        ).rows[0],
      ).toMatchObject({ status: "PROCESSING", completed_at: null });
      expect(
        (
          await pool.query(
            "select id from document_versions where document_id=$1 and state='SEALED'",
            [workflow.documentId],
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await pool.query(
            "select id from audit_events where document_id=$1 and event_type='DOCUMENT_SEALED'",
            [workflow.documentId],
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await pool.query("select status from outbox_jobs where id=$1", [
            workflow.sealJobId,
          ])
        ).rows[0]?.status,
      ).toBe("FAILED");
    } finally {
      putSpy.mockRestore();
      await pool.query(
        "drop trigger if exists phase4_reject_seal_audit on audit_events",
      );
      await pool.query("drop function if exists phase4_reject_seal_audit()");
    }
    expect(finalKey).toMatch(/^sealed\//);
    await expect(documentStorage.get(finalKey!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
