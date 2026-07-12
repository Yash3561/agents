/**
 * POST /api/whatsapp/review-worker?token=…  — QStash callback, fires 3 days
 *   after fulfillment with a self-contained review-request payload.
 * GET  /api/whatsapp/review-worker?token=…  — legacy drain of the old Redis
 *   sorted-set queue (in-flight entries scheduled before the QStash migration).
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { decryptToken, sendReplyButtons, workerToken } from "~/lib/whatsapp.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const secret = workerToken();
  if (!secret || token !== secret) return new Response("Forbidden", { status: 403 });

  let body: {
    phone: string;
    orderName: string;
    shopDomain: string;
    waPhoneNumberId: string;
    waAccessToken: string;
    storeName: string;
  };
  try {
    body = await request.json();
  } catch {
    return new Response("bad body", { status: 400 });
  }

  try {
    const { redis } = await import("~/redis.server");
    if (await redis.exists(`wa:optout:${body.phone}`)) {
      return new Response("opted out", { status: 200 });
    }
    // QStash guarantees at-least-once delivery — dedup by phone+order so a retry
    // (or duplicate callback) doesn't send the customer the review request twice.
    const dedupKey = `wa:review:sent:${body.phone}:${body.orderName}:${body.shopDomain}`;
    const isNew = await redis.set(dedupKey, "1", "EX", 7 * 24 * 60 * 60, "NX");
    if (isNew === null) return new Response("already sent", { status: 200 });
    await sendReplyButtons(
      body.waPhoneNumberId,
      decryptToken(body.waAccessToken),
      body.phone,
      `Hi! How was your order ${body.orderName} from ${body.storeName}? We'd love your feedback 🌟`,
      [
        { id: `review_good|${body.orderName}`, title: "⭐ Leave a Review" },
        { id: `review_issue|${body.orderName}`, title: "😕 Had an Issue" },
      ],
    );
  } catch (err) {
    console.error(`[review-worker] QStash job failed for ${body.orderName}:`, err);
    // Return 200 anyway — a hard-failed send (expired token, opted-out device)
    // won't succeed on QStash retries either.
  }
  return new Response(null, { status: 200 });
}

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
