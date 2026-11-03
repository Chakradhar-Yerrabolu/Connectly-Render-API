ALTER TABLE "conversation_members"
  ADD COLUMN "is_favorite" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "is_locked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lock_secret_hash" TEXT;

CREATE TABLE "call_history_hidden" (
  "id" UUID NOT NULL,
  "call_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "hidden_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "call_history_hidden_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "call_history_hidden_call_id_user_id_key" ON "call_history_hidden"("call_id", "user_id");
CREATE INDEX "call_history_hidden_user_id_hidden_at_idx" ON "call_history_hidden"("user_id", "hidden_at");
ALTER TABLE "call_history_hidden" ADD CONSTRAINT "call_history_hidden_call_id_fkey"
  FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
