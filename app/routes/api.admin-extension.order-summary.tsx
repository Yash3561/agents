import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Backend for the admin.order-details.block.render extension
 * (extensions/admin-conversation-block). Admin UI extensions authenticate
 * their own fetch() calls with a Shopify ID token Bearer header, which
 * authenticate.admin() already knows how to verify — same mechanism the
 * embedded app iframe uses, just without a browser session/cookie.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const rawOrderId = url.searchParams.get("orderId") ?? "";
  // Extension passes shopify.data.selected[0].id, a GID (gid://shopify/Order/123);
  // Conversation.orderId is stored as the plain numeric id from the orders/paid
  // REST webhook payload — normalize before matching.
  const orderId = rawOrderId.replace("gid://shopify/Order/", "");
  if (!orderId) {
    return Response.json({ found: false });
  }

  const conversation = await db.conversation.findFirst({
    where: { shopDomain: session.shop, orderId },
    select: {
      id: true,
      channel: true,
      messageCount: true,
      escalated: true,
      resolved: true,
      qualityScore: true,
      firstUserMessage: true,
      startedAt: true,
      discountCode: true,
    },
  });

  if (!conversation) {
    return Response.json({ found: false });
  }

  const shopHandle = session.shop.replace(".myshopify.com", "");
  return Response.json({
    found: true,
    ...conversation,
    inboxUrl: `https://admin.shopify.com/store/${shopHandle}/apps/${process.env.SHOPIFY_API_KEY}/app/inbox?id=${conversation.id}`,
  });
};
