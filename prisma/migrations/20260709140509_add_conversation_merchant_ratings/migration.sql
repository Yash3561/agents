-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "merchantThumbsUp" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Conversation" ADD COLUMN "merchantThumbsDown" INTEGER NOT NULL DEFAULT 0;
