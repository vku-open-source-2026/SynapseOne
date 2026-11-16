ALTER TABLE "organizations" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "suspended_by" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "suspend_reason" text;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD COLUMN "revoked_at" timestamp with time zone;