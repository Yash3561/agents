/**
 * Integration tests for POST /api/chat
 *
 * Strategy: import the action function directly and call it with mock Request
 * objects. Mock all external dependencies (LLM, Redis, Prisma, MCP, auth).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// All mocks must be declared before importing the module under test

vi.mock("~/redis.server", () => ({
  redis: {
    exists: vi.fn().mockResolvedValue(0),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    setex: vi.fn().mockResolvedValue("OK"),
    incr: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock("~/db.server", () => ({
  default: {
    merchant: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    conversation: {
      upsert: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    session: {
      findFirst: vi.fn().mockResolvedValue({ accessToken: "fake-token" }),
    },
  },
}));

vi.mock("~/lib/auth.server", () => ({
  getStorefrontAccessToken: vi.fn().mockResolvedValue("fake-storefront-token"),
}));

vi.mock("~/lib/rate-limit.server", () => ({
  checkChatRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

vi.mock("~/lib/billing.server", () => ({
  checkAndIncrementUsage: vi.fn().mockResolvedValue({ allowed: true, used: 1, limit: 500 }),
}));

vi.mock("~/lib/agents/memory.server", () => ({
  fetchCustomerMemory: vi.fn().mockResolvedValue({}),
  updateCustomerMemory: vi.fn().mockResolvedValue(undefined),
  clearAbandonedCart: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/lib/mcp/cart.server", () => ({
  createCart: vi.fn().mockResolvedValue({ id: "gid://shopify/Cart/new123" }),
  updateCart: vi.fn().mockResolvedValue({ id: "gid://shopify/Cart/new123" }),
}));

vi.mock("~/lib/mcp/catalog.server", () => ({
  searchCatalog: vi.fn().mockResolvedValue([]),
}));

// Mock the unified agent to emit a simple SSE stream deterministically
vi.mock("~/lib/agents/unified.server", () => ({
  runUnifiedAgent: vi.fn().mockImplementation(async function* () {
    yield { type: "delta", text: "Hello from mock agent!" };
    yield { type: "done" };
  }),
}));

vi.mock("~/lib/conversation.server", () => ({
  persistConversationTurn: vi.fn().mockResolvedValue(undefined),
  extractCheckoutToken: vi.fn().mockReturnValue(undefined),
}));

// shopify.server is needed for auth fallback
vi.mock("~/shopify.server", () => ({
  authenticate: {
    admin: vi.fn().mockRejectedValue(new Error("not admin")),
    webhook: vi.fn(),
  },
}));

import type { ActionFunctionArgs } from "react-router";
import { action } from "~/routes/api.chat";
import prisma from "~/db.server";
import { checkAndIncrementUsage } from "~/lib/billing.server";
import { createCart } from "~/lib/mcp/cart.server";

const mockPrisma = prisma as unknown as {
  merchant: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
};

/** Build a properly typed ActionFunctionArgs from a POST body */
function makeArgs(body: Record<string, unknown>): ActionFunctionArgs {
  return {
    request: new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: {},
    context: {} as ActionFunctionArgs["context"],
    url: new URL("http://localhost/api/chat"),
    pattern: "/api/chat",
  };
}

const baseMerchant = {
  id: "1",
  shopDomain: "test.myshopify.com",
  plan: "spark",
  conversationCount: 5,
  conversationResetAt: new Date(),
  widgetColor: "#7c3aed",
  widgetPosition: "bottom-right",
  widgetGreeting: "Hi!",
  botName: "NeonPing",
  brandVoice: "friendly",
  supportEmail: null,
  escalationEmailEnabled: false,
  customFaqs: [],
  excludedPages: [],
  proactiveEngagementEnabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.merchant.upsert.mockResolvedValue(baseMerchant);
  vi.mocked(checkAndIncrementUsage).mockResolvedValue({ allowed: true, used: 1, limit: 500 });
});

describe("POST /api/chat", () => {
  it("returns SSE stream on valid request", async () => {
    const response = await action(
      makeArgs({
        session_id: "test-session-1",
        shop: "test.myshopify.com",
        message: "hello",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
  });

  it("returns 400 when session_id is missing", async () => {
    const response = await action(
      makeArgs({
        shop: "test.myshopify.com",
        message: "hello",
      }),
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 when shop is missing", async () => {
    const response = await action(
      makeArgs({
        session_id: "abc",
        message: "hello",
      }),
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 when message is missing", async () => {
    const response = await action(
      makeArgs({
        session_id: "abc",
        shop: "test.myshopify.com",
      }),
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 when message exceeds 2000 characters", async () => {
    const response = await action(
      makeArgs({
        session_id: "abc",
        shop: "test.myshopify.com",
        message: "x".repeat(2001),
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("message_too_long");
  });

  it("returns 402 when billing limit exceeded", async () => {
    vi.mocked(checkAndIncrementUsage).mockResolvedValue({ allowed: false, used: 500, limit: 500 });

    const response = await action(
      makeArgs({
        session_id: "abc",
        shop: "test.myshopify.com",
        message: "hello",
      }),
    );

    expect(response.status).toBe(402);
  });

  it("returns 405 for non-POST methods", async () => {
    const response = await action({
      request: new Request("http://localhost/api/chat", { method: "GET" }),
      params: {},
      context: {} as ActionFunctionArgs["context"],
      url: new URL("http://localhost/api/chat"),
      pattern: "/api/chat",
    });

    expect(response.status).toBe(405);
  });

  it("calls createCart when cartAction is present and no existing cart", async () => {
    vi.mocked(createCart).mockResolvedValue({ id: "gid://shopify/Cart/brand-new" } as Awaited<ReturnType<typeof createCart>>);

    const response = await action(
      makeArgs({
        session_id: "cart-action-session",
        shop: "test.myshopify.com",
        message: "Add this to cart",
        cartAction: { variantId: "gid://shopify/ProductVariant/1", quantity: 1 },
      }),
    );

    // The cartAction is handled inside the ReadableStream start() callback.
    // Consume the stream to ensure the async work completes before asserting.
    if (response.body) {
      const reader = response.body.getReader();
      let streamDone = false;
      while (!streamDone) {
        const { done } = await reader.read();
        streamDone = done;
      }
    }

    // createCart should have been called
    expect(createCart).toHaveBeenCalled();
  });
});
