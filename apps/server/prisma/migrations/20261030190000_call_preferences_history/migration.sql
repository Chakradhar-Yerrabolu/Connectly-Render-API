ALTER TABLE "users" ADD COLUMN "ringtone_url" VARCHAR(2048), ADD COLUMN "caller_tune_url" VARCHAR(2048);
CREATE TABLE "calls" (
  "id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "caller_id" UUID NOT NULL,
  "mode" VARCHAR(10) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'RINGING',
  "started_at" TIMESTAMP(3),
  "ended_at" TIMESTAMP(3),
  "duration_seconds" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "calls_conversation_id_created_at_idx" ON "calls"("conversation_id", "created_at");
CREATE INDEX "calls_caller_id_created_at_idx" ON "calls"("caller_id", "created_at");
ALTER TABLE "calls" ADD CONSTRAINT "calls_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "calls" ADD CONSTRAINT "calls_caller_id_fkey" FOREIGN KEY ("caller_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
