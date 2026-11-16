CREATE TABLE "synapseone_secret_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"secret_id" text NOT NULL,
	"version" integer NOT NULL,
	"value_enc" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "synapseone_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"account_id" text,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"scope" text DEFAULT 'tenant' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "synapseone_secret_versions_key" ON "synapseone_secret_versions" USING btree ("secret_id","version");--> statement-breakpoint
CREATE INDEX "idx_synapseone_secret_versions_secret" ON "synapseone_secret_versions" USING btree ("secret_id","version" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "synapseone_secrets_tenant_name_key" ON "synapseone_secrets" USING btree ("org_id","account_id","name");--> statement-breakpoint
CREATE INDEX "idx_synapseone_secrets_tenant" ON "synapseone_secrets" USING btree ("org_id","account_id");