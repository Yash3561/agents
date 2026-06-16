import { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import type { ConversationSession } from "~/lib/session.server";

/**
 * Shopify's checkout_url is shaped https://{shop}/cart/c/{token}?key=...
 * The {token} segment is what orders/paid webhooks expose as cart_token,
 * letting us match a completed order back to the conversation that produced it.
 */
export function extractCheckoutToken(checkoutUrl?: string): string | undefined {
  if (!checkoutUrl) return undefined;
  return checkoutUrl.match(/\/cart\/c\/([^/?]+)/)?.[1];
}

/**
 * Write-through persistence of conversation state to Postgres, called once per
 * turn from the chat route. Fire-and-forget — never blocks or fails the SSE
 * response if Postgres is briefly unavailable.
 */
export async function persistConversationTurn(opts: {
  shopDomain: string;
  sessionId: string;
  customerId?: string;
  session: ConversationSession;
  checkoutUrl?: string;
  discountCode?: string;
  escalateToHuman?: boolean;
  agentTrace: string[];
}): Promise<void> {
  const { shopDomain, sessionId, customerId, session, checkoutUrl, discountCode, escalateToHuman, agentTrace } = opts;
  const checkoutToken = extractCheckoutToken(checkoutUrl);

  await prisma.conversation.upsert({
    where: { shopDomain_sessionId: { shopDomain, sessionId } },
    create: {
      shopDomain,
      sessionId,
      customerId,
      messages: session.conversation_history as unknown as Prisma.InputJsonValue,
      messageCount: session.conversation_history.length,
      cartId: session.cart_id,
      checkoutToken,
      discountCode,
      escalated: !!escalateToHuman,
      agentTrace,
    },
    update: {
      messages: session.conversation_history as unknown as Prisma.InputJsonValue,
      messageCount: session.conversation_history.length,
      cartId: session.cart_id,
      ...(checkoutToken ? { checkoutToken } : {}),
      ...(discountCode ? { discountCode } : {}),
      ...(escalateToHuman ? { escalated: true } : {}),
      agentTrace,
    },
  });
}
