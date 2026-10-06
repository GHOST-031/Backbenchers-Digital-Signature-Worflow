ALTER TYPE "public"."audit_event_type" ADD VALUE 'SIGNERS_ASSIGNED' BEFORE 'DOCUMENT_VIEWED';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'SIGNATURE_FIELD_CREATED' BEFORE 'DOCUMENT_VIEWED';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'SIGNATURE_FIELD_UPDATED' BEFORE 'DOCUMENT_VIEWED';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'SIGNATURE_FIELD_DELETED' BEFORE 'DOCUMENT_VIEWED';--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "page_count" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "document_versions" ALTER COLUMN "page_count" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signers_doc_user_uq" ON "signers" USING btree ("document_id","user_id") WHERE "signers"."user_id" is not null;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_page_count_check" CHECK ("document_versions"."page_count" between 1 and 50);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_document_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'document versions cannot be deleted';
  END IF;
  IF OLD.state <> 'SOURCE' THEN
    RAISE EXCEPTION 'sealed or superseded document versions are immutable';
  END IF;
  IF ROW(NEW.id, NEW.document_id, NEW.version_number, NEW.object_key, NEW.created_by_user_id, NEW.page_count, NEW.sha256, NEW.byte_length, NEW.media_type, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.document_id, OLD.version_number, OLD.object_key, OLD.created_by_user_id, OLD.page_count, OLD.sha256, OLD.byte_length, OLD.media_type, OLD.created_at) THEN
    RAISE EXCEPTION 'document version content metadata is immutable';
  END IF;
  IF NEW.state <> 'SEALED' AND NEW.pdf_signature_metadata IS DISTINCT FROM OLD.pdf_signature_metadata THEN
    RAISE EXCEPTION 'source or superseded PDF signature metadata is immutable';
  END IF;
  IF NEW.state NOT IN ('SOURCE', 'SEALED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'invalid document version state transition';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION protect_draft_signer_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  document_state document_status;
  target_document_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN target_document_id := OLD.document_id;
  ELSE target_document_id := NEW.document_id;
  END IF;
  SELECT status INTO document_state FROM documents WHERE id = target_document_id FOR UPDATE;
  IF document_state IS DISTINCT FROM 'DRAFT' THEN
    -- The token digest is an access credential and may rotate at send time; it does not change signer assignment.
    IF TG_OP <> 'UPDATE' OR ROW(NEW.id, NEW.document_id, NEW.sequence, NEW.role, NEW.full_name, NEW.email, NEW.user_id)
       IS DISTINCT FROM ROW(OLD.id, OLD.document_id, OLD.sequence, OLD.role, OLD.full_name, OLD.email, OLD.user_id) THEN
      RAISE EXCEPTION 'signer configuration is frozen after draft';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER signers_draft_configuration BEFORE INSERT OR UPDATE OR DELETE ON signers FOR EACH ROW EXECUTE FUNCTION protect_draft_signer_configuration();
--> statement-breakpoint
CREATE FUNCTION protect_draft_signature_fields() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  document_state document_status;
  target_document_id uuid;
  version_page_count integer;
BEGIN
  IF TG_OP = 'DELETE' THEN target_document_id := OLD.document_id;
  ELSE target_document_id := NEW.document_id;
  END IF;
  SELECT status INTO document_state FROM documents WHERE id = target_document_id FOR UPDATE;
  IF document_state IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'signature fields are frozen after draft';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT page_count INTO version_page_count
      FROM document_versions
      WHERE document_id = NEW.document_id AND id = NEW.source_version_id;
    IF version_page_count IS NULL OR NEW.page_number > version_page_count THEN
      RAISE EXCEPTION 'signature field page is outside its source PDF';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER signature_fields_draft_only BEFORE INSERT OR UPDATE OR DELETE ON signature_fields FOR EACH ROW EXECUTE FUNCTION protect_draft_signature_fields();
