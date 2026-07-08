import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Redis and Prisma before importing the module under test
vi.mock("~/redis.server", () => ({
  redis: {
    exists: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    setex: vi.fn(),
    incr: vi.fn(),
  },
}));

vi.mock("~/db.server", () => ({
  default: {
    merchant: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("~/lib/conversation.server", () => ({
  sendUsageAlertEmail: vi.fn().mockResolvedValue(undefined),
}));

import { checkAndIncrementUsage, PLAN_LIMITS } from "~/lib/billing.server";
import { sendUsageAlertEmail } from "~/lib/conversation.server";
import { redis } from "~/redis.server";
import prisma from "~/db.server";

const mockRedis = redis as unknown as {
  exists: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  setex: ReturnType<typeof vi.fn>;
  incr: ReturnType<typeof vi.fn>;
};

const mockPrisma = prisma as unknown as {
  merchant: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

const now = new Date();
const recentReset = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day ago

function makeMerchant(plan: string, conversationCount: number) {
  return {
    shopDomain: "test.myshopify.com",
    plan,
    conversationCount,
    conversationResetAt: recentReset,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("checkAndIncrementUsage", () => {
  it("returns allowed:false when merchant not found", async () => {
    mockPrisma.merchant.findUnique.mockResolvedValue(null);

    const result = await checkAndIncrementUsage("unknown.myshopify.com");
    expect(result.allowed).toBe(false);
    expect(result.limit).toBe(0);
  });

  it("blocks the 501st session on spark plan (limit 500)", async () => {
    mockPrisma.merchant.findUnique.mockResolvedValue(
      makeMerchant("spark", 500),
    );
    // session not already billed
    mockRedis.exists.mockResolvedValueOnce(0); // sessionBilledKey check
    mockRedis.get.mockResolvedValue("500");

    const result = await checkAndIncrementUsage(
      "test.myshopify.com",
      "session-501",
    );
    expect(result.allowed).toBe(false);
    expect(result.used).toBe(500);
    expect(result.limit).toBe(500);
  });

  it("allows sessions under spark plan limit", async () => {
    mockPrisma.merchant.findUnique.mockResolvedValue(
      makeMerchant("spark", 100),
    );
    // session not already billed
    mockRedis.exists.mockResolvedValueOnce(0); // sessionBilledKey check
    // usage key exists
    mockRedis.exists.mockResolvedValueOnce(1);
    mockRedis.get.mockResolvedValue("100");
    mockRedis.incr.mockResolvedValue(101);
    mockRedis.setex.mockResolvedValue("OK");

    const result = await checkAndIncrementUsage(
      "test.myshopify.com",
      "session-101",
    );
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(101);
  });

  it("surge plan (limit 10000) is never blocked below limit", async () => {
    mockPrisma.merchant.findUnique.mockResolvedValue(
      makeMerchant("surge", 9999),
    );
    mockPrisma.merchant.update.mockResolvedValue({ conversationCount: 10000 });
    mockRedis.exists.mockResolvedValueOnce(0);
    mockRedis.exists.mockResolvedValueOnce(1);
    mockRedis.get.mockResolvedValue("9999");
    mockRedis.incr.mockResolvedValue(10000);
    mockRedis.setex.mockResolvedValue("OK");

    const result = await checkAndIncrementUsage(
      "test.myshopify.com",
      "session-xyz",
    );
    expect(result.allowed).toBe(true);
  });

  it("same session_id within 7-day TTL is counted only once (allowed, no increment)", async () => {
    mockPrisma.merchant.findUnique.mockResolvedValue(
      makeMerchant("spark", 50),
    );
    // First call: session NOT billed yet
    mockRedis.exists.mockResolvedValueOnce(0); // sessionBilledKey
    mockRedis.get.mockResolvedValue("50");
    mockRedis.incr.mockResolvedValue(51);
    mockRedis.setex.mockResolvedValue("OK");

    await checkAndIncrementUsage("test.myshopify.com", "dup-session");
    expect(mockRedis.incr).toHaveBeenCalledTimes(1);

    vi.resetAllMocks();

    // Second call: same session IS already billed
    mockPrisma.merchant.findUnique.mockResolvedValue(
      makeMerchant("spark", 51),
    );
    mockRedis.exists.mockResolvedValueOnce(1); // sessionBilledKey — already billed
    mockRedis.get.mockResolvedValue("51");

    const result2 = await checkAndIncrementUsage(
      "test.myshopify.com",
      "dup-session",
    );
    expect(result2.allowed).toBe(true);
    // incr must NOT be called for an already-billed session
    expect(mockRedis.incr).not.toHaveBeenCalled();
  });

  it("fails open when Redis throws — falls back to Prisma", async () => {
    mockPrisma.merchant.findUnique.mockResolvedValue(
      makeMerchant("spark", 10),
    );
    // Redis is down
    mockRedis.exists.mockRejectedValue(new Error("Redis connection error"));
    // Prisma update succeeds as fallback
    mockPrisma.merchant.update.mockResolvedValue({ conversationCount: 11 });

    const result = await checkAndIncrementUsage(
      "test.myshopify.com",
      "session-redis-down",
    );
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(11);
  });

  it("emails the merchant once when crossing 80% of the plan limit", async () => {
    mockPrisma.merchant.findUnique.mockResolvedValue({
      ...makeMerchant("spark", 399),
      supportEmail: "owner@store.com",
    });
    mockPrisma.merchant.update.mockResolvedValue({ conversationCount: 400 });
    mockRedis.exists.mockResolvedValueOnce(0); // session not billed
    mockRedis.get.mockResolvedValue("399");
    mockRedis.incr.mockResolvedValue(400); // 400/500 = exactly 80%
    mockRedis.set.mockResolvedValue("OK"); // NX dedup flag acquired
    mockRedis.setex.mockResolvedValue("OK");

    await checkAndIncrementUsage("test.myshopify.com", "session-80pct");
    await new Promise((r) => setTimeout(r, 0)); // alertUsage is fire-and-forget

    expect(sendUsageAlertEmail).toHaveBeenCalledWith(
      "owner@store.com", "test.myshopify.com", 400, 500, 80,
    );
  });

  it("does not re-email when the cycle dedup flag already exists", async () => {
    mockPrisma.merchant.findUnique.mockResolvedValue({
      ...makeMerchant("spark", 400),
      supportEmail: "owner@store.com",
    });
    mockPrisma.merchant.update.mockResolvedValue({ conversationCount: 401 });
    mockRedis.exists.mockResolvedValueOnce(0);
    mockRedis.get.mockResolvedValue("400");
    mockRedis.incr.mockResolvedValue(401);
    mockRedis.set.mockResolvedValue(null); // NX flag NOT acquired — already alerted
    mockRedis.setex.mockResolvedValue("OK");

    await checkAndIncrementUsage("test.myshopify.com", "session-81pct");
    await new Promise((r) => setTimeout(r, 0));

    expect(sendUsageAlertEmail).not.toHaveBeenCalled();
  });

  it("PLAN_LIMITS constants match expected values", () => {
    expect(PLAN_LIMITS.spark).toBe(500);
    expect(PLAN_LIMITS.pulse).toBe(2500);
    expect(PLAN_LIMITS.surge).toBe(10000);
  });
});
