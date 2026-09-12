/**
 * Shopify Global Catalog MCP — searches across every Shopify merchant from a
 * single endpoint, not just this store. Distinct from catalog.server.ts
 * (Storefront Catalog, this merchant only). Requires a hosted UCP agent
 * profile for capability negotiation (see client.server.ts); the
 * per-store Storefront Catalog doesn't need one.
 *
 * Endpoint and response shape confirmed via live call against the real
 * Shopify-hosted endpoint (2026-09-12):
 *   POST https://catalog.shopify.com/api/ucp/mcp
 * seller/checkout_url/price/rating/condition live on each *variant*, not the
 * product — a product's variants can come from different sellers in theory,
 * though in practice each product here is one seller's own listing.
 *
 * IMPORTANT: results are other merchants' own listings. `eligible.native_checkout`
 * is false for these — there is no way to add them to *our* cart; the only
 * honest action is handing the customer that merchant's own product/checkout
 * URL. Never represent one of these as something this store sells.
 */
import { callMcpTool } from "~/lib/mcp/client.server";

const GLOBAL_CATALOG_ENDPOINT = "https://catalog.shopify.com/api/ucp/mcp";

// GLOBAL_CATALOG_AGENT_PROFILE_URL lets local dev point at any hosted profile
// (e.g. Shopify's own public sample at
// https://shopify.dev/ucp/agent-profiles/2026-08-25/valid-with-capabilities.json)
// before SHOPIFY_APP_URL has a real reachable tunnel yet. Falls back to the
// same derived-from-SHOPIFY_APP_URL profile every other MCP module uses.
const AGENT_PROFILE =
  process.env.GLOBAL_CATALOG_AGENT_PROFILE_URL ||
  (process.env.SHOPIFY_APP_URL
    ? `${process.env.SHOPIFY_APP_URL}/.well-known/ucp-agent.json`
    : "https://neonping.azurecontainerapps.io/.well-known/ucp-agent.json");

export interface GlobalCatalogResult {
  title: string;
  price: string; // formatted, e.g. "209.99"
  currency: string;
  url: string; // the seller's own product page
  checkout_url: string; // the seller's own checkout — NOT ours
  seller_name: string;
  seller_domain: string;
  rating?: number;
  rating_count?: number;
  image_url?: string;
}

function moneyToString(money: { amount?: number } | undefined): string {
  return typeof money?.amount === "number" ? (money.amount / 100).toFixed(2) : "0.00";
}

/** Search Shopify's Global Catalog — every merchant, not just this one. */
export async function searchGlobalCatalog(
  query: string,
  opts: { maxResults?: number } = {},
): Promise<GlobalCatalogResult[]> {
  const result = await callMcpTool<Record<string, unknown>>(
    {
      endpoint: GLOBAL_CATALOG_ENDPOINT,
      agentProfileUrl: AGENT_PROFILE,
    },
    "search_catalog",
    {
      catalog: {
        query,
        pagination: { limit: Math.min(opts.maxResults ?? 3, 5) },
      },
    },
  );

  const rawProducts = (result.structuredContent.products as Array<Record<string, unknown>>) ?? [];
  const mapped: GlobalCatalogResult[] = [];

  for (const product of rawProducts) {
    const variants = (product.variants as Array<Record<string, unknown>>) ?? [];
    const v = variants[0];
    if (!v) continue;

    const seller = v.seller as Record<string, unknown> | undefined;
    const price = v.price as { amount?: number; currency?: string } | undefined;
    const rating = v.rating as { value?: number; count?: number } | undefined;
    const media = (product.media as Array<Record<string, unknown>>) ?? [];

    if (!v.checkout_url || !seller?.domain) continue; // incomplete listing — skip rather than guess

    mapped.push({
      title: (product.title as string) ?? "Unknown product",
      price: moneyToString(price),
      currency: price?.currency ?? "USD",
      url: (v.url as string) ?? (seller.url as string) ?? "",
      checkout_url: v.checkout_url as string,
      seller_name: (seller.name as string) ?? "another Shopify store",
      seller_domain: seller.domain as string,
      rating: rating?.value,
      rating_count: rating?.count,
      image_url: media[0]?.url as string | undefined,
    });
  }

  // A semantic catalog can return the same listing more than once when the
  // query contains several overlapping concepts. Keep the first ranked copy
  // so WhatsApp does not render duplicate cards for one seller/checkout.
  const seenCheckouts = new Set<string>();
  return mapped.filter((product) => {
    if (seenCheckouts.has(product.checkout_url)) return false;
    seenCheckouts.add(product.checkout_url);
    return true;
  });
}
