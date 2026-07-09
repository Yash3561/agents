/**
 * Real-model eval for the WhatsApp agent's system prompt (buildWhatsAppPrompt
 * in app/lib/agents/whatsapp.server.ts, consumed via runWhatsAppAgent). Unlike
 * tests/unit/whatsapp-cart-assist.test.ts, this does NOT mock `ai` or
 * `~/lib/llm.server` — a real gpt-4o-mini call goes out to Azure AI Foundry.
 * buildWhatsAppPrompt itself isn't exported, so exercising it directly (rather
 * than re-typing its text into a fixture, which would test a copy, not the
 * real prompt) means going through the real runWhatsAppAgent entry point —
 * only the Shopify MCP / memory network boundary is mocked.
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe.skipIf(!hasCreds)("real-model eval: WhatsApp conciseness (default channel constraint)", () => {
  it("stays close to the ~200-char guideline for a simple product query", async () => {
    searchCatalogMock.mockResolvedValue({
      products: [
        {
          id: "gid://shopify/Product/1",
          title: "Trail Running Shoes",
          price_min: "89.00",
          variants: [{ id: "gid://shopify/ProductVariant/1", title: "Default", price: "89.00", available: true }],
        },
      ],
      total: 1,
    });

    const result = await runWhatsAppAgent({
      ...baseOpts,
      agentMessage: "do you have running shoes?",
      session: makeSession(),
    });

    expect(result.agent_trace).toContain("search_catalog");
    // Soft guideline ("under 200 characters when possible"), not a hard cap — give the
    // model headroom but still catch a prompt regression that makes replies balloon.
    expect(result.text.length).toBeLessThan(280);
    expect(result.text).not.toMatch(/[*_`]|^\s*[-•]/m); // no markdown/bullets
  });
});

describe.skipIf(!hasCreds)("real-model eval: WhatsApp 3h-equivalent — detail question overrides the length guideline", () => {
  it("calls get_product and gives a full answer even past ~200 chars", async () => {
    searchCatalogMock.mockResolvedValue({
      products: [
        {
          id: "gid://shopify/Product/42",
          title: "Merino Wool Socks",
          price_min: "16.00",
          variants: [{ id: "gid://shopify/ProductVariant/42", title: "Default", price: "16.00", available: true }],
        },
      ],
      total: 1,
    });
    getProductMock.mockResolvedValue({
      id: "gid://shopify/Product/42",
      title: "Merino Wool Socks",
      description:
        "Knit from 80% merino wool, 15% nylon, 5% elastane. Hand wash cold, lay flat to dry — machine washing will felt the wool.",
      variants: [{ id: "gid://shopify/ProductVariant/42", title: "Default", price: "16.00", available: true }],
    });

    const result = await runWhatsAppAgent({
      ...baseOpts,
      agentMessage: "what are the Merino Wool Socks made of and can I machine wash them?",
      session: makeSession(),
    });

    expect(result.agent_trace).toContain("get_product");
    expect(result.text.toLowerCase()).toMatch(/wool|merino|nylon/);
    expect(result.text.toLowerCase()).toMatch(/wash/);
  });
});
