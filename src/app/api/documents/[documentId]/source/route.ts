import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/db/client";
import { appendAuditEventInTransaction, auditService } from "@/services/audit";
import { integrityService, type IntegrityManifest } from "@/services/integrity";
import { documentStorage } from "@/services/storage";
import { apiError, requestIdFrom, requester } from "../../http";

type RouteContext = { params: Promise<{ documentId: string }> };
export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const identity = await requester();
  if (!identity)
    return apiError(requestId, 401, "UNAUTHENTICATED", "Sign in to continue");
  const { documentId } = await context.params;
  let client;
  try {
    const result = await pool.query<{
      owner_user_id: string;
      status: string;
      version_id: string;
      object_key: string;
      version_state: string;
      sha256: Buffer;
      kms_key_version: string | null;
      sealed_at: Date | null;
      manifest: IntegrityManifest | null;
      manifest_record: IntegrityManifest | null;
      manifest_signature: Buffer | null;
      manifest_digest: Buffer | null;
      manifest_signature_copy: Buffer | null;
      manifest_key_version: string | null;
      manifest_signing_time: Date | null;
      signer_id: string | null;
    }>(
      `select d.owner_user_id, d.status, v.id as version_id, v.object_key, v.state as version_state,
        v.sha256, v.kms_key_version, v.sealed_at, v.integrity_manifest as manifest,
        v.manifest_signature, m.canonical_manifest as manifest_record,
        m.digest as manifest_digest, m.signature as manifest_signature_copy,
        m.key_version as manifest_key_version, m.signing_time as manifest_signing_time,
        (select s.id from signers s where s.document_id=d.id and s.user_id=$2 and s.status<>'REVOKED' limit 1) as signer_id
       from documents d join document_versions v
         on v.id = d.current_version_id and v.document_id = d.id
       left join integrity_manifests m on m.document_id=d.id and m.version_id=v.id
       where d.id = $1`,
      [documentId, identity.userId],
    );
    const row = result.rows[0];
    if (!row) return apiError(requestId, 404, "NOT_FOUND", "PDF was not found");
    const isOwner = row.owner_user_id === identity.userId;
    const signerId = row.signer_id as string | null;
    if (!isOwner && !signerId)
      return apiError(requestId, 403, "FORBIDDEN", "You cannot view this PDF");
    if (row.status === "INTEGRITY_FAILED")
      return apiError(
        requestId,
        409,
        "INTEGRITY_FAILED",
        "This document failed integrity verification and is unavailable",
      );
    const bytes = await documentStorage.get(row.object_key);
    const storedHash = Buffer.from(row.sha256).toString("hex");
    let integrityFailure: string | null = null;
    if (row.status === "COMPLETED") {
      const manifest = row.manifest;
      if (
        row.version_state !== "SEALED" ||
        !row.kms_key_version ||
        !row.sealed_at ||
        !manifest ||
        !row.manifest_record ||
        !row.manifest_signature ||
        !row.manifest_digest ||
        !row.manifest_signature_copy ||
        !row.manifest_key_version ||
        !row.manifest_signing_time
      ) {
        integrityFailure = "manifest_evidence_missing";
      } else if (
        !Buffer.from(row.manifest_digest).equals(Buffer.from(row.sha256)) ||
        !Buffer.from(row.manifest_signature_copy).equals(
          row.manifest_signature,
        ) ||
        row.manifest_key_version !== row.kms_key_version ||
        row.manifest_key_version !== manifest.keyVersion ||
        row.manifest_record.documentId !== manifest.documentId ||
        row.manifest_record.versionId !== manifest.versionId ||
        row.manifest_record.sha256 !== manifest.sha256 ||
        row.manifest_record.signingTime !== manifest.signingTime ||
        row.manifest_record.keyVersion !== manifest.keyVersion ||
        new Date(manifest.signingTime).getTime() !==
          row.manifest_signing_time.getTime() ||
        new Date(manifest.signingTime).getTime() !== row.sealed_at.getTime() ||
        manifest.documentId !== documentId ||
        manifest.versionId !== row.version_id ||
        manifest.sha256 !== storedHash ||
        !integrityService.verifyManifest(
          bytes,
          manifest,
          row.manifest_signature,
        )
      ) {
        integrityFailure = "manifest_or_pdf_verification_failed";
      }
    } else if (!integrityService.hash(bytes).equals(Buffer.from(row.sha256))) {
      integrityFailure = "source_digest_mismatch";
    }

    if (integrityFailure) {
      client = await pool.connect();
      await client.query("begin");
      const locked = await client.query<{
        status: string;
        current_version_id: string | null;
      }>(
        "select status,current_version_id from documents where id=$1 for update",
        [documentId],
      );
      const lockedDocument = locked.rows[0];
      if (
        lockedDocument &&
        lockedDocument.current_version_id === row.version_id &&
        lockedDocument.status !== "INTEGRITY_FAILED" &&
        lockedDocument.status !== "CANCELLED"
      ) {
        const failed = await client.query(
          "update documents set status='INTEGRITY_FAILED' where id=$1 and current_version_id=$2 and status=$3",
          [documentId, row.version_id, lockedDocument.status],
        );
        if (failed.rowCount !== 1)
          throw new Error("Document integrity state changed during retrieval");
        await appendAuditEventInTransaction(
          client,
          {
            documentId,
            actorType: isOwner ? "REQUESTER" : "SIGNER",
            ...(isOwner
              ? { actorUserId: identity.userId }
              : { actorSignerId: signerId! }),
            eventType: "INTEGRITY_FAILED",
            details: {
              versionId: row.version_id,
              reason: integrityFailure,
              phase: "retrieval",
              expectedSha256: storedHash,
              actualSha256: integrityService.hash(bytes).toString("hex"),
            },
          },
          auditService,
        );
      }
      await client.query("commit");
      return apiError(
        requestId,
        409,
        "INTEGRITY_FAILED",
        "The final PDF failed integrity verification and is unavailable",
      );
    }

    client = await pool.connect();
    await client.query("begin");
    const viewResult = await client.query<{ id: string }>(
      `insert into document_views (document_id,version_id,user_id,signer_id,request_id)
       values ($1,$2,$3,$4,$5) returning id`,
      [
        documentId,
        row.version_id,
        isOwner ? identity.userId : null,
        isOwner ? null : signerId,
        randomUUID(),
      ],
    );
    const view = viewResult.rows[0];
    if (!view) throw new Error("View record could not be created");
    await appendAuditEventInTransaction(
      client,
      {
        documentId,
        actorType: isOwner ? "REQUESTER" : "SIGNER",
        ...(isOwner
          ? { actorUserId: identity.userId }
          : { actorSignerId: signerId! }),
        viewId: view.id,
        eventType: "DOCUMENT_VIEWED",
        details: { versionId: row.version_id, sha256: storedHash },
      },
      auditService,
    );
    if (row.status === "COMPLETED") {
      await appendAuditEventInTransaction(
        client,
        {
          documentId,
          actorType: isOwner ? "REQUESTER" : "SIGNER",
          ...(isOwner
            ? { actorUserId: identity.userId }
            : { actorSignerId: signerId! }),
          eventType: "INTEGRITY_VERIFIED",
          details: { versionId: row.version_id, sha256: storedHash },
        },
        auditService,
      );
    }
    await client.query("commit");
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": 'inline; filename="document.pdf"',
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    if (client) await client.query("rollback").catch(() => undefined);
    return apiError(
      requestId,
      503,
      "PDF_UNAVAILABLE",
      "Could not securely retrieve the PDF",
    );
  } finally {
    client?.release();
  }
}
