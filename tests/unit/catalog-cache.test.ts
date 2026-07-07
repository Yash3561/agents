/**
 * Regression test: searchCacheKey used to omit `intent`, even though intent
 * changes the actual query sent to Shopify (context.intent) and reorders
 * results. Within the 60s cache TTL, a gift-intent search and a plain search
 * for the identical query text used to silently share a cache entry.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { redisMock, callMcpToolMock } = vi.hoisted(() => ({
  redisMock: { get: vi.fn(), setex: vi.fn() },
  callMcpToolMock: vi.fn(),
}));

vi.mock("~/redis.server", () => ({ redis: redisMock }));
vi.mock("~/lib/mcp/client.server", () => ({
  callMcpTool: (...args: unknown[]) => callMcpToolMock(...args),
  McpError: class McpError extends Error {},
}));

import { searchCatalog } from "~/lib/mcp/catalog.server";

const SHOP = "test.myshopify.com";

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockResolvedValue(null);
  redisMock.setex.mockResolvedValue(undefined);
  callMcpToolMock.mockResolvedValue({ structuredContent: { products: [], pagination: undefined } });
});

describe("search cache key includes intent (Fix B)", () => {
  it("uses different cache keys for the same query with different intent", async () => {
    await searchCatalog(SHOP, "socks", { intent: "gift for dad" });
    await searchCatalog(SHOP, "socks", { intent: "running gear" });

    const keysWritten = redisMock.setex.mock.calls.map((c) => c[0]);
    expect(keysWritten[0]).not.toBe(keysWritten[1]);
    expect(keysWritten[0]).toContain("gift for dad");
    expect(keysWritten[1]).toContain("running gear");
  });

  it("a cached result for one intent is not served to a different intent", async () => {
    redisMock.get.mockImplementation(async (key: string) =>
      key.endsWith(":gift for dad") ? JSON.stringify({ products: [{ id: "cached" }], total: 1 }) : null,
    );

    const giftResult = await searchCatalog(SHOP, "socks", { intent: "gift for dad" });
    expect(giftResult.products[0]).toEqual({ id: "cached" });
    expect(callMcpToolMock).not.toHaveBeenCalled();

    const plainResult = await searchCatalog(SHOP, "socks", {});
    expect(plainResult.products).toEqual([]); // fresh fetch, not the gift-cached result
    expect(callMcpToolMock).toHaveBeenCalledTimes(1);
  });
});
