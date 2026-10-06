import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "@/db/client";
import { signingProvider } from "./signing-provider";

export interface AuditEventInput {
  id: string;
  documentId: string;
  actorType: "REQUESTER" | "SIGNER" | "SYSTEM";
  actorUserId: string | null;
  actorSignerId: string | null;
  viewId: string | null;
  signatureId: string | null;
  eventType: string;
  occurredAt: string;
  sequence: string;
  details: Record<string, unknown>;
  previousHash: string;
  kmsKeyVersion: string;
}
export interface AuditEventRecord extends AuditEventInput {
  eventHash: string;
  eventSignature: string;
}
export interface AuditSigningProvider {
  readonly keyVersion: string;
  signAudit(bytes: Uint8Array): Uint8Array;
  verifyAudit(bytes: Uint8Array, signature: Uint8Array): boolean;
}
export interface AuditService {
  readonly keyVersion: string;
  createEvent(input: AuditEventInput): AuditEventRecord;
  verifyChain(
    events: AuditEventRecord[],
    provider: AuditSigningProvider,
  ): boolean;
}
function canonical(value: AuditEventInput): Buffer {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return item;
  };
  return Buffer.from(JSON.stringify(normalize(value)));
}
export class ChainedAuditService implements AuditService {
  constructor(private readonly signer: AuditSigningProvider) {}
  get keyVersion(): string {
    return this.signer.keyVersion;
  }
  createEvent(input: AuditEventInput): AuditEventRecord {
    const hash = createHash("sha256").update(canonical(input)).digest();
    return {
      ...input,
      eventHash: hash.toString("hex"),
      eventSignature: Buffer.from(this.signer.signAudit(hash)).toString(
        "base64",
      ),
    };
  }
  verifyChain(events: AuditEventRecord[], provider = this.signer): boolean {
    let previous = Buffer.alloc(32).toString("hex");
    let sequence = 1n;
    for (const event of events) {
      if (
        event.previousHash !== previous ||
        BigInt(event.sequence) !== sequence
      )
        return false;
      const input: AuditEventInput = {
        id: event.id,
        documentId: event.documentId,
        actorType: event.actorType,
        actorUserId: event.actorUserId,
        actorSignerId: event.actorSignerId,
        viewId: event.viewId,
        signatureId: event.signatureId,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        sequence: event.sequence,
        details: event.details,
        previousHash: event.previousHash,
        kmsKeyVersion: event.kmsKeyVersion,
      };
      const hash = createHash("sha256").update(canonical(input)).digest();
      if (hash.toString("hex") !== event.eventHash) return false;
      try {
        if (
          !provider.verifyAudit(
            hash,
            Buffer.from(event.eventSignature, "base64"),
          )
        )
          return false;
      } catch {
        return false;
      }
      previous = event.eventHash;
      sequence++;
    }
    return true;
  }
}
export const auditService: AuditService = new ChainedAuditService(
  signingProvider,
);

export interface PersistAuditInput {
  documentId: string;
  actorUserId?: string;
  actorSignerId?: string;
  actorType: "REQUESTER" | "SIGNER" | "SYSTEM";
  eventType:
    | "DOCUMENT_CREATED"
    | "DOCUMENT_SENT"
    | "SIGNERS_ASSIGNED"
    | "SIGNATURE_FIELD_CREATED"
    | "SIGNATURE_FIELD_UPDATED"
    | "SIGNATURE_FIELD_DELETED"
    | "DOCUMENT_VIEWED"
    | "FIELD_SIGNED"
    | "DOCUMENT_RECIPIENT_COMPLETED"
    | "DOCUMENT_SEALED"
    | "INTEGRITY_VERIFIED"
    | "INTEGRITY_FAILED";
  details: Record<string, unknown>;
  viewId?: string;
  signatureId?: string;
}
export async function appendAuditEventInTransaction(
  client: PoolClient,
  input: PersistAuditInput,
  service: AuditService,
): Promise<AuditEventRecord> {
  const documentResult = await client.query<{
    audit_next_sequence: string;
    audit_head_hash: Buffer;
  }>(
    "select audit_next_sequence, audit_head_hash from documents where id = $1 for update",
    [input.documentId],
  );
  const document = documentResult.rows[0];
  if (!document) throw new Error("Document does not exist for audit event");
  const timeResult = await client.query<{ occurred_at: Date }>(
    "select clock_timestamp() as occurred_at",
  );
  const time = timeResult.rows[0];
  if (!time) throw new Error("Database timestamp could not be obtained");
  const record = service.createEvent({
    id: randomUUID(),
    documentId: input.documentId,
    actorType: input.actorType,
    actorUserId: input.actorUserId ?? null,
    actorSignerId: input.actorSignerId ?? null,
    viewId: input.viewId ?? null,
    signatureId: input.signatureId ?? null,
    eventType: input.eventType,
    occurredAt: time.occurred_at.toISOString(),
    sequence: String(document.audit_next_sequence),
    details: input.details,
    previousHash: document.audit_head_hash.toString("hex"),
    kmsKeyVersion: service.keyVersion,
  });
  await client.query(
    "insert into audit_events (id,document_id,sequence,event_type,actor_type,actor_user_id,actor_signer_id,view_id,signature_id,occurred_at,details,previous_hash,event_hash,event_signature,kms_key_version) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
    [
      record.id,
      input.documentId,
      record.sequence,
      input.eventType,
      input.actorType,
      input.actorUserId ?? null,
      input.actorSignerId ?? null,
      input.viewId ?? null,
      input.signatureId ?? null,
      time.occurred_at,
      input.details,
      Buffer.from(record.previousHash, "hex"),
      Buffer.from(record.eventHash, "hex"),
      Buffer.from(record.eventSignature, "base64"),
      service.keyVersion,
    ],
  );
  await client.query(
    "update documents set audit_next_sequence = $2, audit_head_hash = $3 where id = $1",
    [
      input.documentId,
      BigInt(record.sequence) + 1n,
      Buffer.from(record.eventHash, "hex"),
    ],
  );
  return record;
}

export async function persistAuditEvent(
  input: PersistAuditInput,
  service: AuditService,
): Promise<AuditEventRecord> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const record = await appendAuditEventInTransaction(client, input, service);
    await client.query("commit");
    return record;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
