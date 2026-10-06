import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  userIds: ["student-user", "advisor-user", "hod-user"],
  signerIds: ["student-signer", "advisor-signer", "hod-signer"],
  documentId: "document-1",
  fieldIds: ["student-field", "advisor-field", "hod-field"],
  status: "PENDING" as string,
  signers: [] as Array<Record<string, unknown>>,
  fields: [] as Array<Record<string, unknown>>,
  signatures: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  failSignatureAudit: false,
}));

vi.mock("@/db/client", () => ({
  db: {},
  pool: {
    query: async (sql: string) => {
      const q = sql.toLowerCase().replaceAll(/\s+/g, " ").trim();
      if (q.startsWith("select 1 from revoked_sessions")) return { rows: [] };
      if (q.startsWith("insert into revoked_sessions")) return { rows: [] };
      throw new Error(`Unexpected pool query in signing test: ${q}`);
    },
    connect: async () => {
      const state = fixture;
      const snapshot = () =>
        structuredClone({
          status: state.status,
          signers: state.signers,
          signatures: state.signatures,
          audits: state.audits,
        });
      let before = snapshot();
      return {
        query: async (sql: string, values: unknown[] = []) => {
          const q = sql.toLowerCase().replaceAll(/\s+/g, " ").trim();
          if (q === "begin") {
            before = snapshot();
            return { rows: [] };
          }
          if (q === "commit") return { rows: [] };
          if (q === "rollback") {
            state.status = before.status;
            state.signers = before.signers;
            state.signatures = before.signatures;
            state.audits = before.audits;
            return { rows: [] };
          }
          if (q.startsWith("select status, owner_user_id from documents"))
            return { rows: [{ status: state.status, owner_user_id: "owner" }] };
          if (
            q.startsWith("select id,user_id,sequence,role,status from signers")
          )
            return { rows: structuredClone(state.signers) };
          if (
            q.startsWith("select id,field_type,required from signature_fields")
          ) {
            const row = state.fields.find(
              (field) =>
                field.id === values[0] &&
                field.document_id === values[1] &&
                field.assigned_signer_id === values[2],
            );
            return { rows: row ? [structuredClone(row)] : [] };
          }
          if (
            q.startsWith(
              "select id,field_id,request_id,method,value,image_object_key,signed_at from signatures",
            )
          )
            return {
              rows: structuredClone(
                state.signatures.filter(
                  (signature) =>
                    signature.signer_id === values[0] &&
                    signature.request_id === values[1],
                ),
              ),
            };
          if (q.startsWith("select id from signatures where field_id="))
            return {
              rows: structuredClone(
                state.signatures.filter(
                  (signature) => signature.field_id === values[0],
                ),
              ),
            };
          if (q.startsWith("insert into signatures")) {
            state.signatures.push({
              id: values[0],
              document_id: values[1],
              field_id: values[2],
              signer_id: values[3],
              method: values[4],
              value: values[5],
              image_object_key: values[6],
              request_id: values[7],
              signed_at: new Date("2026-10-06T00:00:00Z"),
            });
            return { rows: [] };
          }
          if (q.startsWith("select signed_at from signatures"))
            return { rows: [{ signed_at: new Date("2026-10-06T00:00:00Z") }] };
          if (q.startsWith("select audit_next_sequence, audit_head_hash"))
            return {
              rows: [
                {
                  audit_next_sequence: String(state.audits.length + 1),
                  audit_head_hash: Buffer.alloc(32),
                },
              ],
            };
          if (q.startsWith("select clock_timestamp() as occurred_at"))
            return {
              rows: [{ occurred_at: new Date("2026-10-06T00:00:00Z") }],
            };
          if (q.startsWith("insert into audit_events")) {
            if (state.failSignatureAudit && values[3] === "FIELD_SIGNED")
              throw new Error("audit persistence unavailable");
            state.audits.push({
              event_type: values[3],
              signature_id: values[8],
              details: values[10],
            });
            return { rows: [] };
          }
          if (q.startsWith("update documents set audit_next_sequence"))
            return { rows: [] };
          if (q.startsWith("select f.id from signature_fields"))
            return {
              rows: state.fields
                .filter(
                  (field) =>
                    field.assigned_signer_id === values[1] &&
                    field.required &&
                    !state.signatures.some(
                      (signature) => signature.field_id === field.id,
                    ),
                )
                .map((field) => ({ id: field.id })),
            };
          if (q.startsWith("select details from audit_events"))
            return { rows: [] };
          if (q.startsWith("select id from audit_events")) return { rows: [] };
          if (q.startsWith("update signers set status='signed'")) {
            const signer = state.signers.find((item) => item.id === values[0]);
            if (signer) {
              signer.status = "SIGNED";
              signer.signed_at = new Date("2026-10-06T00:00:00Z");
            }
            return { rows: [] };
          }
          if (q.startsWith("update signers set status='active'")) {
            const signer = state.signers.find((item) => item.id === values[0]);
            if (signer) signer.status = "ACTIVE";
            return { rows: [] };
          }
          if (q.startsWith("update documents set status='processing'")) {
            state.status = "PROCESSING";
            return { rows: [] };
          }
          if (q.startsWith("insert into outbox_jobs(type,payload)"))
            return { rows: [{ id: "seal-job" }] };
          throw new Error(`Unexpected SQL in signing test: ${q}`);
        },
        release: () => undefined,
      };
    },
  },
}));
vi.mock("@/services/finalization", () => ({
  finalizationService: {
    processJob: async () => ({ versionId: "final-version", reused: false }),
  },
  FinalizationError: class FinalizationError extends Error {},
}));

