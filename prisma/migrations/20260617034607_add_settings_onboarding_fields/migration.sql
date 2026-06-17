-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "escalationEmailEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "excludedPages" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "onboardingStep" INTEGER NOT NULL DEFAULT 1;
