import { McpError } from "~/lib/mcp/client.server";

const API_VERSION = "2026-04";

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; locations?: unknown }>;
}

interface UserError {
  field: string[];
  message: string;
}

/**
 * Execute an Admin GraphQL query or mutation against a merchant's store.
 * Used by Memory Agent (metafields) and Personalization Agent (discounts, tags).
 *
 * @param shopDomain    e.g. "auranod.myshopify.com"
 * @param accessToken   Merchant's Shopify access token (from our Postgres Session table)
 * @param query         GraphQL query or mutation string
 * @param variables     Optional variables object
 */
export async function adminGraphql<T = unknown>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  if (!shopDomain.endsWith(".myshopify.com")) throw new Error(`Invalid shop domain: ${shopDomain}`);
  const url = `https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new McpError(`Admin GraphQL network error: ${msg}`, -32000);
  }

  if (!response.ok) {
    throw new McpError(
      `Admin GraphQL HTTP ${response.status} for ${shopDomain}`,
      response.status,
    );
  }

  const json = (await response.json()) as GraphQLResponse<T & { userErrors?: UserError[] }>;

  if (json.errors?.length) {
    throw new McpError(
      json.errors.map((e) => e.message).join("; "),
      -32000,
      json.errors,
    );
  }

  // Surface userErrors from mutations (discountCodeBasicCreate, etc.)
  const data = json.data as Record<string, { userErrors?: UserError[] }> | undefined;
  if (data) {
    for (const value of Object.values(data)) {
      if (value?.userErrors?.length) {
        const msg = value.userErrors.map((e) => `${e.field.join(".")}: ${e.message}`).join("; ");
        throw new McpError(`Admin GraphQL userErrors: ${msg}`, -32000, value.userErrors);
      }
    }
  }

  if (!json.data) {
    throw new McpError("Admin GraphQL returned no data", -32000);
  }

  return json.data;
}

/**
 * Called on every inbound WhatsApp message to resolve the sender to a Shopify
 * customer — cached 5 min in Redis (including a "none" sentinel for non-customers)
 * so a burst of messages from the same phone doesn't hit the Admin API each time.
 */
export async function lookupCustomerByPhone(
  shopDomain: string,
  accessToken: string,
  phone: string,
): Promise<{ id: string; firstName?: string; displayName?: string; numberOfOrders?: number } | null> {
  const { redis } = await import("~/redis.server");
  const cacheKey = `wa:custlookup:${shopDomain}:${phone}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return cached === "none" ? null : JSON.parse(cached);
  } catch { /* fall through to live fetch */ }

  try {
    const data = await adminGraphql<{
      customers: { edges: Array<{ node: { id: string; firstName?: string; displayName?: string; numberOfOrders?: number } }> };
    }>(
      shopDomain,
      accessToken,
      `query($q: String!) { customers(query: $q, first: 1) { edges { node { id firstName displayName numberOfOrders } } } }`,
      { q: `phone:"${phone.replace(/"/g, "")}"` },
    );
    const customer = data.customers?.edges?.[0]?.node ?? null;
    await redis.set(cacheKey, customer ? JSON.stringify(customer) : "none", "EX", 300).catch(() => null);
    return customer;
  } catch {
    return null;
  }
}

/**
 * Fetch product star ratings from Shopify metafields.
 * Tries the native "reviews" namespace (Shopify Product Reviews app + native ratings).
 * Results cached in Redis 1h — ratings don't change per-minute.
 * Best-effort: always returns a Map (empty on any error).
 */
