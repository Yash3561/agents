import { adminGraphql } from "~/lib/mcp/admin.server";
import { redis } from "~/redis.server";

export interface ActiveDiscount {
  code: string;
  title: string;
  summary: string;
  type: "percentage" | "fixed_amount" | "free_shipping" | "buy_x_get_y";
  value: number;
}

const DISCOUNT_CACHE_TTL = 300; // 5 minutes — discounts change rarely
const discountCacheKey = (shop: string) => `discounts:${shop}`;

export async function getActiveDiscounts(
  shopDomain: string,
  accessToken: string,
): Promise<ActiveDiscount[]> {
  // Redis cache — avoid Admin API hit on every agent turn
  const cacheKey = discountCacheKey(shopDomain);
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(String(cached)) as ActiveDiscount[];
      console.debug("[discounts] cache hit:", parsed.length, "codes for", shopDomain);
      return parsed;
    }
  } catch {
    // Redis unavailable — fall through to live fetch
  }

  try {
    // Fetch WITHOUT query filter — "status:active" filter string is unreliable
    // across Shopify Admin API versions. Fetch all (first: 10) and filter by
    // the `status` field returned in each fragment instead.
    const data = await adminGraphql<{
      codeDiscountNodes: {
        nodes: Array<{
          codeDiscount: {
            __typename: string;
            title?: string;
            status?: string;
            codes?: { nodes: Array<{ code: string }> };
            endsAt?: string | null;
            customerGets?: {
              value?: {
                __typename: string;
                percentage?: number;
                amount?: { amount: string; currencyCode: string };
              };
            };
          };
        }>;
      };
    }>(
      shopDomain,
      accessToken,
      `{
        codeDiscountNodes(first: 10) {
          nodes {
            codeDiscount {
              __typename
              ... on DiscountCodeBasic {
                title
                status
                endsAt
                codes(first: 1) { nodes { code } }
                customerGets {
                  value {
                    __typename
                    ... on DiscountPercentage { percentage }
                    ... on DiscountAmount { amount { amount currencyCode } }
                  }
                }
              }
              ... on DiscountCodeFreeShipping {
                title
                status
                endsAt
                codes(first: 1) { nodes { code } }
              }
              ... on DiscountCodeBuyX {
                title
                status
                endsAt
                codes(first: 1) { nodes { code } }
              }
            }
          }
        }
      }`,
    );

    const now = new Date();
    const results: ActiveDiscount[] = [];

    for (const node of data.codeDiscountNodes.nodes) {
      const d = node.codeDiscount;
      if (!d) continue;

      // Filter: only ACTIVE status (Shopify returns "ACTIVE", "EXPIRED", "SCHEDULED")
      if (!d.status || d.status.toUpperCase() !== "ACTIVE") continue;

      // Filter: not expired
      if (d.endsAt && new Date(d.endsAt) < now) continue;

      const code = d.codes?.nodes?.[0]?.code;
      if (!code) continue;

      const title = d.title ?? "Discount";
      let summary = title;
      let type: ActiveDiscount["type"] = "buy_x_get_y";
      let value = 0;

      if (d.__typename === "DiscountCodeBasic" && d.customerGets?.value) {
        const v = d.customerGets.value;
        if (v.__typename === "DiscountPercentage" && v.percentage) {
          summary = `${Math.round(v.percentage * 100)}% off your order`;
          type = "percentage";
          value = Math.round(v.percentage * 100);
        } else if (v.__typename === "DiscountAmount" && v.amount) {
          summary = `${v.amount.amount} ${v.amount.currencyCode} off your order`;
          type = "fixed_amount";
          value = Math.round(parseFloat(v.amount.amount) * 100);
        }
      } else if (d.__typename === "DiscountCodeFreeShipping") {
        summary = "free shipping on your order";
        type = "free_shipping";
        value = 0;
      }

      results.push({ code, title, summary, type, value });
    }

    // Sort ascending by value: cheapest offer first, most generous last
    results.sort((a, b) => {
      const score = (d: ActiveDiscount) => {
        if (d.type === "free_shipping") return 50;
        if (d.type === "buy_x_get_y") return 40;
        return d.value;
      };
      return score(a) - score(b);
    });

    // Cache the result
    if (results.length > 0) {
      await redis.setex(cacheKey, DISCOUNT_CACHE_TTL, JSON.stringify(results)).catch(() => null);
    }

    console.debug("[discounts] fetched", results.length, "active codes for", shopDomain);
    return results;

  } catch (err) {
    // Full error logged — was previously swallowing everything silently
    console.error("[discounts] getActiveDiscounts failed — shop:", shopDomain, "err:", String(err));
    return [];
  }
}
