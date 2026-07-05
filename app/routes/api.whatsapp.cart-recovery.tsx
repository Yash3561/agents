import type { ActionFunctionArgs } from "react-router";
import { decryptToken, sendTemplate, sendTextMessage } from "~/lib/whatsapp.server";
import { redis } from "~/redis.server";

/**
 * POST /api/whatsapp/cart-recovery
 *
 * QStash callback — fires 30 minutes after checkout creation.
 * Skipped if the customer placed an order in the meantime (paid flag in Redis).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });

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
      // Template not yet approved — fall back to session-window text
      const message = `Hey! You left something in your cart at ${body.storeName}:\n\n${body.items.map(i => `• ${i}`).join("\n")}\n\nYour cart is saved:\n${body.checkoutUrl}\n\nReply STOP to unsubscribe.`;
      await sendTextMessage(body.waPhoneNumberId, accessToken, body.phone, message);
    }
  } catch {
    // best-effort
  }

  return new Response(null, { status: 200 });
};
