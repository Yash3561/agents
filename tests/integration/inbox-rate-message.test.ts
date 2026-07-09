/**
 * Integration tests for the "rate-message" branch of app.inbox.tsx's action —
 * merchant thumbs up/down on individual AI replies (new gap vs Shopify Inbox's
 * Spring '26 rating/training loop). Covers the increment/decrement delta math
 * (rate -> re-rate opposite -> un-rate) and the guard that only genuine AI
 * replies (role: assistant, not merchant-authored "[Merchant] ..." text) are ratable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/shopify.server", () => ({
  authenticate: {
    admin: vi.fn().mockResolvedValue({ session: { shop: "test.myshopify.com" } }),
  },
}));

vi.mock("~/lib/whatsapp.server", () => ({
  sendTextMessage: vi.fn(),
  decryptToken: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  appendMessage: vi.fn(),
}));

vi.mock("~/lib/agents/merchant-analyst.server", () => ({
  runQAJudge: vi.fn(),
}));

vi.mock("~/db.server", () => ({
  default: {
    conversation: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    merchant: {
      findUnique: vi.fn(),
    },
  },
}));

import { action } from "~/routes/app.inbox";
import prisma from "~/db.server";

const mockPrisma = prisma as unknown as {
  conversation: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

function makeRequest(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields);
  return new Request("https://test.myshopify.com/app/inbox", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

const AI_MESSAGE = { role: "assistant", content: "Here are some options!", timestamp: 1000 };
const MERCHANT_MESSAGE = { role: "assistant", content: "[Merchant] Let me check on that.", timestamp: 2000 };
const USER_MESSAGE = { role: "user", content: "show me shoes", timestamp: 500 };

function makeConversation(messages: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    id: "conv-1",
    shopDomain: "test.myshopify.com",
    messages,
    merchantThumbsUp: 0,
    merchantThumbsDown: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("rate-message action", () => {
  it("rates a genuine AI reply up and increments merchantThumbsUp", async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(
      makeConversation([USER_MESSAGE, AI_MESSAGE]),
    );

    await action({
      request: makeRequest({
        intent: "rate-message",
        conversationId: "conv-1",
        messageTimestamp: "1000",
        rating: "up",
      }),
    } as never);

    expect(mockPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "conv-1" },
      data: expect.objectContaining({
        merchantThumbsUp: { increment: 1 },
        messages: [USER_MESSAGE, { ...AI_MESSAGE, merchantRating: "up" }],
      }),
    });
  });

  it("switching an existing 'up' rating to 'down' decrements up and increments down in the same call", async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(
      makeConversation([{ ...AI_MESSAGE, merchantRating: "up" }], { merchantThumbsUp: 1 }),
    );

    await action({
      request: makeRequest({
        intent: "rate-message",
        conversationId: "conv-1",
        messageTimestamp: "1000",
        rating: "down",
      }),
    } as never);

    expect(mockPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "conv-1" },
      data: expect.objectContaining({
        merchantThumbsUp: { increment: -1 },
        merchantThumbsDown: { increment: 1 },
      }),
    });
  });

  it("clicking the same rating again un-rates (empty string rating) and decrements", async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(
      makeConversation([{ ...AI_MESSAGE, merchantRating: "up" }], { merchantThumbsUp: 1 }),
    );

    await action({
      request: makeRequest({
        intent: "rate-message",
        conversationId: "conv-1",
        messageTimestamp: "1000",
        rating: "",
      }),
    } as never);

    const call = mockPrisma.conversation.update.mock.calls[0][0];
    expect(call.data.merchantThumbsUp).toEqual({ increment: -1 });
    expect(call.data.merchantThumbsDown).toBeUndefined(); // no-op delta omitted entirely
    const savedMessages = call.data.messages as Array<{ merchantRating?: string }>;
    expect(savedMessages[0].merchantRating).toBeUndefined();
  });

  it("refuses to rate a merchant-authored '[Merchant] ...' message even though role is assistant", async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(
      makeConversation([MERCHANT_MESSAGE]),
    );

    const result = await action({
      request: makeRequest({
        intent: "rate-message",
        conversationId: "conv-1",
        messageTimestamp: "2000",
        rating: "up",
      }),
    } as never);

    expect(result).toEqual({ error: "Message not ratable" });
    expect(mockPrisma.conversation.update).not.toHaveBeenCalled();
  });

  it("refuses to rate a customer's own message (role: user)", async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(
      makeConversation([USER_MESSAGE]),
    );

    const result = await action({
      request: makeRequest({
        intent: "rate-message",
        conversationId: "conv-1",
        messageTimestamp: "500",
        rating: "up",
      }),
    } as never);

    expect(result).toEqual({ error: "Message not ratable" });
    expect(mockPrisma.conversation.update).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric messageTimestamp instead of throwing", async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(makeConversation([AI_MESSAGE]));

    const result = await action({
      request: makeRequest({
        intent: "rate-message",
        conversationId: "conv-1",
        messageTimestamp: "not-a-number",
        rating: "up",
      }),
    } as never);

    expect(result).toEqual({ error: "Invalid message" });
  });
});
