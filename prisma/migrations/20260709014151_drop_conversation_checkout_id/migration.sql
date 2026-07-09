-- AlterTable
-- Conversation.checkoutId was write-only and never read anywhere in the
-- codebase (superseded by checkoutToken, which is what orders/paid actually
-- matches against). Dropping dead column per issue #195.
ALTER TABLE "Conversation" DROP COLUMN "checkoutId";
