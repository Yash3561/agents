/**
 * Exa neural search — gives the shopping agent a web-research tool for
 * anything outside the store's own catalog (comparisons, reviews, buying
 * guides). See shared-tools.server.ts's web_search tool for the agent-facing
 * side; this file is just the thin Exa API client.
 *
 * Docs: https://docs.exa.ai/reference/search
 */

const EXA_SEARCH_URL = "https://api.exa.ai/search";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

export interface WebSearchOptions {
  numResults?: number;
  /** Only include pages published on or after this ISO timestamp. */
  startPublishedDate?: string;
  /** Only include pages published before this ISO timestamp. */
  endPublishedDate?: string;
  /** Prefer a recently refreshed Exa index result. */
  maxAgeHours?: number;
  /** Ask Exa to crawl the live page when available. */
  livecrawl?: "preferred" | "always" | "fallback";
  /** Instruct Exa how to rank/summarize the returned research. */
  systemPrompt?: string;
}

export async function webSearch(
  query: string,
  opts: WebSearchOptions = {},
): Promise<{ results: WebSearchResult[]; error?: string }> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    return { results: [], error: "Web search is not configured." };
  }

  try {
    const body = {
      query,
      type: "auto",
      numResults: opts.numResults ?? 5,
      ...(opts.startPublishedDate ? { startPublishedDate: opts.startPublishedDate } : {}),
      ...(opts.endPublishedDate ? { endPublishedDate: opts.endPublishedDate } : {}),
      ...(opts.maxAgeHours != null ? { maxAgeHours: opts.maxAgeHours } : {}),
      ...(opts.livecrawl ? { livecrawl: opts.livecrawl } : {}),
      ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      contents: { text: { maxCharacters: 500 } },
    };

    const res = await fetch(EXA_SEARCH_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      return { results: [], error: `Exa returned ${res.status}` };
    }

    const data = (await res.json()) as {
      results?: Array<{ title?: string; url: string; text?: string; publishedDate?: string }>;
    };

    const results: WebSearchResult[] = (data.results ?? []).map((r) => ({
      title: r.title ?? r.url,
      url: r.url,
      snippet: (r.text ?? "").trim(),
      ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
    }));

    return { results };
  } catch (err) {
    return { results: [], error: err instanceof Error ? err.message : "Web search failed" };
  }
}
