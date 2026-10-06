-- Keep document lifecycle transitions explicit and integrity failures terminal.
CREATE FUNCTION guard_document_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;

  IF (OLD.status = 'DRAFT' AND NEW.status IN ('PENDING', 'CANCELLED', 'INTEGRITY_FAILED'))
     OR (OLD.status = 'PENDING' AND NEW.status IN ('PROCESSING', 'CANCELLED', 'INTEGRITY_FAILED'))
     OR (OLD.status = 'PROCESSING' AND NEW.status IN ('COMPLETED', 'INTEGRITY_FAILED'))
     OR (OLD.status = 'COMPLETED' AND NEW.status = 'INTEGRITY_FAILED') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid document status transition from % to %', OLD.status, NEW.status;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER a_document_status_transition_guard
BEFORE UPDATE OF status ON documents
FOR EACH ROW EXECUTE FUNCTION guard_document_status_transition();
--> statement-breakpoint
CREATE FUNCTION require_integrity_failure_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'INTEGRITY_FAILED' AND OLD.status IS DISTINCT FROM 'INTEGRITY_FAILED' THEN
    IF NEW.current_version_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM audit_events e
      WHERE e.document_id = NEW.id
        AND e.event_type = 'INTEGRITY_FAILED'
        AND e.details->>'versionId' = NEW.current_version_id::text
    ) THEN
      RAISE EXCEPTION 'integrity failure status requires matching audit evidence';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER integrity_failure_audit_guard
AFTER UPDATE OF status ON documents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_integrity_failure_audit();
