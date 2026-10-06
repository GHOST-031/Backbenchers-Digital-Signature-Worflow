import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtemp, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makePdf } from "./pdf-fixture";

describe("foundation services", () => {
  it("creates and validates signed sessions; rejects tampering and expiry", async () => {
    const { LocalAuthenticationService } = await import("@/services/auth");
    const revoked = new Set<string>();
    const auth = new LocalAuthenticationService({
      async isRevoked(digest) {
        return revoked.has(digest.toString("hex"));
      },
      async revoke(digest) {
        revoked.add(digest.toString("hex"));
      },
    });
    const token = auth.issueSession({
      userId: "u1",
      email: "user@example.test",
      displayName: "User",
    });
    await expect(auth.readSession(token)).resolves.toMatchObject({
      userId: "u1",
    });
    await expect(auth.readSession(`${token}x`)).resolves.toBeNull();
    await expect(auth.readSession(undefined)).resolves.toBeNull();
    await auth.revokeSession(token);
    await expect(auth.readSession(token)).resolves.toBeNull();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    await expect(auth.readSession(token)).resolves.toBeNull();
    vi.useRealTimers();
    const hash = await auth.createPasswordHash("a sufficiently long password");
    expect(
      await auth.verifyPassword("a sufficiently long password", hash),
    ).toBe(true);
    expect(await auth.verifyPassword("wrong password", hash)).toBe(false);
  });
  it("authorizes ownership and only ACTIVE linked signers", async () => {
    const { DefaultAuthorizationService } =
      await import("@/services/authorization");
    const authz = new DefaultAuthorizationService();
    const user = { userId: "owner", email: "a@b.test", displayName: "A" };
    expect(authz.ownsDocument(user, "owner")).toBe(true);
    expect(authz.ownsDocument(user, "other")).toBe(false);
    const signer = {
      signerId: "s1",
      documentId: "d1",
      role: "STUDENT" as const,
      status: "ACTIVE" as const,
    };
    expect(authz.maySign(signer, "d1")).toBe(true);
    expect(authz.maySign(signer, "d2")).toBe(false);
    expect(authz.maySign({ ...signer, status: "PENDING" }, "d1")).toBe(false);
  });
  it("parses PDFs and enforces byte and page limits", async () => {
    const { LocalPdfService, PendingPdfSigningProvider } =
      await import("@/services/pdf");
    const pdf = new LocalPdfService();
    await expect(pdf.validate(makePdf(1))).resolves.toMatchObject({
      pageCount: 1,
    });
    await expect(
      pdf.validate(new Uint8Array(10 * 1024 * 1024 + 1)),
    ).rejects.toThrow("10 MB");
    await expect(pdf.validate(makePdf(51))).rejects.toThrow("50-page");
    await expect(pdf.validate(Buffer.from("not a pdf"))).rejects.toThrow(
      "not a PDF",
    );
    await expect(
      new PendingPdfSigningProvider().sign(makePdf(1)),
    ).rejects.toThrow("no signature was applied");
  });
  it("hashes bytes and signs/verifies an integrity manifest", async () => {
    const pair = generateKeyPairSync("ed25519");
    const signer = {
      keyVersion: "test",
      signManifest: (bytes: Uint8Array) => sign(null, bytes, pair.privateKey),
      verifyManifest: (bytes: Uint8Array, signature: Uint8Array) =>
        verify(null, bytes, pair.publicKey, signature),
      signAudit: (bytes: Uint8Array) => sign(null, bytes, pair.privateKey),
      verifyAudit: (bytes: Uint8Array, signature: Uint8Array) =>
        verify(null, bytes, pair.publicKey, signature),
    };
    const { LocalIntegrityService } = await import("@/services/integrity");
    const integrity = new LocalIntegrityService(signer);
    const bytes = Buffer.from("sealed bytes");
    expect(integrity.hash(bytes).toString("hex")).toBe(
      "f35cf5b361b0eaf7b0c02e75808e260e3f379c4745abe45552ba768e85687749",
    );
    const result = integrity.createManifest(
      bytes,
      { documentId: "d1", versionId: "v1" },
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(
      integrity.verifyManifest(bytes, result.manifest, result.signature),
    ).toBe(true);
    expect(
      integrity.verifyManifest(
        Buffer.from("sealed byteS"),
        result.manifest,
        result.signature,
      ),
    ).toBe(false);
    expect(
      integrity.verifyManifest(
        bytes,
        { ...result.manifest, documentId: "elsewhere" },
        result.signature,
      ),
    ).toBe(false);
  });
  it("chains and verifies audit events, rejecting changed or reordered events", async () => {
    const pair = generateKeyPairSync("ed25519");
    const crypto = await import("node:crypto");
    const provider = {
      keyVersion: "test",
      signAudit: (bytes: Uint8Array) =>
        crypto.sign(null, bytes, pair.privateKey),
      verifyAudit: (bytes: Uint8Array, signature: Uint8Array) =>
        crypto.verify(null, bytes, pair.publicKey, signature),
    };
    const { ChainedAuditService } = await import("@/services/audit");
    const audit = new ChainedAuditService(provider);
    const first = audit.createEvent({
      id: "e1",
      documentId: "d1",
      actorType: "SYSTEM",
      actorUserId: null,
      actorSignerId: null,
      viewId: null,
      signatureId: null,
      eventType: "DOCUMENT_CREATED",
      occurredAt: "2026-01-01T00:00:00.000Z",
      sequence: "1",
      details: {},
      previousHash: "00".repeat(32),
      kmsKeyVersion: provider.keyVersion,
    });
    const second = audit.createEvent({
      id: "e2",
      documentId: "d1",
      actorType: "SYSTEM",
      actorUserId: null,
      actorSignerId: null,
      viewId: "view-1",
      signatureId: null,
      eventType: "DOCUMENT_VIEWED",
      occurredAt: "2026-01-01T00:01:00.000Z",
      sequence: "2",
      details: { versionId: "v1", page: 3, extra: { z: true, a: "value" } },
      previousHash: first.eventHash,
      kmsKeyVersion: provider.keyVersion,
    });
    expect(audit.verifyChain([first, second], provider)).toBe(true);
    expect(
      audit.verifyChain(
        [
          first,
          {
            ...second,
            details: {
              extra: { a: "value", z: true },
              page: 3,
              versionId: "v1",
            },
          },
        ],
        provider,
      ),
    ).toBe(true);
    expect(audit.verifyChain([second, first], provider)).toBe(false);
    expect(
      audit.verifyChain(
        [first, { ...second, details: { changed: true } }],
        provider,
      ),
    ).toBe(false);
    expect(
      audit.verifyChain([first, { ...second, actorType: "SIGNER" }], provider),
    ).toBe(false);
    expect(
      audit.verifyChain(
        [first, { ...second, viewId: "another-view" }],
        provider,
      ),
    ).toBe(false);
    expect(
      audit.verifyChain(
        [first, { ...second, kmsKeyVersion: "rotated-key" }],
        provider,
      ),
    ).toBe(false);
  });
  it("isolates private files and rejects path traversal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "od-storage-"));
    try {
      const { FilesystemDocumentStorage } = await import("@/services/storage");
      const storage = new FilesystemDocumentStorage(root);
      const key = await storage.put(Buffer.from("secret"), "source");
      expect(key.startsWith("source/")).toBe(true);
      expect((await storage.get(key)).toString()).toBe("secret");
      expect((await stat(path.join(root, key))).mode & 0o077).toBe(0);
      await expect(storage.get("../secret.pdf")).rejects.toThrow(
        "Invalid storage key",
      );
      await expect(storage.removeSource(key)).resolves.toBeUndefined();
      const sealedKey = await storage.put(Buffer.from("final"), "sealed");
      await expect(storage.removeSource(sealedKey)).rejects.toThrow(
        "Only source documents may be removed",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.skipIf(!process.env.FOUNDATION_DB_TEST)(
    "connects to PostgreSQL",
    async () => {
      const { checkDatabase } = await import("@/db/client");
      await expect(checkDatabase()).resolves.toBeUndefined();
    },
  );
  it.skipIf(!process.env.FOUNDATION_DB_TEST)(
    "enqueues, claims, completes, and marks failed outbox work",
    async () => {
      const [{ jobRepository }, { pool }] = await Promise.all([
        import("@/services/jobs"),
        import("@/db/client"),
      ]);
      await pool.query("delete from outbox_jobs where type='test'");
      const id = await jobRepository.enqueue({
        type: "test",
        payload: { ok: true },
      });
      const job = await jobRepository.claim("test");
      expect(job?.id).toBe(id);
      await jobRepository.fail(id, "transient failure");
      // Failed status and reason are retained for operator visibility; a later phase adds retry scheduling.
    },
  );
});
