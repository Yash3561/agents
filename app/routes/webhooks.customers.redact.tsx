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
  const { shop, payload, session } = await authenticate.webhook(request);

  try {
    const customer = payload.customer as { id?: number | string; email?: string } | undefined;
    const customerIdRaw = customer?.id != null ? String(customer.id) : null;
    const customerEmail = customer?.email;

    if (!customerIdRaw && !customerEmail) {
      return new Response(null, { status: 200 });
    }

    const customerId = customerIdRaw ? `gid://shopify/Customer/${customerIdRaw}` : null;
    if (session?.accessToken && customerId) {
      await wipeCustomerMemory(shop, session.accessToken, customerId).catch((err) =>
        console.error("[gdpr] wipeCustomerMemory failed:", err),
      );
    }

    const customerWhere =
      customerId && customerEmail
        ? { OR: [{ customerId }, { customerEmail }] }
        : customerId
          ? { customerId }
          : { customerEmail };

    await db.conversation.deleteMany({
      where: { shopDomain: shop, ...customerWhere },
    });

    const fallbackFilters = [
      ...(customerIdRaw ? [{ customerId: customerIdRaw }] : []),
      ...(customerEmail ? [{ customerEmail: { equals: customerEmail, mode: "insensitive" as const } }] : []),
    ];
    if (fallbackFilters.length) {
      await db.conversation.deleteMany({
        where: { shopDomain: shop, OR: fallbackFilters },
      });
    }

    return new Response(null, { status: 200 });
  } catch (err) {
    console.error(`[customers/redact] Error processing webhook for ${shop}:`, err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
};
