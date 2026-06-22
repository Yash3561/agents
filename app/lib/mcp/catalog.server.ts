import { callMcpTool } from "~/lib/mcp/client.server";
import { redis } from "~/redis.server";

// Shopify Storefront MCP — public, no auth required for catalog operations.
// Discovery (/.well-known/ucp) is not implemented on most stores; use /api/mcp directly.
const endpoint = (shop: string) => ({ endpoint: `https://${shop}/api/mcp` });

const SEARCH_CACHE_TTL = 60; // seconds — balance freshness vs latency

function searchCacheKey(shop: string, query: string, maxPriceCents?: number): string {
  const price = maxPriceCents != null ? String(maxPriceCents) : "any";
  return `search:${shop}:${query.toLowerCase().trim()}:${price}`;
}

// ---------------------------------------------------------------------------
// Types — aligned with Shopify UCP catalog search response
// ---------------------------------------------------------------------------

export interface ProductVariant {
  id: string;           // "gid://shopify/ProductVariant/..."
  title: string;
  price: string;        // formatted string e.g. "29.99"
  currency?: string;
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
  price_min?: string;   // lowest variant price, formatted
  currency?: string;
  url?: string;         // relative URL e.g. "/products/handle"
}

export interface CatalogSearchResult {
  products: CatalogProduct[];
  total: number;
  pagination?: { has_next_page: boolean; cursor?: string };
}

// ---------------------------------------------------------------------------
// Internal — map Shopify UCP product shape to our CatalogProduct
// Real shape (confirmed via live search_catalog call):
// { id, title, description: {html}, price_range: {min: {amount, currency}},
//   variants: [{ id, title, price: {amount, currency}, availability: {available}, media: [{url}] }],
//   media: [{type, url, alt_text}] }
// ---------------------------------------------------------------------------

function moneyToString(money: Record<string, unknown> | undefined): string | undefined {
  if (!money) return undefined;
  const amount = money.amount;
  return typeof amount === "number" ? (amount / 100).toFixed(2) : (amount as string | undefined);
}

function mapProduct(p: Record<string, unknown>): CatalogProduct {
  const variants = (p.variants as Array<Record<string, unknown>> | undefined) ?? [];
  const media = (p.media as Array<Record<string, unknown>> | undefined) ?? [];
  const priceRange = p.price_range as Record<string, unknown> | undefined;
  const minPrice = priceRange?.min as Record<string, unknown> | undefined;
  const description = p.description as Record<string, unknown> | string | undefined;

  return {
    id: p.id as string,
    title: p.title as string,
    description:
      typeof description === "string" ? description : (description?.html as string | undefined),
    image_url: media[0]?.url as string | undefined,
    vendor: p.vendor as string | undefined,
    price_min: moneyToString(minPrice),
    currency: minPrice?.currency as string | undefined,
    url: p.url as string | undefined,
    variants: variants.map((v) => {
      const vMedia = (v.media as Array<Record<string, unknown>> | undefined) ?? [];
      const price = v.price as Record<string, unknown> | undefined;
      const availability = v.availability as Record<string, unknown> | undefined;
      return {
        id: v.id as string,
        title: (v.title ?? "Default") as string,
        price: moneyToString(price) ?? "0",
        currency: price?.currency as string | undefined,
        available: (availability?.available ?? true) as boolean,
        image_url: vMedia[0]?.url as string | undefined,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Search a merchant's catalog — uses Shopify Storefront MCP search_catalog tool.
 * No auth required (public storefront data).
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

  // Strip emoji and other non-text Unicode so they don't pollute the search query
  const cleanQuery = query
    .replace(/\p{Emoji_Presentation}/gu, "")
    .replace(/\s+/g, " ")
    .trim();

  const args: Record<string, unknown> = {
    catalog: {
      query: cleanQuery,
      context: {
        currency,
        address_country: addressCountry,
        ...(intent ? { intent } : {}),
      },
      ...(maxPriceCents !== undefined
        ? { filters: { price: { max: maxPriceCents } } }
        : {}),
      pagination: { limit: Math.min(limit, 3) },
    },
  };

  // Cache check — eliminates 700ms Shopify MCP call on repeated searches
  const cacheKey = searchCacheKey(shopDomain, cleanQuery, maxPriceCents);
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(String(cached)) as CatalogSearchResult;
  } catch {
    // Redis unavailable — fall through to live fetch
  }

  const result = await callMcpTool<Record<string, unknown>>(
    endpoint(shopDomain),
    "search_catalog",
    args,
  );

  const raw = result.structuredContent;
  const rawProducts = (raw.products as Array<Record<string, unknown>>) ?? [];

  const searchResult: CatalogSearchResult = {
    products: rawProducts.map(mapProduct),
    total: rawProducts.length,
    pagination: raw.pagination as CatalogSearchResult["pagination"],
  };

  // Write to cache (fire-and-forget — never blocks the response)
  redis.setex(cacheKey, SEARCH_CACHE_TTL, JSON.stringify(searchResult)).catch(() => null);

  return searchResult;
}

/** Look up specific products by GID — implemented as parallel get_product_details calls. */
export async function lookupCatalog(
  shopDomain: string,
  ids: string[],
): Promise<ProductVariant[]> {
  const results = await Promise.allSettled(ids.map((id) => getProduct(shopDomain, id)));
  return results
    .filter((r): r is PromiseFulfilledResult<CatalogProduct> => r.status === "fulfilled")
    .flatMap((r) => r.value.variants);
}

/** Get full product details by GID. */
export async function getProduct(
  shopDomain: string,
  productId: string,
  selectedOptions?: Array<{ name: string; label: string }>,
): Promise<CatalogProduct> {
  // Shopify expects options as { "Size": "L", "Color": "Red" }
  const options = selectedOptions?.reduce<Record<string, string>>(
    (acc, { name, label }) => ({ ...acc, [name]: label }),
    {},
  );

  const result = await callMcpTool<Record<string, unknown>>(
    endpoint(shopDomain),
    "get_product_details",
    {
      product_id: productId,
      ...(options && Object.keys(options).length > 0 ? { options } : {}),
    },
  );

  const raw = result.structuredContent;
  // Response may be { product: {...} } or the product directly
  const p = (raw.product as Record<string, unknown> | undefined) ?? raw;
  return mapProduct(p);
}
