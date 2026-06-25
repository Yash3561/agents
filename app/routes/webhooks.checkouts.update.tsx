import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { writeAbandonedCart } from "~/lib/agents/memory.server";

/**
 * POST /webhooks/checkouts/update
 *
 * Fires when a checkout is updated (e.g. line items added after creation).
 * We only write the abandoned_cart metafield when line_items is non-empty,
 * catching the case where checkouts/create fired before items were added.
 *
 * If the checkout has already been completed (completed_at is set) we skip it —
 * orders/paid will clear the signal when the order is confirmed.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    // Skip completed checkouts — the purchase already happened
    if (payload.completed_at) {
      return new Response();
    }

    const customer = payload.customer as { id?: number | string } | null | undefined;
    const customerId = customer?.id != null ? String(customer.id) : null;

    if (!customerId) {
      // Anonymous checkout — can't recover without a customer identity
      return new Response();
    }

    const lineItems = (payload.line_items as Array<{
      variant_id?: number | string | null;
      title?: string;
      quantity?: number;
      price?: string;
    }> | undefined) ?? [];

    if (!lineItems.length) {
      // No items — nothing to recover
      return new Response();
    }

    const items = lineItems
      .filter((li) => li.variant_id != null)
      .map((li) => ({
        variantId: String(li.variant_id),
        title: li.title ?? "Unknown",
        quantity: li.quantity ?? 1,
        priceCents: li.price ? Math.round(parseFloat(li.price) * 100) : 0,
      }));

    if (!items.length) {
      return new Response();
    }

    const totalPrice = payload.total_price as string | undefined;
    const totalCents = totalPrice ? Math.round(parseFloat(totalPrice) * 100) : 0;

    // Resolve the merchant's offline access token to write metafields
    const session = await prisma.session.findFirst({
      where: { shop, isOnline: false },
      select: { accessToken: true },
    });

    if (!session?.accessToken) {
      console.warn(`[checkouts/update] No offline session found for ${shop} — skipping metafield write`);
      return new Response();
    }

    const customerGid = `gid://shopify/Customer/${customerId}`;
    await writeAbandonedCart(shop, session.accessToken, customerGid, items, totalCents);
  } catch (err) {
    console.error(`[checkouts/update] Error processing webhook for ${shop}:`, err);
    // Return 200 so Shopify doesn't retry — the signal is best-effort
  }

  return new Response();
};
