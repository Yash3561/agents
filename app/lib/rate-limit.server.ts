import { redis } from "~/redis.server";

const PER_SHOP_LIMIT = Number(process.env.RATE_LIMIT_PER_SHOP ?? 60); // messages/min across all customers of one shop
const PER_IP_LIMIT = Number(process.env.RATE_LIMIT_PER_IP ?? 20); // messages/min from one visitor
const WINDOW_SECONDS = 60;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

/**
 * Fixed-window counter using Redis INCR/EXPIRE. Good enough for abuse
 * protection (not billing-grade precision) — a single Redis round trip per
 * check, fails open if Redis is briefly unavailable so a Redis hiccup never
 * takes down the chat endpoint.
 */
async function checkWindow(key: string, limit: number): Promise<RateLimitResult> {
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, WINDOW_SECONDS);
    }
    if (count > limit) {
      const ttl = await redis.ttl(key);
      return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : WINDOW_SECONDS };
    }
    return { allowed: true };
  } catch {
    return { allowed: true }; // fail open — never let a Redis outage block chat
  }
}

/** Checks both per-shop and per-IP limits for a chat request; per-IP is checked first since it's the tighter, more common abuse case. */
export async function checkChatRateLimit(
  shop: string,
  clientIp: string,
): Promise<RateLimitResult> {
  const ipResult = await checkWindow(`ratelimit:ip:${clientIp}`, PER_IP_LIMIT);
  if (!ipResult.allowed) return ipResult;

  return checkWindow(`ratelimit:shop:${shop}`, PER_SHOP_LIMIT);
}

/** Best-effort client IP extraction behind common proxies (Cloudflare, Vercel, generic). */
export function getClientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}
