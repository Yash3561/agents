import { describe, it, expect } from "vitest";
import { buildShoppingPrompt, buildSupportPrompt } from "~/lib/prompt.server";
import type { CustomerMemory } from "~/lib/agents/memory.server";
import type { ConversationSession } from "~/lib/session.server";
import type { Merchant } from "@prisma/client";

// Minimal merchant fixture — only the fields prompt.server.ts actually reads
function makeMerchant(overrides: Partial<Merchant> = {}): Merchant {
  return {
    id: "1",
    shopDomain: "test-store.myshopify.com",
    accessToken: "tok",
    plan: "spark",
    conversationCount: 0,
    conversationResetAt: new Date(),
    widgetColor: "#7c3aed",
    widgetPosition: "bottom-right",
    widgetGreeting: "Hi! How can I help?",
    botName: "NeonPing",
    brandVoice: "friendly",
    supportEmail: null,
    escalationEmailEnabled: false,
    customFaqs: [],
    excludedPages: [],
    proactiveEngagementEnabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Merchant;
}

function makeSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    conversation_history: [],
    discount_negotiation: { offered_codes: [], level: 0 },
    ...overrides,
  };
}

const emptyMemory: CustomerMemory = {};

describe("buildShoppingPrompt", () => {
  it("includes cart ID in cartState when session has cart_id", () => {
    const prompt = buildShoppingPrompt(
      makeMerchant(),
      makeSession({ cart_id: "gid://shopify/Cart/abc123" }),
      emptyMemory,
    );
    expect(prompt).toContain("gid://shopify/Cart/abc123");
  });

  it("says 'No cart yet.' when session has no cart_id", () => {
    const prompt = buildShoppingPrompt(
      makeMerchant(),
      makeSession(),
      emptyMemory,
    );
    expect(prompt).toContain("No cart yet.");
  });

  it("includes customer name when memory has firstName", () => {
    const prompt = buildShoppingPrompt(
      makeMerchant(),
      makeSession(),
      { firstName: "Alice" },
    );
    expect(prompt).toContain("Alice");
    expect(prompt).toContain("Customer name:");
  });

  it("does not include customer name section when memory has no firstName", () => {
    const prompt = buildShoppingPrompt(
      makeMerchant(),
      makeSession(),
      emptyMemory,
    );
    expect(prompt).not.toContain("Customer name:");
  });

  it("includes abandoned_cart recovery rule (rule 11) when memory.abandoned_cart is set", () => {
    const prompt = buildShoppingPrompt(
      makeMerchant(),
      makeSession(),
      {
        abandoned_cart: {
          items: [],
          total: 29.99,
          timestamp: new Date().toISOString(),
        },
      },
    );
    // Rule 11 mentions abandoned_cart
    expect(prompt).toContain("abandoned_cart");
  });

  it("includes recent_products from memory in the JSON dump", () => {
    const memory: CustomerMemory = {
      recent_products: ["Fabric Resistance Bands (Pink)", "Silk Sleep Mask"],
    };
    const prompt = buildShoppingPrompt(makeMerchant(), makeSession(), memory);
    expect(prompt).toContain("Fabric Resistance Bands (Pink)");
    expect(prompt).toContain("Silk Sleep Mask");
  });

  it("does not crash with empty memory", () => {
    expect(() =>
      buildShoppingPrompt(makeMerchant(), makeSession(), {}),
    ).not.toThrow();
  });

  it("includes shop domain in the prompt", () => {
    const prompt = buildShoppingPrompt(
      makeMerchant({ shopDomain: "myawesomestore.myshopify.com" }),
      makeSession(),
      emptyMemory,
    );
    expect(prompt).toContain("myawesomestore.myshopify.com");
  });
});

describe("buildSupportPrompt", () => {
  it("injects custom FAQs into the prompt", () => {
    const merchant = makeMerchant({
      customFaqs: [
        { question: "Do you ship internationally?", answer: "Yes, we ship worldwide." },
        { question: "What is your return policy?", answer: "30-day returns, no questions asked." },
      ] as unknown as Merchant["customFaqs"],
    });

    const prompt = buildSupportPrompt(merchant);
    expect(prompt).toContain("Do you ship internationally?");
    expect(prompt).toContain("Yes, we ship worldwide.");
    expect(prompt).toContain("What is your return policy?");
  });

  it("has no FAQ section when customFaqs is empty", () => {
    const prompt = buildSupportPrompt(makeMerchant({ customFaqs: [] as unknown as Merchant["customFaqs"] }));
    expect(prompt).not.toContain("Custom FAQ");
  });

  it("uses supportEmail in contact info when provided", () => {
    const prompt = buildSupportPrompt(
      makeMerchant({ supportEmail: "help@mystore.com" }),
    );
    expect(prompt).toContain("help@mystore.com");
  });

  it("falls back to /pages/contact when no supportEmail", () => {
    const prompt = buildSupportPrompt(makeMerchant({ supportEmail: null }));
    expect(prompt).toContain("/pages/contact");
  });

  it("does not crash with empty merchant", () => {
    expect(() => buildSupportPrompt(makeMerchant())).not.toThrow();
  });
});
