import { NextRequest } from "next/server";
import { pool } from "@/db/client";
import { auditService } from "@/services/audit";
import { signingProvider } from "@/services/signing-provider";
import { apiError, requestIdFrom, requester } from "../../http";

type RouteContext = { params: Promise<{ documentId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const identity = await requester();
  if (!identity)
    return apiError(requestId, 401, "UNAUTHENTICATED", "Sign in to continue");
  const { documentId } = await context.params;
  const after = request.nextUrl.searchParams.get("afterSequence") ?? "0";
  if (!/^(0|[1-9]\d*)$/.test(after))
    return apiError(
      requestId,
      400,
      "INVALID_CURSOR",
      "afterSequence must be a non-negative integer",
    );
  try {
    const documentResult = await pool.query<{
      owner_user_id: string;
      audit_next_sequence: string;
      audit_head_hash: Buffer;
      is_signer: boolean;
    }>(
      `select d.owner_user_id,d.audit_next_sequence,d.audit_head_hash,
        exists(select 1 from signers s where s.document_id=d.id and s.user_id=$2 and s.status<>'REVOKED') as is_signer
       from documents d where d.id=$1`,
      [documentId, identity.userId],
    );
    const document = documentResult.rows[0];
    if (!document)
      return apiError(requestId, 404, "NOT_FOUND", "Request was not found");
    if (document.owner_user_id !== identity.userId && !document.is_signer)
      return apiError(
        requestId,
        403,
        "FORBIDDEN",
        "You cannot view this audit history",
      );

    const result = await pool.query<{
      id: string;
      document_id: string;
      sequence: string;
      actor_type: "REQUESTER" | "SIGNER" | "SYSTEM";
      actor_user_id: string | null;
      actor_signer_id: string | null;
      view_id: string | null;
      signature_id: string | null;
      event_type: string;
      occurred_at: Date;
      details: Record<string, unknown>;
      previous_hash: Buffer;
      event_hash: Buffer;
      event_signature: Buffer;
      kms_key_version: string;
    }>(
      `select id,document_id,sequence::text,actor_type,actor_user_id,actor_signer_id,
        view_id,signature_id,event_type,occurred_at,details,previous_hash,event_hash,event_signature,kms_key_version
       from audit_events where document_id=$1 order by sequence::bigint`,
      [documentId],
    );
    const records = result.rows.map((row) => ({
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
      previousHash: row.previous_hash.toString("hex"),
      eventHash: row.event_hash.toString("hex"),
      eventSignature: row.event_signature.toString("base64"),
      kmsKeyVersion: row.kms_key_version,
    }));
    const last = records.at(-1);
    const expectedNextSequence = last ? BigInt(last.sequence) + 1n : 1n;
    const expectedHead = last?.eventHash ?? Buffer.alloc(32).toString("hex");
    if (
      !auditService.verifyChain(records, signingProvider) ||
      expectedNextSequence !== BigInt(document.audit_next_sequence) ||
      expectedHead !== document.audit_head_hash.toString("hex")
    )
      return apiError(
        requestId,
        409,
        "AUDIT_INTEGRITY_FAILED",
        "The audit history failed integrity verification",
      );

    const cursor = BigInt(after);
    return Response.json({
      events: records
        .filter((event) => BigInt(event.sequence) > cursor)
        .map(({ eventSignature, ...event }) => ({
          ...event,
          occurredAt: event.occurredAt,
          eventSignature,
        })),
      integrity: "VALID",
      requestId,
    });
  } catch {
    return apiError(
      requestId,
      503,
      "AUDIT_UNAVAILABLE",
      "Could not load the audit history",
    );
  }
}
