/**
 * recordLlmUsage() — day-granularity upsert-increment for the LLM cost/usage
 * dashboard groundwork. Covers: correct field mapping (including the AI SDK's
 * nested inputTokenDetails.cacheReadTokens -> flat cachedInputTokens), the
 * day-truncation key, undefined-token fields defaulting to 0, and the
 * fail-open contract (must never throw even if the DB call rejects).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LanguageModelUsage } from "ai";

vi.mock("~/db.server", () => ({
  default: {
    llmUsage: {
      upsert: vi.fn(),
    },
  },
}));

import { recordLlmUsage } from "~/lib/llm.server";
import prisma from "~/db.server";

const mockUpsert = (prisma as unknown as { llmUsage: { upsert: ReturnType<typeof vi.fn> } }).llmUsage.upsert;

function usage(overrides: Partial<LanguageModelUsage> = {}): LanguageModelUsage {
  return {
    inputTokens: 1200,
    outputTokens: 150,
    totalTokens: 1350,
    inputTokenDetails: { noCacheTokens: 400, cacheReadTokens: 800, cacheWriteTokens: 0 },
    outputTokenDetails: { textTokens: 150, reasoningTokens: 0 },
    ...overrides,
  } as LanguageModelUsage;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsert.mockResolvedValue(undefined);
});

describe("recordLlmUsage", () => {
  it("maps inputTokens/outputTokens and flattens cacheReadTokens into cachedInputTokens", async () => {
    await recordLlmUsage("test.myshopify.com", "unified", usage());

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const call = mockUpsert.mock.calls[0][0];
    expect(call.where.shopDomain_date_agent.shopDomain).toBe("test.myshopify.com");
    expect(call.where.shopDomain_date_agent.agent).toBe("unified");
    expect(call.create).toMatchObject({
      inputTokens: 1200,
      outputTokens: 150,
      cachedInputTokens: 800,
      callCount: 1,
    });
    expect(call.update).toEqual({
      inputTokens: { increment: 1200 },
      outputTokens: { increment: 150 },
      cachedInputTokens: { increment: 800 },
      callCount: { increment: 1 },
    });
  });

  it("truncates the date key to UTC midnight so same-day calls collapse into one row", async () => {
    await recordLlmUsage("test.myshopify.com", "whatsapp", usage());
    const date = mockUpsert.mock.calls[0][0].where.shopDomain_date_agent.date as Date;
    expect(date.getUTCHours()).toBe(0);
    expect(date.getUTCMinutes()).toBe(0);
    expect(date.getUTCSeconds()).toBe(0);
    expect(date.getUTCMilliseconds()).toBe(0);
  });

  it("defaults undefined token fields to 0 instead of writing NaN/undefined", async () => {
    await recordLlmUsage("test.myshopify.com", "summary", usage({
      inputTokens: undefined,
      outputTokens: undefined,
      inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
    }));

    const call = mockUpsert.mock.calls[0][0];
    expect(call.create.inputTokens).toBe(0);
    expect(call.create.outputTokens).toBe(0);
    expect(call.create.cachedInputTokens).toBe(0);
  });

  it("never throws when the DB call rejects (fail-open telemetry)", async () => {
    mockUpsert.mockRejectedValue(new Error("connection refused"));
    await expect(recordLlmUsage("test.myshopify.com", "unified", usage())).resolves.toBeUndefined();
  });
});
