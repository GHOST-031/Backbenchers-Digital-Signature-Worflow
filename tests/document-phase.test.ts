import { describe, expect, it, vi } from "vitest";
import {
  fieldsInputSchema,
  quantizeFieldGeometry,
  readinessIssues,
  signerAssignmentSchema,
  validateFieldPlacement,
} from "@/services/document-input";
import { makePdf } from "./pdf-fixture";

const signerIds = {
  student: "11111111-1111-4111-8111-111111111111",
  advisor: "22222222-2222-4222-8222-222222222222",
  hod: "33333333-3333-4333-8333-333333333333",
};

describe("document workflow validation", () => {
  it("renders persisted typed signature values into the source PDF without changing page dimensions", async () => {
    const { LocalPdfService } = await import("@/services/pdf");
    const { PDFDocument } = await import("pdf-lib");
    const source = makePdf(1);
    const service = new LocalPdfService();
    const rendered = await service.renderSignatures(source, [
      {
        pageNumber: 1,
        x: 0.1,
        y: 0.7,
        width: 0.4,
        height: 0.08,
        method: "TYPED",
        value: "Ada Example",
        image: null,
      },
      {
        pageNumber: 1,
        x: 0.55,
        y: 0.7,
        width: 0.3,
        height: 0.08,
        method: "DRAWN",
        value: null,
        image: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
          "base64",
        ),
      },
    ]);
    expect(Buffer.from(rendered).equals(Buffer.from(source))).toBe(false);
    const [before, after] = await Promise.all([
      PDFDocument.load(source),
      PDFDocument.load(rendered),
    ]);
    expect(after.getPages()[0]?.getSize()).toEqual(
      before.getPages()[0]?.getSize(),
    );
    expect((await service.validate(rendered)).pageCount).toBe(1);
    const sealed = await service.seal(rendered);
    const sealedPdf = await PDFDocument.load(sealed);
    expect(sealedPdf.getSubject()).toContain("no PDF certificate signature");
  });

  it("accepts exactly the fixed signer order and rejects missing, reordered, or reused users", () => {
    const valid = [
      { sequence: 1, role: "STUDENT", email: "student@example.test" },
      { sequence: 2, role: "FACULTY_ADVISOR", email: "advisor@example.test" },
      { sequence: 3, role: "HOD", email: "hod@example.test" },
    ];
    expect(signerAssignmentSchema.safeParse(valid).success).toBe(true);
    expect(signerAssignmentSchema.safeParse(valid.slice(0, 2)).success).toBe(
      false,
    );
    expect(
      signerAssignmentSchema.safeParse([valid[1], valid[0], valid[2]]).success,
    ).toBe(false);
    expect(
      signerAssignmentSchema.safeParse([
        valid[0],
        valid[1],
        { ...valid[2], email: "STUDENT@example.test" },
      ]).success,
    ).toBe(false);
  });

  it("rejects malformed field data and validates page, signer, and normalized bounds", () => {
    const field = {
      signerId: signerIds.student,
      pageNumber: 1,
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.1,
      fieldType: "SIGNATURE" as const,
      required: true,
    };
    expect(fieldsInputSchema.safeParse({ fields: [field] }).success).toBe(true);
    expect(
      validateFieldPlacement(field, 2, new Set([signerIds.student])),
    ).toBeNull();
    expect(
      validateFieldPlacement(
        { ...field, pageNumber: 3 },
        2,
        new Set([signerIds.student]),
      ),
    ).toMatch(/Page/);
    expect(
      validateFieldPlacement(
        { ...field, signerId: signerIds.hod },
        2,
        new Set([signerIds.student]),
      ),
    ).toMatch(/Signer/);
    expect(
      validateFieldPlacement(
        { ...field, x: 0.8 },
        2,
        new Set([signerIds.student]),
      ),
    ).toMatch(/geometry/);
    expect(
      validateFieldPlacement(
        { ...field, width: 0 },
        2,
        new Set([signerIds.student]),
      ),
    ).toMatch(/geometry/);
    expect(
      fieldsInputSchema.safeParse({ fields: [{ ...field, pageNumber: 0 }] })
        .success,
    ).toBe(false);
    expect(
      fieldsInputSchema.safeParse({ fields: [{ ...field, height: -0.1 }] })
        .success,
    ).toBe(false);
    expect(quantizeFieldGeometry({ ...field, x: 0.123456789 }).x).toBe(
      0.1234568,
    );
  });

  it("reports readiness until every ordered signer has a required field", () => {
    const signers = [
      { id: signerIds.student, sequence: 1, role: "STUDENT" },
      { id: signerIds.advisor, sequence: 2, role: "FACULTY_ADVISOR" },
      { id: signerIds.hod, sequence: 3, role: "HOD" },
    ];
    expect(
      readinessIssues({
        hasSourcePdf: true,
        signers,
        requiredFieldSignerIds: Object.values(signerIds),
      }),
    ).toEqual([]);
    expect(
      readinessIssues({
        hasSourcePdf: false,
        signers: signers.slice(0, 2),
        requiredFieldSignerIds: [signerIds.student],
      }),
    ).toHaveLength(3);
  });

  it("uses the real source PDF bytes as its stored digest input", async () => {
    const { createHash } = await import("node:crypto");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { FilesystemDocumentStorage } = await import("@/services/storage");
    const root = await mkdtemp(path.join(os.tmpdir(), "phase2-source-"));
    try {
      const storage = new FilesystemDocumentStorage(root);
      const original = makePdf(2);
      const key = await storage.put(original, "source");
      const stored = await storage.get(key);
      expect(createHash("sha256").update(stored).digest("hex")).toBe(
        createHash("sha256").update(original).digest("hex"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not report success when required audit persistence fails", async () => {
    const { appendAuditEventInTransaction, ChainedAuditService } =
      await import("@/services/audit");
    const { generateKeyPairSync, sign, verify } = await import("node:crypto");
    const pair = generateKeyPairSync("ed25519");
    const service = new ChainedAuditService({
      keyVersion: "test-key",
      signAudit: (bytes) => sign(null, bytes, pair.privateKey),
      verifyAudit: (bytes, signature) =>
        verify(null, bytes, pair.publicKey, signature),
    });
    const client = {
      query: async (sql: string) => {
        if (sql.startsWith("select audit_next_sequence"))
          return {
            rows: [
              { audit_next_sequence: "1", audit_head_hash: Buffer.alloc(32) },
            ],
          };
        if (sql.startsWith("select clock_timestamp"))
          return { rows: [{ occurred_at: new Date("2026-01-01T00:00:00Z") }] };
        if (sql.startsWith("insert into audit_events"))
          throw new Error("audit storage unavailable");
        return { rows: [] };
      },
    } as never;
    await expect(
      appendAuditEventInTransaction(
        client,
        {
          documentId: "44444444-4444-4444-8444-444444444444",
          actorType: "SYSTEM",
          eventType: "DOCUMENT_CREATED",
          details: {},
        },
        service,
      ),
    ).rejects.toThrow("audit storage unavailable");
  });

  it("rejects unauthenticated uploads and invalid, oversized, or over-page PDFs before persistence", async () => {
    const { cookieState, requestRoute } =
      await import("./document-route-test-helpers");
    cookieState.value = "";
    const unauthenticated = await requestRoute("POST", "/api/documents");
    expect(unauthenticated.status).toBe(401);

    const { authenticationService } = await import("@/services/auth");
    cookieState.value = authenticationService.issueSession({
      userId: "55555555-5555-4555-8555-555555555555",
      email: "requester@example.test",
      displayName: "Requester",
    });
    const input = { title: "Test request", letterType: "OD" };
    const invalid = await requestRoute("POST", "/api/documents", {
      fields: input,
      file: Buffer.from("not a PDF"),
    });
    expect(invalid.status).toBe(415);
    const tooLarge = await requestRoute("POST", "/api/documents", {
      fields: input,
      file: new Uint8Array(10 * 1024 * 1024 + 1),
    });
    expect(tooLarge.status).toBe(413);
    const tooManyPages = await requestRoute("POST", "/api/documents", {
      fields: input,
      file: makePdf(51),
    });
    expect(tooManyPages.status).toBe(422);
  });

  it("accepts valid PDFs at the configured 50-page and near-10-MB boundaries", async () => {
    const { pdfService, MAX_PDF_BYTES } = await import("@/services/pdf");
    const pageLimit = await pdfService.validate(makePdf(50));
    expect(pageLimit.pageCount).toBe(50);

    const base = Buffer.from(makePdf(1));
    const nearByteLimit = Buffer.concat([
      base,
      Buffer.alloc(MAX_PDF_BYTES - base.byteLength - 1, 0x20),
    ]);
    expect(nearByteLimit.byteLength).toBe(MAX_PDF_BYTES - 1);
    expect((await pdfService.validate(nearByteLimit)).pageCount).toBe(1);
  });
});

describe.skipIf(!process.env.FOUNDATION_DB_TEST)(
  "document workflow with PostgreSQL",
  () => {
    it("removes a private source upload when storage readback fails before database publication", async () => {
      const { cookieState, createUser, requestRoute } =
        await import("./document-route-test-helpers");
      const { documentStorage } = await import("@/services/storage");
      const owner = await createUser("source-readback-failure");
      cookieState.value = owner.cookie;
      let sourceKey: string | undefined;
      const originalPut = documentStorage.put.bind(documentStorage);
      const put = vi
        .spyOn(documentStorage, "put")
        .mockImplementation(async (bytes, kind) => {
          const key = await originalPut(bytes, kind);
          sourceKey = key;
          return key;
        });
      const get = vi
        .spyOn(documentStorage, "get")
        .mockRejectedValueOnce(new Error("private storage path failure"));
      try {
        const response = await requestRoute("POST", "/api/documents", {
          fields: { title: "Readback error", letterType: "OD" },
          file: makePdf(1),
        });
        expect(response.status).toBe(503);
        const body = await response.text();
        expect(body).not.toContain("private storage path");
        expect(body).not.toContain("/private/");
        expect(sourceKey).toMatch(/^source\//);
      } finally {
        get.mockRestore();
        put.mockRestore();
      }
      await expect(documentStorage.get(sourceKey!)).rejects.toThrow();
      const { pool } = await import("@/db/client");
      expect(
        (
          await pool.query(
            "select id from documents where owner_user_id=$1 and title='Readback error'",
            [owner.userId],
          )
        ).rows,
      ).toHaveLength(0);
    });

    it("creates a private PDF version, assigns fixed-order users, and round-trips fields/audit", async () => {
      const { cookieState, createUser, requestRoute } =
        await import("./document-route-test-helpers");
      const owner = await createUser("owner");
      const student = await createUser("student");
      const advisor = await createUser("advisor");
      const hod = await createUser("hod");
      cookieState.value = owner.cookie;
      const { makePdf } = await import("./pdf-fixture");
      const validResponse = await requestRoute("POST", "/api/documents", {
        fields: { title: "Conference OD", letterType: "OD" },
        file: makePdf(1),
      });
      expect(validResponse.status).toBe(201);
      const created = await validResponse.json();
      const { pool } = await import("@/db/client");
      const version = await pool.query(
        "select v.*,d.owner_user_id from document_versions v join documents d on d.id=v.document_id where v.id=$1",
        [created.initialVersionId],
      );
      const row = version.rows[0];
      const { documentStorage } = await import("@/services/storage");
      const bytes = await documentStorage.get(row.object_key);
      const { createHash } = await import("node:crypto");
      expect(createHash("sha256").update(bytes).digest()).toEqual(row.sha256);
      expect(row.state).toBe("SOURCE");
      expect(row.owner_user_id).toBe(owner.userId);

      const incomplete = await requestRoute(
        "PUT",
        `/api/documents/${created.documentId}/signers`,
        {
          json: {
            signers: [{ sequence: 1, role: "STUDENT", email: student.email }],
          },
        },
      );
      expect(incomplete.status).toBe(422);
      const assigned = await requestRoute(
        "PUT",
        `/api/documents/${created.documentId}/signers`,
        {
          json: {
            signers: [
              { sequence: 1, role: "STUDENT", email: student.email },
              { sequence: 2, role: "FACULTY_ADVISOR", email: advisor.email },
              { sequence: 3, role: "HOD", email: hod.email },
            ],
          },
        },
      );
      expect(assigned.status).toBe(200);
      const signerRows = (await assigned.json()).signers;
      expect(
        signerRows.map(
          (signer: { role: string; sequence: number; status: string }) => [
            signer.sequence,
            signer.role,
            signer.status,
          ],
        ),
      ).toEqual([
        [1, "STUDENT", "PENDING"],
        [2, "FACULTY_ADVISOR", "PENDING"],
        [3, "HOD", "PENDING"],
      ]);
      const badField = await requestRoute(
        "PUT",
        `/api/documents/${created.documentId}/fields`,
        {
          json: {
            fields: [
              {
                signerId: signerRows[0].id,
                pageNumber: 2,
                x: 0,
                y: 0,
                width: 0.2,
                height: 0.1,
                fieldType: "SIGNATURE",
                required: true,
              },
            ],
          },
        },
      );
      expect(badField.status).toBe(422);
      const fieldResponse = await requestRoute(
        "PUT",
        `/api/documents/${created.documentId}/fields`,
        {
          json: {
            fields: [
              {
                signerId: signerRows[0].id,
                pageNumber: 1,
                x: 0.1,
                y: 0.2,
                width: 0.2,
                height: 0.1,
                fieldType: "SIGNATURE",
                required: true,
              },
            ],
          },
        },
      );
      expect(fieldResponse.status).toBe(200);
      const createdField = (await fieldResponse.json()).fields[0];
      const detailResponse = await requestRoute(
        "GET",
        `/api/documents/${created.documentId}`,
      );
      const details = (await detailResponse.json()).document;
      expect(details.fields[0]).toMatchObject({
        id: createdField.id,
        signer_id: signerRows[0].id,
        x: "0.1000000",
        y: "0.2000000",
      });
      const audit = await pool.query(
        "select event_type from audit_events where document_id=$1 order by sequence",
        [created.documentId],
      );
      expect(audit.rows.map(({ event_type }) => event_type)).toEqual([
        "DOCUMENT_CREATED",
        "SIGNERS_ASSIGNED",
        "SIGNATURE_FIELD_CREATED",
      ]);

      cookieState.value = advisor.cookie;
      const forbidden = await requestRoute(
        "PUT",
        `/api/documents/${created.documentId}/fields`,
        {
          json: { fields: [] },
        },
      );
      expect(forbidden.status).toBe(403);
    });
  },
);
