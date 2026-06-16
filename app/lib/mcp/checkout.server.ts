/**
 * Shopify Storefront MCP does not expose separate checkout tools.
 * Checkout is initiated by sending the buyer to the cart's checkoutUrl.
 * This module provides a thin wrapper so the rest of the codebase keeps
 * a consistent import surface.
 */
import type { Cart } from "~/lib/mcp/cart.server";

export interface Checkout {
  continue_url: string;
  requires_escalation: boolean;
}

/**
 * "Create checkout" from a cart — just extract the cart's checkout URL.
 * The buyer clicks this link to complete payment on Shopify's hosted checkout.
 */
export function checkoutFromCart(cart: Cart): Checkout {
  const url = cart.checkoutUrl ?? cart.continue_url ?? "";
  return { continue_url: url, requires_escalation: !url };
}
