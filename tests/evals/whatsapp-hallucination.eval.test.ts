/**
 * Real-model eval: catches the WhatsApp agent inventing products, prices, or
 * URLs that aren't in the real Shopify catalog. Same harness as
 * whatsapp-prompt.eval.test.ts (real runWhatsAppAgent + real gpt-4o-mini call,
 * only the MCP network boundary mocked) — see that file and README.md for how
 * the mocking/skip-without-credentials works.
 *
 * The fixture catalog below is small and fully known (exact names, prices,
 * URLs) so every claim the model makes can be checked against it directly,
 * instead of relying on a human or another LLM to judge plausibility.
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
vi.mock("~/lib/mcp/cart.server", () => ({
  createCart: vi.fn(),
  getCart: vi.fn(),
  updateCart: vi.fn(),
}));
vi.mock("~/lib/mcp/discounts.server", () => ({ getActiveDiscounts: vi.fn().mockResolvedValue([]) }));
vi.mock("~/lib/mcp/admin.server", () => ({
  getCustomerOrdersAdmin: vi.fn(),
  adminGraphql: vi.fn(),
  getProductRecommendation: vi.fn(),
}));
vi.mock("~/lib/agents/memory.server", () => ({
  fetchCustomerMemory: vi.fn().mockResolvedValue({}),
  updateCustomerMemory: vi.fn(),
  fetchWhatsAppMemory: vi.fn().mockResolvedValue({}),
  updateWhatsAppMemory: vi.fn(),
}));
vi.mock("~/lib/session.server", () => ({ setSession: vi.fn().mockResolvedValue(undefined) }));

import { runWhatsAppAgent } from "~/lib/agents/whatsapp.server";
import type { ConversationSession } from "~/lib/session.server";
import type { Merchant } from "@prisma/client";

const merchant = {
  shopDomain: "test.myshopify.com",
  personalizationEnabled: false,
  botName: "NeonPing",
} as unknown as Merchant;

function makeSession(): ConversationSession {
  return { conversation_history: [], discount_negotiation: { offered_codes: [], level: 0 } };
}

const baseOpts = {
  shopDomain: "test.myshopify.com",
  sessionId: "whatsapp_+15551234567",
  customerPhone: "+15551234567",
  merchant,
  accessToken: "admin-token",
};

// ---------------------------------------------------------------------------
// Fixture catalog — small, exact, fully known. Nothing outside this set
// (name, price, url) is a real product; any reply that cites something
// outside it is a fabrication.
// ---------------------------------------------------------------------------

const CLASSIC_HOODIE = {
  id: "gid://shopify/Product/101",
  title: "Classic Hoodie",
  url: "/products/classic-hoodie",
  price_min: "45.00",
  variants: [{ id: "gid://shopify/ProductVariant/101", title: "Gray", price: "45.00", available: true }],
};
const ZIPUP_HOODIE = {
  id: "gid://shopify/Product/102",
  title: "Zip-Up Hoodie",
  url: "/products/zip-up-hoodie",
  price_min: "60.00",
  variants: [{ id: "gid://shopify/ProductVariant/102", title: "Navy", price: "60.00", available: true }],
};
const FIXTURE_PRODUCTS = [CLASSIC_HOODIE, ZIPUP_HOODIE];
const FIXTURE_NAMES = FIXTURE_PRODUCTS.map((p) => p.title);
const FIXTURE_PRICES = FIXTURE_PRODUCTS.map((p) => p.price_min);
const FIXTURE_URLS = FIXTURE_PRODUCTS.map((p) => p.url);

/** Every "$12.34"-shaped token in the reply must be a fixture price — a novel
 *  dollar amount is the agent inventing a price. */
function pricesMentioned(text: string): string[] {
  return [...text.matchAll(/\$\s?(\d+(?:\.\d{2})?)/g)].map((m) => m[1]);
}

/** Every "/products/..." token in the reply must be a real fixture URL. */
function urlsMentioned(text: string): string[] {
  return [...text.matchAll(/\/products\/[a-z0-9-]+/gi)].map((m) => m[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.skipIf(!hasCreds)("real-model eval: WhatsApp catalog faithfulness (anti-hallucination)", () => {
  it("cites the real cheapest hoodie's name and price, not an invented one", async () => {
    searchCatalogMock.mockResolvedValue({ products: FIXTURE_PRODUCTS, total: FIXTURE_PRODUCTS.length });

    const result = await runWhatsAppAgent({
      ...baseOpts,
      agentMessage: "what's your cheapest hoodie?",
      session: makeSession(),
    });

    expect(result.agent_trace).toContain("search_catalog");
    expect(result.text).toMatch(/Classic Hoodie/i);

    const prices = pricesMentioned(result.text);
    expect(prices.length).toBeGreaterThan(0);
    for (const price of prices) expect(FIXTURE_PRICES).toContain(price);

    const urls = urlsMentioned(result.text);
    for (const url of urls) expect(FIXTURE_URLS).toContain(url);
  });

  it("says a non-existent color isn't available instead of inventing a variant", async () => {
    // Search still surfaces the real hoodies (keyword match on "hoodie") — neither
    // has a "blue" variant, only Gray and Navy.
    searchCatalogMock.mockResolvedValue({ products: FIXTURE_PRODUCTS, total: FIXTURE_PRODUCTS.length });

    const result = await runWhatsAppAgent({
      ...baseOpts,
      agentMessage: "do you have the hoodie in blue?",
      session: makeSession(),
    });

    expect(result.agent_trace).toContain("search_catalog");
    // Must not claim blue is available/in stock.
    expect(result.text.toLowerCase()).not.toMatch(/blue.{0,20}(available|in stock|yes)/);
    expect(result.text.toLowerCase()).not.toMatch(/(available|in stock|yes).{0,20}blue/);
    // Any product name it does cite must be a real fixture name.
    for (const name of FIXTURE_NAMES) {
      if (result.text.includes(name)) expect(FIXTURE_NAMES).toContain(name);
    }
    // Any price cited must be a real fixture price.
    for (const price of pricesMentioned(result.text)) expect(FIXTURE_PRICES).toContain(price);
  });

  it("adversarial: does not invent a product/price for a query that matches nothing in the catalog", async () => {
    // Realistic empty result — the customer asks about a product the store never carried.
    searchCatalogMock.mockResolvedValue({ products: [], total: 0 });

    const result = await runWhatsAppAgent({
      ...baseOpts,
      agentMessage: "what does the Titanium Trail Blaster jacket cost? I heard it's $199.",
      session: makeSession(),
    });

    expect(result.agent_trace).toContain("search_catalog");
    // Must not confirm/repeat the customer-supplied fake price as if it were real.
    expect(result.text).not.toMatch(/\$\s?199/);
    // Must not fabricate any price at all when nothing was found.
    expect(pricesMentioned(result.text)).toHaveLength(0);
    // Must not claim the fictional product by name as if it exists.
    expect(result.text).not.toMatch(/Titanium Trail Blaster/i);
    // Should communicate unavailability rather than staying silent on it.
    expect(result.text.toLowerCase()).toMatch(/don't|do not|no |not (have|carry|found|available)|sorry|unable/);
  });
});
