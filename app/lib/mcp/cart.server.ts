import { callMcpTool } from "~/lib/mcp/client.server";

// Shopify Cart MCP — anonymous, no auth required.
const endpoint = (shop: string) => {
  if (!shop.endsWith(".myshopify.com")) throw new Error(`Invalid shop domain: ${shop}`);
  return { endpoint: `https://${shop}/api/mcp` };
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CartAddItem {
  product_variant_id: string;   // ProductVariant GID
  quantity: number;
}

export interface CartUpdateItem {
  id: string;       // line item ID (not variant ID)
  quantity: number; // set to 0 to remove
}

export interface Cart {
  id: string;                   // "gid://shopify/Cart/..."
  checkoutUrl: string;          // URL to complete purchase (normalized from checkout_url)
  // Real Shopify UCP shape uses snake_case throughout — confirmed via live calls.
  lines?: Array<{
    id: string;
    quantity: number;
    merchandise?: {
      id: string;
      title?: string;
      product?: { id?: string; title?: string; handle?: string };
    };
    cost?: {
      total_amount?: { amount: string; currency: string };
      subtotal_amount?: { amount: string; currency: string };
    };
  }>;
  cost?: {
    subtotal_amount?: { amount: string; currency: string };
    total_amount?: { amount: string; currency: string };
  };
  total_quantity?: number;
  // Keep continue_url as alias so existing code that references it still works
  continue_url?: string;
  // Shopify returns discount codes applied to the cart
  discountCodes?: Array<{ code: string; applicable?: boolean }>;
  discount_codes?: Array<{ code: string; applicable?: boolean }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeCart(raw: Record<string, unknown>): Cart {
  const cart = (raw.cart as Record<string, unknown> | undefined) ?? raw;
  // Shopify's real UCP cart response uses snake_case checkout_url —
  // confirmed via live create_cart call. Keep the other variants as
  // fallbacks in case of future API changes.
  const url = (cart.checkout_url ?? cart.checkoutUrl ?? cart.webUrl ?? cart.continue_url ?? "") as string;
  return {
    ...(cart as unknown as Cart),
    checkoutUrl: url,
    continue_url: url,
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Create a new cart. Shopify uses update_cart without a cart_id to create.
 * lineItems must be non-empty (enforced by guardrails before this is called).
 */
export async function createCart(
  shopDomain: string,
  lineItems: Array<{ item: { id: string }; quantity: number }>,
  context?: { currency?: string; addressCountry?: string },
): Promise<Cart> {
  const result = await callMcpTool<Record<string, unknown>>(
    endpoint(shopDomain),
    "update_cart",
    {
      add_items: lineItems.map((li) => ({
        product_variant_id: li.item.id,
        quantity: li.quantity,
      })),
      ...(context?.addressCountry
        ? { buyer_identity: { country_code: context.addressCountry } }
        : {}),
    },
  );
  return normalizeCart(result.structuredContent);
}

/** Fetch current cart state. */
export async function getCart(shopDomain: string, cartId: string): Promise<Cart> {
  const result = await callMcpTool<Record<string, unknown>>(
    endpoint(shopDomain),
    "get_cart",
    { cart_id: cartId },
  );
  return normalizeCart(result.structuredContent);
}

/**
 * Add or update items in the cart, and/or apply discount/gift card codes.
 * Pass add_items to add new variants, update_items to change quantities (0 = remove).
 */
export async function updateCart(
  shopDomain: string,
  cartId: string,
  changes: {
    add?: CartAddItem[];
    update?: CartUpdateItem[];
    discountCodes?: string[];
    giftCardCodes?: string[];
  },
): Promise<Cart> {
  const result = await callMcpTool<Record<string, unknown>>(
    endpoint(shopDomain),
    "update_cart",
    {
      cart_id: cartId,
      ...(changes.add?.length ? { add_items: changes.add } : {}),
      ...(changes.update?.length ? { update_items: changes.update } : {}),
      ...(changes.discountCodes?.length ? { discount_codes: changes.discountCodes } : {}),
      ...(changes.giftCardCodes?.length ? { gift_card_codes: changes.giftCardCodes } : {}),
    },
  );
  return normalizeCart(result.structuredContent);
}

