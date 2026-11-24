ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "consumed_at" timestamp with time zone;
