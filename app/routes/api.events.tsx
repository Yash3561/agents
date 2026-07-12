import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { redis } from "../redis.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const since = url.searchParams.get("since");
  const sinceDate = since ? new Date(since) : new Date(Date.now() - 60_000);
  const convId = url.searchParams.get("conv") ?? "";
  // ponytail: random suffix scopes this key to one SSE connection (one browser tab)
  const viewerKey = convId ? `presence:${shop}:${convId}:${Math.random().toString(36).slice(2)}` : null;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode("event: ping\ndata: {}\n\n"));

      // Register presence for this tab
      if (viewerKey && convId) {
        await redis.set(viewerKey, "1", "EX", 35).catch(() => {});
        await redis.sadd(`presence-set:${shop}:${convId}`, viewerKey).catch(() => {});
        await redis.expire(`presence-set:${shop}:${convId}`, 3600).catch(() => {});
      }

      // Clean up presence key when the client disconnects
      request.signal.addEventListener("abort", () => {
        if (viewerKey && convId) {
          redis.del(viewerKey).catch(() => {});
          redis.srem(`presence-set:${shop}:${convId}`, viewerKey).catch(() => {});
        }
        controller.close();
      });

      let lastCheck = sinceDate;
      let iterations = 0;
      let lastViewerCount = -1; // ponytail: diff check — only send presence when count changes
      const MAX_ITERATIONS = 600; // ponytail: 30-min ceiling; upgrade to WS if needed

      while (iterations < MAX_ITERATIONS && !request.signal.aborted) {
        iterations++;
        await new Promise<void>((resolve) => setTimeout(resolve, 3000));
        if (request.signal.aborted) break;

        try {
          // Dirty-flag check: skip DB query when no new messages have arrived
          const dirty = await redis.get(`inbox:dirty:${shop}`).catch(() => "1");
          if (dirty) {
            await redis.del(`inbox:dirty:${shop}`).catch(() => {});
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

              // The list-row select above deliberately excludes `messages` — it's
              // fine for badges/timestamps on 20 rows, but it silently starved the
              // merchant's open transcript of new message content (the client-side
              // merge never overwrote a field that was never sent). Widen the
              // payload for exactly the conversation currently on screen, if it's
              // one of the ones that just changed — no cost for the other rows.
              let payload: typeof updated | Array<(typeof updated)[number] & { messages?: unknown }> = updated;
              if (convId && updated.some((c) => c.id === convId)) {
                const withMessages = await prisma.conversation.findUnique({
                  where: { id: convId },
                  select: { id: true, messages: true },
                }).catch(() => null);
                if (withMessages) {
                  payload = updated.map((c) => (c.id === convId ? { ...c, messages: withMessages.messages } : c));
                }
              }

              controller.enqueue(
                encoder.encode(
                  `event: update\ndata: ${JSON.stringify({ conversations: payload, ts: lastCheck.toISOString() })}\n\n`,
                ),
              );
            }
          } else if (iterations % 10 === 0) {
            controller.enqueue(encoder.encode("event: ping\ndata: {}\n\n"));
          }

          // Presence: refresh TTL every poll, but only broadcast when count changes (cheap Redis ops)
          if (viewerKey && convId) {
            await redis.set(viewerKey, "1", "EX", 35).catch(() => {});
            const viewerCount = await redis.scard(`presence-set:${shop}:${convId}`).catch(() => 0);
            if (viewerCount !== lastViewerCount) {
              lastViewerCount = viewerCount;
              controller.enqueue(
                encoder.encode(
                  `event: presence\ndata: ${JSON.stringify({ conv_id: convId, viewer_count: viewerCount })}\n\n`,
                ),
              );
            }
          }
        } catch {
          controller.enqueue(encoder.encode("event: ping\ndata: {}\n\n"));
        }
      }

      if (!request.signal.aborted) {
        controller.enqueue(encoder.encode("event: reconnect\ndata: {}\n\n"));
      }
      if (viewerKey && convId) {
        redis.del(viewerKey).catch(() => {});
        redis.srem(`presence-set:${shop}:${convId}`, viewerKey).catch(() => {});
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
