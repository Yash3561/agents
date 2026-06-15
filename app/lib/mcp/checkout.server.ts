import { callMcpTool } from "~/lib/mcp/client.server";
import { getMcpEndpoint } from "~/lib/mcp/discovery.server";

const AGENT_PROFILE =
  process.env.SHOPIFY_APP_URL
    ? `${process.env.SHOPIFY_APP_URL}/.well-known/ucp-agent.json`
    : "https://neonping.azurecontainerapps.io/.well-known/ucp-agent.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Checkout {
  id: string;             // "gid://shopify/Checkout/..."
  cart_id?: string;
  continue_url: string;   // → Shopify payment page
  status: string;
  requires_escalation?: boolean;
}

export interface CheckoutUpdate {
  email?: string;
  utm?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function opts(shopDomain: string) {
  const ucpJwt = process.env.UCP_JWT;
  return {
    endpoint: await getMcpEndpoint(shopDomain),
    agentProfileUrl: AGENT_PROFILE,
    // Checkout MCP requires Token-tier auth — stubbed when JWT not yet provided
    ...(ucpJwt ? { auth: { type: "bearer" as const, token: ucpJwt } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Convert a cart into a checkout session. */
export async function createCheckout(
  shopDomain: string,
  cartId: string,
): Promise<Checkout> {
  const result = await callMcpTool<{ checkout: Checkout }>(
    await opts(shopDomain),
    "create_checkout",
    { cart_id: cartId },
  );
  return result.structuredContent.checkout;
}

/** Update buyer info (email, UTM) on an existing checkout. */
export async function updateCheckout(
  shopDomain: string,
  checkoutId: string,
  updates: CheckoutUpdate,
): Promise<Checkout> {
  const result = await callMcpTool<{ checkout: Checkout }>(
    await opts(shopDomain),
    "update_checkout",
    { id: checkoutId, ...updates },
  );
  return result.structuredContent.checkout;
}

/**
 * Complete a checkout. ONLY called after buyer_confirmed gate passes (#13).
 * If requires_escalation is true, caller must redirect to continue_url — never retry.
 */
export async function completeCheckout(
  shopDomain: string,
  checkoutId: string,
): Promise<Checkout> {
  const result = await callMcpTool<{ checkout: Checkout }>(
    await opts(shopDomain),
    "complete_checkout",
    { id: checkoutId },
  );
  return result.structuredContent.checkout;
}

/** Cancel an in-progress checkout session. */
export async function cancelCheckout(
  shopDomain: string,
  checkoutId: string,
): Promise<void> {
  await callMcpTool(
    await opts(shopDomain),
    "cancel_checkout",
    { id: checkoutId },
  );
}
