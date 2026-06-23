import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock adminGraphql and llm so no real network calls happen
vi.mock("~/lib/mcp/admin.server", () => ({
  adminGraphql: vi.fn(),
}));

vi.mock("~/lib/llm.server", () => ({
  generateSummary: vi.fn().mockResolvedValue("Summary of shopping session."),
}));

import {
  fetchCustomerMemory,
  clearAbandonedCart,
  updateCustomerMemory,
  type CustomerMemory,
} from "~/lib/agents/memory.server";
import { adminGraphql } from "~/lib/mcp/admin.server";

const mockAdminGraphql = adminGraphql as ReturnType<typeof vi.fn>;

const SHOP = "shop.myshopify.com";
const TOKEN = "fake-access-token";
const CUSTOMER_ID = "gid://shopify/Customer/123";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CustomerMemory type shape", () => {
  it("is a well-formed object with optional fields", () => {
    const memory: CustomerMemory = {
      recent_products: ["Product A", "Product B"],
      last_search: "yoga mat",
      summary: "Customer was looking for yoga equipment.",
      abandoned_cart: {
        items: [],
        total: 29.99,
        timestamp: new Date().toISOString(),
      },
      firstName: "Alice",
      phone: "+1555555555",
    };

    expect(memory.recent_products).toHaveLength(2);
    expect(memory.last_search).toBe("yoga mat");
    expect(memory.firstName).toBe("Alice");
    expect(memory.abandoned_cart?.total).toBe(29.99);
  });
});

describe("fetchCustomerMemory", () => {
  it("returns empty object for empty customerId", async () => {
    const result = await fetchCustomerMemory(SHOP, TOKEN, "");
    expect(result).toEqual({});
    expect(mockAdminGraphql).not.toHaveBeenCalled();
  });

  it("returns parsed memory from metafields", async () => {
    mockAdminGraphql.mockResolvedValue({
      customer: {
        firstName: "Bob",
        phone: null,
        metafields: {
          edges: [
            {
              node: {
                key: "recent_products",
                value: JSON.stringify(["Resistance Bands (Pink)"]),
              },
            },
            {
              node: {
                key: "last_search",
                value: JSON.stringify("resistance bands"),
              },
            },
          ],
        },
      },
    });

    const memory = await fetchCustomerMemory(SHOP, TOKEN, CUSTOMER_ID);
    expect(memory.firstName).toBe("Bob");
    expect(memory.recent_products).toEqual(["Resistance Bands (Pink)"]);
    expect(memory.last_search).toBe("resistance bands");
  });

  it("returns empty object when adminGraphql throws", async () => {
    mockAdminGraphql.mockRejectedValue(new Error("Network error"));

    const memory = await fetchCustomerMemory(SHOP, TOKEN, CUSTOMER_ID);
    expect(memory).toEqual({});
  });

  it("silently skips corrupted metafield values", async () => {
    mockAdminGraphql.mockResolvedValue({
      customer: {
        firstName: "Carol",
        phone: null,
        metafields: {
          edges: [
            {
              node: {
                key: "recent_products",
                value: "not-valid-json{{{",
              },
            },
          ],
        },
      },
    });

    const memory = await fetchCustomerMemory(SHOP, TOKEN, CUSTOMER_ID);
    expect(memory.firstName).toBe("Carol");
    expect(memory.recent_products).toBeUndefined();
  });
});

describe("clearAbandonedCart", () => {
  it("is a no-op for empty customerId", async () => {
    await clearAbandonedCart(SHOP, TOKEN, "");
    expect(mockAdminGraphql).not.toHaveBeenCalled();
  });

  it("is a no-op when there is no abandoned_cart in memory", async () => {
    // fetchCustomerMemory returns memory without abandoned_cart
    mockAdminGraphql.mockResolvedValueOnce({
      customer: {
        firstName: "Dave",
        phone: null,
        metafields: { edges: [] },
      },
    });

    await clearAbandonedCart(SHOP, TOKEN, CUSTOMER_ID);

    // writeMemory should NOT be called (no entries to write after clearing nothing)
    // adminGraphql should be called once for fetch, NOT again for write
    expect(mockAdminGraphql).toHaveBeenCalledTimes(1);
  });

  it("clears abandoned_cart while preserving other fields", async () => {
    const existingMemory = {
      customer: {
        firstName: "Eve",
        phone: null,
        metafields: {
          edges: [
            {
              node: {
                key: "abandoned_cart",
                value: JSON.stringify({
                  items: [{ id: "1", title: "Product X" }],
                  total: 49.99,
                  timestamp: new Date().toISOString(),
                }),
              },
            },
            {
              node: {
                key: "last_search",
                value: JSON.stringify("yoga mat"),
              },
            },
          ],
        },
      },
    };

    // fetchCustomerMemory
    mockAdminGraphql.mockResolvedValueOnce(existingMemory);
    // writeMemory mutation
    mockAdminGraphql.mockResolvedValueOnce({
      metafieldsSet: { userErrors: [] },
    });

    await clearAbandonedCart(SHOP, TOKEN, CUSTOMER_ID);

    // Should have called graphql twice: once to fetch, once to write
    expect(mockAdminGraphql).toHaveBeenCalledTimes(2);

    // The write call should include last_search but NOT abandoned_cart
    const writeCall = mockAdminGraphql.mock.calls[1];
    const variables = writeCall[3] as { metafields: Array<{ key: string }> };
    const keys = variables.metafields.map((m) => m.key);
    expect(keys).toContain("last_search");
    expect(keys).not.toContain("abandoned_cart");
  });
});

describe("updateCustomerMemory — extractRecentProducts via cartLines", () => {
  it("extracts product titles from cart lines and stores them", async () => {
    // fetchCustomerMemory
    mockAdminGraphql.mockResolvedValueOnce({
      customer: {
        firstName: "Frank",
        phone: null,
        metafields: { edges: [] },
      },
    });
    // writeMemory
    mockAdminGraphql.mockResolvedValueOnce({
      metafieldsSet: { userErrors: [] },
    });

    const cartLines = [
      {
        merchandise: {
          title: "Pink",
          product: { title: "Resistance Bands" },
        },
      },
    ];

    await updateCustomerMemory(
      SHOP,
      TOKEN,
      CUSTOMER_ID,
      {
        conversation_history: [],
        discount_negotiation: { offered_codes: [], level: 0 },
      },
      "resistance bands",
      cartLines,
    );

    const writeCall = mockAdminGraphql.mock.calls[1];
    const variables = writeCall[3] as { metafields: Array<{ key: string; value: string }> };
    const recentField = variables.metafields.find((m) => m.key === "recent_products");
    expect(recentField).toBeDefined();
    const parsed = JSON.parse(recentField!.value) as string[];
    expect(parsed[0]).toBe("Resistance Bands (Pink)");
  });
});
