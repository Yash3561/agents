-- Conversation reads are now WhatsApp-scoped throughout the dashboard/inbox.
-- Keep legacy/null/widget rows queryable without letting the old widget value
-- silently default onto new rows from any remaining generic persistence path.
ALTER TABLE "Conversation" ALTER COLUMN "channel" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "Conversation_shopDomain_channel_startedAt_idx" ON "Conversation"("shopDomain", "channel", "startedAt");

-- LlmUsage is shop-scoped retention data. Remove historical telemetry for shops
-- that no longer have a Merchant row, then enforce cleanup on future shop deletes.
DELETE FROM "LlmUsage" u
WHERE NOT EXISTS (
  SELECT 1 FROM "Merchant" m WHERE m."shopDomain" = u."shopDomain"
);

-- AddForeignKey
ALTER TABLE "LlmUsage" ADD CONSTRAINT "LlmUsage_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Merchant"("shopDomain") ON DELETE CASCADE ON UPDATE CASCADE;
