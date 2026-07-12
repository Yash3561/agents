import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Decrements orderRevenueCents by the refunded amount so a partial refund
 * doesn't leave the dashboard's revenue/AOV numbers overstating what the
 * order actually netted. Matched by orderId (see webhooks.orders.paid.tsx),
 * clamped at 0 rather than going negative.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const orderId = payload.order_id != null ? String(payload.order_id) : undefined;
    if (!orderId) return new Response();

    const transactions = (payload.transactions as Array<{ amount?: string; kind?: string }> | undefined) ?? [];
    const refundedCents = Math.round(
      transactions
        .filter((t) => t.kind === "refund")
        .reduce((sum, t) => sum + (parseFloat(t.amount ?? "0") || 0), 0) * 100,
    );
    if (refundedCents <= 0) return new Response();

    const conversation = await db.conversation.findFirst({
      where: { shopDomain: shop, orderId },
      select: { id: true, orderRevenueCents: true },
    });
    if (!conversation) return new Response();

    const newRevenueCents = Math.max(0, (conversation.orderRevenueCents ?? 0) - refundedCents);
    await db.conversation.update({
      where: { id: conversation.id },
      data: { orderRevenueCents: newRevenueCents },
    });
  } catch (err) {
    console.error(`[refunds/create] Error processing webhook for ${shop}:`, err);
  }

  return new Response();
};
