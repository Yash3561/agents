import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { wipeCustomerMemory } from "../lib/agents/memory.server";

/**
 * Mandatory GDPR webhook. Fired when a buyer asks a store owner to delete
 * their personal data. Delete everything we hold tied to this customer:
 * the neonping_chat metafields (preferences/last_search/summary/abandoned_cart)
 * and any Conversation rows (which contain message transcripts).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic, session } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const customerIdNum = (payload.customer as { id?: number } | undefined)?.id;
  if (!customerIdNum) return new Response();

  const customerId = `gid://shopify/Customer/${customerIdNum}`;

  if (session?.accessToken) {
    await wipeCustomerMemory(shop, session.accessToken, customerId).catch((err) =>
      console.error("[gdpr] wipeCustomerMemory failed:", err),
    );
  }

  await db.conversation
    .deleteMany({ where: { shopDomain: shop, customerId } })
    .catch((err) => console.error("[gdpr] conversation deleteMany failed:", err));

  return new Response();
};
