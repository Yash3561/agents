import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/redis.server", () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
}));

import { getSession, setSession } from "~/lib/session.server";
import { redis } from "~/redis.server";

const mockRedis = redis as unknown as {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getSession", () => {
  it("returns DEFAULT_SESSION for non-existent key", async () => {
    mockRedis.get.mockResolvedValue(null);

    const session = await getSession("shop.myshopify.com", "new-session-id");
    expect(session.conversation_history).toEqual([]);
    expect(session.discount_negotiation).toEqual({ offered_codes: [], level: 0 });
    expect(session.cart_id).toBeUndefined();
  });

  it("migrates sessions missing discount_negotiation field", async () => {
    const legacy = {
      conversation_history: [
        { role: "user", content: "hello", timestamp: Date.now() },
      ],
      cart_id: "gid://shopify/Cart/abc",
      // No discount_negotiation field
    };
    mockRedis.get.mockResolvedValue(JSON.stringify(legacy));

    const session = await getSession("shop.myshopify.com", "legacy-session");
    expect(session.discount_negotiation).toEqual({ offered_codes: [], level: 0 });
    expect(session.cart_id).toBe("gid://shopify/Cart/abc");
    expect(session.conversation_history).toHaveLength(1);
  });

  it("returns DEFAULT_SESSION when Redis returns corrupted JSON", async () => {
    mockRedis.get.mockResolvedValue("{not valid json{{{{");

    const session = await getSession("shop.myshopify.com", "corrupt-session");
    expect(session.conversation_history).toEqual([]);
  });

  it("returns DEFAULT_SESSION when Redis throws", async () => {
    mockRedis.get.mockRejectedValue(new Error("Redis down"));

    const session = await getSession("shop.myshopify.com", "error-session");
    expect(session.conversation_history).toEqual([]);
    expect(session.discount_negotiation).toEqual({ offered_codes: [], level: 0 });
  });

  it("loads a valid session correctly", async () => {
    const stored = {
      conversation_history: [
        { role: "user", content: "hi", timestamp: 1000 },
        { role: "assistant", content: "hello", timestamp: 1001 },
      ],
      cart_id: "gid://shopify/Cart/xyz",
      discount_negotiation: { offered_codes: ["SAVE10"], level: 1 },
    };
    mockRedis.get.mockResolvedValue(JSON.stringify(stored));

    const session = await getSession("shop.myshopify.com", "good-session");
    expect(session.conversation_history).toHaveLength(2);
    expect(session.cart_id).toBe("gid://shopify/Cart/xyz");
    expect(session.discount_negotiation.offered_codes).toContain("SAVE10");
  });
});

describe("setSession", () => {
  it("trims conversation_history to MAX_HISTORY (20) before saving", async () => {
    mockRedis.set.mockResolvedValue("OK");

    // Build a history with 25 messages
    const messages = Array.from({ length: 25 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `msg ${i}`,
      timestamp: i,
    }));

    await setSession("shop.myshopify.com", "trim-session", {
      conversation_history: messages,
      discount_negotiation: { offered_codes: [], level: 0 },
    });

    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    const savedRaw = mockRedis.set.mock.calls[0][1] as string;
    const saved = JSON.parse(savedRaw);
    // Should only have last 20
    expect(saved.conversation_history).toHaveLength(20);
    // Should start from message index 5 (the last 20 of 25)
    expect(saved.conversation_history[0].content).toBe("msg 5");
  });

  it("sets the session TTL as EX parameter", async () => {
    mockRedis.set.mockResolvedValue("OK");

    await setSession("shop.myshopify.com", "ttl-session", {
      conversation_history: [],
      discount_negotiation: { offered_codes: [], level: 0 },
    });

    const [, , exFlag, ttlValue] = mockRedis.set.mock.calls[0] as [string, string, string, number];
    expect(exFlag).toBe("EX");
    expect(ttlValue).toBeGreaterThan(0);
  });

  it("uses correct Redis key format", async () => {
    mockRedis.set.mockResolvedValue("OK");

    await setSession("mystore.myshopify.com", "session-abc", {
      conversation_history: [],
      discount_negotiation: { offered_codes: [], level: 0 },
    });

    const key = mockRedis.set.mock.calls[0][0] as string;
    expect(key).toBe("session:mystore.myshopify.com:session-abc");
  });
});
