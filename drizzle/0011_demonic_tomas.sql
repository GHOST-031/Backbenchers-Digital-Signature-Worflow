ALTER TABLE "revoked_sessions" DROP CONSTRAINT "revoked_sessions_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "revoked_sessions" ADD CONSTRAINT "revoked_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revoked_sessions" ADD CONSTRAINT "revoked_sessions_digest_length" CHECK (octet_length("revoked_sessions"."token_digest") = 32);