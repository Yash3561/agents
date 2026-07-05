import { callMcpTool, McpError } from "~/lib/mcp/client.server";
import { getMcpEndpoint } from "~/lib/mcp/discovery.server";

const AGENT_PROFILE =
  process.env.SHOPIFY_APP_URL
    ? `${process.env.SHOPIFY_APP_URL}/.well-known/ucp-agent.json`
    : "https://neonping.azurecontainerapps.io/.well-known/ucp-agent.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomerOrderLine {
  id: string;
  title: string;
  quantity: number;
  price: number;          // cents
  variant_id?: string;
}

export interface CustomerOrder {
  id: string;
  name: string;           // "#1234"
  created_at: string;
  total_price: number;    // cents
  currency: string;
  fulfillment_status: string;
  line_items: CustomerOrderLine[];
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Get order history for a logged-in customer.
 * Requires a valid customer OAuth access token — throws immediately without one.
 */
export async function getCustomerOrders(
  shopDomain: string,
  customerAccessToken: string,
): Promise<CustomerOrder[]> {
  if (!customerAccessToken) {
    throw new McpError("Customer access token required for order history", 401);
  }

  const result = await callMcpTool<{ orders: CustomerOrder[] }>(
    {
      endpoint: await getMcpEndpoint(shopDomain),
      agentProfileUrl: AGENT_PROFILE,
      auth: { type: "bearer", token: customerAccessToken },
    },
    "get_customer_orders",
    {},
  );

  const orders = result.structuredContent.orders ?? [];
  // Sort newest first
  return orders.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

