import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "@/db/client";
import { appendAuditEventInTransaction, auditService } from "./audit";
import { documentStorage } from "./storage";

export type SigningErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "OUT_OF_TURN"
  | "DOCUMENT_NOT_PENDING"
  | "ALREADY_SIGNED"
  | "REQUIRED_FIELDS_MISSING"
  | "INVALID_SIGNATURE"
  | "REPLAY_CONFLICT";
export class SigningError extends Error {
  constructor(
    readonly code: SigningErrorCode,
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

type LockedSigner = {
  id: string;
  user_id: string | null;
  sequence: number;
  role: "STUDENT" | "FACULTY_ADVISOR" | "HOD";
  status: "PENDING" | "ACTIVE" | "SIGNED" | "REVOKED";
};
type LockedWorkflow = {
  status: string;
  owner_user_id: string;
  signers: LockedSigner[];
  signer: LockedSigner;
};

async function lockWorkflow(
  client: PoolClient,
  documentId: string,
  userId: string,
): Promise<LockedWorkflow> {
  const documentResult = await client.query<{
    status: string;
    owner_user_id: string;
  }>("select status, owner_user_id from documents where id=$1 for update", [
    documentId,
  ]);
  const document = documentResult.rows[0];
  if (!document)
    throw new SigningError("NOT_FOUND", "Document was not found", 404);
  const signerResult = await client.query<LockedSigner>(
    "select id,user_id,sequence,role,status from signers where document_id=$1 order by sequence for update",
    [documentId],
  );
  const signers = signerResult.rows;
  const signer = signers.find((item) => item.user_id === userId);
  if (!signer) throw new SigningError("NOT_FOUND", "Signer was not found", 404);
  return { ...document, signers, signer };
}

function assertCurrentTurn(workflow: LockedWorkflow): void {
  if (workflow.status !== "PENDING")
    throw new SigningError(
      "DOCUMENT_NOT_PENDING",
      "Document is not open for signing",
    );
  const { signers, signer } = workflow;
  const current = signers.find((item) => item.status !== "SIGNED");
  const validOrder =
    signers.length === 3 &&
    signers[0]?.sequence === 1 &&
    signers[0].role === "STUDENT" &&
    signers[1]?.sequence === 2 &&
    signers[1].role === "FACULTY_ADVISOR" &&
    signers[2]?.sequence === 3 &&
    signers[2].role === "HOD" &&
    signers.every((item, index) =>
      index < (current?.sequence ?? 1) - 1
        ? item.status === "SIGNED"
        : index === (current?.sequence ?? 1) - 1
          ? item.status === "ACTIVE"
          : item.status === "PENDING",
    );
  if (!validOrder || current?.id !== signer.id || signer.status !== "ACTIVE")
    throw new SigningError(
      "OUT_OF_TURN",
      "This signer is not currently eligible",
    );
}

export async function getSigningContext(documentId: string, userId: string) {
  const result = await pool.query(
    `select d.id,d.title,d.status,d.current_version_id,
      s.id signer_id,s.sequence,s.role,s.status signer_status,
      exists(select 1 from signers active where active.document_id=d.id and active.status='ACTIVE' and active.id=s.id) is_current,
      (select json_agg(json_build_object('sequence',ordered.sequence,'role',ordered.role,'status',ordered.status) order by ordered.sequence) from signers ordered where ordered.document_id=d.id) workflow_signers,
      coalesce((select json_agg(json_build_object('id',f.id,'pageNumber',f.page_number,'x',f.x_norm,'y',f.y_norm,'width',f.width_norm,'height',f.height_norm,'fieldType',f.field_type,'required',f.required,'signedAt',sig.signed_at) order by f.page_number,f.created_at) from signature_fields f left join signatures sig on sig.field_id=f.id where f.document_id=d.id and f.assigned_signer_id=s.id),'[]'::json) fields
     from documents d join signers s on s.document_id=d.id
     where d.id=$1 and s.user_id=$2 and s.status<>'REVOKED'`,
    [documentId, userId],
  );
  if (!result.rows[0])
    throw new SigningError("NOT_FOUND", "Signer was not found", 404);
  return result.rows[0];
}

export async function sendDocument(documentId: string, ownerUserId: string) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query<{
      status: string;
      owner_user_id: string;
      current_version_id: string | null;
    }>(
      "select status,owner_user_id,current_version_id from documents where id=$1 for update",
      [documentId],
    );
    const document = result.rows[0];
    if (!document)
      throw new SigningError("NOT_FOUND", "Document was not found", 404);
    if (document.owner_user_id !== ownerUserId)
      throw new SigningError("FORBIDDEN", "You cannot send this document", 403);
    if (document.status !== "DRAFT")
      throw new SigningError(
        "DOCUMENT_NOT_PENDING",
        "Document is not an editable draft",
      );
    if (!document.current_version_id)
      throw new SigningError(
        "REQUIRED_FIELDS_MISSING",
        "Upload a PDF before sending",
        422,
      );
    const signers = await client.query<LockedSigner>(
      "select id,user_id,sequence,role,status from signers where document_id=$1 order by sequence for update",
      [documentId],
    );
    const roles = signers.rows;
    if (
      roles.length !== 3 ||
      roles.some(
        (s, i) =>
          s.sequence !== i + 1 ||
          s.role !== (["STUDENT", "FACULTY_ADVISOR", "HOD"] as const)[i] ||
          !s.user_id,
      )
    )
      throw new SigningError(
        "REQUIRED_FIELDS_MISSING",
        "Assign all three workflow signers before sending",
        422,
      );
    const fields = await client.query<{
      signer_id: string;
      missing: boolean;
      unsupported: boolean;
    }>(
      `select s.id signer_id,
        not exists(select 1 from signature_fields f where f.document_id=s.document_id and f.assigned_signer_id=s.id and f.required and f.field_type='SIGNATURE') missing,
        exists(select 1 from signature_fields f where f.document_id=s.document_id and f.assigned_signer_id=s.id and f.required and f.field_type<>'SIGNATURE') unsupported
       from signers s where s.document_id=$1 order by s.sequence`,
      [documentId],
    );
    if (fields.rows.some((item) => item.unsupported))
      throw new SigningError(
        "REQUIRED_FIELDS_MISSING",
        "Required fields must use a signature type supported by this workflow",
        422,
      );
    if (fields.rows.some((item) => item.missing))
      throw new SigningError(
        "REQUIRED_FIELDS_MISSING",
        "Place a required signature field for every signer",
        422,
      );
    await client.query(
      "update signers set status=case when sequence=1 then 'ACTIVE'::signer_status else 'PENDING'::signer_status end, activated_at=case when sequence=1 then clock_timestamp() else null end where document_id=$1",
      [documentId],
    );
    await client.query(
      "update documents set status='PENDING', sent_at=clock_timestamp() where id=$1",
      [documentId],
    );
    await appendAuditEventInTransaction(
      client,
      {
        documentId,
        actorType: "REQUESTER",
        actorUserId: ownerUserId,
        eventType: "DOCUMENT_SENT",
        details: { activeSignerId: roles[0]?.id },
      },
      auditService,
    );
    await client.query("commit");
    return { status: "PENDING", activeSignerId: roles[0]?.id };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function submitSignature(input: {
  documentId: string;
  userId: string;
  fieldId: string;
  requestId: string;
  method: "TYPED" | "DRAWN";
  value?: string;
}) {
  let imageKey: string | undefined;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const workflow = await lockWorkflow(client, input.documentId, input.userId);
    const fieldResult = await client.query<{
      id: string;
      field_type: string;
      required: boolean;
    }>(
      "select id,field_type,required from signature_fields where id=$1 and document_id=$2 and assigned_signer_id=$3 for update",
      [input.fieldId, input.documentId, workflow.signer.id],
    );
    const field = fieldResult.rows[0];
    if (!field)
      throw new SigningError("NOT_FOUND", "Signature field was not found", 404);
    if (field.field_type !== "SIGNATURE")
      throw new SigningError(
        "INVALID_SIGNATURE",
        "This field does not accept a signature",
        422,
      );
    let textValue: string | null = null;
    let image: Buffer | null = null;
    if (input.method === "TYPED") {
      textValue = input.value?.trim() ?? "";
      if (!textValue || textValue.length > 200)
        throw new SigningError(
          "INVALID_SIGNATURE",
          "Typed signature must be 1 to 200 characters",
          422,
        );
    } else {
      const encoded = input.value?.match(
        /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/,
      )?.[1];
      if (!encoded || encoded.length > 350_000)
        throw new SigningError(
          "INVALID_SIGNATURE",
          "Drawn signature must be a small PNG image",
          422,
        );
      const decodedImage = Buffer.from(encoded, "base64");
      if (
        decodedImage.length > 256 * 1024 ||
        decodedImage.length < 24 ||
        !decodedImage
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        decodedImage.toString("ascii", 12, 16) !== "IHDR" ||
        decodedImage.readUInt32BE(16) < 1 ||
        decodedImage.readUInt32BE(16) > 1600 ||
        decodedImage.readUInt32BE(20) < 1 ||
        decodedImage.readUInt32BE(20) > 600
      )
        throw new SigningError(
          "INVALID_SIGNATURE",
          "Drawn signature image is invalid or exceeds limits",
          422,
        );
      // Keep a copy for replay comparison; the private object is written only
      // after the request has passed authorization and duplicate checks.
      image = decodedImage;
    }

    const requestReplay = await client.query<{
      id: string;
      field_id: string;
      request_id: string;
      method: "TYPED" | "DRAWN";
      value: string | null;
      image_object_key: string | null;
      signed_at: Date;
    }>(
      "select id,field_id,request_id,method,value,image_object_key,signed_at from signatures where signer_id=$1 and request_id=$2",
      [workflow.signer.id, input.requestId],
    );
    const replay = requestReplay.rows[0];
    if (replay) {
      if (replay.field_id !== input.fieldId || replay.method !== input.method)
        throw new SigningError(
          "REPLAY_CONFLICT",
          "This request ID was already used for a different signature",
        );
      let sameValue = replay.value === textValue;
      if (input.method === "DRAWN") {
        if (!image || !replay.image_object_key) sameValue = false;
        else {
          try {
            sameValue = (
              await documentStorage.get(replay.image_object_key)
            ).equals(image);
          } catch {
            sameValue = false;
          }
        }
      }
      if (!sameValue)
        throw new SigningError(
          "REPLAY_CONFLICT",
          "This request ID was already used with different signature data",
        );
      await client.query("commit");
      return {
        signatureId: replay.id,
        fieldId: input.fieldId,
        signedAt: replay.signed_at.toISOString(),
        replay: true,
      };
    }

    const prior = await client.query(
      "select id from signatures where field_id=$1",
      [input.fieldId],
    );
    if (prior.rows[0])
      throw new SigningError(
        "ALREADY_SIGNED",
        "This field has already been signed",
      );
    assertCurrentTurn(workflow);
    if (image) imageKey = await documentStorage.putSignature(image);
    const signatureId = randomUUID();
    await client.query(
      "insert into signatures (id,document_id,field_id,signer_id,method,value,image_object_key,signed_at,request_id) values ($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),$8)",
      [
        signatureId,
        input.documentId,
        input.fieldId,
        workflow.signer.id,
        input.method,
        textValue,
        imageKey ?? null,
        input.requestId,
      ],
    );
    const timestamp = await client.query<{ signed_at: Date }>(
      "select signed_at from signatures where id=$1",
      [signatureId],
    );
    await appendAuditEventInTransaction(
      client,
      {
        documentId: input.documentId,
        actorType: "SIGNER",
        actorSignerId: workflow.signer.id,
        signatureId,
        eventType: "FIELD_SIGNED",
        details: {
          fieldId: input.fieldId,
          method: input.method,
          signedAt: timestamp.rows[0]?.signed_at.toISOString(),
        },
      },
      auditService,
    );
    await client.query("commit");
    return {
      signatureId,
      fieldId: input.fieldId,
      signedAt: timestamp.rows[0]?.signed_at.toISOString(),
      replay: false,
    };
  } catch (error) {
    await client.query("rollback");
    if (imageKey) await documentStorage.removeSignature(imageKey);
    throw error;
  } finally {
    client.release();
  }
}

export async function completeSigner(
  documentId: string,
  userId: string,
  requestId: string,
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const workflow = await lockWorkflow(client, documentId, userId);
    const priorCompletion = await client.query<{
      details: {
        signerId?: string;
        sequence?: number;
        nextSignerId?: string | null;
        readyForSealing?: boolean;
      };
    }>(
      "select details from audit_events where actor_signer_id=$1 and event_type='DOCUMENT_RECIPIENT_COMPLETED' and details->>'requestId'=$2",
      [workflow.signer.id, requestId],
    );
    if (priorCompletion.rows[0]) {
      const details = priorCompletion.rows[0].details;
      let sealJobId: string | null = null;
      if (details.readyForSealing) {
        const job = await client.query<{ id: string }>(
          "select id from outbox_jobs where type='SEAL_DOCUMENT' and payload->>'documentId'=$1 order by created_at desc limit 1",
          [documentId],
        );
        sealJobId = job.rows[0]?.id ?? null;
      }
      await client.query("commit");
      return {
        signerId: workflow.signer.id,
        status: "SIGNED",
        nextSignerId: details.nextSignerId ?? null,
        readyForSealing: details.readyForSealing === true,
        ...(sealJobId ? { sealJobId } : {}),
        retry: true,
      };
    }
    if (
      workflow.signer.status === "SIGNED" &&
      workflow.signer.role === "HOD" &&
      (workflow.status === "PROCESSING" || workflow.status === "COMPLETED")
    ) {
      const job = await client.query<{ id: string }>(
        "select id from outbox_jobs where type='SEAL_DOCUMENT' and payload->>'documentId'=$1 order by created_at desc limit 1",
        [documentId],
      );
      if (job.rows[0]) {
        await client.query("commit");
        return {
          signerId: workflow.signer.id,
          status: "SIGNED",
          nextSignerId: null,
          readyForSealing: true,
          sealJobId: job.rows[0].id,
          retry: true,
        };
      }
    }
    if (workflow.signer.status === "SIGNED")
      throw new SigningError("ALREADY_SIGNED", "Signer has already completed");
    assertCurrentTurn(workflow);
    const missing = await client.query<{ id: string }>(
      `select f.id from signature_fields f left join signatures sig on sig.field_id=f.id and sig.signer_id=f.assigned_signer_id and sig.document_id=f.document_id where f.document_id=$1 and f.assigned_signer_id=$2 and f.required and (f.field_type<>'SIGNATURE' or sig.id is null)`,
      [documentId, workflow.signer.id],
    );
    if (missing.rows.length)
      throw new SigningError(
        "REQUIRED_FIELDS_MISSING",
        "Complete every required signature field before continuing",
        422,
      );
    await client.query(
      "update signers set status='SIGNED', signed_at=clock_timestamp() where id=$1",
      [workflow.signer.id],
    );
    const next = workflow.signers.find(
      (item) => item.sequence === workflow.signer.sequence + 1,
    );
    if (next)
      await client.query(
        "update signers set status='ACTIVE', activated_at=clock_timestamp() where id=$1",
        [next.id],
      );
    else {
      await client.query(
        "update documents set status='PROCESSING' where id=$1",
        [documentId],
      );
    }
    await appendAuditEventInTransaction(
      client,
      {
        documentId,
        actorType: "SIGNER",
        actorSignerId: workflow.signer.id,
        eventType: "DOCUMENT_RECIPIENT_COMPLETED",
        details: {
          signerId: workflow.signer.id,
          sequence: workflow.signer.sequence,
          requestId,
          nextSignerId: next?.id ?? null,
          readyForSealing: !next,
        },
      },
      auditService,
    );
    let sealJobId: string | null = null;
    if (!next) {
      const queued = await client.query<{ id: string }>(
        `insert into outbox_jobs(type,payload)
         values ('SEAL_DOCUMENT',jsonb_build_object('documentId',$1::text,'finalSignerId',$2::text,'idempotencyKey',$3::text))
         returning id`,
        [documentId, workflow.signer.id, requestId],
      );
      sealJobId = queued.rows[0]?.id ?? null;
      if (!sealJobId) throw new Error("Finalization job could not be queued");
    }
    await client.query("commit");
    return {
      signerId: workflow.signer.id,
      status: "SIGNED",
      nextSignerId: next?.id ?? null,
      readyForSealing: !next,
      ...(sealJobId ? { sealJobId } : {}),
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
