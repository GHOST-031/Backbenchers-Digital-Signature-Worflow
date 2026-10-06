import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/db/client";
import { appendAuditEventInTransaction, auditService } from "@/services/audit";
import {
  fieldsInputSchema,
  quantizeFieldGeometry,
  validateFieldPlacement,
} from "@/services/document-input";
import { apiError, requestIdFrom, requester } from "../../http";

type RouteContext = { params: Promise<{ documentId: string }> };
export async function PUT(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const identity = await requester();
  if (!identity)
    return apiError(requestId, 401, "UNAUTHENTICATED", "Sign in to continue");
  const { documentId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(requestId, 400, "INVALID_INPUT", "Submit valid JSON");
  }
  const parsed = fieldsInputSchema.safeParse(body);
  if (!parsed.success)
    return apiError(
      requestId,
      422,
      "INVALID_FIELDS",
      "Check the signature field positions",
    );
  const fields = parsed.data.fields.map(quantizeFieldGeometry);

  const client = await pool.connect().catch(() => null);
  if (!client)
    return apiError(
      requestId,
      503,
      "DATABASE_UNAVAILABLE",
      "Could not save fields",
    );
  try {
    await client.query("begin");
    const documentResult = await client.query(
      `select d.owner_user_id,d.status,d.current_version_id,v.page_count
       from documents d left join document_versions v
         on v.id=d.current_version_id and v.document_id=d.id
       where d.id=$1 for update of d`,
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
    if (!document.current_version_id || !document.page_count) {
      await client.query("rollback");
      return apiError(
        requestId,
        409,
        "PDF_REQUIRED",
        "Upload a PDF before placing fields",
      );
    }
    const signerResult = await client.query(
      "select id from signers where document_id=$1",
      [documentId],
    );
    const signerIds = new Set<string>(signerResult.rows.map(({ id }) => id));
    for (const field of fields) {
      const problem = validateFieldPlacement(
        field,
        document.page_count,
        signerIds,
      );
      if (problem) {
        await client.query("rollback");
        return apiError(requestId, 422, "INVALID_FIELD_PLACEMENT", problem);
      }
    }
    const existingResult = await client.query(
      `select id,assigned_signer_id,page_number,x_norm,y_norm,width_norm,height_norm,field_type,required
       from signature_fields where document_id=$1 for update`,
      [documentId],
    );
    const existing = new Map<string, Record<string, unknown>>(
      existingResult.rows.map((row) => [row.id, row]),
    );
    for (const field of fields) {
      if (field.id && !existing.has(field.id)) {
        await client.query("rollback");
        return apiError(
          requestId,
          404,
          "FIELD_NOT_FOUND",
          "A field does not belong to this request",
        );
      }
    }

    const kept = new Set<string>();
    const saved = [];
    for (const field of fields) {
      const id = field.id ?? randomUUID();
      const values = [
        id,
        documentId,
        document.current_version_id,
        field.signerId,
        field.pageNumber,
        field.x,
        field.y,
        field.width,
        field.height,
        field.fieldType,
        field.required,
      ];
      const wasExisting = existing.has(id);
      const result = wasExisting
        ? await client.query(
            `update signature_fields set assigned_signer_id=$4,page_number=$5,x_norm=$6,y_norm=$7,
                    width_norm=$8,height_norm=$9,field_type=$10,required=$11
             where id=$1 and document_id=$2 returning id,assigned_signer_id,page_number,
                    x_norm,y_norm,width_norm,height_norm,field_type,required`,
            values,
          )
        : await client.query(
            `insert into signature_fields
             (id,document_id,source_version_id,assigned_signer_id,page_number,x_norm,y_norm,width_norm,height_norm,field_type,required)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             returning id,assigned_signer_id,page_number,x_norm,y_norm,width_norm,height_norm,field_type,required`,
            values,
          );
      const row = result.rows[0];
      if (!row) throw new Error("Field mutation did not return a row");
      kept.add(id);
      saved.push(row);
      await appendAuditEventInTransaction(
        client,
        {
          documentId,
          actorType: "REQUESTER",
          actorUserId: identity.userId,
          eventType: wasExisting
            ? "SIGNATURE_FIELD_UPDATED"
            : "SIGNATURE_FIELD_CREATED",
          details: {
            fieldId: id,
            signerId: field.signerId,
            pageNumber: field.pageNumber,
            geometry: {
              x: field.x,
              y: field.y,
              width: field.width,
              height: field.height,
            },
            fieldType: field.fieldType,
            required: field.required,
          },
        },
        auditService,
      );
    }
    for (const [id] of existing) {
      if (kept.has(id)) continue;
      await client.query(
        "delete from signature_fields where id=$1 and document_id=$2",
        [id, documentId],
      );
      await appendAuditEventInTransaction(
        client,
        {
          documentId,
          actorType: "REQUESTER",
          actorUserId: identity.userId,
          eventType: "SIGNATURE_FIELD_DELETED",
          details: { fieldId: id },
        },
        auditService,
      );
    }
    await client.query("commit");
    return NextResponse.json({ fields: saved });
  } catch {
    await client.query("rollback").catch(() => undefined);
    return apiError(
      requestId,
      503,
      "FIELD_SAVE_FAILED",
      "Could not save signature fields",
    );
  } finally {
    client.release();
  }
}
