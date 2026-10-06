import {
  pgEnum,
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  customType,
  numeric,
  uniqueIndex,
  index,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const letterType = pgEnum("letter_type", ["OD", "PERMISSION"]);
export const documentStatus = pgEnum("document_status", [
  "DRAFT",
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "CANCELLED",
  "INTEGRITY_FAILED",
]);
export const signerRole = pgEnum("signer_role", [
  "STUDENT",
  "FACULTY_ADVISOR",
  "HOD",
]);
export const signerStatus = pgEnum("signer_status", [
  "PENDING",
  "ACTIVE",
  "SIGNED",
  "REVOKED",
]);
export const versionState = pgEnum("version_state", [
  "SOURCE",
  "SEALED",
  "SUPERSEDED",
]);
export const fieldType = pgEnum("field_type", [
  "SIGNATURE",
  "INITIALS",
  "DATE",
  "TEXT",
]);
export const signatureMethod = pgEnum("signature_method", ["DRAWN", "TYPED"]);
export const auditEventType = pgEnum("audit_event_type", [
  "DOCUMENT_CREATED",
  "DOCUMENT_SENT",
  "SIGNERS_ASSIGNED",
  "SIGNATURE_FIELD_CREATED",
  "SIGNATURE_FIELD_UPDATED",
  "SIGNATURE_FIELD_DELETED",
  "DOCUMENT_VIEWED",
  "FIELD_SIGNED",
  "DOCUMENT_RECIPIENT_COMPLETED",
  "DOCUMENT_SEALED",
  "INTEGRITY_VERIFIED",
  "INTEGRITY_FAILED",
]);
export const actorType = pgEnum("actor_type", [
  "REQUESTER",
  "SIGNER",
  "SYSTEM",
]);
export const outboxStatus = pgEnum("outbox_status", [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const revokedSessions = pgTable(
  "revoked_sessions",
  {
    tokenDigest: bytea("token_digest").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("revoked_sessions_user_idx").on(t.userId),
    check(
      "revoked_sessions_digest_length",
      sql`octet_length(${t.tokenDigest}) = 32`,
    ),
  ],
);
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id),
    letterType: letterType("letter_type").notNull(),
    title: text("title").notNull(),
    status: documentStatus("status").notNull().default("DRAFT"),
    currentVersionId: uuid("current_version_id"),
    auditNextSequence: bigint("audit_next_sequence", { mode: "bigint" })
      .notNull()
      .default(sql`1`),
    auditHeadHash: bytea("audit_head_hash")
      .notNull()
      .default(sql`decode(repeat('00', 32), 'hex')`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("documents_owner_created_idx").on(t.ownerUserId, t.createdAt),
    index("documents_status_created_idx").on(t.status, t.createdAt),
  ],
);
export const signers = pgTable(
  "signers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    role: signerRole("role").notNull(),
    fullName: text("full_name").notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    userId: uuid("user_id").references(() => users.id),
    identitySubject: text("identity_subject"),
    tokenDigest: bytea("token_digest").notNull().unique(),
    status: signerStatus("status").notNull().default("PENDING"),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    signedAt: timestamp("signed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("signers_doc_sequence_uq").on(t.documentId, t.sequence),
    uniqueIndex("signers_doc_role_uq").on(t.documentId, t.role),
    uniqueIndex("signers_one_active_per_doc_uq")
      .on(t.documentId)
      .where(sql`${t.status} = 'ACTIVE'`),
    uniqueIndex("signers_doc_user_uq")
      .on(t.documentId, t.userId)
      .where(sql`${t.userId} is not null`),
    uniqueIndex("signers_id_doc_uq").on(t.id, t.documentId),
    uniqueIndex("signers_doc_id_uq").on(t.documentId, t.id),
    index("signers_doc_status_sequence_idx").on(
      t.documentId,
      t.status,
      t.sequence,
    ),
    check(
      "signers_sequence_check",
      sql`(${t.sequence} = 1 and ${t.role} = 'STUDENT') or (${t.sequence} = 2 and ${t.role} = 'FACULTY_ADVISOR') or (${t.sequence} = 3 and ${t.role} = 'HOD')`,
    ),
  ],
);
export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    objectKey: text("object_key").notNull().unique(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    pageCount: integer("page_count").notNull(),
    sha256: bytea("sha256").notNull(),
    byteLength: bigint("byte_length", { mode: "number" }).notNull(),
    mediaType: text("media_type").notNull().default("application/pdf"),
    state: versionState("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sealedAt: timestamp("sealed_at", { withTimezone: true }),
    pdfSignatureMetadata: jsonb("pdf_signature_metadata"),
    integrityManifest: jsonb("integrity_manifest"),
    manifestSignature: bytea("manifest_signature"),
    kmsKeyVersion: text("kms_key_version"),
  },
  (t) => [
    uniqueIndex("document_versions_doc_number_uq").on(
      t.documentId,
      t.versionNumber,
    ),
    uniqueIndex("document_versions_one_sealed_per_document_uq")
      .on(t.documentId)
      .where(sql`${t.state} = 'SEALED'`),
    uniqueIndex("document_versions_id_doc_uq").on(t.id, t.documentId),
    uniqueIndex("document_versions_doc_id_uq").on(t.documentId, t.id),
    index("document_versions_doc_number_idx").on(t.documentId, t.versionNumber),
    check("document_versions_number_positive", sql`${t.versionNumber} > 0`),
    check(
      "document_versions_digest_length",
      sql`octet_length(${t.sha256}) = 32`,
    ),
    check("document_versions_length_positive", sql`${t.byteLength} > 0`),
    check(
      "document_versions_page_count_check",
      sql`${t.pageCount} between 1 and 50`,
    ),
    check(
      "document_versions_pdf_type",
      sql`${t.mediaType} = 'application/pdf'`,
    ),
    check(
      "document_versions_seal_metadata",
      sql`(${t.state} <> 'SEALED' and ${t.sealedAt} is null and ${t.integrityManifest} is null and ${t.manifestSignature} is null and ${t.kmsKeyVersion} is null) or (${t.state} = 'SEALED' and ${t.sealedAt} is not null and ${t.integrityManifest} is not null and ${t.manifestSignature} is not null and ${t.kmsKeyVersion} is not null)`,
    ),
  ],
);
export const signatureFields = pgTable(
  "signature_fields",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    sourceVersionId: uuid("source_version_id").notNull(),
    assignedSignerId: uuid("assigned_signer_id").notNull(),
    pageNumber: integer("page_number").notNull(),
    xNorm: numeric("x_norm", { precision: 8, scale: 7 }).notNull(),
    yNorm: numeric("y_norm", { precision: 8, scale: 7 }).notNull(),
    widthNorm: numeric("width_norm", { precision: 8, scale: 7 }).notNull(),
    heightNorm: numeric("height_norm", { precision: 8, scale: 7 }).notNull(),
    fieldType: fieldType("field_type").notNull(),
    required: boolean("required").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.documentId, t.sourceVersionId],
      foreignColumns: [documentVersions.documentId, documentVersions.id],
      name: "fields_doc_source_version_fk",
    }),
    foreignKey({
      columns: [t.assignedSignerId, t.documentId],
      foreignColumns: [signers.id, signers.documentId],
      name: "fields_assigned_signer_doc_fk",
    }),
    uniqueIndex("fields_id_signer_uq").on(t.id, t.assignedSignerId),
    uniqueIndex("fields_id_signer_doc_uq").on(
      t.id,
      t.assignedSignerId,
      t.documentId,
    ),
    index("fields_doc_signer_idx").on(t.documentId, t.assignedSignerId),
    check("fields_page_check", sql`${t.pageNumber} > 0`),
    check("fields_x_check", sql`${t.xNorm} >= 0 and ${t.xNorm} <= 1`),
    check("fields_y_check", sql`${t.yNorm} >= 0 and ${t.yNorm} <= 1`),
    check(
      "fields_width_check",
      sql`${t.widthNorm} > 0 and ${t.widthNorm} <= 1`,
    ),
    check(
      "fields_height_check",
      sql`${t.heightNorm} > 0 and ${t.heightNorm} <= 1`,
    ),
    check(
      "fields_geometry_bounds_check",
      sql`${t.xNorm} + ${t.widthNorm} <= 1 and ${t.yNorm} + ${t.heightNorm} <= 1`,
    ),
  ],
);
export const signatures = pgTable(
  "signatures",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id").notNull(),
    fieldId: uuid("field_id").notNull(),
    signerId: uuid("signer_id").notNull(),
    method: signatureMethod("method").notNull(),
    value: text("value"),
    imageObjectKey: text("image_object_key"),
    signedAt: timestamp("signed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    requestId: uuid("request_id").notNull(),
    clientMetadata: jsonb("client_metadata"),
  },
  (t) => [
    foreignKey({
      columns: [t.fieldId, t.signerId, t.documentId],
      foreignColumns: [
        signatureFields.id,
        signatureFields.assignedSignerId,
        signatureFields.documentId,
      ],
      name: "signatures_field_signer_doc_fk",
    }),
    uniqueIndex("signatures_field_uq").on(t.fieldId),
    uniqueIndex("signatures_signer_request_uq").on(t.signerId, t.requestId),
    uniqueIndex("signatures_id_doc_uq").on(t.id, t.documentId),
    index("signatures_signer_signed_idx").on(t.signerId, t.signedAt),
    check(
      "signatures_method_value_check",
      sql`(${t.method} = 'TYPED' and ${t.value} is not null and length(btrim(${t.value})) between 1 and 200 and ${t.imageObjectKey} is null) or (${t.method} = 'DRAWN' and ${t.value} is null and ${t.imageObjectKey} like 'signatures/%')`,
    ),
  ],
);
export const documentViews = pgTable(
  "document_views",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    versionId: uuid("version_id").notNull(),
    signerId: uuid("signer_id"),
    userId: uuid("user_id").references(() => users.id),
    viewedAt: timestamp("viewed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    requestId: uuid("request_id").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (t) => [
    foreignKey({
      columns: [t.documentId, t.versionId],
      foreignColumns: [documentVersions.documentId, documentVersions.id],
      name: "views_doc_version_fk",
    }),
    foreignKey({
      columns: [t.documentId, t.signerId],
      foreignColumns: [signers.documentId, signers.id],
      name: "views_doc_signer_fk",
    }),
    uniqueIndex("views_id_doc_uq").on(t.id, t.documentId),
    index("views_doc_viewed_idx").on(t.documentId, t.viewedAt),
    index("views_signer_viewed_idx").on(t.signerId, t.viewedAt),
    check(
      "views_exactly_one_actor_check",
      sql`(${t.signerId} is null) <> (${t.userId} is null)`,
    ),
  ],
);
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    eventType: auditEventType("event_type").notNull(),
    actorType: actorType("actor_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    actorSignerId: uuid("actor_signer_id"),
    viewId: uuid("view_id"),
    signatureId: uuid("signature_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    details: jsonb("details").notNull(),
    previousHash: bytea("previous_hash").notNull(),
    eventHash: bytea("event_hash").notNull(),
    eventSignature: bytea("event_signature").notNull(),
    kmsKeyVersion: text("kms_key_version").notNull(),
  },
  (t) => [
    uniqueIndex("audit_doc_sequence_uq").on(t.documentId, t.sequence),
    uniqueIndex("audit_view_uq").on(t.viewId),
    uniqueIndex("audit_signature_uq").on(t.signatureId),
    foreignKey({
      columns: [t.documentId, t.actorSignerId],
      foreignColumns: [signers.documentId, signers.id],
      name: "audit_doc_signer_fk",
    }),
    foreignKey({
      columns: [t.viewId, t.documentId],
      foreignColumns: [documentViews.id, documentViews.documentId],
      name: "audit_view_doc_fk",
    }),
    foreignKey({
      columns: [t.signatureId, t.documentId],
      foreignColumns: [signatures.id, signatures.documentId],
      name: "audit_signature_doc_fk",
    }),
    check(
      "audit_actor_identity_check",
      sql`(${t.actorType} = 'REQUESTER' and ${t.actorUserId} is not null and ${t.actorSignerId} is null) or (${t.actorType} = 'SIGNER' and ${t.actorSignerId} is not null and ${t.actorUserId} is null) or (${t.actorType} = 'SYSTEM' and ${t.actorUserId} is null and ${t.actorSignerId} is null)`,
    ),
    index("audit_doc_sequence_idx").on(t.documentId, t.sequence),
    index("audit_doc_occurred_idx").on(t.documentId, t.occurredAt),
    index("audit_type_occurred_idx").on(t.eventType, t.occurredAt),
  ],
);
export const integrityManifests = pgTable(
  "integrity_manifests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id").notNull(),
    versionId: uuid("version_id").notNull().unique(),
    digest: bytea("digest").notNull(),
    canonicalManifest: jsonb("canonical_manifest").notNull(),
    signature: bytea("signature").notNull(),
    signingTime: timestamp("signing_time", { withTimezone: true })
      .notNull()
      .defaultNow(),
    keyVersion: text("key_version").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.documentId, t.versionId],
      foreignColumns: [documentVersions.documentId, documentVersions.id],
      name: "manifest_doc_version_fk",
    }),
    check("manifest_digest_length", sql`octet_length(${t.digest}) = 32`),
  ],
);
export const outboxJobs = pgTable(
  "outbox_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: varchar("type", { length: 120 }).notNull(),
    payload: jsonb("payload").notNull(),
    status: outboxStatus("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("outbox_status_available_idx").on(t.status, t.availableAt)],
);
