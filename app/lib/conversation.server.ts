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
 * Send an escalation alert email via Resend when the AI can't resolve a
 * customer issue and escalates to human support. Fire-and-forget — graceful
 * no-op if RESEND_API_KEY is not configured.
 */
async function sendEscalationEmail(
  toEmail: string,
  sessionId: string,
  messages: unknown[],
  shop: string,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log('[NeonPing] Escalation email skipped — RESEND_API_KEY not set');
    return;
  }
  const transcript = (Array.isArray(messages) ? messages : [])
    .map((m: unknown) => {
      const msg = m as { role?: string; content?: string };
      return `${msg.role === 'user' ? 'Customer' : 'AI'}: ${msg.content ?? ''}`;
    })
    .join('\n');

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'NeonPing Alerts <alerts@neonping.com>',
      to: toEmail,
      subject: `Customer needs help — ${shop}`,
      text: `A conversation was escalated to human support.\n\nSession: ${sessionId}\nShop: ${shop}\n\nTranscript:\n${transcript}`,
    }),
  }).catch(e => console.error('[NeonPing] Escalation email error:', e));
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

  // Fire escalation email if needed — fetch merchant settings to check toggles
  if (escalateToHuman) {
    const merchant = await prisma.merchant.findUnique({ where: { shopDomain } }).catch(() => null);
    if (merchant?.escalationEmailEnabled && merchant?.supportEmail) {
      sendEscalationEmail(
        merchant.supportEmail,
        sessionId,
        session.conversation_history,
        shopDomain,
      ).catch(console.error);
    }
  }
}
