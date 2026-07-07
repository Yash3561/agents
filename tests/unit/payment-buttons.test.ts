/**
 * Regression test: the "Cash on Delivery" WhatsApp button used to be shown to
 * every merchant unconditionally, regardless of whether their store actually
 * supports COD/manual payment — a customer picking it could hit a checkout
 * dead-end. It's now gated on merchant.codEnabled (default false).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("~/shopify.server", () => ({ authenticate: { webhook: vi.fn() } }));
vi.mock("~/db.server", () => ({ default: {} }));
vi.mock("~/lib/billing.server", () => ({ checkAndIncrementUsage: vi.fn() }));
vi.mock("~/lib/conversation.server", () => ({ extractCheckoutToken: vi.fn(), sendEscalationEmail: vi.fn() }));
vi.mock("~/lib/whatsapp.server", () => ({
  verifyWebhookSignature: vi.fn(), decryptToken: vi.fn(), sendTextMessage: vi.fn(),
  sendReplyButtons: vi.fn(), sendCarousel: vi.fn(), sendVariantList: vi.fn(),
  sendCheckoutMessage: vi.fn(), sendListMessage: vi.fn(),
}));
vi.mock("~/lib/session.server", () => ({ getSession: vi.fn(), setSession: vi.fn(), appendMessage: vi.fn(), deleteSession: vi.fn() }));
vi.mock("~/lib/agents/whatsapp.server", () => ({ runWhatsAppAgent: vi.fn() }));
vi.mock("~/lib/agents/whatsapp-formatter.server", () => ({ formatCarousel: vi.fn() }));
vi.mock("~/lib/mcp/admin.server", () => ({ lookupCustomerByPhone: vi.fn(), fetchProductRatings: vi.fn(), adminGraphql: vi.fn() }));
vi.mock("~/lib/mcp/cart.server", () => ({ createCart: vi.fn(), updateCart: vi.fn() }));
vi.mock("~/lib/agents/memory.server", () => ({ fetchWhatsAppMemory: vi.fn(), updateWhatsAppMemory: vi.fn() }));
vi.mock("~/redis.server", () => ({ redis: {} }));

import { buildPaymentButtons } from "~/routes/api.whatsapp.webhook";

describe("buildPaymentButtons", () => {
  it("omits Cash on Delivery when the merchant hasn't enabled it", () => {
    const buttons = buildPaymentButtons(false);
    expect(buttons.map((b) => b.id)).toEqual(["pay_prepaid", "post_checkout_shop"]);
  });

  it("includes Cash on Delivery when the merchant has explicitly enabled it", () => {
    const buttons = buildPaymentButtons(true);
    expect(buttons.map((b) => b.id)).toEqual(["pay_prepaid", "pay_cod", "post_checkout_shop"]);
  });
});
