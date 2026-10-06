import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/db/client";
import { appendAuditEventInTransaction, auditService } from "@/services/audit";
import { apiError, requestIdFrom, requester } from "../../../http";

type RouteContext = {
  params: Promise<{ documentId: string; fieldId: string }>;
};
export async function DELETE(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const identity = await requester();
  if (!identity)
    return apiError(requestId, 401, "UNAUTHENTICATED", "Sign in to continue");
  const { documentId, fieldId } = await context.params;
  const client = await pool.connect().catch(() => null);
  if (!client)
    return apiError(
      requestId,
      503,
      "DATABASE_UNAVAILABLE",
      "Could not delete the field",
    );
  try {
    await client.query("begin");
    const documentResult = await client.query(
      "select owner_user_id,status from documents where id=$1 for update",
      [documentId],
    );
    const document = documentResult.rows[0];
    if (!document) {
      await client.query("rollback");
      return apiError(requestId, 404, "NOT_FOUND", "Request was not found");
    }
    if (document.owner_user_id !== identity.userId) {
      await client.query("rollback");
      return apiError(
        requestId,
        403,
        "FORBIDDEN",
        "You cannot edit this request",
      );
    }
    if (document.status !== "DRAFT") {
      await client.query("rollback");
      return apiError(
        requestId,
        409,
        "DOCUMENT_NOT_EDITABLE",
        "Only draft requests can be changed",
      );
    }
    const field = await client.query(
      "select id from signature_fields where id=$1 and document_id=$2 for update",
      [fieldId, documentId],
    );
    if (!field.rowCount) {
      await client.query("rollback");
      return apiError(requestId, 404, "FIELD_NOT_FOUND", "Field was not found");
    }
    await client.query(
      "delete from signature_fields where id=$1 and document_id=$2",
      [fieldId, documentId],
    );
    await appendAuditEventInTransaction(
      client,
      {
        documentId,
        actorType: "REQUESTER",
        actorUserId: identity.userId,
        eventType: "SIGNATURE_FIELD_DELETED",
        details: { fieldId },
      },
      auditService,
    );
    await client.query("commit");
    return NextResponse.json({ deleted: true, fieldId });
  } catch {
    await client.query("rollback").catch(() => undefined);
    return apiError(
      requestId,
      503,
      "FIELD_DELETE_FAILED",
      "Could not delete the field",
    );
  } finally {
    client.release();
  }
}
