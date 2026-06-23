/**
 * Integration tests for webhook routes
 *
 * All tests mock authenticate.webhook to bypass real HMAC verification.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/shopify.server", () => ({
  authenticate: {
    webhook: vi.fn(),
    admin: vi.fn().mockRejectedValue(new Error("not admin")),
  },
}));

vi.mock("~/db.server", () => ({
  default: {
    conversation: {
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    session: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    merchant: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));

vi.mock("~/lib/agents/memory.server", () => ({
  wipeCustomerMemory: vi.fn().mockResolvedValue(undefined),
  fetchCustomerMemory: vi.fn().mockResolvedValue({}),
  updateCustomerMemory: vi.fn().mockResolvedValue(undefined),
  clearAbandonedCart: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/lib/mcp/admin.server", () => ({
  adminGraphql: vi.fn().mockResolvedValue({}),
}));

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { action as ordersPaidAction } from "~/routes/webhooks.orders.paid";
import { action as customersRedactAction } from "~/routes/webhooks.customers.redact";
import { action as appUninstalledAction } from "~/routes/webhooks.app.uninstalled";
import { wipeCustomerMemory } from "~/lib/agents/memory.server";
import prisma from "~/db.server";

const mockAuth = authenticate as unknown as { webhook: ReturnType<typeof vi.fn> };
const mockPrisma = prisma as unknown as {
  conversation: {
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  session: { deleteMany: ReturnType<typeof vi.fn> };
  merchant: { updateMany: ReturnType<typeof vi.fn> };
};

function makeArgs(body: Record<string, unknown> = {}): ActionFunctionArgs {
  return {
    request: new Request("http://localhost/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: {},
    context: {} as ActionFunctionArgs["context"],
    url: new URL("http://localhost/webhooks"),
    pattern: "/webhooks/:topic",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ──────────────────────────────────────────────────────────────
// orders/paid
// ──────────────────────────────────────────────────────────────
describe("webhooks.orders.paid", () => {
  it("returns 200 with a valid orders/paid payload", async () => {
    mockAuth.webhook.mockResolvedValue({
      shop: "test.myshopify.com",
      topic: "orders/paid",
      payload: { cart_token: "abc123", id: 9876 },
      session: { accessToken: "fake-token" },
    });

    mockPrisma.conversation.findFirst.mockResolvedValue({
      id: "conv-1",
      shopDomain: "test.myshopify.com",
      checkoutToken: "abc123",
    });

    const response = await ordersPaidAction(makeArgs({ cart_token: "abc123", id: 9876 }));

    expect(response.status).toBe(200);
    expect(mockPrisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orderId: "9876" }),
      }),
    );
  });

  it("returns 200 but skips DB update when no matching conversation", async () => {
    mockAuth.webhook.mockResolvedValue({
      shop: "test.myshopify.com",
      topic: "orders/paid",
      payload: { cart_token: "no-match-token", id: 111 },
      session: null,
    });

    mockPrisma.conversation.findFirst.mockResolvedValue(null);

    const response = await ordersPaidAction(makeArgs({ cart_token: "no-match-token", id: 111 }));

    expect(response.status).toBe(200);
    expect(mockPrisma.conversation.update).not.toHaveBeenCalled();
  });

  it("returns 200 when cart_token is missing in payload", async () => {
    mockAuth.webhook.mockResolvedValue({
      shop: "test.myshopify.com",
      topic: "orders/paid",
      payload: { id: 222 }, // no cart_token
      session: null,
    });

    const response = await ordersPaidAction(makeArgs({ id: 222 }));

    expect(response.status).toBe(200);
    expect(mockPrisma.conversation.update).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────
// customers/redact
// ──────────────────────────────────────────────────────────────
describe("webhooks.customers.redact", () => {
  it("calls wipeCustomerMemory and deletes conversations", async () => {
    mockAuth.webhook.mockResolvedValue({
      shop: "test.myshopify.com",
      topic: "customers/redact",
      payload: { customer: { id: 42 } },
      session: { accessToken: "fake-token" },
    });

    const response = await customersRedactAction(makeArgs({ customer: { id: 42 } }));

    expect(response.status).toBe(200);
    expect(wipeCustomerMemory).toHaveBeenCalledWith(
      "test.myshopify.com",
      "fake-token",
      "gid://shopify/Customer/42",
    );
    expect(mockPrisma.conversation.deleteMany).toHaveBeenCalledWith({
      where: {
        shopDomain: "test.myshopify.com",
        customerId: "gid://shopify/Customer/42",
      },
    });
  });

  it("returns 200 and skips wipeCustomerMemory when no session accessToken", async () => {
    mockAuth.webhook.mockResolvedValue({
      shop: "test.myshopify.com",
      topic: "customers/redact",
      payload: { customer: { id: 99 } },
      session: null, // no access token
    });

    const response = await customersRedactAction(makeArgs({ customer: { id: 99 } }));

    expect(response.status).toBe(200);
    expect(wipeCustomerMemory).not.toHaveBeenCalled();
    // DB cleanup should still happen
    expect(mockPrisma.conversation.deleteMany).toHaveBeenCalled();
  });

  it("returns 200 when customer ID is missing in payload", async () => {
    mockAuth.webhook.mockResolvedValue({
      shop: "test.myshopify.com",
      topic: "customers/redact",
      payload: {}, // no customer
      session: { accessToken: "fake-token" },
    });

    const response = await customersRedactAction(makeArgs({}));

    expect(response.status).toBe(200);
    expect(wipeCustomerMemory).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────
// app/uninstalled
// ──────────────────────────────────────────────────────────────
describe("webhooks.app.uninstalled", () => {
  it("cleans up sessions and resets merchant on uninstall", async () => {
    mockAuth.webhook.mockResolvedValue({
      shop: "test.myshopify.com",
      topic: "app/uninstalled",
      payload: {},
      session: { id: "sess-1", shop: "test.myshopify.com" },
    });

    const response = await appUninstalledAction(makeArgs({}));

    expect(response.status).toBe(200);
    expect(mockPrisma.session.deleteMany).toHaveBeenCalledWith({
      where: { shop: "test.myshopify.com" },
    });
    expect(mockPrisma.merchant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopDomain: "test.myshopify.com" },
        data: expect.objectContaining({ plan: "free", conversationCount: 0 }),
      }),
    );
  });

  it("skips session deletion when no session present", async () => {
    mockAuth.webhook.mockResolvedValue({
      shop: "test.myshopify.com",
      topic: "app/uninstalled",
      payload: {},
      session: undefined,
    });

    const response = await appUninstalledAction(makeArgs({}));

    expect(response.status).toBe(200);
    expect(mockPrisma.session.deleteMany).not.toHaveBeenCalled();
    // merchant reset should still happen
    expect(mockPrisma.merchant.updateMany).toHaveBeenCalled();
  });
});
