-- Add escalation fields to Conversation
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "routeReason" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "customerEmail" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMP(3);

-- Add settings fields to Merchant
ALTER TABLE "Merchant" ADD COLUMN IF NOT EXISTS "customFaqs" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "Merchant" ADD COLUMN IF NOT EXISTS "quickReplies" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Make botName nullable (was required)
ALTER TABLE "Merchant" ALTER COLUMN "botName" DROP NOT NULL;

-- Change escalationEmailEnabled default to false
ALTER TABLE "Merchant" ALTER COLUMN "escalationEmailEnabled" SET DEFAULT false;
