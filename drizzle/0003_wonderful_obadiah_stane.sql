ALTER TABLE "document_versions" DROP CONSTRAINT "document_versions_seal_metadata";--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_seal_metadata" CHECK (("document_versions"."state" <> 'SEALED' and "document_versions"."sealed_at" is null and "document_versions"."integrity_manifest" is null and "document_versions"."manifest_signature" is null and "document_versions"."kms_key_version" is null) or ("document_versions"."state" = 'SEALED' and "document_versions"."sealed_at" is not null and "document_versions"."integrity_manifest" is not null and "document_versions"."manifest_signature" is not null and "document_versions"."kms_key_version" is not null));
--> statement-breakpoint
CREATE FUNCTION reject_append_only_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_append_only_evidence_mutation();
--> statement-breakpoint
CREATE TRIGGER document_views_append_only BEFORE UPDATE OR DELETE ON document_views FOR EACH ROW EXECUTE FUNCTION reject_append_only_evidence_mutation();
--> statement-breakpoint
CREATE FUNCTION protect_document_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'document versions cannot be deleted';
  END IF;
  IF OLD.state <> 'SOURCE' THEN
    RAISE EXCEPTION 'sealed or superseded document versions are immutable';
  END IF;
  IF ROW(NEW.id, NEW.document_id, NEW.version_number, NEW.object_key, NEW.sha256, NEW.byte_length, NEW.media_type, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.document_id, OLD.version_number, OLD.object_key, OLD.sha256, OLD.byte_length, OLD.media_type, OLD.created_at) THEN
    RAISE EXCEPTION 'document version content metadata is immutable';
  END IF;
  IF NEW.state NOT IN ('SOURCE', 'SEALED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'invalid document version state transition';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER document_versions_immutable BEFORE UPDATE OR DELETE ON document_versions FOR EACH ROW EXECUTE FUNCTION protect_document_version();
