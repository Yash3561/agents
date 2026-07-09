import { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { redis } from "~/redis.server";
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
export async function sendEscalationEmail(
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
 * Plan-usage alert (80% warning / 100% limit reached), sent once per threshold
 * per billing cycle — dedup handled by the caller (billing.server.ts).
 * Graceful no-op if RESEND_API_KEY is not configured.
 */
export async function sendUsageAlertEmail(
  toEmail: string,
  shop: string,
  used: number,
  limit: number,
  level: number,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  const atLimit = level >= 100;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'NeonPing Alerts <alerts@neonping.com>',
      to: toEmail,
      subject: atLimit
        ? `NeonPing: conversation limit reached — chat is paused (${shop})`
        : `NeonPing: ${level}% of your monthly conversations used (${shop})`,
      text: atLimit
        ? `Your store ${shop} has used all ${limit} conversations in this billing cycle. New customer chats are paused until your plan resets or you upgrade.\n\nUpgrade: open NeonPing → Billing in your Shopify admin.`
        : `Your store ${shop} has used ${used} of ${limit} conversations (${level}%) this billing cycle. Once the limit is reached, new customer chats will be paused.\n\nUpgrade any time: open NeonPing → Billing in your Shopify admin.`,
    }),
  }).catch(e => console.error('[NeonPing] Usage alert email error:', e));
}

export interface StoredMessage {
  role: string;
  content: string;
  timestamp?: number;
}

const MAX_STORED_MESSAGES = 200;

/**
 * Append-only merge of the Redis session history (capped at the last 20
 * messages) into the durable Postgres thread. A plain overwrite silently
 * truncated long conversations in the inbox and deleted Postgres-only entries
 * (internal notes, merchant replies). Capped at MAX_STORED_MESSAGES so the
 * JSON blob can't grow unbounded (#187).
 */
export function mergeMessages(
  existingRaw: unknown,
  incoming: StoredMessage[],
): StoredMessage[] {
  const existing = Array.isArray(existingRaw) ? (existingRaw as StoredMessage[]) : [];
  const key = (m: StoredMessage) =>
    `${m.timestamp ?? 0}|${m.role}|${(m.content ?? "").slice(0, 40)}`;
  const seen = new Set(existing.map(key));
  return [...existing, ...incoming.filter((m) => !seen.has(key(m)))]
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
    .slice(-MAX_STORED_MESSAGES);
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
  customerName?: string;
  session: ConversationSession;
  checkoutUrl?: string;
  discountCode?: string;
  escalateToHuman?: boolean;
  agentTrace: string[];
  routeReason?: string;
  cartValueCents?: number;
}): Promise<void> {
  const { shopDomain, sessionId, customerId, customerName, session, checkoutUrl, discountCode, escalateToHuman, agentTrace, routeReason, cartValueCents } = opts;
  const checkoutToken = extractCheckoutToken(checkoutUrl);
  const cartValue = cartValueCents != null ? cartValueCents / 100 : undefined;

  const existing = await prisma.conversation
    .findUnique({
      where: { shopDomain_sessionId: { shopDomain, sessionId } },
      select: { messages: true },
    })
    .catch(() => null);
  const history = mergeMessages(
    existing?.messages,
    session.conversation_history as Array<{ role: string; content: string; timestamp?: number }>,
  );

  await prisma.conversation.upsert({
    where: { shopDomain_sessionId: { shopDomain, sessionId } },
    create: {
      shopDomain,
      sessionId,
      customerId,
      ...(customerName ? { customerName } : {}),
      messages: history as unknown as Prisma.InputJsonValue,
      messageCount: history.length,
      firstUserMessage: (
        (session.conversation_history as Array<{ role: string; content: string }>)
          .find((m) => m.role === "user")?.content?.slice(0, 200) ?? null
      ),
      cartId: session.cart_id,
      cartValue,
      checkoutToken,
      discountCode,
      escalated: !!escalateToHuman,
      agentTrace,
      routeReason: routeReason ?? undefined,
    },
    update: {
      messages: history as unknown as Prisma.InputJsonValue,
      messageCount: history.length,
      cartId: session.cart_id,
      ...(cartValue != null ? { cartValue } : {}),
      ...(checkoutToken ? { checkoutToken } : {}),
      ...(discountCode ? { discountCode } : {}),
      ...(escalateToHuman ? { escalated: true } : {}),
      agentTrace,
      routeReason: routeReason ?? undefined,
    },
  });

  // Signal SSE pollers that this shop has new data
  await redis.set(`inbox:dirty:${shopDomain}`, "1", "EX", 30).catch(() => {});

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

export function computeOutcome(c: {
  orderId: string | null;
  escalated: boolean;
  cartId: string | null;
  lastMessageAt: Date;
}): "converted" | "in_cart" | "escalated" | "active" | "ended" {
  if (c.orderId) return "converted";
  if (c.escalated) return "escalated";
  if (new Date(c.lastMessageAt) > new Date(Date.now() - 10 * 60 * 1000)) return "active";
  if (c.cartId) return "in_cart";
  return "ended";
}
