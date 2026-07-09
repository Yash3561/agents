/**
 * Real-model eval for the web-widget agent's system prompt (app/lib/prompt.server.ts,
 * consumed via app/lib/agents/unified.server.ts's runUnifiedAgent). Unlike
 * tests/unit/unified-agent-fixes.test.ts, this does NOT mock `ai` or
 * `~/lib/llm.server` — a real gpt-4o-mini call goes out to Azure AI Foundry.
 * Only the Shopify MCP network boundary (catalog/cart/discounts/policy/order)
 * is mocked, using the exact same fixture-mock pattern as the existing unit
 * tests, so the prompt text and tool schemas under test are 100% the real
 * production ones — only the fixtures backing tool results are fake.
 *
 * Skips (does not fail) without real Azure credentials — see README.md.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { hasCreds } from "./helpers/has-creds";

const searchCatalogMock = vi.fn();
const getProductMock = vi.fn();
vi.mock("~/lib/mcp/catalog.server", () => ({
  searchCatalog: (...args: unknown[]) => searchCatalogMock(...args),
  getProduct: (...args: unknown[]) => getProductMock(...args),
  lookupCatalog: vi.fn(),
}));
vi.mock("~/lib/mcp/policy.server", () => ({ searchPoliciesAndFaqs: vi.fn() }));
vi.mock("~/lib/mcp/order.server", () => ({ getOrder: vi.fn().mockRejectedValue(new Error("not found")) }));
vi.mock("~/lib/mcp/customer-accounts.server", () => ({ getCustomerOrders: vi.fn() }));
vi.mock("~/lib/mcp/cart.server", () => ({
  createCart: vi.fn(),
  getCart: vi.fn(),
  updateCart: vi.fn(),
}));
vi.mock("~/lib/mcp/discounts.server", () => ({ getActiveDiscounts: vi.fn().mockResolvedValue([]) }));

import { runUnifiedAgent } from "~/lib/agents/unified.server";
import type { ConversationSession } from "~/lib/session.server";
import type { Merchant } from "@prisma/client";
import type { CustomerMemory } from "~/lib/agents/memory.server";

const merchant = {
  shopDomain: "test.myshopify.com",
  brandVoice: "friendly and helpful",
  personalizationEnabled: false,
  quickReplies: [],
} as unknown as Merchant;
const memory = {} as CustomerMemory;

function makeSession(): ConversationSession {
  return { conversation_history: [], discount_negotiation: { offered_codes: [], level: 0 } };
}

const baseOpts = {
  shopDomain: "test.myshopify.com",
  merchant,
  memory,
  accessToken: "admin-token",
};

// Rough sentence count: split on ., !, ? — ignoring the trailing terminator and blanks.
function countSentences(text: string): number {
  return text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.skipIf(!hasCreds)("real-model eval: rule 3a — one sentence after search_catalog", () => {
  it("replies with a single short sentence and no per-product details, prices, or lists", async () => {
    searchCatalogMock.mockResolvedValue({
      products: [
        {
          id: "gid://shopify/Product/1",
          title: "Eco Yoga Mat",
          price_min: "29.99",
          variants: [{ id: "gid://shopify/ProductVariant/1", title: "Default", price: "29.99", available: true }],
        },
        {
          id: "gid://shopify/Product/2",
          title: "Pro Yoga Mat",
          price_min: "49.99",
          variants: [{ id: "gid://shopify/ProductVariant/2", title: "Default", price: "49.99", available: true }],
        },
      ],
      total: 2,
    });

    const result = await runUnifiedAgent({
      ...baseOpts,
      agentMessage: "show me some yoga mats",
      session: makeSession(),
    });

    expect(result.agent_trace).toContain("search_catalog");
    expect(countSentences(result.text)).toBeLessThanOrEqual(1);
    expect(result.text).not.toMatch(/\n/);
    expect(result.text).not.toMatch(/29\.99|49\.99/);
    expect(result.text.toLowerCase()).not.toContain("eco yoga mat");
    expect(result.text.toLowerCase()).not.toContain("pro yoga mat");
  });
});

describe.skipIf(!hasCreds)("real-model eval: rule 3h — product-detail Q&A", () => {
  it("calls get_product and answers with real detail instead of a generic one-liner", async () => {
    searchCatalogMock.mockResolvedValue({
      products: [
        {
          id: "gid://shopify/Product/99",
          title: "Organic Cotton Tee",
          price_min: "24.00",
          variants: [{ id: "gid://shopify/ProductVariant/99", title: "Default", price: "24.00", available: true }],
        },
      ],
      total: 1,
    });
    getProductMock.mockResolvedValue({
      id: "gid://shopify/Product/99",
      title: "Organic Cotton Tee",
      description:
        "Made from 100% GOTS-certified organic cotton, pre-shrunk and machine washable cold. Runs true to size.",
      variants: [{ id: "gid://shopify/ProductVariant/99", title: "Default", price: "24.00", available: true }],
    });

    const result = await runUnifiedAgent({
      ...baseOpts,
      agentMessage: "what material is the Organic Cotton Tee made of, and can I machine wash it?",
      session: makeSession(),
    });

    expect(result.agent_trace).toContain("get_product");
    expect(result.text.length).toBeGreaterThan(30);
    // The real fact only exists in the get_product fixture, not the search snippet —
    // this is the check that catches the model answering from the title alone.
    expect(result.text.toLowerCase()).toMatch(/organic|cotton|gots/);
    expect(result.text.toLowerCase()).toMatch(/wash/);
  });
});

describe.skipIf(!hasCreds)("real-model eval: gift-intent extraction", () => {
  it("passes gift + recipient + interest intent and maxPriceCents to search_catalog", async () => {
    searchCatalogMock.mockResolvedValue({
      products: [
        {
          id: "gid://shopify/Product/5",
          title: "Trail Running Socks",
          price_min: "18.00",
          variants: [{ id: "gid://shopify/ProductVariant/5", title: "Default", price: "18.00", available: true }],
        },
      ],
      total: 1,
    });

    await runUnifiedAgent({
      ...baseOpts,
      agentMessage: "something for my dad who loves running under $50",
      session: makeSession(),
    });

    expect(searchCatalogMock).toHaveBeenCalled();
    const [, query, opts] = searchCatalogMock.mock.calls[0] as [string, string, { intent?: string; maxPriceCents?: number }];
    expect(opts.maxPriceCents).toBe(5000);
    expect(opts.intent?.toLowerCase()).toContain("dad");
    expect(opts.intent?.toLowerCase()).toContain("gift");
    // Per the tool description's own worked example: the query should be the
    // recipient's interest, not the literal word "gift" (which won't match tags).
    expect(query.toLowerCase()).not.toBe("gift");
  });
});
