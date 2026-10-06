-- Custom SQL migration file, put your code below! --
CREATE FUNCTION reject_signature_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'persisted signatures are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER signatures_append_only
BEFORE UPDATE OR DELETE ON signatures
FOR EACH ROW EXECUTE FUNCTION reject_signature_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_document_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document version evidence is immutable';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION validate_sealed_version_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  document_state document_status;
  source_version_state version_state;
  source_version_id uuid;
  signer_count integer;
  signed_count integer;
BEGIN
  IF NEW.state <> 'SEALED' THEN RETURN NEW; END IF;

  SELECT status, current_version_id INTO document_state, source_version_id
    FROM documents WHERE id = NEW.document_id;
  IF document_state IS DISTINCT FROM 'PROCESSING' THEN
    RAISE EXCEPTION 'sealed versions require a processing document';
  END IF;
  SELECT state INTO source_version_state
    FROM document_versions
    WHERE document_id = NEW.document_id AND id = source_version_id;
  IF source_version_id IS NULL OR source_version_state IS DISTINCT FROM 'SOURCE' THEN
    RAISE EXCEPTION 'sealed versions require the current source version';
  END IF;

  SELECT count(*), count(*) FILTER (WHERE role IN ('STUDENT','FACULTY_ADVISOR','HOD') AND sequence IN (1,2,3) AND status='SIGNED' AND signed_at IS NOT NULL)
    INTO signer_count, signed_count
    FROM signers WHERE document_id = NEW.document_id;
  IF signer_count <> 3 OR signed_count <> 3 THEN
    RAISE EXCEPTION 'sealed versions require all ordered signers to complete';
  END IF;

  IF NEW.sealed_at IS NULL
     OR NEW.media_type <> 'application/pdf'
     OR octet_length(NEW.sha256) <> 32
     OR octet_length(NEW.manifest_signature) <> 64
     OR NEW.integrity_manifest->>'documentId' IS DISTINCT FROM NEW.document_id::text
     OR NEW.integrity_manifest->>'versionId' IS DISTINCT FROM NEW.id::text
     OR lower(NEW.integrity_manifest->>'sha256') IS DISTINCT FROM encode(NEW.sha256,'hex')
     OR NEW.integrity_manifest->>'keyVersion' IS DISTINCT FROM NEW.kms_key_version
     OR (NEW.integrity_manifest->>'signingTime')::timestamptz IS DISTINCT FROM NEW.sealed_at THEN
    RAISE EXCEPTION 'sealed version integrity evidence is incomplete or inconsistent';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sealed_version_insert_guard
BEFORE INSERT ON document_versions
FOR EACH ROW EXECUTE FUNCTION validate_sealed_version_insert();
--> statement-breakpoint
CREATE UNIQUE INDEX document_versions_one_sealed_per_document_uq
ON document_versions (document_id) WHERE state = 'SEALED';
--> statement-breakpoint
CREATE FUNCTION validate_completed_document_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  final_version document_versions%ROWTYPE;
  manifest integrity_manifests%ROWTYPE;
BEGIN
  IF NEW.status <> 'COMPLETED' THEN RETURN NEW; END IF;

  IF NEW.current_version_id IS NULL OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'completed documents require a final version and completion timestamp';
  END IF;
  SELECT * INTO final_version FROM document_versions
    WHERE document_id = NEW.id AND id = NEW.current_version_id AND state = 'SEALED';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'completed documents must point to a sealed final version';
  END IF;
  SELECT * INTO manifest FROM integrity_manifests
    WHERE document_id = NEW.id AND version_id = final_version.id;
  IF NOT FOUND
     OR manifest.digest IS DISTINCT FROM final_version.sha256
     OR manifest.canonical_manifest IS DISTINCT FROM final_version.integrity_manifest
     OR manifest.signature IS DISTINCT FROM final_version.manifest_signature
     OR manifest.key_version IS DISTINCT FROM final_version.kms_key_version
     OR manifest.signing_time IS DISTINCT FROM final_version.sealed_at THEN
    RAISE EXCEPTION 'completed documents require matching integrity manifest evidence';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM audit_events e
    WHERE e.document_id = NEW.id
      AND e.event_type = 'DOCUMENT_SEALED'
      AND e.details->>'versionId' = final_version.id::text
      AND lower(e.details->>'sha256') = encode(final_version.sha256,'hex')
  ) THEN
    RAISE EXCEPTION 'completed documents require a DOCUMENT_SEALED audit event';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER completed_document_evidence_guard
BEFORE INSERT OR UPDATE OF status, current_version_id, completed_at ON documents
FOR EACH ROW EXECUTE FUNCTION validate_completed_document_evidence();
