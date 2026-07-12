import type { ActionFunctionArgs } from "react-router";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const gdprPayload = payload as {
    customer?: { id?: number | string; email?: string };
    data_request?: { id?: number | string };
  };

  const customerIdRaw = gdprPayload.customer?.id != null ? String(gdprPayload.customer.id) : null;
  const customerId = customerIdRaw ? `gid://shopify/Customer/${customerIdRaw}` : null;
  const customerEmail = gdprPayload.customer?.email ?? null;
  const customerFilters: Prisma.ConversationWhereInput[] = [];
  if (customerId) customerFilters.push({ customerId });
  if (customerIdRaw) customerFilters.push({ customerId: customerIdRaw });
  if (customerEmail) customerFilters.push({ customerEmail: { equals: customerEmail, mode: "insensitive" } });

  if (customerFilters.length === 0) {
    return Response.json({
      data_request_id: gdprPayload.data_request?.id ?? null,
      shop,
      customer_id: null,
      customer_email: null,
      exported_at: new Date().toISOString(),
      conversations: [],
    });
  }

  try {
    const conversations = await prisma.conversation.findMany({
      where: { shopDomain: shop, OR: customerFilters },
      select: {
        id: true,
        sessionId: true,
        channel: true,
        customerId: true,
        customerEmail: true,
        customerName: true,
        messages: true,
        firstUserMessage: true,
        startedAt: true,
        lastMessageAt: true,
        messageCount: true,
        orderId: true,
        orderRevenueCents: true,
        cartId: true,
        checkoutToken: true,
        cartValue: true,
        discountCode: true,
        escalated: true,
        resolved: true,
        resolvedAt: true,
        agentTrace: true,
        routeReason: true,
      },
      orderBy: { startedAt: "asc" },
    });

    const exportData = {
      data_request_id: gdprPayload.data_request?.id ?? null,
      shop,
      customer_id: customerId,
      customer_email: customerEmail,
      exported_at: new Date().toISOString(),
      conversations,
    };

    return Response.json(exportData);
  } catch (err) {
    console.error(`[GDPR data_request] Error processing webhook for ${shop}:`, err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
};
