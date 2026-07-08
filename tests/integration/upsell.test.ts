/**
 * Tests for the post-purchase WhatsApp upsell feature:
 *   - getProductRecommendation (admin.server.ts) — REST + GraphQL + Redis cache
 *   - webhooks.orders.create — fires the upsell prompt when a recommendation exists
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const redisMock = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  exists: vi.fn(),
};

vi.mock("~/redis.server", () => ({ redis: redisMock }));

vi.mock("~/db.server", () => ({
  default: {
    session: { findFirst: vi.fn() },
    // orders/create gates free-form sends on an existing WhatsApp conversation
    conversation: {
      findUnique: vi.fn().mockResolvedValue({ id: "conv-1" }),
    },
    merchant: {
      findFirst: vi.fn().mockResolvedValue({
        shopDomain: "test.myshopify.com",
        waPhoneNumberId: "wa-phone-id",
        waAccessToken: "encrypted-token",
      }),
    },
  },
}));

vi.mock("~/shopify.server", () => ({
  authenticate: { webhook: vi.fn() },
}));

vi.mock("~/lib/whatsapp.server", () => ({
  decryptToken: vi.fn(() => "wa-access-token"),
  normalizePhone: vi.fn((p: string) => p),
  sendTextMessage: vi.fn().mockResolvedValue(undefined),
  sendReplyButtons: vi.fn().mockResolvedValue(undefined),
  sendTemplate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/lib/mcp/discounts.server", () => ({
  getActiveDiscounts: vi.fn().mockResolvedValue([]),
}));

vi.mock("~/lib/mcp/admin.server", () => ({
  getProductRecommendation: vi.fn(),
}));

import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { sendReplyButtons } from "~/lib/whatsapp.server";
import { getProductRecommendation } from "~/lib/mcp/admin.server";
import { action as ordersCreateAction } from "~/routes/webhooks.orders.create";
import type { ActionFunctionArgs } from "react-router";

const mockAuth = authenticate as unknown as { webhook: ReturnType<typeof vi.fn> };
const mockPrismaSession = prisma as unknown as { session: { findFirst: ReturnType<typeof vi.fn> } };
const mockGetRec = getProductRecommendation as unknown as ReturnType<typeof vi.fn>;
const mockSendReplyButtons = sendReplyButtons as unknown as ReturnType<typeof vi.fn>;

function makeArgs(body: Record<string, unknown> = {}): ActionFunctionArgs {
  return {
    request: new Request("http://localhost/webhooks/orders/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: {},
    context: {} as ActionFunctionArgs["context"],
    url: new URL("http://localhost/webhooks/orders/create"),
    pattern: "/webhooks/orders/create",
  };
}

const basePayload = {
  id: 9001,
  name: "#1001",
  order_number: 1001,
  total_price: "50.00",
  payment_gateway_names: ["shopify_payments"], // prepaid, not COD
  customer: { phone: "+15551234567" },
  line_items: [{ product_id: 555 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrismaSession.session.findFirst.mockResolvedValue({ accessToken: "admin-token" });
});

describe("webhooks.orders.create — post-purchase upsell", () => {
  it("waits for the fire-and-forget upsell task then sends a reply-buttons prompt with a 30-min redis TTL key", async () => {
    mockAuth.webhook.mockResolvedValue({
      shop: "test.myshopify.com",
      topic: "orders/create",
      payload: basePayload,
    });
    mockGetRec.mockResolvedValue({
      id: "777",
      title: "Matching Socks",
      variantId: "gid://shopify/ProductVariant/1",
      priceCents: 1200,
    });

    const response = await ordersCreateAction(makeArgs(basePayload));
    expect(response.status).toBe(200);

    // upsell task is fire-and-forget (void IIFE) — flush microtasks
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(mockGetRec).toHaveBeenCalledWith("test.myshopify.com", "admin-token", "555");
    expect(redisMock.set).toHaveBeenCalledWith(
      "wa:upsell:9001",
      expect.stringContaining("Matching Socks"),
      "EX",
      1800,
    );
    expect(mockSendReplyButtons).toHaveBeenCalledWith(
      "wa-phone-id",
      "wa-access-token",
      "+15551234567",
      expect.stringContaining("Matching Socks"),
      [
        { id: "addupsell|9001", title: "➕ Yes, add it" },
        { id: "skip|", title: "No thanks" },
      ],
    );
  });

  it("skips the upsell prompt entirely when there's no recommendation", async () => {
    mockAuth.webhook.mockResolvedValue({
      shop: "test.myshopify.com",
      topic: "orders/create",
      payload: basePayload,
    });
    mockGetRec.mockResolvedValue(null);

    const response = await ordersCreateAction(makeArgs(basePayload));
    expect(response.status).toBe(200);

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(redisMock.set).not.toHaveBeenCalledWith(expect.stringMatching(/^wa:upsell:/), expect.anything(), expect.anything(), expect.anything());
  });

  it("skips the upsell lookup entirely when the order has no line items", async () => {
    mockAuth.webhook.mockResolvedValue({
      shop: "test.myshopify.com",
      topic: "orders/create",
      payload: { ...basePayload, line_items: [] },
    });

    const response = await ordersCreateAction(makeArgs({ ...basePayload, line_items: [] }));
    expect(response.status).toBe(200);

    await new Promise((r) => setTimeout(r, 0));
    expect(mockGetRec).not.toHaveBeenCalled();
  });
});
