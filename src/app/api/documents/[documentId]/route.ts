import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/db/client";
import { apiError, requestIdFrom, requester } from "../http";
import { readinessIssues } from "@/services/document-input";

type RouteContext = { params: Promise<{ documentId: string }> };
export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const identity = await requester();
  if (!identity)
    return apiError(requestId, 401, "UNAUTHENTICATED", "Sign in to continue");
  const { documentId } = await context.params;
  try {
    const documentResult = await pool.query(
      `select d.id, d.owner_user_id, d.letter_type, d.title, d.status,
              d.created_at, d.current_version_id, v.version_number, v.object_key,
              v.sha256, v.byte_length, v.page_count, v.media_type
       from documents d
       left join document_versions v on v.id = d.current_version_id and v.document_id = d.id
       where d.id = $1`,
      [documentId],
    );
    const document = documentResult.rows[0];
    if (!document)
      return apiError(requestId, 404, "NOT_FOUND", "Request was not found");
    if (document.owner_user_id !== identity.userId)
      return apiError(
        requestId,
        403,
        "FORBIDDEN",
        "You cannot edit this request",
      );
    const [signersResult, fieldsResult] = await Promise.all([
      pool.query(
        `select s.id, s.sequence, s.role, s.full_name, s.email, s.user_id, s.status
         from signers s where s.document_id = $1 order by s.sequence`,
        [documentId],
      ),
      pool.query(
        `select f.id, f.assigned_signer_id as signer_id, f.page_number,
                f.x_norm as x, f.y_norm as y, f.width_norm as width,
                f.height_norm as height, f.field_type, f.required
         from signature_fields f where f.document_id = $1 order by f.page_number, f.created_at`,
        [documentId],
      ),
    ]);
    const signers = signersResult.rows;
    const fields = fieldsResult.rows;
    return NextResponse.json({
      document: {
        id: document.id,
        letterType: document.letter_type,
        title: document.title,
        status: document.status,
        createdAt: new Date(document.created_at).toISOString(),
        currentVersionId: document.current_version_id,
        source: document.current_version_id
          ? {
              versionId: document.current_version_id,
              versionNumber: document.version_number,
              byteLength: Number(document.byte_length),
              pageCount: document.page_count,
              mediaType: document.media_type,
              sha256: Buffer.from(document.sha256).toString("hex"),
              viewPath: `/api/documents/${documentId}/source`,
            }
          : null,
        signers,
        fields,
        readinessIssues: readinessIssues({
          hasSourcePdf: Boolean(document.current_version_id),
          signers,
          requiredFieldSignerIds: fields
            .filter((field) => field.required)
            .map((field) => field.signer_id),
        }),
      },
    });
  } catch {
    return apiError(
      requestId,
      503,
      "DATABASE_UNAVAILABLE",
      "Could not load the request",
    );
  }
}
