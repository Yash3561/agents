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

function rawProduct(id: string, title: string, variantAvailable: boolean) {
  return {
    id,
    title,
    variants: [{ id: `${id}-v1`, title: "Default Title", price: { amount: "10.00", currency: "USD" }, availability: { available: variantAvailable } }],
  };
}

describe("product descriptions are stripped of HTML before reaching the agent", () => {
  it("removes tags and decodes entities from a rich-text description", async () => {
    callMcpToolMock.mockResolvedValue({
      structuredContent: {
        products: [{
          id: "gid://1",
          title: "Item",
          description: { html: "<p>Made from <strong>100% cotton</strong> &amp; recycled fibers.</p><ul><li>Machine washable</li></ul>" },
          variants: [{ id: "v1", title: "Default", price: { amount: "10.00", currency: "USD" }, availability: { available: true } }],
        }],
      },
    });

    const result = await searchCatalog(SHOP, "item");
    expect(result.products[0].description).toBe("Made from 100% cotton & recycled fibers. Machine washable");
  });

  it("leaves a plain-string description untouched aside from whitespace", async () => {
    callMcpToolMock.mockResolvedValue({
      structuredContent: {
        products: [{
          id: "gid://2",
          title: "Item",
          description: "Already plain text",
          variants: [{ id: "v1", title: "Default", price: { amount: "10.00", currency: "USD" }, availability: { available: true } }],
        }],
      },
    });

    const result = await searchCatalog(SHOP, "item");
    expect(result.products[0].description).toBe("Already plain text");
  });
});

describe("search results preserve active products that Shopify marks unavailable", () => {
  it("keeps a product whose only variant is unavailable-looking for oversell/backorder stores", async () => {
    callMcpToolMock.mockResolvedValue({
      structuredContent: {
        products: [
          rawProduct("gid://1", "In Stock Item", true),
          rawProduct("gid://2", "Oversell Item", false),
        ],
      },
    });

    const result = await searchCatalog(SHOP, "anything");
    expect(result.products.map((p) => p.title)).toEqual(["In Stock Item", "Oversell Item"]);
    expect(result.total).toBe(2);
  });

  it("keeps all variants so WhatsApp can still offer real size/color choices", async () => {
    callMcpToolMock.mockResolvedValue({
      structuredContent: {
        products: [{
          id: "gid://3",
          title: "Multi-Variant Item",
          variants: [
            { id: "v1", title: "Small", price: { amount: "10.00", currency: "USD" }, availability: { available: false } },
            { id: "v2", title: "Large", price: { amount: "10.00", currency: "USD" }, availability: { available: true } },
          ],
        }],
      },
    });

    const result = await searchCatalog(SHOP, "anything");
    expect(result.products).toHaveLength(1);
    expect(result.products[0].variants.map((v) => v.title)).toEqual(["Small", "Large"]);
  });
});
