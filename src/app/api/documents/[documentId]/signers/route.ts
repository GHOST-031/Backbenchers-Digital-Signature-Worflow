import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { pool } from "@/db/client";
import { appendAuditEventInTransaction, auditService } from "@/services/audit";
import { signerAssignmentSchema } from "@/services/document-input";
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
  const parsed = z.object({ signers: signerAssignmentSchema }).safeParse(body);
  if (!parsed.success)
    return apiError(
      requestId,
      422,
      "INVALID_SIGNER_CONFIGURATION",
      "Assign each required role once in order",
    );

  const client = await pool.connect().catch(() => null);
  if (!client)
    return apiError(
      requestId,
      503,
      "DATABASE_UNAVAILABLE",
      "Could not save signers",
    );
  try {
    await client.query("begin");
    const documentResult = await client.query(
      "select owner_user_id,status from documents where id = $1 for update",
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
    const emails = parsed.data.signers.map(({ email }) => email);
    const userResult = await client.query(
      "select id,display_name,email from users where lower(email) = any($1::text[])",
      [emails],
    );
    const users = new Map<string, { display_name: string; email: string }>(
      userResult.rows.map((row) => [row.id, row]),
    );
    if (users.size !== 3) {
      await client.query("rollback");
      return apiError(
        requestId,
        422,
        "SIGNER_NOT_FOUND",
        "Each signer must be an existing application user",
      );
    }

    const saved = [];
    for (const assignment of parsed.data.signers) {
      const user = userResult.rows.find(
        (row) => row.email.toLowerCase() === assignment.email,
      );
      if (!user) throw new Error("Validated signer disappeared");
      const existingResult = await client.query(
        "select id from signers where document_id = $1 and sequence = $2 for update",
        [documentId, assignment.sequence],
      );
      const existingId = existingResult.rows[0]?.id as string | undefined;
      const tokenDigest = createHash("sha256").update(randomBytes(32)).digest();
      if (existingId) {
        const result = await client.query(
          `update signers set role=$3,user_id=$4,full_name=$5,email=$6,token_digest=$7,
                  status='PENDING',invited_at=null,activated_at=null,signed_at=null
           where id=$1 and document_id=$2 returning id,sequence,role,user_id,status`,
          [
            existingId,
            documentId,
            assignment.role,
            user.id,
            user.display_name,
            user.email,
            tokenDigest,
          ],
        );
        saved.push(result.rows[0]);
      } else {
        const result = await client.query(
          `insert into signers (document_id,sequence,role,user_id,full_name,email,token_digest,status)
           values ($1,$2,$3,$4,$5,$6,$7,'PENDING')
           returning id,sequence,role,user_id,status`,
          [
            documentId,
            assignment.sequence,
            assignment.role,
            user.id,
            user.display_name,
            user.email,
            tokenDigest,
          ],
        );
        saved.push(result.rows[0]);
      }
    }
    await appendAuditEventInTransaction(
      client,
      {
        documentId,
        actorType: "REQUESTER",
        actorUserId: identity.userId,
        eventType: "SIGNERS_ASSIGNED",
        details: {
          signers: saved.map(({ id, sequence, role, user_id }) => ({
            id,
            sequence,
            role,
            userId: user_id,
          })),
        },
      },
      auditService,
    );
    await client.query("commit");
    return NextResponse.json({ signers: saved }, { status: 200 });
  } catch {
    await client.query("rollback").catch(() => undefined);
    return apiError(
      requestId,
      503,
      "SIGNER_SAVE_FAILED",
      "Could not save signer assignments",
    );
  } finally {
    client.release();
  }
}
