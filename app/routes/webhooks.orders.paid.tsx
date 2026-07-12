import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { clearAbandonedCart } from "~/lib/agents/memory.server";
import { redis } from "~/redis.server";

async function clearCustomerAbandonedCart(shop: string, customerGid: string): Promise<void> {
  try {
    const session = await db.session.findFirst({
      where: { shop, isOnline: false },
      select: { accessToken: true },
    });
    if (session?.accessToken) {
      await clearAbandonedCart(shop, session.accessToken, customerGid);
    }
  } catch {
    // Clearing the metafield is best-effort — don't fail/retry the paid webhook.
  }
}

/**
 * Matches a completed order back to the conversation that produced it, using
 * the cart token embedded in the checkout_url we stored on the Conversation
 * row (see app/lib/conversation.server.ts). Shopify's order payload exposes
 * the same token as cart_token (and checkout_token for completed checkouts).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  try {
    const cartToken = (payload.cart_token ?? payload.checkout_token) as
      | string
      | undefined;

    // Flag this checkout as paid so the QStash cart-recovery job skips it.
    // Keyed by checkout_id (numeric), matching the id the checkouts/create
    // webhook uses to build the same `wa:abcart:paid:` key — cart_token/
    // checkout_token are a different, opaque value and never match it.
    const checkoutId = payload.checkout_id != null ? String(payload.checkout_id) : undefined;
    if (checkoutId) {
      await redis.set(`wa:abcart:paid:${checkoutId}`, 1, "EX", 86400);
    }

    const totalPrice = payload.total_price as string | undefined;
    const orderId = payload.id != null ? String(payload.id) : undefined;

    // Extract customer id from order payload for clearing abandoned cart signal
    const orderCustomer = payload.customer as { id?: number | string } | null | undefined;
    const rawCustomerId = orderCustomer?.id != null ? String(orderCustomer.id) : undefined;
    const customerGid = rawCustomerId ? `gid://shopify/Customer/${rawCustomerId}` : undefined;

    if (!cartToken || !orderId) {
      return new Response();
    }

    const conversation = await db.conversation.findFirst({
      where: { shopDomain: shop, checkoutToken: cartToken },
    });

    if (!conversation) {
      // No matching conversation — order wasn't facilitated through the widget.
      // Still clear the abandoned cart signal if we have a customer id.
      if (customerGid) {
        void clearCustomerAbandonedCart(shop, customerGid);
      }
      return new Response();
    }

    await db.conversation.update({
      where: { id: conversation.id },
      data: {
        orderId,
        orderRevenueCents: totalPrice ? Math.round(parseFloat(totalPrice) * 100) : undefined,
      },
    });

    // Clear the abandoned_cart metafield now that the order is confirmed.
    // This is the correct place to clear it — not during cart pre-population,
    // which fires when the widget opens but before the customer confirms a purchase.
    if (customerGid) {
      void clearCustomerAbandonedCart(shop, customerGid);
    }
  } catch (err) {
    console.error(`[orders/paid] Error processing webhook for ${shop}:`, err);
    // Retry critical paid-state/revenue failures so we don't message customers
    // after purchase or permanently lose dashboard attribution.
    return new Response(null, { status: 500 });
  }

  return new Response();
};
