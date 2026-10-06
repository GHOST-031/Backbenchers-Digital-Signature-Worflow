CREATE TABLE "revoked_sessions" (
	"token_digest" "bytea" PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "revoked_sessions" ADD CONSTRAINT "revoked_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "revoked_sessions_user_idx" ON "revoked_sessions" USING btree ("user_id");--> statement-breakpoint
