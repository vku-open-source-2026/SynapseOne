CREATE TABLE "org_quotas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"service" text NOT NULL,
	"requests_per_min" integer,
	"tokens_per_day" integer,
	"executions_per_hour" integer,
	"concurrent_executions" integer,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_quotas" ADD CONSTRAINT "org_quotas_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_quotas_org_service_key" ON "org_quotas" USING btree ("org_id","service");--> statement-breakpoint
CREATE INDEX "idx_org_quotas_org" ON "org_quotas" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_org_quotas_service" ON "org_quotas" USING btree ("service");