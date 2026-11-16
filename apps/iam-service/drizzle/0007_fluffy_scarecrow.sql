-- Platform administrators and cross-tenant audit index.
-- Idempotent on databases that already applied 0005/0006 (the generated
-- snapshot includes those tables; we keep the statements safe for both fresh
-- and existing databases).
CREATE TABLE IF NOT EXISTS "platform_admins" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"role" text DEFAULT 'auditor' NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"reason" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_account_roles" (
	"service_account_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "service_account_roles_service_account_id_role_id_pk" PRIMARY KEY("service_account_id","role_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_mfa" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret_enc" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"recovery_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_step" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enabled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "org_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'tenant' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_org_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "failed_login_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "service_account_roles" ADD CONSTRAINT "service_account_roles_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "service_account_roles" ADD CONSTRAINT "service_account_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "organizations" ADD CONSTRAINT "organizations_kind_check" CHECK ("kind" IN ('tenant','platform'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_platform_admins_role" ON "platform_admins" USING btree ("role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_platform_admins_revoked" ON "platform_admins" USING btree ("revoked_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_org_time" ON "audit_log" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_organizations_kind" ON "organizations" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_users_email_lower" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_users_created_at" ON "users" USING btree ("created_at" DESC NULLS LAST);
