-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "qaMeta" JSONB,
ADD COLUMN     "qualityScore" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "insightsJson" JSONB,
ADD COLUMN     "revenueNarrative" JSONB;
