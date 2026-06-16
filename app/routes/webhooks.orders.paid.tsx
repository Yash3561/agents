import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Matches a completed order back to the conversation that produced it, using
 * the cart token embedded in the checkout_url we stored on the Conversation
 * row (see app/lib/conversation.server.ts). Shopify's order payload exposes
 * the same token as cart_token (and checkout_token for completed checkouts).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const cartToken = (payload.cart_token ?? payload.checkout_token) as
    | string
    | undefined;
  const totalPrice = payload.total_price as string | undefined;
  const orderId = payload.id != null ? String(payload.id) : undefined;

  if (!cartToken || !orderId) {
    return new Response();
  }

  const conversation = await db.conversation.findFirst({
    where: { shopDomain: shop, checkoutToken: cartToken },
  });

  if (!conversation) {
    // No matching conversation — order wasn't facilitated through the widget.
    return new Response();
  }

  await db.conversation.update({
    where: { id: conversation.id },
    data: {
      orderId,
      orderRevenueCents: totalPrice ? Math.round(parseFloat(totalPrice) * 100) : undefined,
    },
  });

  return new Response();
};
