import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { decryptToken, normalizePhone, sendTextMessage, workerToken } from "~/lib/whatsapp.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  try {
    const merchant = await prisma.merchant.findFirst({ where: { shopDomain: shop } });
    if (!merchant?.waPhoneNumberId || !merchant?.waAccessToken) return new Response();

    const rawPhone =
      (payload.customer as Record<string, unknown> | undefined)?.phone as string | undefined ??
      (payload.shipping_address as Record<string, unknown> | undefined)?.phone as string | undefined;
    const phone = normalizePhone(rawPhone ?? "");
    if (!phone) return new Response();

    const { redis } = await import("~/redis.server");
    if (await redis.exists(`wa:optout:${phone}`)) return new Response();

    // Free-form messages only deliver inside a 24h customer-service window —
    // skip customers who have never messaged this store on WhatsApp (Meta
    // rejects cold free-form sends silently).
    const hasWaConversation = await prisma.conversation.findUnique({
      where: { shopDomain_sessionId: { shopDomain: shop, sessionId: `whatsapp_${phone}` } },
      select: { id: true },
    });
    if (!hasWaConversation) return new Response();

    const accessToken = decryptToken(merchant.waAccessToken);
    const storeName = shop.replace(".myshopify.com", "");
    const orderName = payload.name as string | undefined ?? `#${payload.order_number}`;

    const fulfillments = payload.fulfillments as Array<Record<string, unknown>> | undefined ?? [];
    const trackingUrl = fulfillments[0]?.tracking_url as string | undefined;

    const message = trackingUrl
      ? `Your order ${orderName} from ${storeName} has shipped! Track it here:\n${trackingUrl}`
      : `Your order ${orderName} from ${storeName} has shipped! It's on its way.`;

    await sendTextMessage(merchant.waPhoneNumberId, accessToken, phone, message);

    // Schedule a review request 3 days from now
    const orderStatusUrl = payload.order_status_url as string | undefined ?? "";
    const pendingKey = `wa:review:pending:${phone}:${orderName}`;
    const member = `${phone}:${orderName}:${shop}`;
    await redis.set(
      pendingKey,
      JSON.stringify({
        phone,
        orderName,
        shopDomain: shop,
        waPhoneNumberId: merchant.waPhoneNumberId,
        waAccessToken: merchant.waAccessToken, // encrypted; decrypted in worker
        storeName,
        orderStatusUrl,
      }),
      "EX",
      345600, // 4 days
    );
    await redis.zadd("wa:review:queue", Date.now() + 3 * 24 * 60 * 60 * 1000, member);

    // ponytail: fire-and-forget to process any due review requests from prior orders
    void fetch(
      `${process.env.SHOPIFY_APP_URL}/api/whatsapp/review-worker?token=${encodeURIComponent(workerToken())}`,
    ).catch(() => null);
  } catch (err) {
    console.error(`[orders/fulfilled] Error for ${shop}:`, err);
  }

  return new Response();
};
