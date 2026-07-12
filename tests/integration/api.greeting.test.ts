/**
 * Integration tests for GET /api/greeting
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/agents/memory.server", () => ({
  fetchCustomerMemory: vi.fn(),
}));

vi.mock("~/db.server", () => ({
  default: {
    conversation: {
      findFirst: vi.fn(),
    },
    session: {
      findFirst: vi.fn().mockResolvedValue({ accessToken: "fake-token" }),
    },
  },
}));

vi.mock("~/lib/auth.server", () => ({
  getStorefrontAccessToken: vi.fn().mockResolvedValue("fake-token"),
}));

vi.mock("~/lib/rate-limit.server", () => ({
  checkChatRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

vi.mock("~/shopify.server", () => ({
  authenticate: {
    admin: vi.fn().mockRejectedValue(new Error("not admin")),
  },
}));

import type { LoaderFunctionArgs } from "react-router";
import { loader } from "~/routes/api.greeting";
import { fetchCustomerMemory } from "~/lib/agents/memory.server";
import prisma from "~/db.server";

const mockFetchMemory = fetchCustomerMemory as ReturnType<typeof vi.fn>;
const mockPrisma = prisma as unknown as {
  conversation: { findFirst: ReturnType<typeof vi.fn> };
};

function makeArgs(params: Record<string, string>): LoaderFunctionArgs {
  const url = new URL("http://localhost/api/greeting");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return {
    request: new Request(url.toString()),
    params: {},
    context: {} as LoaderFunctionArgs["context"],
    url,
    pattern: "/api/greeting",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchMemory.mockResolvedValue({});
  mockPrisma.conversation.findFirst.mockResolvedValue(null);
});

describe("GET /api/greeting", () => {
  it("returns { greeting: null } when no customer_id param", async () => {
    const response = await loader(makeArgs({ shop: "test.myshopify.com" }));
    const body = await response.json() as { greeting: string | null };
    expect(body.greeting).toBeNull();
  });

  it("returns { greeting: null } when no shop param", async () => {
    const response = await loader(makeArgs({ customer_id: "gid://shopify/Customer/1" }));
    const body = await response.json() as { greeting: string | null };
    expect(body.greeting).toBeNull();
  });

  it("returns greeting referencing last_search when customer has last_search", async () => {
    mockFetchMemory.mockResolvedValue({ last_search: "yoga mat", firstName: "Alice" });

    const response = await loader(
      makeArgs({
        shop: "test.myshopify.com",
        customer_id: "gid://shopify/Customer/1",
      }),
    );

    const body = await response.json() as { greeting: string | null };
    expect(body.greeting).not.toBeNull();
    expect(body.greeting).toContain("yoga mat");
  });

  it("returns greeting with first name from memory", async () => {
    mockFetchMemory.mockResolvedValue({ firstName: "Bob" });

    const response = await loader(
      makeArgs({
        shop: "test.myshopify.com",
        customer_id: "gid://shopify/Customer/2",
      }),
    );

    const body = await response.json() as { greeting: string | null };
    expect(body.greeting).toContain("Bob");
  });

  it("returns abandoned cart recovery greeting when cart abandoned within window", async () => {
    // 3 hours ago — within the 1hr–14day window
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    mockPrisma.conversation.findFirst.mockResolvedValue({
      cartId: "gid://shopify/Cart/abc",
      orderId: null,
      lastMessageAt: threeHoursAgo,
    });
    mockFetchMemory.mockResolvedValue({ firstName: "Carol" });

    const response = await loader(
      makeArgs({
        shop: "test.myshopify.com",
        customer_id: "gid://shopify/Customer/3",
      }),
    );

    const body = await response.json() as { greeting: string | null };
    expect(body.greeting).not.toBeNull();
    expect(body.greeting).toContain("cart");
  });

  it("does NOT return abandoned cart greeting when cart is too recent (< 1hr ago)", async () => {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    mockPrisma.conversation.findFirst.mockResolvedValue({
      cartId: "gid://shopify/Cart/abc",
      orderId: null,
      lastMessageAt: thirtyMinAgo,
    });
    mockFetchMemory.mockResolvedValue({});

    const response = await loader(
      makeArgs({
        shop: "test.myshopify.com",
        customer_id: "gid://shopify/Customer/4",
      }),
    );

    const body = await response.json() as { greeting: string | null };
    // Should not trigger recovery (too recent)
    expect(body.greeting).toBeNull();
  });

  it("does NOT return abandoned cart greeting when cart is too old (> 14 days)", async () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    mockPrisma.conversation.findFirst.mockResolvedValue({
      cartId: "gid://shopify/Cart/abc",
      orderId: null,
      lastMessageAt: twentyDaysAgo,
    });
    mockFetchMemory.mockResolvedValue({});

    const response = await loader(
      makeArgs({
        shop: "test.myshopify.com",
        customer_id: "gid://shopify/Customer/5",
      }),
    );

    const body = await response.json() as { greeting: string | null };
    expect(body.greeting).toBeNull();
  });

  it("returns { greeting: null } gracefully when an unexpected error occurs", async () => {
    mockFetchMemory.mockRejectedValue(new Error("Unexpected network error"));

    const response = await loader(
      makeArgs({
        shop: "test.myshopify.com",
        customer_id: "gid://shopify/Customer/6",
      }),
    );

    const body = await response.json() as { greeting: string | null };
    expect(body.greeting).toBeNull();
  });
});