import { cookieState } from "./document-route-test-helpers";

const roles = ["STUDENT", "FACULTY_ADVISOR", "HOD"] as const;
function reset() {
  fixture.status = "PENDING";
  fixture.signers = roles.map((role, index) => ({
    id: fixture.signerIds[index],
    document_id: fixture.documentId,
    user_id: fixture.userIds[index],
    sequence: index + 1,
    role,
    status: index === 0 ? "ACTIVE" : "PENDING",
  }));
  fixture.fields = fixture.fieldIds.map((id, index) => ({
    id,
    document_id: fixture.documentId,
    assigned_signer_id: fixture.signerIds[index],
    field_type: "SIGNATURE",
    required: true,
  }));
  fixture.signatures = [];
  fixture.audits = [];
  fixture.failSignatureAudit = false;
}

async function directSign(userId: string, fieldId: string) {
  const { authenticationService } = await import("@/services/auth");
  const { NextRequest } = await import("next/server");
  const { PUT } =
    await import("@/app/api/sign/[documentId]/fields/[fieldId]/route");
  cookieState.value = authenticationService.issueSession({
    userId,
    email: `${userId}@example.test`,
    displayName: userId,
  });
  const request = new NextRequest(
    "http://localhost/api/sign/document-1/fields/field",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        method: "TYPED",
        value: "A Student",
      }),
    },
  );
  return PUT(request, {
    params: Promise.resolve({ documentId: fixture.documentId, fieldId }),
  });
}

async function directComplete(userId: string) {
  const { authenticationService } = await import("@/services/auth");
  const { NextRequest } = await import("next/server");
  const { POST } = await import("@/app/api/sign/[documentId]/complete/route");
  cookieState.value = authenticationService.issueSession({
    userId,
    email: `${userId}@example.test`,
    displayName: userId,
  });
  const request = new NextRequest(
    "http://localhost/api/sign/document-1/complete",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID() }),
    },
  );
  return POST(request, {
    params: Promise.resolve({ documentId: fixture.documentId }),
  });
}

