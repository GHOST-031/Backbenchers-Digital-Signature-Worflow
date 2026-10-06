-- Custom SQL migration file, put your code below! --
CREATE FUNCTION reject_integrity_manifest_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'integrity manifests are append-only';
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER integrity_manifests_append_only
BEFORE UPDATE OR DELETE ON integrity_manifests
FOR EACH ROW EXECUTE FUNCTION reject_integrity_manifest_mutation();
