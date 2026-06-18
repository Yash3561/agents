import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const gdprPayload = payload as {
    customer: { id: number; email: string };
    data_request: { id: number };
  };

  const customerId = `gid://shopify/Customer/${gdprPayload.customer.id}`;
  const customerEmail = gdprPayload.customer.email;

  const conversations = await prisma.conversation.findMany({
    where: { shopDomain: shop, customerId },
    select: {
      id: true,
      sessionId: true,
      startedAt: true,
      lastMessageAt: true,
      messageCount: true,
      orderId: true,
      orderRevenueCents: true,
      cartId: true,
      discountCode: true,
      escalated: true,
    },
  });

  const export_data = {
    data_request_id: gdprPayload.data_request.id,
    shop,
    customer_id: customerId,
    customer_email: customerEmail,
    exported_at: new Date().toISOString(),
    note: "Chat message content is not stored server-side. Only conversation metadata is retained.",
    conversations,
  };

  console.log(`[GDPR data_request] shop=${shop} customer=${customerEmail} conversations=${conversations.length}`);
  console.log(JSON.stringify(export_data));

  return new Response(null, { status: 200 });
};
