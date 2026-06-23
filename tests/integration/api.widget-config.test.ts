/**
 * Integration tests for GET /api/widget-config
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/db.server", () => ({
  default: {
    merchant: {
      findUnique: vi.fn(),
    },
  },
}));

import type { LoaderFunctionArgs } from "react-router";
import { loader } from "~/routes/api.widget-config";
import prisma from "~/db.server";

const mockPrisma = prisma as unknown as {
  merchant: { findUnique: ReturnType<typeof vi.fn> };
};

function makeArgs(params: Record<string, string>): LoaderFunctionArgs {
  const url = new URL("http://localhost/api/widget-config");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return {
    request: new Request(url.toString()),
    params: {},
    context: {} as LoaderFunctionArgs["context"],
    url,
    pattern: "/api/widget-config",
  };
}

const fakeMerchant = {
  shopDomain: "store.myshopify.com",
  widgetColor: "#ff6b6b",
  widgetPosition: "bottom-left",
  widgetGreeting: "Hello! How can I help?",
  botName: "ShopBot",
  excludedPages: ["/cart", "/checkout"],
  proactiveEngagementEnabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/widget-config", () => {
  it("returns config for a known shop", async () => {
    mockPrisma.merchant.findUnique.mockResolvedValue(fakeMerchant);

    const response = await loader(makeArgs({ shop: "store.myshopify.com" }));

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.color).toBe("#ff6b6b");
    expect(body.position).toBe("bottom-left");
    expect(body.greeting).toBe("Hello! How can I help?");
    expect(body.botName).toBe("ShopBot");
  });

  it("returns empty object for unknown shop (not 404)", async () => {
    mockPrisma.merchant.findUnique.mockResolvedValue(null);

    const response = await loader(makeArgs({ shop: "unknown.myshopify.com" }));

    // Should be 200 with empty object, not 404
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body)).toHaveLength(0);
  });

  it("returns empty object when shop param is missing", async () => {
    const response = await loader(makeArgs({}));

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body)).toHaveLength(0);
    expect(mockPrisma.merchant.findUnique).not.toHaveBeenCalled();
  });

  it("has CORS headers", async () => {
    mockPrisma.merchant.findUnique.mockResolvedValue(fakeMerchant);

    const response = await loader(makeArgs({ shop: "store.myshopify.com" }));

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns excludedPages and proactiveEngagement fields", async () => {
    mockPrisma.merchant.findUnique.mockResolvedValue(fakeMerchant);

    const response = await loader(makeArgs({ shop: "store.myshopify.com" }));

    const body = await response.json() as Record<string, unknown>;
    expect(body.excludedPages).toEqual(["/cart", "/checkout"]);
    expect(body.proactiveEngagement).toBe(true);
  });
});
