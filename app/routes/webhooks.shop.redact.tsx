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
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  await db.conversation
    .deleteMany({ where: { shopDomain: shop } })
    .catch((err) => console.error("[gdpr] conversation deleteMany failed:", err));

  await db.merchant
    .delete({ where: { shopDomain: shop } })
    .catch(() => null); // already gone is fine

  try {
    const keys = await redis.keys(`*${shop}*`);
    if (keys.length) await redis.del(...keys);
  } catch (err) {
    console.error("[gdpr] redis cleanup failed:", err);
  }

  return new Response();
};
