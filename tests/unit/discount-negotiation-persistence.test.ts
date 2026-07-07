/**
 * Regression test for a real bug: the offer_discount tool tracked
 * offered_codes/level in local variables scoped to a single agent turn, but
 * neither runWhatsAppAgent nor runUnifiedAgent returned that state, and the
 * WhatsApp webhook never persisted it at all — so the 3-offer cap and the
 * "don't re-offer a code that didn't apply" guard silently reset every turn.
 *
 * Fix: both agents now return `discount_negotiation` (the full post-turn
 * state, including failed/blocked attempts), and both callers persist it.
 *
 * The generateText mock below actually drives the tool calls scripted per
 * test (instead of just capturing them), so the returned discount_negotiation
 * reflects what the tool closures mutated during the same turn — exactly
 * what the real AI SDK multi-step loop does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let scriptedCalls: Array<{ name: string; input: unknown }> = [];

vi.mock("ai", () => ({
  tool: (cfg: unknown) => cfg,
  stepCountIs: () => undefined,
  generateText: vi.fn(async ({ tools }: { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> }) => {
    for (const call of scriptedCalls) {
      await tools[call.name].execute(call.input);
    }
    return { text: "ok", steps: [] };
  }),
}));

vi.mock("~/lib/llm.server", () => ({ deployments: { shopping: () => "fake-model" } }));

const createCartMock = vi.fn();
const updateCartMock = vi.fn();
vi.mock("~/lib/mcp/cart.server", () => ({
  createCart: (...args: unknown[]) => createCartMock(...args),
  getCart: vi.fn(),
  updateCart: (...args: unknown[]) => updateCartMock(...args),
}));

const searchCatalogMock = vi.fn();
vi.mock("~/lib/mcp/catalog.server", () => ({ searchCatalog: (...args: unknown[]) => searchCatalogMock(...args), getProduct: vi.fn(), lookupCatalog: vi.fn() }));
vi.mock("~/lib/mcp/policy.server", () => ({ searchPoliciesAndFaqs: vi.fn() }));
vi.mock("~/lib/mcp/order.server", () => ({ getOrder: vi.fn() }));

const getActiveDiscountsMock = vi.fn();
vi.mock("~/lib/mcp/discounts.server", () => ({ getActiveDiscounts: (...args: unknown[]) => getActiveDiscountsMock(...args) }));

vi.mock("~/lib/mcp/admin.server", () => ({
  getCustomerOrdersAdmin: vi.fn(),
  adminGraphql: vi.fn(),
  getProductRecommendation: vi.fn(),
}));

const fetchWhatsAppMemoryMock = vi.fn();
vi.mock("~/lib/agents/memory.server", () => ({
  fetchCustomerMemory: vi.fn().mockResolvedValue({}),
  updateCustomerMemory: vi.fn(),
  fetchWhatsAppMemory: (...args: unknown[]) => fetchWhatsAppMemoryMock(...args),
  updateWhatsAppMemory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/lib/session.server", () => ({ setSession: vi.fn().mockResolvedValue(undefined) }));

import { runWhatsAppAgent } from "~/lib/agents/whatsapp.server";
import type { ConversationSession } from "~/lib/session.server";
import type { Merchant } from "@prisma/client";

const merchant = { shopDomain: "test.myshopify.com", personalizationEnabled: true } as unknown as Merchant;

function makeSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    conversation_history: [],
    discount_negotiation: { offered_codes: [], level: 0 },
    ...overrides,
  };
}

const baseOpts = {
  shopDomain: "test.myshopify.com",
  sessionId: "whatsapp_+15551234567",
  customerPhone: "+15551234567",
  agentMessage: "any discounts?",
  merchant,
  accessToken: "admin-token",
};

beforeEach(() => {
  vi.clearAllMocks();
  scriptedCalls = [];
  getActiveDiscountsMock.mockResolvedValue([
    { code: "SAVE10", title: "10% off", summary: "10% off", type: "percentage", value: 10 },
  ]);
  fetchWhatsAppMemoryMock.mockResolvedValue({});
});

describe("discount_negotiation is returned and reflects real outcomes", () => {
  it("always includes discount_negotiation on the output, even when no offer was made", async () => {
    const output = await runWhatsAppAgent({ ...baseOpts, session: makeSession() });
    expect(output.discount_negotiation).toEqual({ offered_codes: [], level: 0 });
  });

  it("reflects a successful offer", async () => {
    scriptedCalls = [{ name: "offer_discount", input: { code: "SAVE10", negotiationStance: "firm", message: "10% off!" } }];

    const output = await runWhatsAppAgent({ ...baseOpts, session: makeSession() });

    expect(output.discount_code).toBe("SAVE10");
    expect(output.discount_negotiation).toEqual({ offered_codes: ["SAVE10"], level: 1 });
  });

  it("BUG FIX: still records the offer count when the code doesn't apply to the cart", async () => {
    fetchWhatsAppMemoryMock.mockResolvedValue({ cart_id: "wa-cart-1" });
    updateCartMock.mockResolvedValue({ discountCodes: [{ code: "SAVE10", applicable: false }] });
    scriptedCalls = [{ name: "offer_discount", input: { code: "SAVE10", negotiationStance: "firm", message: "10% off!" } }];

    const output = await runWhatsAppAgent({ ...baseOpts, session: makeSession() });

    // Before the fix, this state only existed in a local variable and was
    // discarded — the caller had nothing to persist for a failed attempt.
    expect(output.discount_code).toBeUndefined();
    expect(output.discount_negotiation).toEqual({ offered_codes: ["SAVE10"], level: 1 });
    expect(updateCartMock).toHaveBeenCalledWith("test.myshopify.com", "wa-cart-1", { discountCodes: ["SAVE10"] });
  });

  it("BUG FIX (Fix A): session.cart_id is a widget-only field and must not gate WhatsApp's cart validation", async () => {
    // Old bug: the tool checked session.cart_id, which is never populated for WhatsApp —
    // so cart validation silently never ran, and codes were always offered blindly.
    fetchWhatsAppMemoryMock.mockResolvedValue({}); // no memory.cart_id, no lastCartId this turn
    scriptedCalls = [{ name: "offer_discount", input: { code: "SAVE10", negotiationStance: "firm", message: "10% off!" } }];

    const output = await runWhatsAppAgent({
      ...baseOpts,
      // Even if something set session.cart_id, it must be ignored for this channel.
      session: makeSession({ cart_id: "widget-only-field-should-be-ignored" }),
    });

    expect(updateCartMock).not.toHaveBeenCalled(); // no real cart known -> no validation attempted
    expect(output.discount_code).toBe("SAVE10"); // still offered (no cart to validate against)
  });

  it("BUG FIX: caps at 3 offers using the negotiation state carried across the whole turn", async () => {
    getActiveDiscountsMock.mockResolvedValue([
      { code: "A", title: "A", summary: "A", type: "percentage", value: 5 },
      { code: "B", title: "B", summary: "B", type: "percentage", value: 10 },
      { code: "C", title: "C", summary: "C", type: "percentage", value: 15 },
      { code: "D", title: "D", summary: "D", type: "percentage", value: 20 },
    ]);
    scriptedCalls = [
      { name: "offer_discount", input: { code: "A", negotiationStance: "firm", message: "m" } },
      { name: "offer_discount", input: { code: "B", negotiationStance: "generous", message: "m" } },
      { name: "offer_discount", input: { code: "C", negotiationStance: "final", message: "m" } },
    ];

    const output = await runWhatsAppAgent({ ...baseOpts, session: makeSession() });

    expect(output.discount_negotiation.level).toBe(3);
    expect(output.discount_negotiation.offered_codes).toEqual(["A", "B", "C"]);
  });

  it("BUG FIX: a successful offer refreshes checkout_url/cart_lines instead of discarding the validated cart", async () => {
    fetchWhatsAppMemoryMock.mockResolvedValue({ cart_id: "wa-cart-1" });
    updateCartMock.mockResolvedValue({
      checkoutUrl: "https://shop/checkout?discount=SAVE10",
      discountCodes: [{ code: "SAVE10", applicable: true }],
      lines: [{ merchandise: { title: "Widget", product: { title: "Widget" } }, quantity: 1, cost: { totalAmount: { amount: "18.00", currencyCode: "USD" } } }],
    });
    scriptedCalls = [{ name: "offer_discount", input: { code: "SAVE10", negotiationStance: "firm", message: "10% off!" } }];

    const output = await runWhatsAppAgent({ ...baseOpts, session: makeSession() });

    expect(output.checkout_url).toBe("https://shop/checkout?discount=SAVE10");
    expect(output.cart_lines).toEqual([{ title: "Widget", quantity: 1, price: "18.00 USD" }]);
  });
});

describe("escalate_human tool (Fix #3 — WhatsApp had no explicit escalation signal)", () => {
  it("sets escalate_to_human when the tool is called, and set_intent is tracked in the trace", async () => {
    scriptedCalls = [
      { name: "set_intent", input: { intent: "general" } },
      { name: "escalate_human", input: {} },
    ];

    const output = await runWhatsAppAgent({ ...baseOpts, session: makeSession() });

    expect(output.escalate_to_human).toBe(true);
    expect(output.agent_trace).toContain("escalate_human");
    expect(output.agent_trace).toContain("set_intent"); // Fix #8
  });

  it("does not escalate when the tool was never called", async () => {
    const output = await runWhatsAppAgent({ ...baseOpts, session: makeSession() });
    expect(output.escalate_to_human).toBeUndefined();
  });
});

describe("create_cart empty-lineItems guard (Fix #7 — consistency with unified.server.ts)", () => {
  it("returns a graceful tool error instead of throwing when lineItems is empty", async () => {
    scriptedCalls = [{ name: "create_cart", input: { lineItems: [] } }];

    await expect(runWhatsAppAgent({ ...baseOpts, session: makeSession() })).resolves.toBeDefined();
    expect(createCartMock).not.toHaveBeenCalled();
  });
});

describe("BUG FIX — a second search_catalog call that finds nothing no longer wipes out an earlier real result", () => {
  it("keeps products from the first search when a later search in the same turn returns empty", async () => {
    // Reproduces a real production symptom reported as 'no catalogs in WhatsApp':
    // customer asked "show me your featured and popular products" -> the model called
    // search_catalog twice (agentTrace showed ["whatsapp","search_catalog","search_catalog"]).
    // The first call found real products (the reply text even named them); the second,
    // for "popular", found nothing. `products = sliced` overwrote the closure each call,
    // so the final structured output had zero products and no carousel was ever sent.
    searchCatalogMock
      .mockResolvedValueOnce({ products: [{ id: "gid://Product/1", title: "Face Mask" }], total: 1 })
      .mockResolvedValueOnce({ products: [], total: 0 });
    scriptedCalls = [
      { name: "search_catalog", input: { query: "featured" } },
      { name: "search_catalog", input: { query: "popular" } },
    ];

    const output = await runWhatsAppAgent({ ...baseOpts, session: makeSession() });
    expect(output.products).toEqual([{ id: "gid://Product/1", title: "Face Mask" }]);
  });
});
