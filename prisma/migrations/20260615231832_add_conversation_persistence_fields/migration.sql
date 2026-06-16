-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "checkoutToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_shopDomain_sessionId_key" ON "Conversation"("shopDomain", "sessionId");

-- CreateIndex
CREATE INDEX "Conversation_checkoutToken_idx" ON "Conversation"("checkoutToken");
