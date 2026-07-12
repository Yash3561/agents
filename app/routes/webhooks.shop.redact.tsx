import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { redis } from "../redis.server";

/**
 * Mandatory GDPR webhook. Fired 48 hours after a shop uninstalls the app —
 * delete everything we hold for that shop: the Merchant row, all its
 * Conversation rows (transcripts), and any Redis keys scoped to the shop
 * (chat sessions, rate-limit counters).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticate.webhook(request);

  try {
    await db.$transaction([
      db.conversation.deleteMany({ where: { shopDomain: shop } }),
      db.session.deleteMany({ where: { shop } }),
      db.merchant.deleteMany({ where: { shopDomain: shop } }),
    ]);

    const keys = await redis.keys(`*${shop}*`);
    if (keys.length) await redis.del(...keys);

    return new Response(null, { status: 200 });
  } catch (err) {
    console.error(`[shop/redact] Error processing webhook for ${shop}:`, err);
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
