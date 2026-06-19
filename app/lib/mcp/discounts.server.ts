import { adminGraphql } from "~/lib/mcp/admin.server";

export interface ActiveDiscount {
  code: string;
  title: string;
  summary: string; // human-readable e.g. "15% off your order"
  type: "percentage" | "fixed_amount" | "free_shipping" | "buy_x_get_y";
  value: number; // percentage as 0–100 for "percentage", cents for "fixed_amount", 0 for others
}

export async function getActiveDiscounts(
  shopDomain: string,
  accessToken: string,
): Promise<ActiveDiscount[]> {
  // Use codeDiscountNodes to fetch active codes
  // Filter: status ACTIVE, endsAt null or in the future
  // Return max 5 codes so we don't overwhelm the agent
  try {
    const data = await adminGraphql<{
      codeDiscountNodes: {
        nodes: Array<{
          codeDiscount: {
            __typename: string;
            title?: string;
            codes?: { nodes: Array<{ code: string }> };
            endsAt?: string | null;
            status?: string;
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
        codeDiscountNodes(first: 5, query: "status:active") {
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

      // Filter out expired
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
        summary = "free shipping";
        type = "free_shipping";
        value = 0;
      }

      results.push({ code, title, summary, type, value });
    }

    // Sort ascending by value so level 0 = cheapest offer, level N = most generous
    // free_shipping has value 0 — treat as mid-tier (score 50) for sort purposes
    results.sort((a, b) => {
      const score = (d: ActiveDiscount) => {
        if (d.type === "free_shipping") return 50;
        if (d.type === "buy_x_get_y") return 40;
        return d.value; // percentage (0–100) or fixed amount cents
      };
      return score(a) - score(b);
    });

    return results;
  } catch {
    return [];
  }
}
