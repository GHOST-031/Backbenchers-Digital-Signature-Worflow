CREATE TYPE "public"."actor_type" AS ENUM('REQUESTER', 'SIGNER', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."audit_event_type" AS ENUM('DOCUMENT_CREATED', 'DOCUMENT_VIEWED', 'FIELD_SIGNED', 'DOCUMENT_RECIPIENT_COMPLETED', 'DOCUMENT_SEALED', 'INTEGRITY_VERIFIED', 'INTEGRITY_FAILED');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('DRAFT', 'PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED', 'INTEGRITY_FAILED');--> statement-breakpoint
CREATE TYPE "public"."field_type" AS ENUM('SIGNATURE', 'INITIALS', 'DATE', 'TEXT');--> statement-breakpoint
CREATE TYPE "public"."letter_type" AS ENUM('OD', 'PERMISSION');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."signature_method" AS ENUM('DRAWN', 'TYPED');--> statement-breakpoint
CREATE TYPE "public"."signer_role" AS ENUM('STUDENT', 'FACULTY_ADVISOR', 'HOD');--> statement-breakpoint
CREATE TYPE "public"."signer_status" AS ENUM('PENDING', 'ACTIVE', 'SIGNED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."version_state" AS ENUM('SOURCE', 'SEALED', 'SUPERSEDED');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"event_type" "audit_event_type" NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_user_id" uuid,
	"actor_signer_id" uuid,
	"view_id" uuid,
	"signature_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" jsonb NOT NULL,
	"previous_hash" "bytea" NOT NULL,
	"event_hash" "bytea" NOT NULL,
	"event_signature" "bytea" NOT NULL,
	"kms_key_version" text NOT NULL,
	CONSTRAINT "audit_actor_identity_check" CHECK (("audit_events"."actor_type" = 'REQUESTER' and "audit_events"."actor_user_id" is not null and "audit_events"."actor_signer_id" is null) or ("audit_events"."actor_type" = 'SIGNER' and "audit_events"."actor_signer_id" is not null and "audit_events"."actor_user_id" is null) or ("audit_events"."actor_type" = 'SYSTEM' and "audit_events"."actor_user_id" is null and "audit_events"."actor_signer_id" is null))
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"object_key" text NOT NULL,
	"sha256" "bytea" NOT NULL,
	"byte_length" bigint NOT NULL,
	"media_type" text DEFAULT 'application/pdf' NOT NULL,
	"state" "version_state" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sealed_at" timestamp with time zone,
	"pdf_signature_metadata" jsonb,
	"integrity_manifest" jsonb,
	"manifest_signature" "bytea",
	"kms_key_version" text,
	CONSTRAINT "document_versions_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "document_versions_number_positive" CHECK ("document_versions"."version_number" > 0),
	CONSTRAINT "document_versions_digest_length" CHECK (octet_length("document_versions"."sha256") = 32),
	CONSTRAINT "document_versions_length_positive" CHECK ("document_versions"."byte_length" > 0),
	CONSTRAINT "document_versions_pdf_type" CHECK ("document_versions"."media_type" = 'application/pdf'),
	CONSTRAINT "document_versions_seal_metadata" CHECK (("document_versions"."state" = 'SOURCE' and "document_versions"."manifest_signature" is null and "document_versions"."integrity_manifest" is null) or ("document_versions"."state" <> 'SOURCE' and "document_versions"."sealed_at" is not null and "document_versions"."integrity_manifest" is not null and "document_versions"."manifest_signature" is not null and "document_versions"."kms_key_version" is not null))
);
--> statement-breakpoint
CREATE TABLE "document_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"signer_id" uuid,
	"user_id" uuid,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" uuid NOT NULL,
	"ip_address" text,
	"user_agent" text,
	CONSTRAINT "document_views_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"letter_type" "letter_type" NOT NULL,
	"title" text NOT NULL,
	"status" "document_status" DEFAULT 'DRAFT' NOT NULL,
	"current_version_id" uuid,
	"audit_next_sequence" bigint DEFAULT 1 NOT NULL,
	"audit_head_hash" "bytea" DEFAULT decode(repeat('00', 32), 'hex') NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integrity_manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"digest" "bytea" NOT NULL,
	"canonical_manifest" jsonb NOT NULL,
	"signature" "bytea" NOT NULL,
	"signing_time" timestamp with time zone DEFAULT now() NOT NULL,
	"key_version" text NOT NULL,
	CONSTRAINT "integrity_manifests_version_id_unique" UNIQUE("version_id"),
	CONSTRAINT "manifest_digest_length" CHECK (octet_length("integrity_manifests"."digest") = 32)
);
--> statement-breakpoint
CREATE TABLE "outbox_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" varchar(120) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signature_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"source_version_id" uuid NOT NULL,
	"assigned_signer_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"x_norm" numeric(8, 7) NOT NULL,
	"y_norm" numeric(8, 7) NOT NULL,
	"width_norm" numeric(8, 7) NOT NULL,
	"height_norm" numeric(8, 7) NOT NULL,
	"field_type" "field_type" NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fields_page_check" CHECK ("signature_fields"."page_number" > 0),
	CONSTRAINT "fields_x_check" CHECK ("signature_fields"."x_norm" >= 0 and "signature_fields"."x_norm" <= 1),
	CONSTRAINT "fields_y_check" CHECK ("signature_fields"."y_norm" >= 0 and "signature_fields"."y_norm" <= 1),
	CONSTRAINT "fields_width_check" CHECK ("signature_fields"."width_norm" > 0 and "signature_fields"."width_norm" <= 1),
	CONSTRAINT "fields_height_check" CHECK ("signature_fields"."height_norm" > 0 and "signature_fields"."height_norm" <= 1),
	CONSTRAINT "fields_geometry_bounds_check" CHECK ("signature_fields"."x_norm" + "signature_fields"."width_norm" <= 1 and "signature_fields"."y_norm" + "signature_fields"."height_norm" <= 1)
);
--> statement-breakpoint
CREATE TABLE "signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"signer_id" uuid NOT NULL,
	"method" "signature_method" NOT NULL,
	"value" text,
	"image_object_key" text,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" uuid NOT NULL,
	"client_metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "signers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"role" "signer_role" NOT NULL,
	"full_name" text NOT NULL,
	"email" varchar(320) NOT NULL,
	"user_id" uuid,
	"identity_subject" text,
	"token_digest" "bytea" NOT NULL,
	"status" "signer_status" DEFAULT 'PENDING' NOT NULL,
	"invited_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	CONSTRAINT "signers_token_digest_unique" UNIQUE("token_digest"),
	CONSTRAINT "signers_sequence_check" CHECK (("signers"."sequence" = 1 and "signers"."role" = 'STUDENT') or ("signers"."sequence" = 2 and "signers"."role" = 'FACULTY_ADVISOR') or ("signers"."sequence" = 3 and "signers"."role" = 'HOD'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audit_doc_sequence_uq" ON "audit_events" USING btree ("document_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_view_uq" ON "audit_events" USING btree ("view_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_signature_uq" ON "audit_events" USING btree ("signature_id");--> statement-breakpoint
CREATE INDEX "audit_doc_sequence_idx" ON "audit_events" USING btree ("document_id","sequence");--> statement-breakpoint
CREATE INDEX "audit_doc_occurred_idx" ON "audit_events" USING btree ("document_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_type_occurred_idx" ON "audit_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_doc_number_uq" ON "document_versions" USING btree ("document_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_id_doc_uq" ON "document_versions" USING btree ("id","document_id");--> statement-breakpoint
CREATE INDEX "document_versions_doc_number_idx" ON "document_versions" USING btree ("document_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "views_id_doc_uq" ON "document_views" USING btree ("id","document_id");--> statement-breakpoint
CREATE INDEX "views_doc_viewed_idx" ON "document_views" USING btree ("document_id","viewed_at");--> statement-breakpoint
CREATE INDEX "views_signer_viewed_idx" ON "document_views" USING btree ("signer_id","viewed_at");--> statement-breakpoint
CREATE INDEX "documents_owner_created_idx" ON "documents" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "documents_status_created_idx" ON "documents" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "outbox_status_available_idx" ON "outbox_jobs" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fields_id_signer_uq" ON "signature_fields" USING btree ("id","assigned_signer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fields_id_signer_doc_uq" ON "signature_fields" USING btree ("id","assigned_signer_id","document_id");--> statement-breakpoint
CREATE INDEX "fields_doc_signer_idx" ON "signature_fields" USING btree ("document_id","assigned_signer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signatures_field_uq" ON "signatures" USING btree ("field_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signatures_signer_request_uq" ON "signatures" USING btree ("signer_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signatures_id_doc_uq" ON "signatures" USING btree ("id","document_id");--> statement-breakpoint
CREATE INDEX "signatures_signer_signed_idx" ON "signatures" USING btree ("signer_id","signed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "signers_doc_sequence_uq" ON "signers" USING btree ("document_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "signers_doc_role_uq" ON "signers" USING btree ("document_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "signers_id_doc_uq" ON "signers" USING btree ("id","document_id");--> statement-breakpoint
CREATE INDEX "signers_doc_status_sequence_idx" ON "signers" USING btree ("document_id","status","sequence");--> statement-breakpoint
