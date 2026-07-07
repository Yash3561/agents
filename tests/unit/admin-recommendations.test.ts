import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const redisMock = { get: vi.fn(), set: vi.fn() };
vi.mock("~/redis.server", () => ({ redis: redisMock }));

import { getProductRecommendation, lookupCustomerByPhone } from "~/lib/mcp/admin.server";

const SHOP = "test.myshopify.com";

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetchSequence(responses: Array<{ url: RegExp; status?: number; body: unknown }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const match = responses.find((r) => r.url.test(url));
      if (!match) throw new Error(`Unexpected fetch to ${url}`);
      return {
        ok: (match.status ?? 200) < 400,
        status: match.status ?? 200,
        json: async () => match.body,
      } as Response;
    }),
  );
}

describe("getProductRecommendation", () => {
  it("returns a cached recommendation without hitting the network", async () => {
    redisMock.get.mockResolvedValue(
      JSON.stringify({ id: "1", title: "Cached Item", variantId: "gid://shopify/ProductVariant/1", priceCents: 500 }),
    );
    mockFetchSequence([]); // fetch must not be called

    const rec = await getProductRecommendation(SHOP, "token", "100");
    expect(rec).toEqual({ id: "1", title: "Cached Item", variantId: "gid://shopify/ProductVariant/1", priceCents: 500 });
  });

  it("returns null immediately when the cache holds the negative sentinel", async () => {
    redisMock.get.mockResolvedValue("none");
    mockFetchSequence([]);

    const rec = await getProductRecommendation(SHOP, "token", "100");
    expect(rec).toBeNull();
  });

  it("fetches live, resolves the variant, and caches the result on a cold cache", async () => {
    mockFetchSequence([
      { url: /recommendations\/products\.json/, body: { recommendations: [{ id: 42 }] } },
      { url: /graphql\.json/, body: { data: { product: { title: "Hat", variants: { nodes: [{ id: "gid://shopify/ProductVariant/9", price: "19.99", title: "Default Title" }] } } } } },
    ]);

    const rec = await getProductRecommendation(SHOP, "token", "100");
    expect(rec).toEqual({ id: "42", title: "Hat", variantId: "gid://shopify/ProductVariant/9", priceCents: 1999 });
    expect(redisMock.set).toHaveBeenCalledWith(
      "productrec:test.myshopify.com:100",
      JSON.stringify(rec),
      "EX",
      3600,
    );
  });

  it("caches a negative result when Shopify returns no recommendations", async () => {
    mockFetchSequence([{ url: /recommendations\/products\.json/, body: { recommendations: [] } }]);

    const rec = await getProductRecommendation(SHOP, "token", "100");
    expect(rec).toBeNull();
    expect(redisMock.set).toHaveBeenCalledWith("productrec:test.myshopify.com:100", "none", "EX", 3600);
  });

  it("returns null when the REST endpoint errors", async () => {
    mockFetchSequence([{ url: /recommendations\/products\.json/, status: 500, body: {} }]);

    const rec = await getProductRecommendation(SHOP, "token", "100");
    expect(rec).toBeNull();
  });
});

describe("lookupCustomerByPhone caching (Fix E — was an uncached Admin API call on every WhatsApp message)", () => {
  it("returns a cached customer without hitting the network", async () => {
    redisMock.get.mockResolvedValue(JSON.stringify({ id: "gid://shopify/Customer/1", firstName: "Ana" }));
    mockFetchSequence([]); // fetch must not be called

    const customer = await lookupCustomerByPhone(SHOP, "token", "+15551234567");
    expect(customer).toEqual({ id: "gid://shopify/Customer/1", firstName: "Ana" });
  });

  it("returns null immediately when the cache holds the negative sentinel", async () => {
    redisMock.get.mockResolvedValue("none");
    mockFetchSequence([]);

    const customer = await lookupCustomerByPhone(SHOP, "token", "+15551234567");
    expect(customer).toBeNull();
  });

  it("fetches live and caches the result (positive and negative) on a cold cache", async () => {
    mockFetchSequence([
      { url: /graphql\.json/, body: { data: { customers: { edges: [{ node: { id: "gid://shopify/Customer/2" } }] } } } },
    ]);

    const customer = await lookupCustomerByPhone(SHOP, "token", "+15551234567");
    expect(customer).toEqual({ id: "gid://shopify/Customer/2" });
    expect(redisMock.set).toHaveBeenCalledWith(
      "wa:custlookup:test.myshopify.com:+15551234567",
      JSON.stringify(customer),
      "EX",
      300,
    );
  });

  it("caches the negative sentinel when no customer matches the phone", async () => {
    mockFetchSequence([{ url: /graphql\.json/, body: { data: { customers: { edges: [] } } } }]);

    const customer = await lookupCustomerByPhone(SHOP, "token", "+15559999999");
    expect(customer).toBeNull();
    expect(redisMock.set).toHaveBeenCalledWith("wa:custlookup:test.myshopify.com:+15559999999", "none", "EX", 300);
  });
});
