import { callMcpTool } from "~/lib/mcp/client.server";
import { getMcpEndpoint } from "~/lib/mcp/discovery.server";
import { randomUUID } from "crypto";

const AGENT_PROFILE =
  process.env.SHOPIFY_APP_URL
    ? `${process.env.SHOPIFY_APP_URL}/.well-known/ucp-agent.json`
    : "https://neonping.azurecontainerapps.io/.well-known/ucp-agent.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CartLineItem {
  item: { id: string };  // ProductVariant GID
  quantity: number;
}

export interface CartLine {
  id: string;
  item: { id: string; title: string; price: number };
  quantity: number;
}

export interface CartTotal {
  type: "subtotal" | "total" | string;
  amount: number;        // cents
  display_text: string;
}

export interface Cart {
  id: string;            // "gid://shopify/Cart/..."
  currency: string;
  line_items: CartLine[];
  totals: CartTotal[];
  continue_url: string;
  expires_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function opts(shopDomain: string) {
  return {
    endpoint: getMcpEndpoint(shopDomain) as unknown as string,
    agentProfileUrl: AGENT_PROFILE,
    // Cart tools are anonymous — no auth needed
  };
}

async function endpoint(shopDomain: string) {
  return {
    endpoint: await getMcpEndpoint(shopDomain),
    agentProfileUrl: AGENT_PROFILE,
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Create a new cart. lineItems must be non-empty (checked by guardrails). */
export async function createCart(
  shopDomain: string,
  lineItems: CartLineItem[],
  context?: { currency?: string; addressCountry?: string },
): Promise<Cart> {
  const result = await callMcpTool<{ cart: Cart }>(
    await endpoint(shopDomain),
    "create_cart",
    {
      line_items: lineItems,
      context: {
        currency: context?.currency ?? "USD",
        address_country: context?.addressCountry ?? "US",
      },
    },
  );
  return result.structuredContent.cart;
}

/** Fetch current cart state. */
export async function getCart(
  shopDomain: string,
  cartId: string,
): Promise<Cart> {
  const result = await callMcpTool<{ cart: Cart }>(
    await endpoint(shopDomain),
    "get_cart",
    { id: cartId },
  );
  return result.structuredContent.cart;
}

/**
 * Replace cart contents entirely (PUT semantics — not a delta).
 * Always pass the complete line_items array including existing lines.
 */
export async function updateCart(
  shopDomain: string,
  cartId: string,
  lineItems: CartLineItem[],
): Promise<Cart> {
  const result = await callMcpTool<{ cart: Cart }>(
    await endpoint(shopDomain),
    "update_cart",
    { id: cartId, line_items: lineItems },
  );
  return result.structuredContent.cart;
}

/** Cancel a cart. Idempotency key is generated per-call as required by UCP spec. */
export async function cancelCart(
  shopDomain: string,
  cartId: string,
): Promise<void> {
  await callMcpTool(
    await endpoint(shopDomain),
    "cancel_cart",
    {
      id: cartId,
      // UCP spec requires a unique idempotency key on cancel_cart
      meta: { "idempotency-key": randomUUID() },
    },
  );
}

/** Convenience: get the total amount in cents from a Cart's totals array. */
export function getCartTotal(cart: Cart): number {
  return cart.totals.find((t) => t.type === "total")?.amount ?? 0;
}
