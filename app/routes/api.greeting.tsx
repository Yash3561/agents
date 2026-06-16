/**
 * GET /api/greeting?shop=...&customer_id=...
 *
 * Lightweight lookup the widget calls before showing its opening greeting.
 * Returns a personalized greeting when the customer has prior memory (e.g.
 * a recent search), or { greeting: null } to fall back to the merchant's
 * static configured greeting (anonymous visitors, first-time customers).
 */
import type { LoaderFunctionArgs } from "react-router";
import { fetchCustomerMemory } from "~/lib/agents/memory.server";
import { getStorefrontAccessToken } from "~/lib/auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const customerId = url.searchParams.get("customer_id");

  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  if (!shop || !customerId) {
    return new Response(JSON.stringify({ greeting: null }), { headers });
  }

  try {
    const accessToken = await getStorefrontAccessToken(request, shop);
    const memory = await fetchCustomerMemory(shop, accessToken, customerId);

    const greeting = memory.last_search
      ? `Welcome back! Still looking for "${memory.last_search}"? Happy to help you pick up where you left off.`
      : null;

    return new Response(JSON.stringify({ greeting }), { headers });
  } catch {
    return new Response(JSON.stringify({ greeting: null }), { headers });
  }
}
