import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Zeroes out orderRevenueCents on a cancelled order so the dashboard's
 * revenue/AOV numbers don't stay permanently inflated by an order that
 * Shopify itself no longer counts as revenue. Matched by orderId, the
 * same field orders/paid writes (see webhooks.orders.paid.tsx).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const orderId = payload.id != null ? String(payload.id) : undefined;
    if (!orderId) return new Response();

    await db.conversation.updateMany({
      where: { shopDomain: shop, orderId },
      data: { orderRevenueCents: 0 },
    });
  } catch (err) {
    console.error(`[orders/cancelled] Error processing webhook for ${shop}:`, err);
    // Still return 200 so Shopify doesn't retry — revenue drift here is
    // recoverable, not worth inflating the webhook error rate over.
  }

  return new Response();
};
