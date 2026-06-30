import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const since = url.searchParams.get("since");
  const sinceDate = since ? new Date(since) : new Date(Date.now() - 60_000);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode("event: ping\ndata: {}\n\n"));

      let lastCheck = sinceDate;
      let iterations = 0;
      const MAX_ITERATIONS = 600; // ponytail: 30-min ceiling; upgrade to WS if needed

      while (iterations < MAX_ITERATIONS && !request.signal.aborted) {
        iterations++;
        await new Promise<void>((resolve) => setTimeout(resolve, 3000));
        if (request.signal.aborted) break;

        try {
          const updated = await prisma.conversation.findMany({
            where: { shopDomain: shop, lastMessageAt: { gt: lastCheck } },
            select: {
              id: true,
              lastMessageAt: true,
              resolved: true,
              escalated: true,
              firstUserMessage: true,
              channel: true,
              customerId: true,
              cartValue: true,
              cartId: true,
              orderId: true,
              orderRevenueCents: true,
            },
            orderBy: { lastMessageAt: "desc" },
            take: 20,
          });

          if (updated.length > 0) {
            lastCheck = new Date();
            controller.enqueue(
              encoder.encode(
                `event: update\ndata: ${JSON.stringify({ conversations: updated, ts: lastCheck.toISOString() })}\n\n`,
              ),
            );
          } else if (iterations % 10 === 0) {
            controller.enqueue(encoder.encode("event: ping\ndata: {}\n\n"));
          }
        } catch {
          controller.enqueue(encoder.encode("event: ping\ndata: {}\n\n"));
        }
      }

      if (!request.signal.aborted) {
        controller.enqueue(encoder.encode("event: reconnect\ndata: {}\n\n"));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
