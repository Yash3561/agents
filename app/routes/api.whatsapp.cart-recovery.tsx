import type { ActionFunctionArgs } from "react-router";
import { decryptToken, sendTemplate, sendTextMessage, workerToken } from "~/lib/whatsapp.server";
import { redis } from "~/redis.server";
import prisma from "~/db.server";

/**
 * POST /api/whatsapp/cart-recovery
 *
 * QStash callback — fires 30 minutes after checkout creation.
 * Skipped if the customer placed an order in the meantime (paid flag in Redis).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });

  // Fail-closed shared-secret auth — the token is appended to the QStash
  // callback URL at enqueue time (webhooks.checkouts.create.tsx).
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const secret = workerToken();
  if (!secret || token !== secret) {
    return new Response("Forbidden", { status: 403 });
  }

  let body: {
    shop: string;
    phone: string;
    checkoutId: string;
    checkoutUrl: string;
    storeName: string;
    waPhoneNumberId: string;
    waAccessToken: string;
    items: string[];
  };
  try {
    body = await request.json();
  } catch {
    return new Response("bad body", { status: 400 });
  }

  try {
    // Skip if order was already placed
    if (await redis.exists(`wa:abcart:paid:${body.checkoutId}`)) {
      return new Response("order placed", { status: 200 });
    }

    // Respect opt-out — the customer may have replied STOP during the 30-min delay
    if (await redis.exists(`wa:optout:${body.phone}`)) {
      return new Response("opted out", { status: 200 });
    }

    const accessToken = decryptToken(body.waAccessToken);
    const itemsText = body.items.join(", ");

    // Try template first (works outside 24h window), fall back to plain text
    try {
      await sendTemplate(
        body.waPhoneNumberId,
        accessToken,
        body.phone,
        "neonping_cart_recovery",
        "en",
        [{
          type: "body",
          parameters: [
            { type: "text", text: body.storeName },
            { type: "text", text: itemsText },
            { type: "text", text: body.checkoutUrl },
          ],
        }],
      );
    } catch {
      // Template not yet approved — plain text only delivers inside the 24h
      // session window, i.e. when this phone has actually messaged the store.
      // A cold free-form send here would be an unconsented business-initiated
      // message (and Meta silently drops it anyway) — skip instead.
      const hasWaConversation = !!(await prisma.conversation.findUnique({
        where: { shopDomain_sessionId: { shopDomain: body.shop, sessionId: `whatsapp_${body.phone}` } },
        select: { id: true },
      }));
      if (hasWaConversation) {
        const message = `Hey! You left something in your cart at ${body.storeName}:\n\n${body.items.map(i => `• ${i}`).join("\n")}\n\nYour cart is saved:\n${body.checkoutUrl}\n\nReply STOP to unsubscribe.`;
        await sendTextMessage(body.waPhoneNumberId, accessToken, body.phone, message);
      }
    }
  } catch (err) {
    console.error(`[cart-recovery] Send failed for checkout ${body.checkoutId}:`, err);
    // Real failure (redis/decrypt/Meta API down) — 500 so QStash retries,
    // instead of silently dropping the recovery message.
    return new Response(null, { status: 500 });
  }

  return new Response(null, { status: 200 });
};
