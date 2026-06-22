-- Backfill firstUserMessage from the messages JSON array for all existing conversations
UPDATE "Conversation"
SET "firstUserMessage" = (
  SELECT elem->>'content'
  FROM jsonb_array_elements("messages"::jsonb) AS elem
  WHERE elem->>'role' = 'user'
  LIMIT 1
)
WHERE "firstUserMessage" IS NULL
  AND "messages" IS NOT NULL
  AND "messages"::text != '[]'
  AND jsonb_array_length("messages"::jsonb) > 0;
