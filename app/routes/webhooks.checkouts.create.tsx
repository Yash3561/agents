import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { writeAbandonedCart } from "~/lib/agents/memory.server";
import { normalizePhone, workerToken } from "~/lib/whatsapp.server";

/**
 * POST /webhooks/checkouts/create
 *
 * Fires when a customer starts a Shopify checkout. We write the abandoned_cart
 * metafield so the recovery greeting and cart pre-population can fire on the
 * customer's next widget session.
 *
 * Anonymous checkouts (no customer.id) are skipped — we can't recover a cart
 * without a customer identity to attach the metafield to.
 * Checkouts with no line items are also skipped — nothing to recover.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
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
      // No items yet — checkouts/update will fire once items are added
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
      console.warn(`[checkouts/create] No offline session found for ${shop} — skipping metafield write`);
      return new Response();
    }

    const customerGid = `gid://shopify/Customer/${customerId}`;
    await writeAbandonedCart(shop, session.accessToken, customerGid, items, totalCents);

    // Enqueue delayed WhatsApp cart recovery via QStash (fires 30 min later)
    void (async () => {
      try {
        const merchant = await prisma.merchant.findFirst({ where: { shopDomain: shop } });
        if (!merchant?.waPhoneNumberId || !merchant?.waAccessToken) return;

        const rawPhone =
          (payload.customer as Record<string, unknown>)?.phone as string | undefined ??
          (payload.shipping_address as Record<string, unknown> | undefined)?.phone as string | undefined;
        const phone = normalizePhone(rawPhone ?? "");
        if (!phone) return;

        const { redis } = await import("~/redis.server");
        if (await redis.exists(`wa:optout:${phone}`)) return;

        const checkoutId = String((payload as Record<string, unknown>).id ?? "");
        const isNew = await redis.set(`wa:abcart:${checkoutId}`, 1, "EX", 86400, "NX");
        if (isNew === null) return; // already enqueued

        const qstashToken = process.env.QSTASH_TOKEN;
        if (!qstashToken) return; // not configured

        const callbackUrl = `${process.env.SHOPIFY_APP_URL}/api/whatsapp/cart-recovery?token=${encodeURIComponent(workerToken())}`;
        const checkoutUrl = (payload as Record<string, unknown>).abandoned_checkout_url as string | undefined
          ?? (payload as Record<string, unknown>).checkout_url as string | undefined;
        const storeName = shop.replace(".myshopify.com", "");

        const body = {
          shop,
          phone,
          checkoutId,
          checkoutUrl: checkoutUrl ?? `https://${shop}`,
          storeName,
          waPhoneNumberId: merchant.waPhoneNumberId,
          waAccessToken: merchant.waAccessToken, // already encrypted
          items: items.slice(0, 3).map((i) => `${i.title} ×${i.quantity}`),
        };

        await fetch(`https://qstash.upstash.io/v2/publish/${encodeURIComponent(callbackUrl)}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${qstashToken}`,
            "Content-Type": "application/json",
            "Upstash-Delay": "1800s",
          },
          body: JSON.stringify(body),
        });
      } catch {
        // best-effort — never throw
      }
    })();
  } catch (err) {
    console.error(`[checkouts/create] Error processing webhook for ${shop}:`, err);
    // Return 200 so Shopify doesn't retry — the signal is best-effort
  }

  return new Response();
};