describe("server-side sequential signing mutation", () => {
  beforeEach(reset);

  it("allows the current Student and persists signature plus audit", async () => {
    const response = await directSign(
      fixture.userIds[0]!,
      fixture.fieldIds[0]!,
    );
    expect(response.status).toBe(200);
    expect(fixture.signatures).toHaveLength(1);
    expect(fixture.signatures[0]?.signer_id).toBe(fixture.signerIds[0]);
    expect(fixture.audits.map((event) => event.event_type)).toContain(
      "FIELD_SIGNED",
    );
    expect(fixture.signers[1]?.status).toBe("PENDING");
  });

  it.each([1, 2])(
    "rejects signer sequence %i when called directly before prior completion",
    async (index) => {
      const response = await directSign(
        fixture.userIds[index]!,
        fixture.fieldIds[index]!,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "OUT_OF_TURN" },
      });
      expect(fixture.signatures).toHaveLength(0);
      expect(fixture.audits).toHaveLength(0);
      expect(fixture.signers[index]?.status).toBe("PENDING");
    },
  );

  it("keeps Advisor blocked after Student signs but before Student completes", async () => {
    expect(
      (await directSign(fixture.userIds[0]!, fixture.fieldIds[0]!)).status,
    ).toBe(200);
    const advisorAttempt = await directSign(
      fixture.userIds[1]!,
      fixture.fieldIds[1]!,
    );
    expect(advisorAttempt.status).toBe(409);
    expect(await advisorAttempt.json()).toMatchObject({
      error: { code: "OUT_OF_TURN" },
    });
    expect(fixture.signatures).toHaveLength(1);
    expect(fixture.signatures[0]?.signer_id).toBe(fixture.signerIds[0]);
    expect(fixture.signers[1]?.status).toBe("PENDING");
    expect(
      fixture.audits.filter((event) => event.event_type === "FIELD_SIGNED"),
    ).toHaveLength(1);
  });

  it("rolls signature state back when the required audit insert fails", async () => {
    fixture.failSignatureAudit = true;
    const response = await directSign(
      fixture.userIds[0]!,
      fixture.fieldIds[0]!,
    );
    expect(response.status).toBe(503);
    expect(fixture.signatures).toHaveLength(0);
    expect(fixture.audits).toHaveLength(0);
    expect(fixture.signers[0]?.status).toBe("ACTIVE");
  });

  it("does not complete or advance when a required field is missing", async () => {
    const response = await directComplete(fixture.userIds[0]!);
    expect(response.status).toBe(422);
    expect(fixture.signers[0]?.status).toBe("ACTIVE");
    expect(fixture.signers[1]?.status).toBe("PENDING");
    expect(fixture.audits).toHaveLength(0);
  });

  it("does not let an unsupported required field bypass signer completion", async () => {
    expect(
      (await directSign(fixture.userIds[0]!, fixture.fieldIds[0]!)).status,
    ).toBe(200);
    fixture.fields.push({
      id: "student-required-text",
      document_id: fixture.documentId,
      assigned_signer_id: fixture.signerIds[0],
      field_type: "TEXT",
      required: true,
    });
    const response = await directComplete(fixture.userIds[0]!);
    expect(response.status).toBe(422);
    expect(fixture.signers[0]?.status).toBe("ACTIVE");
    expect(fixture.signers[1]?.status).toBe("PENDING");
  });

  it("activates each next signer only after current completion and leaves HoD ready for sealing", async () => {
    for (let index = 0; index < 3; index++) {
      expect(fixture.signers[index]?.status).toBe("ACTIVE");
      const signed = await directSign(
        fixture.userIds[index]!,
        fixture.fieldIds[index]!,
      );
      expect(signed.status).toBe(200);
      const completed = await directComplete(fixture.userIds[index]!);
      expect(completed.status).toBe(200);
      if (index < 2) expect(fixture.signers[index + 1]?.status).toBe("ACTIVE");
    }
    expect(fixture.signers.map((signer) => signer.status)).toEqual([
      "SIGNED",
      "SIGNED",
      "SIGNED",
    ]);
    expect(
      fixture.signers.every((signer) => signer.signed_at instanceof Date),
    ).toBe(true);
    expect(fixture.status).toBe("PROCESSING");
    expect(
      fixture.audits.filter((event) => event.event_type === "FIELD_SIGNED"),
    ).toHaveLength(3);
    expect(
      fixture.audits.filter(
        (event) => event.event_type === "DOCUMENT_RECIPIENT_COMPLETED",
      ),
    ).toHaveLength(3);
  });
});
