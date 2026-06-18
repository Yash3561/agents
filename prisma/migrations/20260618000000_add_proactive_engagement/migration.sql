-- AlterTable: add proactiveEngagementEnabled to Merchant
ALTER TABLE "Merchant" ADD COLUMN IF NOT EXISTS "proactiveEngagementEnabled" BOOLEAN NOT NULL DEFAULT true;
