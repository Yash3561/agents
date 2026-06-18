import { adminGraphql } from "~/lib/mcp/admin.server";

export interface ActiveDiscount {
  code: string;
  title: string;
  summary: string; // human-readable e.g. "15% off your order"
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

      if (d.__typename === "DiscountCodeBasic" && d.customerGets?.value) {
        const v = d.customerGets.value;
        if (v.__typename === "DiscountPercentage" && v.percentage) {
          summary = `${Math.round(v.percentage * 100)}% off your order`;
        } else if (v.__typename === "DiscountAmount" && v.amount) {
          summary = `${v.amount.amount} ${v.amount.currencyCode} off your order`;
        }
      } else if (d.__typename === "DiscountCodeFreeShipping") {
        summary = "free shipping";
      }

      results.push({ code, title, summary });
    }

    return results;
  } catch {
    return [];
  }
}
