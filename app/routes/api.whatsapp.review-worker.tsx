/**
 * GET /api/whatsapp/review-worker?token=REVIEW_WORKER_SECRET
 * Processes due review-request entries from the Redis sorted set.
 * Called fire-and-forget from webhooks.orders.fulfilled on each ship event.
 */
import type { LoaderFunctionArgs } from "react-router";
import { decryptToken, sendReplyButtons, workerToken } from "~/lib/whatsapp.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const secret = workerToken();
  // Fail closed — workerToken() falls back to SHOPIFY_API_SECRET so this is never open
  if (!secret || token !== secret) {
    return new Response("Forbidden", { status: 403 });
  }

  const { redis } = await import("~/redis.server");
  const members = await redis.zrangebyscore("wa:review:queue", 0, Date.now(), "LIMIT", 0, 20);

  let processed = 0;
  for (const member of members) {
    const parts = member.split(":");
    const phone = parts[0];
    // Reconstruct orderName — middle segments; shopDomain is always last
    const orderName = parts.slice(1, parts.length - 1).join(":");

    try {
      const pendingKey = `wa:review:pending:${phone}:${orderName}`;
      const raw = await redis.get(pendingKey);
      if (!raw) {
        // Already processed or expired; clean up the sorted set entry
        await redis.zrem("wa:review:queue", member);
        continue;
      }

      // Respect opt-out
      if (await redis.exists(`wa:optout:${phone}`)) {
        await redis.zrem("wa:review:queue", member);
        await redis.del(pendingKey);
        continue;
      }

      const data = JSON.parse(raw) as {
        phone: string;
        orderName: string;
        shopDomain: string;
        waPhoneNumberId: string;
        waAccessToken: string;
        storeName: string;
        orderStatusUrl: string;
      };

      if (!data.waPhoneNumberId || !data.waAccessToken) {
        await redis.zrem("wa:review:queue", member);
        await redis.del(pendingKey);
        continue;
      }

      const accessToken = decryptToken(data.waAccessToken);

      await sendReplyButtons(
        data.waPhoneNumberId,
        accessToken,
        data.phone,
        `Hi! How was your order ${data.orderName} from ${data.storeName}? We'd love your feedback 🌟`,
        [
          { id: `review_good|${data.orderName}`, title: "⭐ Leave a Review" },
          { id: `review_issue|${data.orderName}`, title: "😕 Had an Issue" },
        ],
      );

      await redis.zrem("wa:review:queue", member);
      await redis.del(pendingKey);
      processed++;
    } catch (err) {
      console.error(`[review-worker] failed for ${member}:`, err);
      // Leave in queue for next run
    }
  }

  return Response.json({ processed });
}
