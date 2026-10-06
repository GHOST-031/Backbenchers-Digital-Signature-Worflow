import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { pool } from "@/db/client";
import { appendAuditEventInTransaction, auditService } from "./audit";
import { integrityService, type IntegrityService } from "./integrity";
import { pdfService, type PdfService } from "./pdf";
import { documentStorage, type DocumentStorage } from "./storage";

export interface FinalizationDependencies {
  pool: Pool;
  storage: DocumentStorage;
  pdf: PdfService;
  integrity: IntegrityService;
}
export class FinalizationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

type SourceState = {
  status: string;
  owner_user_id: string;
  current_version_id: string | null;
  source_id: string | null;
  object_key: string | null;
  source_sha256: Buffer | null;
  page_count: number | null;
  source_state: string | null;
};
type FieldRow = {
  id: string;
  page_number: number;
  x_norm: string;
  y_norm: string;
  width_norm: string;
  height_norm: string;
  field_type: string;
  required: boolean;
  method: "TYPED" | "DRAWN" | null;
  value: string | null;
  image_object_key: string | null;
};

export class FinalizationService {
  constructor(private readonly dependencies: FinalizationDependencies) {}

  async processJob(
    jobId: string,
  ): Promise<{ versionId: string; reused: boolean }> {
    const { pool: database } = this.dependencies;
    const claim = await database.connect();
    let documentId = "";
    let finalKey: string | null = null;
    let published = false;
    let preserveFailureArtifact = false;
    let claimTransactionOpen = false;
    let claimedByThisAttempt = false;
    try {
      await claim.query("begin");
      claimTransactionOpen = true;
      const jobResult = await claim.query<{
        type: string;
        payload: { documentId?: string; finalSignerId?: string };
        status: string;
        locked_at: Date | null;
      }>(
        "select type,payload,status,locked_at from outbox_jobs where id=$1 for update",
        [jobId],
      );
      const job = jobResult.rows[0];
      if (!job || job.type !== "SEAL_DOCUMENT")
        throw new FinalizationError(
          "JOB_NOT_FOUND",
          "Finalization job was not found",
          404,
        );
      documentId = String(job.payload.documentId ?? "");
      const finalSignerId = String(job.payload.finalSignerId ?? "");
      if (job.status === "COMPLETED") {
        const version = await claim.query<{ id: string }>(
          "select id from document_versions where document_id=$1 and state='SEALED' order by version_number desc limit 1",
          [documentId],
        );
        const versionId = version.rows[0]?.id;
        if (!versionId)
          throw new Error("Completed seal job has no sealed version");
        await claim.query("commit");
        return { versionId, reused: true };
      }
      if (
        job.status === "PROCESSING" &&
        job.locked_at &&
        Date.now() - job.locked_at.getTime() < 5 * 60_000
      ) {
        await claim.query("rollback");
        claimTransactionOpen = false;
        throw new FinalizationError(
          "JOB_IN_PROGRESS",
          "Finalization is already in progress",
          409,
        );
      }
      await claim.query(
        "update outbox_jobs set status='PROCESSING', attempts=attempts+1, locked_at=clock_timestamp(), last_error=null where id=$1",
        [jobId],
      );
      await claim.query("commit");
      claimTransactionOpen = false;
      claimedByThisAttempt = true;

      const already = await database.query<{ id: string; status: string }>(
        "select v.id,d.status from documents d join document_versions v on v.document_id=d.id and v.id=d.current_version_id where d.id=$1 and v.state='SEALED'",
        [documentId],
      );
      if (already.rows[0]?.status === "COMPLETED") {
        await this.completeJob(jobId);
        return { versionId: already.rows[0].id, reused: true };
      }

      const stateResult = await database.query<SourceState>(
        `select d.status,d.owner_user_id,d.current_version_id,v.id source_id,v.object_key,v.sha256 source_sha256,v.page_count,v.state source_state
         from documents d left join document_versions v on v.document_id=d.id and v.id=d.current_version_id where d.id=$1`,
        [documentId],
      );
      const state = stateResult.rows[0];
      if (
        !state ||
        state.status !== "PROCESSING" ||
        !state.source_id ||
        !state.object_key ||
        !state.source_sha256 ||
        state.source_state !== "SOURCE"
      )
        throw new FinalizationError(
          "NOT_READY",
          "Document is not ready for finalization",
        );

      const signerRows = await database.query<{
        id: string;
        sequence: number;
        role: string;
        status: string;
        signed_at: Date | null;
      }>(
        "select id,sequence,role,status,signed_at from signers where document_id=$1 order by sequence",
        [documentId],
      );
      const expected = ["STUDENT", "FACULTY_ADVISOR", "HOD"];
      if (
        signerRows.rows.length !== expected.length ||
        signerRows.rows.some(
          (signer, index) =>
            signer.sequence !== index + 1 ||
            signer.role !== expected[index] ||
            signer.status !== "SIGNED" ||
            !signer.signed_at,
        ) ||
        signerRows.rows[2]?.id !== finalSignerId
      )
        throw new FinalizationError(
          "NOT_READY",
          "All ordered signers must complete before finalization",
        );

      const fields = await database.query<FieldRow>(
        `select f.id,f.page_number,f.x_norm,f.y_norm,f.width_norm,f.height_norm,f.field_type,f.required,
                sig.method,sig.value,sig.image_object_key
         from signature_fields f left join signatures sig on sig.field_id=f.id and sig.document_id=f.document_id and sig.signer_id=f.assigned_signer_id
         where f.document_id=$1 order by f.page_number,f.created_at`,
        [documentId],
      );
      const placements = [];
      for (const field of fields.rows) {
        if (!field.method) {
          if (field.required)
            throw new FinalizationError(
              "REQUIRED_SIGNATURE_MISSING",
              "A required field has no persisted signature",
            );
          continue;
        }
        if (field.field_type !== "SIGNATURE") {
          if (field.required)
            throw new FinalizationError(
              "UNSUPPORTED_REQUIRED_FIELD",
              "A required field type cannot be rendered",
            );
          continue;
        }
        const image =
          field.method === "DRAWN" && field.image_object_key
            ? new Uint8Array(
                await this.dependencies.storage.get(field.image_object_key),
              )
            : null;
        placements.push({
          pageNumber: field.page_number,
          x: Number(field.x_norm),
          y: Number(field.y_norm),
          width: Number(field.width_norm),
          height: Number(field.height_norm),
          method: field.method,
          value: field.value,
          image,
        });
      }
      if (!placements.length)
        throw new FinalizationError(
          "NO_SIGNATURES",
          "The final PDF has no persisted signatures",
        );

      const sourceBytes = await this.dependencies.storage.get(state.object_key);
      const sourceHash = this.dependencies.integrity.hash(sourceBytes);
      if (!sourceHash.equals(state.source_sha256)) {
        await this.recordIntegrityFailure(
          documentId,
          "source_digest_mismatch",
          state.source_id,
        );
        throw new FinalizationError(
          "SOURCE_INTEGRITY_FAILED",
          "The source PDF failed its integrity check",
          409,
        );
      }
      const sourceInfo = await this.dependencies.pdf.validate(sourceBytes);
      if (sourceInfo.pageCount !== state.page_count)
        throw new FinalizationError(
          "SOURCE_INVALID",
          "Source PDF page count does not match its stored version",
        );
      const prepared =
        await this.dependencies.pdf.prepareForRendering(sourceBytes);
      const rendered = await this.dependencies.pdf.renderSignatures(
        prepared,
        placements,
      );
      const sealed = await this.dependencies.pdf.seal(rendered);
      const finalInfo = await this.dependencies.pdf.validate(sealed);
      if (finalInfo.pageCount !== state.page_count)
        throw new FinalizationError(
          "FINAL_PDF_INVALID",
          "Final PDF does not preserve source page count",
        );
      finalKey = await this.dependencies.storage.put(sealed, "sealed");
      const storedBytes = await this.dependencies.storage.get(finalKey);
      const exactDigest = this.dependencies.integrity.hash(sealed);
      if (!exactDigest.equals(this.dependencies.integrity.hash(storedBytes))) {
        preserveFailureArtifact = true;
        await this.recordIntegrityFailure(
          documentId,
          "sealed_storage_mismatch",
          state.source_id,
          {
            artifactKey: finalKey,
            generatedSha256: exactDigest.toString("hex"),
            storedSha256: this.dependencies.integrity
              .hash(storedBytes)
              .toString("hex"),
          },
        );
        throw new FinalizationError(
          "FINAL_INTEGRITY_FAILED",
          "Stored final PDF differs from generated bytes",
          409,
        );
      }

      const versionId = randomUUID();
      const client = await database.connect();
      try {
        await client.query("begin");
        const locked = await client.query<SourceState>(
          `select d.status,d.owner_user_id,d.current_version_id,v.id source_id,v.object_key,v.sha256 source_sha256,v.page_count,v.state source_state
           from documents d left join document_versions v on v.document_id=d.id and v.id=d.current_version_id where d.id=$1 for update of d`,
          [documentId],
        );
        const lockedState = locked.rows[0];
        if (
          !lockedState ||
          lockedState.status !== "PROCESSING" ||
          lockedState.source_id !== state.source_id
        )
          throw new FinalizationError(
            "STATE_CHANGED",
            "Document changed during finalization; retry safely",
          );
        const liveSigners = await client.query<{
          role: string;
          sequence: number;
          status: string;
          signed_at: Date | null;
        }>(
          "select role,sequence,status,signed_at from signers where document_id=$1 order by sequence for update",
          [documentId],
        );
        if (
          liveSigners.rows.length !== 3 ||
          liveSigners.rows.some(
            (row, index) =>
              row.sequence !== index + 1 ||
              row.role !== expected[index] ||
              row.status !== "SIGNED" ||
              !row.signed_at,
          )
        )
          throw new FinalizationError(
            "NOT_READY",
            "Signer state changed during finalization",
          );
        const dbTimeResult = await client.query<{ now: Date }>(
          "select clock_timestamp() as now",
        );
        const sealedAt = dbTimeResult.rows[0]?.now;
        if (!sealedAt) throw new Error("Database UTC time is unavailable");
        const { manifest, signature } =
          this.dependencies.integrity.createManifest(
            storedBytes,
            { documentId, versionId },
            sealedAt,
          );
        const versionNumberResult = await client.query<{ next_number: number }>(
          "select coalesce(max(version_number),0)+1 as next_number from document_versions where document_id=$1",
          [documentId],
        );
        const versionNumber = versionNumberResult.rows[0]?.next_number;
        if (!versionNumber)
          throw new Error("Final version number could not be allocated");
        await client.query(
          `insert into document_versions
           (id,document_id,version_number,object_key,created_by_user_id,page_count,sha256,byte_length,media_type,state,created_at,sealed_at,pdf_signature_metadata,integrity_manifest,manifest_signature,kms_key_version)
           values ($1,$2,$3,$4,null,$5,$6,$7,'application/pdf','SEALED',$8,$8,$9,$10,$11,$12)`,
          [
            versionId,
            documentId,
            versionNumber,
            finalKey,
            finalInfo.pageCount,
            this.dependencies.integrity.hash(storedBytes),
            storedBytes.byteLength,
            sealedAt,
            { provider: "local-demo", certificateBacked: false },
            manifest,
            signature,
            manifest.keyVersion,
          ],
        );
        await client.query(
          `insert into integrity_manifests (document_id,version_id,digest,canonical_manifest,signature,signing_time,key_version)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [
            documentId,
            versionId,
            Buffer.from(manifest.sha256, "hex"),
            manifest,
            signature,
            sealedAt,
            manifest.keyVersion,
          ],
        );
        await client.query(
          "update documents set current_version_id=$2 where id=$1",
          [documentId, versionId],
        );
        await appendAuditEventInTransaction(
          client,
          {
            documentId,
            actorType: "SYSTEM",
            eventType: "DOCUMENT_SEALED",
            details: {
              finalSignerId,
              versionId,
              sha256: manifest.sha256,
              byteLength: storedBytes.byteLength,
              manifestKeyVersion: manifest.keyVersion,
              signingTime: manifest.signingTime,
            },
          },
          auditService,
        );
        await client.query(
          "update documents set status='COMPLETED',completed_at=$2 where id=$1",
          [documentId, sealedAt],
        );
        await client.query(
          "update outbox_jobs set status='COMPLETED',completed_at=clock_timestamp(),locked_at=null,last_error=null where id=$1 and status='PROCESSING'",
          [jobId],
        );
        await client.query("commit");
        published = true;
        return { versionId, reused: false };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (claimTransactionOpen) {
        await claim.query("rollback").catch(() => undefined);
        claimTransactionOpen = false;
      }
      if (
        documentId &&
        claimedByThisAttempt &&
        !(
          error instanceof FinalizationError && error.code === "JOB_IN_PROGRESS"
        )
      ) {
        await database
          .query(
            "update outbox_jobs set status='FAILED',last_error=$2,available_at=clock_timestamp()+interval '1 minute',locked_at=null where id=$1 and status='PROCESSING'",
            [
              jobId,
              error instanceof Error
                ? error.message.slice(0, 500)
                : "finalization failed",
            ],
          )
          .catch(() => undefined);
      }
      throw error;
    } finally {
      if (finalKey && !published && !preserveFailureArtifact) {
        const referenced = await database
          .query("select 1 from document_versions where object_key=$1", [
            finalKey,
          ])
          .catch(() => ({ rowCount: 1 }) as { rowCount: number | null });
        if (!referenced.rowCount)
          await this.dependencies.storage
            .removeSealed(finalKey)
            .catch(() => undefined);
      }
      claim.release();
    }
  }

  private async completeJob(jobId: string) {
    await this.dependencies.pool.query(
      "update outbox_jobs set status='COMPLETED',completed_at=clock_timestamp(),locked_at=null,last_error=null where id=$1 and status in ('PROCESSING','FAILED','PENDING')",
      [jobId],
    );
  }

  private async recordIntegrityFailure(
    documentId: string,
    reason: string,
    versionId: string,
    evidence: Record<string, unknown> = {},
  ) {
    const client: PoolClient = await this.dependencies.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "update documents set status='INTEGRITY_FAILED' where id=$1 and status='PROCESSING'",
        [documentId],
      );
      await appendAuditEventInTransaction(
        client,
        {
          documentId,
          actorType: "SYSTEM",
          eventType: "INTEGRITY_FAILED",
          details: { reason, versionId, phase: "finalization", ...evidence },
        },
        auditService,
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

export const finalizationService = new FinalizationService({
  pool,
  storage: documentStorage,
  pdf: pdfService,
  integrity: integrityService,
});
