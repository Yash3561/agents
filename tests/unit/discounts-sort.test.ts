/**
 * Regression test: the "cheapest → most generous" sort used to compare raw
 * percentage points directly against raw cents, so a $5-off fixed_amount code
 * (value=500) always outranked a 20%-off percentage code (value=20) — nonsense
 * once you consider a 20%-off on anything over $25 is worth more than $5 flat.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { redisMock, adminGraphqlMock } = vi.hoisted(() => ({
  redisMock: { get: vi.fn(), setex: vi.fn() },
  adminGraphqlMock: vi.fn(),
}));

vi.mock("~/redis.server", () => ({ redis: redisMock }));
vi.mock("~/lib/mcp/admin.server", () => ({ adminGraphql: (...args: unknown[]) => adminGraphqlMock(...args) }));

import { getActiveDiscounts } from "~/lib/mcp/discounts.server";

const SHOP = "test.myshopify.com";

function discountNode(opts: { typename: string; title: string; code: string; percentage?: number; amountDollars?: string }) {
  const base = {
    __typename: opts.typename,
    title: opts.title,
    status: "ACTIVE",
    endsAt: null,
    codes: { nodes: [{ code: opts.code }] },
  };
  if (opts.typename === "DiscountCodeBasic") {
    return {
      ...base,
      customerGets: {
        value: opts.percentage != null
          ? { __typename: "DiscountPercentage", percentage: opts.percentage / 100 }
          : { __typename: "DiscountAmount", amount: { amount: opts.amountDollars, currencyCode: "USD" } },
      },
    };
  }
  return base;
}

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockResolvedValue(null);
  redisMock.setex.mockResolvedValue(undefined);
});

describe("getActiveDiscounts sort order (Fix D)", () => {
  it("does not let a small fixed-amount code outrank a large percentage code", async () => {
    adminGraphqlMock.mockResolvedValue({
      codeDiscountNodes: {
        nodes: [
          { codeDiscount: discountNode({ typename: "DiscountCodeBasic", title: "5 off", code: "FIVEOFF", amountDollars: "5.00" }) },
          { codeDiscount: discountNode({ typename: "DiscountCodeBasic", title: "20 pct", code: "TWENTY", percentage: 20 }) },
        ],
      },
    });

    const results = await getActiveDiscounts(SHOP, "token");
    const codes = results.map((r) => r.code);

    // Before the fix: FIVEOFF (value=500) sorted below TWENTY (value=20), i.e. FIVEOFF
    // was treated as "cheaper" — nonsense once cart size is considered. After the fix,
    // a $5 flat discount should not out-rank a 20% discount.
    expect(codes.indexOf("TWENTY")).toBeGreaterThan(codes.indexOf("FIVEOFF"));
  });

  it("still sorts within the same type by magnitude", async () => {
    adminGraphqlMock.mockResolvedValue({
      codeDiscountNodes: {
        nodes: [
          { codeDiscount: discountNode({ typename: "DiscountCodeBasic", title: "30 pct", code: "THIRTY", percentage: 30 }) },
          { codeDiscount: discountNode({ typename: "DiscountCodeBasic", title: "10 pct", code: "TEN", percentage: 10 }) },
        ],
      },
    });

    const results = await getActiveDiscounts(SHOP, "token");
    expect(results.map((r) => r.code)).toEqual(["TEN", "THIRTY"]);
  });
});
