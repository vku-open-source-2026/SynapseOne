CREATE TABLE IF NOT EXISTS "synapseone_runner_usage_hourly" (
  "instance_id" text NOT NULL,
  "runner_id" text NOT NULL,
  "hour_start" timestamp with time zone NOT NULL,
  "samples" integer DEFAULT 0 NOT NULL,
  "cpu_used_sum" double precision DEFAULT 0 NOT NULL,
  "cpu_limit_sum" double precision DEFAULT 0 NOT NULL,
  "memory_used_sum" double precision DEFAULT 0 NOT NULL,
  "memory_limit_sum" double precision DEFAULT 0 NOT NULL,
  "max_cpu_percent" double precision DEFAULT 0 NOT NULL,
  "max_memory_used_mb" double precision DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "synapseone_runner_usage_hourly_instance_id_hour_start_pk" PRIMARY KEY("instance_id","hour_start")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_synapseone_runner_usage_runner_hour" ON "synapseone_runner_usage_hourly" ("runner_id","hour_start" DESC);
