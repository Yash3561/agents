-- AlterTable
ALTER TABLE "Conversation" ALTER COLUMN "channel" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "waAccessToken" TEXT,
ADD COLUMN     "waConnectedAt" TIMESTAMP(3),
ADD COLUMN     "waPhone" TEXT,
ADD COLUMN     "waPhoneNumberId" TEXT,
ADD COLUMN     "wabaId" TEXT;
