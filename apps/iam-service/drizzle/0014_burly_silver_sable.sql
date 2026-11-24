ALTER TABLE "accounts" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "retired_by" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "retire_reason" text;