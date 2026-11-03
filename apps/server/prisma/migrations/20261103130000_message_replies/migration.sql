-- Link replies to their original message. reply_to_id already exists.
CREATE INDEX IF NOT EXISTS "messages_reply_to_id_idx" ON "messages"("reply_to_id");
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
