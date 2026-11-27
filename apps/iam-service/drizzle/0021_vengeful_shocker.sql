CREATE TABLE "oidc_login_states" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_slug" text NOT NULL,
	"nonce" text NOT NULL,
	"verifier_enc" text NOT NULL,
	"browser_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_login_states_nonce_key" ON "oidc_login_states" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "idx_oidc_login_states_expiry" ON "oidc_login_states" USING btree ("expires_at");