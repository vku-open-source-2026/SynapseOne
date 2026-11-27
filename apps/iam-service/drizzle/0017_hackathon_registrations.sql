CREATE TABLE "hackathon_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_name" text NOT NULL,
	"captain_name" text NOT NULL,
	"captain_email" text NOT NULL,
	"captain_phone" text NOT NULL,
	"captain_student_id" text NOT NULL,
	"member_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"project_idea" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"review_note" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"api_key_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hackathon_registrations_team_name_key" ON "hackathon_registrations" USING btree (lower("team_name"));--> statement-breakpoint
CREATE UNIQUE INDEX "hackathon_registrations_captain_email_key" ON "hackathon_registrations" USING btree (lower("captain_email"));--> statement-breakpoint
CREATE INDEX "idx_hackathon_registrations_status" ON "hackathon_registrations" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_hackathon_registrations_created_at" ON "hackathon_registrations" USING btree ("created_at" DESC NULLS LAST);