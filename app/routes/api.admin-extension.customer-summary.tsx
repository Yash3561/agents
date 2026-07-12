import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Backend for the admin.customer-details.block.render extension
 * (extensions/admin-conversation-block). See api.admin-extension.order-summary.tsx
 * for the auth mechanism — same pattern, different resource.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const rawCustomerId = url.searchParams.get("customerId") ?? "";
  // Conversation.customerId is already stored as a full GID, matches directly.
  const customerId = rawCustomerId.startsWith("gid://")
    ? rawCustomerId
    : `gid://shopify/Customer/${rawCustomerId}`;
  if (!rawCustomerId) {
    return Response.json({ found: false, conversations: [] });
  }

  const conversations = await db.conversation.findMany({
    where: { shopDomain: session.shop, customerId },
    orderBy: { lastMessageAt: "desc" },
    take: 5,
    select: {
      id: true,
      channel: true,
      messageCount: true,
      escalated: true,
      resolved: true,
      qualityScore: true,
      firstUserMessage: true,
      startedAt: true,
      orderRevenueCents: true,
    },
  });

  if (!conversations.length) {
    return Response.json({ found: false, conversations: [] });
  }

  const shopHandle = session.shop.replace(".myshopify.com", "");
  return Response.json({
    found: true,
    conversations: conversations.map((c) => ({
      ...c,
      inboxUrl: `https://admin.shopify.com/store/${shopHandle}/apps/${process.env.SHOPIFY_API_KEY}/app/inbox?id=${c.id}`,
    })),
  });
};
