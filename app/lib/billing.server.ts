import prisma from "~/db.server";
import { redis } from "~/redis.server";

/**
 * Conversation-per-month limits per plan. Real plan assignment depends on
 * Shopify's Billing API (#27, not yet built) — until then every merchant
 * defaults to "free" via the Merchant model. This map and the limit
 * enforcement below are real and active regardless; only the mechanism
 * that upgrades merchant.plan is missing.
 */
const PLAN_LIMITS: Record<string, number> = {
  free: 500,
  trial: 500,
  starter: 500,
  growth: 2000,
  pro: 999_999,
};

const usageKey = (shopDomain: string) => `usage:${shopDomain}`;
const PRISMA_SYNC_INTERVAL = 10;

export interface UsageCheck {
  allowed: boolean;
  used: number;
  limit: number;
}

function isNewBillingMonth(resetAt: Date, now: Date): boolean {
  return (
    now.getUTCFullYear() !== resetAt.getUTCFullYear() ||
    now.getUTCMonth() !== resetAt.getUTCMonth()
  );
}

/**
 * Checks the shop's conversation usage against its plan limit, and — if
 * allowed — increments the counter for this turn. Redis is the fast path
 * (avoids a Prisma write on every single chat message); the durable count
 * in Postgres is synced every PRISMA_SYNC_INTERVAL increments, and is the
 * source of truth Redis re-seeds from after a cache miss/restart.
 *
 * Fails open: if Redis is unavailable, falls back to a direct Prisma
 * increment so a Redis outage never blocks chat.
 */
export async function checkAndIncrementUsage(shopDomain: string): Promise<UsageCheck> {
  const merchant = await prisma.merchant.findUnique({ where: { shopDomain } });
  if (!merchant) {
    return { allowed: true, used: 0, limit: PLAN_LIMITS.free };
  }

  const limit = PLAN_LIMITS[merchant.plan] ?? PLAN_LIMITS.free;
  const now = new Date();
  let durableCount = merchant.conversationCount;

  if (isNewBillingMonth(merchant.conversationResetAt, now)) {
    durableCount = 0;
    await prisma.merchant
      .update({ where: { shopDomain }, data: { conversationCount: 0, conversationResetAt: now } })
      .catch(() => null);
    await redis.set(usageKey(shopDomain), "0").catch(() => null);
  }

  const key = usageKey(shopDomain);
  try {
    // The live count must come from Redis, not the Prisma snapshot — Prisma
    // only syncs every PRISMA_SYNC_INTERVAL increments, so checking against
    // it would let a shop run up to that many requests past its real limit.
    const exists = await redis.exists(key);
    if (!exists) await redis.set(key, String(durableCount));
    const liveCount = parseInt((await redis.get(key)) ?? String(durableCount), 10);

    if (liveCount >= limit) {
      return { allowed: false, used: liveCount, limit };
    }

    const newCount = await redis.incr(key);
    if (newCount % PRISMA_SYNC_INTERVAL === 0) {
      await prisma.merchant
        .update({ where: { shopDomain }, data: { conversationCount: newCount } })
        .catch(() => null);
    }
    return { allowed: true, used: newCount, limit };
  } catch {
    // Redis fully unavailable — fall back to the durable Prisma count for
    // both the check and the increment, so a Redis outage never blocks chat
    // but also never silently skips enforcement.
    if (durableCount >= limit) {
      return { allowed: false, used: durableCount, limit };
    }
    const updated = await prisma.merchant
      .update({ where: { shopDomain }, data: { conversationCount: { increment: 1 } } })
      .catch(() => null);
    return { allowed: true, used: updated?.conversationCount ?? durableCount + 1, limit };
  }
}
