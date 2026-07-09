-- CreateTable
CREATE TABLE "LlmUsage" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "agent" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "callCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LlmUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LlmUsage_shopDomain_idx" ON "LlmUsage"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "LlmUsage_shopDomain_date_agent_key" ON "LlmUsage"("shopDomain", "date", "agent");
