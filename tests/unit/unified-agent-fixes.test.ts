/**
 * Regression tests for the unified.server.ts (widget agent) audit fixes:
 *  - Fix #1: route_reason now reflects a real set_intent classification, not a
 *    hardcoded "unified" constant (the merchant dashboard groups conversations
 *    by this field — app._index.tsx).
 *  - Fix #2: the failure-fallback text acknowledges already-mutated cart/discount
 *    state instead of a blind "sorry" that hides a real checkout link/discount.
 *  - Fix #4: order-not-found no longer force-escalates to human.
 *  - Fix #6: a 429 retry resets per-turn closures so it can't merge state
 *    from a partially-executed failed attempt.
 *  - Fix #7: create_cart returns a graceful tool error on empty lineItems
 *    instead of throwing and blowing up the whole turn.
 *  - escalate_human: the only real mechanism for explicit human handoff.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ai", () => ({ tool: (cfg: unknown) => cfg }));

type Tools = Record<string, { execute: (input: unknown) => Promise<unknown> }>;

let streamImpl: (tools: Tools) => AsyncGenerator<string>;
const runAgentStreamMock = vi.fn((opts: { tools: Tools }) => ({
  textStream: streamImpl(opts.tools),
}));

vi.mock("~/lib/llm.server", () => ({
  deployments: { shopping: () => "fake-model" },
  runAgentStream: (...args: [{ tools: Tools }]) => runAgentStreamMock(...args),
}));

const createCartMock = vi.fn();
const getCartMock = vi.fn();
const updateCartMock = vi.fn();
vi.mock("~/lib/mcp/cart.server", () => ({
  createCart: (...args: unknown[]) => createCartMock(...args),
  getCart: (...args: unknown[]) => getCartMock(...args),
  updateCart: (...args: unknown[]) => updateCartMock(...args),
}));

vi.mock("~/lib/mcp/catalog.server", () => ({ searchCatalog: vi.fn(), getProduct: vi.fn(), lookupCatalog: vi.fn() }));
vi.mock("~/lib/mcp/policy.server", () => ({ searchPoliciesAndFaqs: vi.fn() }));
vi.mock("~/lib/mcp/order.server", () => ({ getOrder: vi.fn().mockRejectedValue(new Error("not found")) }));
vi.mock("~/lib/mcp/customer-accounts.server", () => ({ getCustomerOrders: vi.fn() }));

const getActiveDiscountsMock = vi.fn();
vi.mock("~/lib/mcp/discounts.server", () => ({ getActiveDiscounts: (...args: unknown[]) => getActiveDiscountsMock(...args) }));

import { runUnifiedAgent } from "~/lib/agents/unified.server";
import type { ConversationSession } from "~/lib/session.server";
import type { Merchant } from "@prisma/client";
import type { CustomerMemory } from "~/lib/agents/memory.server";

const merchant = { shopDomain: "test.myshopify.com", personalizationEnabled: true, quickReplies: [] } as unknown as Merchant;
const memory = {} as CustomerMemory;

function makeSession(): ConversationSession {
  return { conversation_history: [], discount_negotiation: { offered_codes: [], level: 0 } };
}

const baseOpts = {
  shopDomain: "test.myshopify.com",
  agentMessage: "hi",
  merchant,
  memory,
  accessToken: "admin-token",
};

async function* justYield(text = "ok"): AsyncGenerator<string> {
  yield text;
}

beforeEach(() => {
  vi.clearAllMocks();
  getActiveDiscountsMock.mockResolvedValue([]);
  streamImpl = () => justYield();
});

describe("Fix #1 — route_reason reflects real intent, falls back to 'unified'", () => {
  it("uses the set_intent classification when the model calls it", async () => {
    streamImpl = async function* (tools) {
      await tools.set_intent.execute({ intent: "order_tracking" });
      yield "ok";
    };
    const output = await runUnifiedAgent({ ...baseOpts, session: makeSession() });
    expect(output.route_reason).toBe("order_tracking");
    expect(output.agent_trace).toContain("set_intent");
  });

  it("falls back to 'unified' when set_intent was never called", async () => {
    const output = await runUnifiedAgent({ ...baseOpts, session: makeSession() });
    expect(output.route_reason).toBe("unified");
  });
});

describe("escalate_human — the only real explicit-escalation mechanism", () => {
  it("sets escalate_to_human when called", async () => {
    streamImpl = async function* (tools) {
      await tools.escalate_human.execute({});
      yield "ok";
    };
    const output = await runUnifiedAgent({ ...baseOpts, session: makeSession() });
    expect(output.escalate_to_human).toBe(true);
    expect(output.agent_trace).toContain("escalate_human");
  });
});

describe("Fix #4 — order-not-found no longer force-escalates", () => {
  it("get_order failing does not set escalate_to_human", async () => {
    streamImpl = async function* (tools) {
      const result = (await tools.get_order.execute({ orderId: "999" })) as { error?: string };
      expect(result.error).toBe("Order not found");
      yield "ok";
    };
    const output = await runUnifiedAgent({ ...baseOpts, session: makeSession() });
    expect(output.escalate_to_human).toBeUndefined();
  });
});

describe("Fix #7 — create_cart empty-lineItems guard", () => {
  it("returns a graceful tool error instead of throwing", async () => {
    let toolResult: unknown;
    streamImpl = async function* (tools) {
      toolResult = await tools.create_cart.execute({ lineItems: [] });
      yield "ok";
    };
    await expect(runUnifiedAgent({ ...baseOpts, session: makeSession() })).resolves.toBeDefined();
    expect(toolResult).toEqual({
      error: "empty_cart",
      message: "No items were provided — ask the customer which product they'd like to add.",
    });
    expect(createCartMock).not.toHaveBeenCalled();
  });
});

describe("Fix #2 — failure fallback text is aware of already-mutated state", () => {
  it("uses a generic apology when nothing succeeded before the failure", async () => {
    streamImpl = async function* () {
      throw new Error("boom");
      // eslint-disable-next-line no-unreachable
      yield "";
    };
    const output = await runUnifiedAgent({ ...baseOpts, session: makeSession() });
    expect(output.text).toBe("I'm having trouble with that right now. Please try again in a moment.");
  });

  it("acknowledges partial success when a cart/discount was already created before the failure", async () => {
    createCartMock.mockResolvedValue({ id: "cart1", checkoutUrl: "https://shop/checkout" });
    streamImpl = async function* (tools) {
      await tools.create_cart.execute({ lineItems: [{ item: { id: "gid://v1" }, quantity: 1 }] });
      throw new Error("boom after tool call");
      // eslint-disable-next-line no-unreachable
      yield "";
    };
    const output = await runUnifiedAgent({ ...baseOpts, session: makeSession() });
    expect(output.text).toContain("here's what I've got so far");
    expect(output.checkout_url).toBe("https://shop/checkout"); // state survives even though text apologizes
  });
});

describe("Fix #6 — 429 retry resets closures instead of merging stale state", () => {
  it("does not carry over a cart created during a failed first attempt", async () => {
    createCartMock.mockResolvedValue({ id: "cart1", checkoutUrl: "https://shop/checkout" });
    let attempt = 0;
    streamImpl = (tools) => {
      attempt += 1;
      if (attempt === 1) {
        return (async function* (): AsyncGenerator<string> {
          // Simulate: create_cart succeeded, then a LATER step in the same
          // generation hit a 429 before finishing the reply.
          await tools.create_cart.execute({ lineItems: [{ item: { id: "gid://v1" }, quantity: 1 }] });
          throw Object.assign(new Error("rate limited"), { statusCode: 429 });
          // eslint-disable-next-line no-unreachable
          yield "";
        })();
      }
      // Second attempt: clean success, no tool calls at all this time.
      return justYield("all good");
    };

    vi.useFakeTimers();
    try {
      const promise = runUnifiedAgent({ ...baseOpts, session: makeSession() });
      await vi.advanceTimersByTimeAsync(1000); // the 1s backoff before the retry attempt
      const output = await promise;

      // If the retry didn't reset state, checkout_url/cart would still hold
      // attempt 1's leftover value even though attempt 2 never touched the cart.
      expect(output.checkout_url).toBeUndefined();
      expect(output.cart).toBeUndefined();
      expect(output.text).toBe("all good");
      expect(createCartMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
