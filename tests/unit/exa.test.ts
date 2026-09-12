import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webSearch } from "~/lib/exa.server";

describe("webSearch", () => {
  const originalApiKey = process.env.EXA_API_KEY;

  beforeEach(() => {
    process.env.EXA_API_KEY = "test-exa-key";
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = originalApiKey;
    vi.unstubAllGlobals();
  });

  it("forwards freshness controls and preserves published dates", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [{
        title: "New headphones",
        url: "https://example.com/headphones",
        text: "A recent product announcement.",
        publishedDate: "2026-08-01T00:00:00.000Z",
      }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await webSearch("new wireless headphones", {
      numResults: 5,
      startPublishedDate: "2025-09-12T00:00:00.000Z",
      endPublishedDate: "2026-09-12T00:00:00.000Z",
      maxAgeHours: 24,
      livecrawl: "preferred",
      systemPrompt: "Prefer official sources.",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      startPublishedDate: "2025-09-12T00:00:00.000Z",
      endPublishedDate: "2026-09-12T00:00:00.000Z",
      maxAgeHours: 24,
      livecrawl: "preferred",
      systemPrompt: "Prefer official sources.",
    });
    expect(result.results[0]).toMatchObject({
      title: "New headphones",
      publishedDate: "2026-08-01T00:00:00.000Z",
    });
  });

  it("fails open when Exa is not configured", async () => {
    delete process.env.EXA_API_KEY;
    const result = await webSearch("wireless headphones");
    expect(result.results).toEqual([]);
    expect(result.error).toContain("not configured");
  });
});
