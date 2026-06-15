import { callMcpTool } from "~/lib/mcp/client.server";

const STOREFRONT_ENDPOINT = (shop: string) =>
  `https://${shop}/api/mcp`;

const AGENT_PROFILE =
  process.env.SHOPIFY_APP_URL
    ? `${process.env.SHOPIFY_APP_URL}/.well-known/ucp-agent.json`
    : "https://neonping.azurecontainerapps.io/.well-known/ucp-agent.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProductVariant {
  id: string;           // "gid://shopify/ProductVariant/..."
  title: string;
  price: number;        // cents
  available: boolean;
  image_url?: string;
  checkout_url?: string;
}

export interface CatalogProduct {
  id: string;           // "gid://shopify/Product/..."
  title: string;
  description?: string;
  variants: ProductVariant[];
  image_url?: string;
  vendor?: string;
}

export interface CatalogSearchResult {
  products: CatalogProduct[];
  total: number;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Search a merchant's catalog by natural-language query.
 * Max 3 results enforced here (not just in the prompt).
 */
export async function searchCatalog(
  shopDomain: string,
  query: string,
  opts: {
    maxPriceCents?: number;
    limit?: number;
    currency?: string;
    intent?: string;
    addressCountry?: string;
  } = {},
): Promise<CatalogSearchResult> {
  const { maxPriceCents, limit = 3, currency = "USD", intent, addressCountry = "US" } = opts;

  const args: Record<string, unknown> = {
    catalog: {
      query,
      context: {
        ...(intent ? { intent } : {}),
        address_country: addressCountry,
        currency,
      },
      ...(maxPriceCents !== undefined
        ? { filters: { price: { max: maxPriceCents } } }
        : {}),
      pagination: { limit: Math.min(limit, 3) }, // hard cap at 3
    },
  };

  const result = await callMcpTool<CatalogSearchResult>(
    { endpoint: STOREFRONT_ENDPOINT(shopDomain), agentProfileUrl: AGENT_PROFILE },
    "search_catalog",
    args,
  );

  return result.structuredContent;
}

/** Lookup specific variants by GID. */
export async function lookupCatalog(
  shopDomain: string,
  ids: string[],
): Promise<ProductVariant[]> {
  const result = await callMcpTool<{ variants: ProductVariant[] }>(
    { endpoint: STOREFRONT_ENDPOINT(shopDomain), agentProfileUrl: AGENT_PROFILE },
    "lookup_catalog",
    { ids },
  );

  return result.structuredContent.variants ?? [];
}

/** Get full product details including all variants. */
export async function getProduct(
  shopDomain: string,
  productId: string,
  selectedOptions?: Array<{ name: string; label: string }>,
): Promise<CatalogProduct> {
  const result = await callMcpTool<CatalogProduct>(
    { endpoint: STOREFRONT_ENDPOINT(shopDomain), agentProfileUrl: AGENT_PROFILE },
    "get_product",
    {
      id: productId,
      ...(selectedOptions ? { selected: selectedOptions } : {}),
    },
  );

  return result.structuredContent;
}
