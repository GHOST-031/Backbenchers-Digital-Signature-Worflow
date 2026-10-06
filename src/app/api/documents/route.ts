import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/db/client";
import { appendAuditEventInTransaction } from "@/services/audit";
import { auditService } from "@/services/audit";
import { integrityService } from "@/services/integrity";
import { pdfService, MAX_PDF_BYTES } from "@/services/pdf";
import { documentStorage } from "@/services/storage";
import { apiError, databaseErrorCode, requestIdFrom, requester } from "./http";
import { documentInputSchema } from "@/services/document-input";

export async function GET(request: NextRequest) {
  const requestId = requestIdFrom(request);
  const identity = await requester();
  if (!identity)
    return apiError(requestId, 401, "UNAUTHENTICATED", "Sign in to continue");
  try {
    const result = await pool.query(
      `select d.id, d.letter_type, d.title, d.status, d.created_at, d.current_version_id,
              v.page_count, v.byte_length
       from documents d
       left join document_versions v on v.id = d.current_version_id and v.document_id = d.id
       where d.owner_user_id = $1
       order by d.created_at desc`,
      [identity.userId],
    );
    return NextResponse.json({ documents: result.rows });
  } catch {
    return apiError(
      requestId,
      503,
      "DATABASE_UNAVAILABLE",
      "Could not load requests",
    );
  }
}

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);
  const identity = await requester();
  if (!identity)
    return apiError(requestId, 401, "UNAUTHENTICATED", "Sign in to continue");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return apiError(
      requestId,
      400,
      "INVALID_FORM",
      "Submit a multipart PDF form",
    );
  }
  const metadata = documentInputSchema.safeParse({
    letterType: form.get("letterType"),
    title: form.get("title"),
  });
  if (!metadata.success)
    return apiError(
      requestId,
      400,
      "INVALID_INPUT",
      "Check the document details",
    );
  const file = form.get("file");
  if (!(file instanceof File))
    return apiError(requestId, 400, "PDF_REQUIRED", "Choose a PDF file");
  if (file.type !== "application/pdf")
    return apiError(
      requestId,
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Upload a PDF file",
    );
  if (file.size > MAX_PDF_BYTES)
    return apiError(
      requestId,
      413,
      "PDF_TOO_LARGE",
      "PDF must be 10 MB or smaller",
    );

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await file.arrayBuffer());
  } catch {
    return apiError(
      requestId,
      400,
      "INVALID_UPLOAD",
      "Could not read the uploaded PDF",
    );
  }
  let pdfInfo: Awaited<ReturnType<typeof pdfService.validate>>;
  try {
    pdfInfo = await pdfService.validate(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/10 MB/.test(message))
      return apiError(
        requestId,
        413,
        "PDF_TOO_LARGE",
        "PDF must be 10 MB or smaller",
      );
    if (/not a PDF/.test(message))
      return apiError(
        requestId,
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Upload a valid PDF file",
      );
    return apiError(
      requestId,
      422,
      "INVALID_PDF",
      "PDF is invalid or cannot be parsed",
    );
  }

  let storageKey: string | undefined;
  let storedBytes: Buffer;
  try {
    storageKey = await documentStorage.put(bytes, "source");
    storedBytes = await documentStorage.get(storageKey);
  } catch {
    if (storageKey)
      await documentStorage.removeSource(storageKey).catch(() => undefined);
    return apiError(
      requestId,
      503,
      "STORAGE_UNAVAILABLE",
      "Could not store the PDF",
    );
  }
  try {
    pdfInfo = await pdfService.validate(storedBytes);
  } catch {
    await documentStorage
      .removeSource(storageKey)
      .catch(() =>
        console.error("Could not clean up an invalid stored upload"),
      );
    return apiError(
      requestId,
      503,
      "STORAGE_INTEGRITY_FAILED",
      "Stored PDF failed validation",
    );
  }

  const documentId = randomUUID();
  const versionId = randomUUID();
  const client = await pool.connect().catch(() => null);
  if (!client) {
    await documentStorage
      .removeSource(storageKey)
      .catch(() => console.error("Could not clean up an unreferenced upload"));
    return apiError(
      requestId,
      503,
      "DATABASE_UNAVAILABLE",
      "Could not create the request",
    );
  }
  try {
    await client.query("begin");
    await client.query(
      "insert into documents (id,owner_user_id,letter_type,title,status) values ($1,$2,$3,$4,'DRAFT')",
      [
        documentId,
        identity.userId,
        metadata.data.letterType,
        metadata.data.title,
      ],
    );
    await client.query(
      "insert into document_versions (id,document_id,version_number,object_key,created_by_user_id,page_count,sha256,byte_length,media_type,state) values ($1,$2,1,$3,$4,$5,$6,$7,'application/pdf','SOURCE')",
      [
        versionId,
        documentId,
        storageKey,
        identity.userId,
        pdfInfo.pageCount,
        integrityService.hash(storedBytes),
        storedBytes.byteLength,
      ],
    );
    await client.query(
      "update documents set current_version_id = $2 where id = $1",
      [documentId, versionId],
    );
    await appendAuditEventInTransaction(
      client,
      {
        documentId,
        actorType: "REQUESTER",
        actorUserId: identity.userId,
        eventType: "DOCUMENT_CREATED",
        details: {
          letterType: metadata.data.letterType,
          initialVersionId: versionId,
          pdfSha256: createHash("sha256").update(storedBytes).digest("hex"),
          pageCount: pdfInfo.pageCount,
        },
      },
      auditService,
    );
    await client.query("commit");
    return NextResponse.json(
      {
        documentId,
        initialVersionId: versionId,
        upload: {
          byteLength: storedBytes.byteLength,
          pageCount: pdfInfo.pageCount,
          mediaType: "application/pdf",
        },
        status: "DRAFT",
      },
      { status: 201 },
    );
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    const duplicate = databaseErrorCode(error) === "23505";
    await documentStorage
      .removeSource(storageKey)
      .catch(() => console.error("Could not clean up an unreferenced upload"));
    return apiError(
      requestId,
      duplicate ? 409 : 503,
      duplicate ? "DUPLICATE_REQUEST" : "DOCUMENT_CREATE_FAILED",
      duplicate
        ? "This request was already created"
        : "Could not create the request",
    );
  } finally {
    client.release();
  }
}
