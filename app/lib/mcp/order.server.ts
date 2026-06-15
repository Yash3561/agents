import { callMcpTool } from "~/lib/mcp/client.server";
import { getMcpEndpoint } from "~/lib/mcp/discovery.server";

const AGENT_PROFILE =
  process.env.SHOPIFY_APP_URL
    ? `${process.env.SHOPIFY_APP_URL}/.well-known/ucp-agent.json`
    : "https://neonping.azurecontainerapps.io/.well-known/ucp-agent.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrderLine {
  id: string;
  title: string;
  quantity: number;
  price: number;          // cents
  variant_id?: string;
}

export interface OrderTracking {
  number: string;
  url?: string;
  carrier?: string;
}

export interface Order {
  id: string;
  name: string;           // "#1234"
  fulfillment_status: string;
  financial_status: string;
  line_items: OrderLine[];
  tracking?: OrderTracking;
  estimated_delivery?: string;
  created_at: string;
  total_price: number;    // cents
  currency: string;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

/**
 * Fetch a single order's current state.
 * Throws McpError if order not found — caller (Support Agent) handles gracefully.
 */
export async function getOrder(
  shopDomain: string,
  orderId: string,
): Promise<Order> {
  const ucpJwt = process.env.UCP_JWT;

  const result = await callMcpTool<Order>(
    {
      endpoint: await getMcpEndpoint(shopDomain),
      agentProfileUrl: AGENT_PROFILE,
      ...(ucpJwt ? { auth: { type: "bearer" as const, token: ucpJwt } } : {}),
    },
    "get_order",
    { id: orderId },
  );

  return result.structuredContent;
}
