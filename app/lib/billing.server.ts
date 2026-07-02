import prisma from "~/db.server";
import { redis } from "~/redis.server";
import { PLAN_LIMITS } from "~/lib/plans";
export { PLAN_CONFIG, PLAN_LIMITS } from "~/lib/plans";

const usageKey = (shopDomain: string) => `usage:${shopDomain}`;
// Tracks whether a given session has already been counted toward the plan limit.
// TTL of 7 days covers even the longest multi-day shopping sessions.
const sessionBilledKey = (shopDomain: string, sessionId: string) =>
  `session_billed:${shopDomain}:${sessionId}`;
const SESSION_BILLED_TTL = 7 * 24 * 60 * 60; // 7 days in seconds
const PRISMA_SYNC_INTERVAL = 10;

export interface UsageCheck {
  allowed: boolean;
  used: number;
  limit: number;
}

/**
 * Checks the shop's conversation usage against its plan limit, and — if
 * allowed and this is a NEW session — increments the counter once per
 * conversation (not once per message).
 *
 * sessionId dedup: a Redis key `session_billed:<shop>:<sessionId>` is set
 * with a 7-day TTL the first time a session is counted. Subsequent messages
 * in the same session skip the increment entirely. This ensures "500
 * conversations/mo" means 500 distinct chat sessions, not 500 messages.
 *
 * Fails open: if Redis is unavailable, falls back to Prisma-only path which
 * cannot deduplicate by session (counts per message) — acceptable degraded
 * behavior during a Redis outage.
 */
export async function checkAndIncrementUsage(shopDomain: string, sessionId?: string): Promise<UsageCheck> {
  const merchant = await prisma.merchant.findUnique({ where: { shopDomain } });
  if (!merchant) {
    return { allowed: false, used: 0, limit: 0 };
  }

  const limit = PLAN_LIMITS[merchant.plan] ?? 0;
  const now = new Date();
  let durableCount = merchant.conversationCount;

  if (now.getTime() - merchant.conversationResetAt.getTime() >= 30 * 24 * 60 * 60 * 1000) {
    durableCount = 0;
    await prisma.merchant
      .update({ where: { shopDomain }, data: { conversationCount: 0, conversationResetAt: now } })
      .catch(() => null);
    await redis.set(usageKey(shopDomain), "0").catch(() => null);
  }

  const key = usageKey(shopDomain);
  try {
    // Check if this session has already been counted toward the plan limit.
    // If yes, allow the message through without incrementing.
    if (sessionId) {
      const billedKey = sessionBilledKey(shopDomain, sessionId);
      const alreadyBilled = await redis.exists(billedKey);
      if (alreadyBilled) {
        // Session already counted — just return current usage without incrementing.
        await redis.set(key, String(durableCount), "NX"); // atomic: only sets if not exists
        const liveCount = parseInt((await redis.get(key)) ?? String(durableCount), 10);
        if (liveCount >= limit) {
          return { allowed: false, used: liveCount, limit };
        }
        return { allowed: true, used: liveCount, limit };
      }
    }

    // New session (or no sessionId) — check limit and increment.
    await redis.set(key, String(durableCount), "NX"); // atomic: only sets if not exists
    const liveCount = parseInt((await redis.get(key)) ?? String(durableCount), 10);

    if (liveCount >= limit) {
      return { allowed: false, used: liveCount, limit };
    }

    const newCount = await redis.incr(key);

    // Mark this session as billed so subsequent messages don't increment.
    if (sessionId) {
      await redis.setex(sessionBilledKey(shopDomain, sessionId), SESSION_BILLED_TTL, "1").catch(() => null);
    }

    if (newCount % PRISMA_SYNC_INTERVAL === 0) {
      await prisma.merchant
        .update({ where: { shopDomain }, data: { conversationCount: newCount } })
        .catch(() => null);
    }
    return { allowed: true, used: newCount, limit };
  } catch {
    // Redis fully unavailable — fall back to Prisma. Cannot deduplicate by
    // session without Redis, so this counts per message during an outage.
    if (durableCount >= limit) {
      return { allowed: false, used: durableCount, limit };
    }
    const updated = await prisma.merchant
      .update({ where: { shopDomain }, data: { conversationCount: { increment: 1 } } })
      .catch(() => null);
    return { allowed: true, used: updated?.conversationCount ?? durableCount + 1, limit };
  }
}

/**
 * Returns the current usage snapshot for a shop without modifying any counters.
 * Reads the live Redis count when available, falls back to the durable Prisma value.
 */
export async function getUsage(shopDomain: string): Promise<{ used: number; limit: number; plan: string }> {
  const merchant = await prisma.merchant.findUnique({
    where: { shopDomain },
    select: { plan: true, conversationCount: true, conversationResetAt: true },
  });
  if (!merchant) return { used: 0, limit: 0, plan: "free" };
  const limit = PLAN_LIMITS[merchant.plan as keyof typeof PLAN_LIMITS] ?? 0;
  try {
    const key = usageKey(shopDomain);
    const val = await redis.get(key);
    const used = val ? parseInt(String(val), 10) : merchant.conversationCount;
    return { used: isNaN(used) ? 0 : used, limit, plan: merchant.plan };
  } catch {
    return { used: merchant.conversationCount, limit, plan: merchant.plan };
  }
}
