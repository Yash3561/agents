import { describe, it, expect } from "vitest";
import { computeOutcome, extractCheckoutToken } from "~/lib/conversation.server";

// computeOutcome(c: { orderId, escalated, cartId, lastMessageAt })
// returns "converted" | "in_cart" | "escalated" | "active" | "ended"

describe("computeOutcome", () => {
  const recentTime = new Date(Date.now() - 2 * 60 * 1000); // 2 min ago — within active window
  const oldTime = new Date(Date.now() - 30 * 60 * 1000);   // 30 min ago — past active window

  it("returns 'converted' when orderId is present", () => {
    expect(
      computeOutcome({
        orderId: "12345",
        escalated: false,
        cartId: null,
        lastMessageAt: oldTime,
      }),
    ).toBe("converted");
  });

  it("orderId takes priority over escalated", () => {
    expect(
      computeOutcome({
        orderId: "99",
        escalated: true,
        cartId: "cart123",
        lastMessageAt: oldTime,
      }),
    ).toBe("converted");
  });

  it("returns 'escalated' when escalated is true and no orderId", () => {
    expect(
      computeOutcome({
        orderId: null,
        escalated: true,
        cartId: null,
        lastMessageAt: oldTime,
      }),
    ).toBe("escalated");
  });

  it("returns 'active' for a recent message with no orderId", () => {
    expect(
      computeOutcome({
        orderId: null,
        escalated: false,
        cartId: null,
        lastMessageAt: recentTime,
      }),
    ).toBe("active");
  });

  it("returns 'in_cart' when cartId is present and message is old, no orderId", () => {
    expect(
      computeOutcome({
        orderId: null,
        escalated: false,
        cartId: "gid://shopify/Cart/abc",
        lastMessageAt: oldTime,
      }),
    ).toBe("in_cart");
  });

  it("returns 'ended' when no orderId, not escalated, old message, no cartId", () => {
    expect(
      computeOutcome({
        orderId: null,
        escalated: false,
        cartId: null,
        lastMessageAt: oldTime,
      }),
    ).toBe("ended");
  });
});

describe("extractCheckoutToken", () => {
  it("extracts token from Shopify cart URL", () => {
    const url = "https://store.myshopify.com/cart/c/abc123token?key=xyz";
    expect(extractCheckoutToken(url)).toBe("abc123token");
  });

  it("returns undefined for undefined input", () => {
    expect(extractCheckoutToken(undefined)).toBeUndefined();
  });

  it("returns undefined for URL without /cart/c/ pattern", () => {
    expect(extractCheckoutToken("https://example.com/checkout")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(extractCheckoutToken("")).toBeUndefined();
  });
});
