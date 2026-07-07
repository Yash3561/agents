/**
 * Tests for the in-session WhatsApp cart-assist feature (Phase 2):
 * one nudge per session, free-shipping "utility upsell" when the cart is
 * close to a threshold, generic "passive assist" otherwise, and checkout
 * (get_checkout_url) is never touched by any of it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedTools: Record<string, { execute: (input: unknown) => Promise<unknown> }> = {};

vi.mock("ai", () => ({
  tool: (cfg: unknown) => cfg,
  stepCountIs: () => undefined,
  generateText: vi.fn(async ({ tools }: { tools: typeof capturedTools }) => {
    capturedTools = tools;
    return { text: "ok", steps: [] };
  }),
}));

vi.mock("~/lib/llm.server", () => ({ deployments: { shopping: () => "fake-model" } }));

const createCartMock = vi.fn();
const getCartMock = vi.fn();
const updateCartMock = vi.fn();
vi.mock("~/lib/mcp/cart.server", () => ({
  createCart: (...args: unknown[]) => createCartMock(...args),
  getCart: (...args: unknown[]) => getCartMock(...args),
  updateCart: (...args: unknown[]) => updateCartMock(...args),
}));

vi.mock("~/lib/mcp/catalog.server", () => ({
  searchCatalog: vi.fn(),
  getProduct: vi.fn(),
  lookupCatalog: vi.fn(),
}));
vi.mock("~/lib/mcp/policy.server", () => ({ searchPoliciesAndFaqs: vi.fn() }));
vi.mock("~/lib/mcp/order.server", () => ({ getOrder: vi.fn() }));

const getActiveDiscountsMock = vi.fn();
vi.mock("~/lib/mcp/discounts.server", () => ({ getActiveDiscounts: (...args: unknown[]) => getActiveDiscountsMock(...args) }));

const adminGraphqlMock = vi.fn();
const getProductRecommendationMock = vi.fn();
vi.mock("~/lib/mcp/admin.server", () => ({
  getCustomerOrdersAdmin: vi.fn(),
  adminGraphql: (...args: unknown[]) => adminGraphqlMock(...args),
  getProductRecommendation: (...args: unknown[]) => getProductRecommendationMock(...args),
}));

vi.mock("~/lib/agents/memory.server", () => ({
  fetchCustomerMemory: vi.fn().mockResolvedValue({}),
  updateCustomerMemory: vi.fn(),
  fetchWhatsAppMemory: vi.fn().mockResolvedValue({}),
  updateWhatsAppMemory: vi.fn(),
}));

const setSessionMock = vi.fn().mockResolvedValue(undefined);
vi.mock("~/lib/session.server", () => ({ setSession: (...args: unknown[]) => setSessionMock(...args) }));

import { runWhatsAppAgent } from "~/lib/agents/whatsapp.server";
import type { ConversationSession } from "~/lib/session.server";
import type { Merchant } from "@prisma/client";

function makeSession(cartAssistShown = false): ConversationSession {
  return {
    conversation_history: [],
    discount_negotiation: { offered_codes: [], level: 0 },
    cart_assist_shown: cartAssistShown,
  };
}

const merchant = { shopDomain: "test.myshopify.com", personalizationEnabled: true } as unknown as Merchant;

const baseOpts = {
  shopDomain: "test.myshopify.com",
  sessionId: "whatsapp_+15551234567",
  customerPhone: "+15551234567",
  agentMessage: "add it to my cart",
  merchant,
  accessToken: "admin-token",
};

beforeEach(() => {
  vi.clearAllMocks();
  capturedTools = {};
  getActiveDiscountsMock.mockResolvedValue([]);
});

describe("WhatsApp in-session cart assist", () => {
  it("passive-assist hint fires on the first add-to-cart when no threshold applies", async () => {
    createCartMock.mockResolvedValue({ id: "cart1", checkoutUrl: "https://shop/checkout", cost: { total_amount: { amount: "20.00" } } });

    const session = makeSession(false);
    await runWhatsAppAgent({ ...baseOpts, session });

    const result = (await capturedTools.create_cart.execute({
      lineItems: [{ item: { id: "gid://shopify/ProductVariant/1" }, quantity: 1 }],
    })) as { assistant_reply_hint?: string };

    expect(result.assistant_reply_hint).toMatch(/checkout link|find matching items/);
    expect(setSessionMock).toHaveBeenCalledWith(
      "test.myshopify.com",
      "whatsapp_+15551234567",
      expect.objectContaining({ cart_assist_shown: true }),
    );
  });

  it("does not suggest anything on the second add-to-cart once the cap has been used", async () => {
    createCartMock.mockResolvedValue({ id: "cart1", checkoutUrl: "https://shop/checkout", cost: { total_amount: { amount: "20.00" } } });

    const session = makeSession(true); // already shown earlier this session
    await runWhatsAppAgent({ ...baseOpts, session });

    const result = (await capturedTools.create_cart.execute({
      lineItems: [{ item: { id: "gid://shopify/ProductVariant/1" }, quantity: 1 }],
    })) as { assistant_reply_hint?: string };

    expect(result.assistant_reply_hint).toBeUndefined();
    expect(setSessionMock).not.toHaveBeenCalled();
  });

  it("gives the free-shipping utility-upsell hint with a matching item when the cart is within 20% of the threshold", async () => {
    getActiveDiscountsMock.mockResolvedValue([
      { code: "FREESHIP", title: "Free Shipping", summary: "free shipping", type: "free_shipping", value: 0, minSubtotalCents: 5000 },
    ]);
    createCartMock.mockResolvedValue({ id: "cart1", checkoutUrl: "https://shop/checkout", cost: { total_amount: { amount: "45.00" } } }); // 90% of $50
    adminGraphqlMock.mockResolvedValue({ productVariant: { product: { id: "gid://shopify/Product/999" } } });
    getProductRecommendationMock.mockResolvedValue({ id: "999", title: "Shaker Bottle", variantId: "gid://shopify/ProductVariant/2", priceCents: 1200 });

    const session = makeSession(false);
    await runWhatsAppAgent({ ...baseOpts, session });

    const result = (await capturedTools.create_cart.execute({
      lineItems: [{ item: { id: "gid://shopify/ProductVariant/1" }, quantity: 1 }],
    })) as { assistant_reply_hint?: string };

    expect(result.assistant_reply_hint).toContain("$5.00 away from free shipping");
    expect(result.assistant_reply_hint).toContain("Shaker Bottle");
    expect(result.assistant_reply_hint).toContain("$12.00");
  });

  it("falls back to the generic free-shipping nudge when the matching-item lookup fails", async () => {
    getActiveDiscountsMock.mockResolvedValue([
      { code: "FREESHIP", title: "Free Shipping", summary: "free shipping", type: "free_shipping", value: 0, minSubtotalCents: 5000 },
    ]);
    createCartMock.mockResolvedValue({ id: "cart1", checkoutUrl: "https://shop/checkout", cost: { total_amount: { amount: "45.00" } } });
    adminGraphqlMock.mockRejectedValue(new Error("network down"));

    const session = makeSession(false);
    await runWhatsAppAgent({ ...baseOpts, session });

    const result = (await capturedTools.create_cart.execute({
      lineItems: [{ item: { id: "gid://shopify/ProductVariant/1" }, quantity: 1 }],
    })) as { assistant_reply_hint?: string };

    expect(result.assistant_reply_hint).toContain("$5.00 away from free shipping");
    expect(result.assistant_reply_hint).not.toContain("Shaker Bottle");
  });

  it("does not nudge when the cart is far from the free-shipping threshold", async () => {
    getActiveDiscountsMock.mockResolvedValue([
      { code: "FREESHIP", title: "Free Shipping", summary: "free shipping", type: "free_shipping", value: 0, minSubtotalCents: 5000 },
    ]);
    createCartMock.mockResolvedValue({ id: "cart1", checkoutUrl: "https://shop/checkout", cost: { total_amount: { amount: "10.00" } } }); // 20% of $50

    const session = makeSession(false);
    await runWhatsAppAgent({ ...baseOpts, session });

    const result = (await capturedTools.create_cart.execute({
      lineItems: [{ item: { id: "gid://shopify/ProductVariant/1" }, quantity: 1 }],
    })) as { assistant_reply_hint?: string };

    // Falls through to the generic passive-assist hint, not the threshold one
    expect(result.assistant_reply_hint).not.toContain("free shipping");
    expect(result.assistant_reply_hint).toMatch(/checkout link|find matching items/);
  });

  it("get_checkout_url never carries a suggestion, even with the cap unused", async () => {
    getCartMock.mockResolvedValue({ checkoutUrl: "https://shop/checkout", cost: { total_amount: { amount: "10.00" } } });

    const session = makeSession(false);
    await runWhatsAppAgent({ ...baseOpts, session });

    const result = (await capturedTools.get_checkout_url.execute({ cartId: "cart1" })) as Record<string, unknown>;
    expect(result.assistant_reply_hint).toBeUndefined();
    expect(setSessionMock).not.toHaveBeenCalled();
  });

  it("update_cart with only a discount code (no add) does not consume the cap", async () => {
    updateCartMock.mockResolvedValue({ checkoutUrl: "https://shop/checkout", cost: { total_amount: { amount: "10.00" } } });

    const session = makeSession(false);
    await runWhatsAppAgent({ ...baseOpts, session });

    const result = (await capturedTools.update_cart.execute({ cartId: "cart1", discountCodes: ["SAVE10"] })) as Record<string, unknown>;
    expect(result.assistant_reply_hint).toBeUndefined();
    expect(setSessionMock).not.toHaveBeenCalled();
  });
});