export async function fetchProductRatings(
  shopDomain: string,
  accessToken: string,
  productIds: string[],
): Promise<Map<string, { rating: number; count: number }>> {
  if (!productIds.length) return new Map();
  const { redis } = await import("~/redis.server");

  const result = new Map<string, { rating: number; count: number }>();
  const misses: string[] = [];

  await Promise.all(productIds.map(async (id) => {
    const cached = await redis.get(`wa:rating:${id}`).catch(() => null);
    if (cached === "none") return;
    if (cached) {
      try { result.set(id, JSON.parse(cached) as { rating: number; count: number }); } catch { misses.push(id); }
    } else {
      misses.push(id);
    }
  }));

  if (!misses.length) return result;

  try {
    const data = await adminGraphql<{
      nodes: Array<{
        id: string;
        rating?: { value: string };
        ratingCount?: { value: string };
      } | null>;
    }>(
      shopDomain,
      accessToken,
      `query GetRatings($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            rating: metafield(namespace: "reviews", key: "rating") { value }
            ratingCount: metafield(namespace: "reviews", key: "rating_count") { value }
          }
        }
      }`,
      { ids: misses },
    );

    await Promise.all((data.nodes ?? []).map(async (node) => {
      if (!node?.id) return;
      let rating: number | undefined;
      let count: number | undefined;
      if (node.rating?.value) {
        try {
          const parsed = JSON.parse(node.rating.value) as { value?: string };
          const r = parseFloat(parsed.value ?? "");
          if (!isNaN(r)) rating = Math.round(r * 10) / 10;
        } catch { /* skip */ }
      }
      if (node.ratingCount?.value) {
        const c = parseInt(node.ratingCount.value, 10);
        if (!isNaN(c)) count = c;
      }
      const cacheKey = `wa:rating:${node.id}`;
      if (rating !== undefined && count !== undefined && count > 0) {
        const val = { rating, count };
        result.set(node.id, val);
        await redis.set(cacheKey, JSON.stringify(val), "EX", 3600).catch(() => null);
      } else {
        await redis.set(cacheKey, "none", "EX", 3600).catch(() => null);
      }
    }));
  } catch { /* best-effort */ }

  return result;
}

/**
 * Top complementary-product recommendation for the given product, via Shopify's
 * Admin REST "Product Recommendations" endpoint (no Storefront token needed —
 * reuses the offline admin token every webhook already has). Cached 1h in Redis.
 */
export async function getProductRecommendation(
  shopDomain: string,
  accessToken: string,
  productId: string,
): Promise<{ id: string; title: string; variantId: string; priceCents: number } | null> {
  const { redis } = await import("~/redis.server");
  const cacheKey = `productrec:${shopDomain}:${productId}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return cached === "none" ? null : (JSON.parse(cached) as { id: string; title: string; variantId: string; priceCents: number });
  } catch { /* fall through to live fetch */ }

  try {
    const res = await fetch(
      `https://${shopDomain}/admin/api/${API_VERSION}/recommendations/products.json?product_id=${encodeURIComponent(productId)}&intent=complementary`,
      { headers: { "X-Shopify-Access-Token": accessToken }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) {
      await redis.set(cacheKey, "none", "EX", 3600).catch(() => null);
      return null;
    }
    const data = (await res.json()) as { recommendations?: Array<{ id: number }> };
    const top = data.recommendations?.[0];
    if (!top) {
      await redis.set(cacheKey, "none", "EX", 3600).catch(() => null);
      return null;
    }

    const variantData = await adminGraphql<{
      product: { title: string; variants: { nodes: Array<{ id: string; price: string; title: string }> } } | null;
    }>(
      shopDomain,
      accessToken,
      `query($id: ID!) { product(id: $id) { title variants(first: 1) { nodes { id price title } } } }`,
      { id: `gid://shopify/Product/${top.id}` },
    );
    const v = variantData.product?.variants.nodes[0];
    if (!v || !variantData.product) {
      await redis.set(cacheKey, "none", "EX", 3600).catch(() => null);
      return null;
    }

    const rec = {
      id: String(top.id),
      title: v.title === "Default Title" ? variantData.product.title : `${variantData.product.title} (${v.title})`,
      variantId: v.id,
      priceCents: Math.round(parseFloat(v.price) * 100),
    };
    await redis.set(cacheKey, JSON.stringify(rec), "EX", 3600).catch(() => null);
    return rec;
  } catch {
    return null;
  }
}

export async function getCustomerOrdersAdmin(
  shopDomain: string,
  accessToken: string,
  customerId: string,
): Promise<unknown[]> {
  try {
    const data = await adminGraphql<{
      customer: { orders: { edges: Array<{ node: unknown }> } };
    }>(
      shopDomain,
      accessToken,
      `query($id: ID!) {
        customer(id: $id) {
          orders(first: 5, sortKey: CREATED_AT, reverse: true) {
            edges { node {
              name createdAt fulfillmentStatus
              totalPriceV2 { amount currencyCode }
              lineItems(first: 3) { edges { node { title quantity } } }
            }}
          }
        }
      }`,
      { id: customerId },
    );
    return data.customer?.orders?.edges?.map((e) => e.node) ?? [];
  } catch {
    return [];
  }
}
