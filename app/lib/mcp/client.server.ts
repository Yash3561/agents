/**
 * Shared JSON-RPC 2.0 HTTP client for all Shopify-hosted MCP servers and our
 * Admin GraphQL proxy. Every MCP module (catalog, cart, checkout, etc.) calls
 * callMcpTool() — auth, retries, and error normalisation live here once.
 *
 * Auth tiers per the UCP spec:
 *   "none"   → Storefront Catalog, Policy & FAQs (no credentials needed)
 *   "bearer" → Cart, Checkout, Order, Customer Accounts (UCP JWT or OAuth token)
 *   "admin"  → Admin GraphQL proxy (merchant's Shopify access token)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpAuth {
  type: "none" | "bearer" | "admin";
  /** Required when type is "bearer" or "admin". */
  token?: string;
}

export interface McpClientOptions {
  endpoint: string;
  auth?: McpAuth;
  /**
   * URL of our hosted UCP agent profile.
   * When set, auto-injected as meta["ucp-agent"].profile into every tool's
   * arguments. Required for Cart MCP, Checkout MCP, and Order MCP — Shopify
   * fetches this URL to negotiate capabilities before accepting the call.
   */
  agentProfileUrl?: string;
  /** Per-call timeout in ms. Default: 10 000. */
  timeoutMs?: number;
  /** Retry once on transient HTTP 5xx or network error. Default: true. */
  retry?: boolean;
}

/**
 * Shape of a successful MCP tool result.
 * Real data lives in structuredContent; content[] is a text fallback.
 */
export interface McpToolResult<T> {
  structuredContent: T;
  content?: Array<{ type: string; text: string }>;
}

// Internal JSON-RPC 2.0 wire types
interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: "tools/call";
  id: number;
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface JsonRpcSuccess<T> {
  jsonrpc: "2.0";
  id: number;
  result: McpToolResult<T>;
}

interface JsonRpcErrorPayload {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcErrorPayload;

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class McpError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.data = data;
  }

  /** True for errors the caller should NOT retry (bad input, auth denied). */
  get isTerminal(): boolean {
    // 4xx except 429 (rate-limit) are terminal — bad request or auth failure.
    return this.code >= 400 && this.code < 500 && this.code !== 429;
  }

  get isRateLimited(): boolean {
    return this.code === 429;
  }
}

// ---------------------------------------------------------------------------
// Request counter — unique IDs for in-flight correlation only
// ---------------------------------------------------------------------------

let _nextId = 0;
const nextId = (): number => (++_nextId & 0x7fffffff);

// ---------------------------------------------------------------------------
// Core call
// ---------------------------------------------------------------------------

/**
 * Call a named tool on a Shopify MCP server.
 *
 * @param options  Endpoint, auth, agentProfileUrl, and retry/timeout settings.
 * @param toolName The MCP tool name, e.g. "search_catalog".
 * @param args     Tool arguments. agentProfileUrl is auto-merged as meta["ucp-agent"].profile.
 * @returns        McpToolResult<T> — access real data via result.structuredContent.
 * @throws         McpError on JSON-RPC error, HTTP error, or timeout.
 */
export async function callMcpTool<T = unknown>(
  options: McpClientOptions,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult<T>> {
  const {
    endpoint,
    auth,
    agentProfileUrl,
    timeoutMs = 10_000,
    retry = true,
  } = options;

  // Merge UCP agent profile into meta — required by Cart, Checkout, Order MCP
  // for capability negotiation. Caller args take precedence if meta is already set.
  const mergedArgs: Record<string, unknown> = agentProfileUrl
    ? {
        meta: { "ucp-agent": { profile: agentProfileUrl } },
        ...args,
        // If caller already passed a meta, deep-merge to preserve their keys
        ...(args.meta
          ? {
              meta: {
                "ucp-agent": { profile: agentProfileUrl },
                ...(args.meta as Record<string, unknown>),
              },
            }
          : {}),
      }
    : args;

  const attempt = async (): Promise<McpToolResult<T>> => {
    const body: JsonRpcRequest = {
      jsonrpc: "2.0",
      method: "tools/call",
      id: nextId(),
      params: { name: toolName, arguments: mergedArgs },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (auth?.type === "bearer" && auth.token) {
      headers["Authorization"] = `Bearer ${auth.token}`;
    } else if (auth?.type === "admin" && auth.token) {
      // Admin GraphQL proxy: merchant's Shopify access token.
      // X-Auth-Type lets our proxy distinguish this from UCP JWT calls.
      headers["Authorization"] = `Bearer ${auth.token}`;
      headers["X-Auth-Type"] = "shopify-admin";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if ((err as Error).name === "AbortError") {
        throw new McpError(
          `MCP tool "${toolName}" timed out after ${timeoutMs}ms`,
          -32000,
        );
      }
      throw new McpError(
        `MCP network error calling "${toolName}": ${msg}`,
        -32000,
      );
    } finally {
      clearTimeout(timer);
    }

    // Surface 429 with Retry-After so the retry logic below can respect it
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const waitMs = retryAfter ? parseFloat(retryAfter) * 1_000 : 1_000;
      const err = new McpError(
        `MCP rate limit hit for tool "${toolName}" — retry after ${retryAfter ?? "1"}s`,
        429,
        { retryAfterMs: waitMs },
      );
      throw err;
    }

    if (!response.ok) {
      throw new McpError(
        `MCP server returned HTTP ${response.status} for tool "${toolName}"`,
        response.status,
      );
    }

    let json: JsonRpcResponse<T>;
    try {
      json = (await response.json()) as JsonRpcResponse<T>;
    } catch {
      throw new McpError(
        `MCP server returned non-JSON response for tool "${toolName}"`,
        -32700,
      );
    }

    if ("error" in json) {
      throw new McpError(json.error.message, json.error.code, json.error.data);
    }

    // Shopify MCP returns data in result.content[0].text (a JSON string).
    // Non-Shopify MCP servers may use result.structuredContent directly.
    const raw = json.result as {
      content?: Array<{ type: string; text: string }>;
      isError?: boolean;
      structuredContent?: T;
    };

    const textContent = raw.content?.[0]?.text;
    if (textContent) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(textContent) as Record<string, unknown>;
      } catch {
        throw new McpError(
          `MCP server returned non-JSON text for tool "${toolName}"`,
          -32700,
        );
      }
      if (raw.isError) {
        const errs = parsed.errors as Array<{ message: string }> | undefined;
        throw new McpError(
          errs?.[0]?.message ?? `Tool "${toolName}" returned an error`,
          -32000,
          parsed.errors,
        );
      }
      return { structuredContent: parsed as T, content: raw.content };
    }

    return {
      structuredContent: (raw.structuredContent ?? {}) as T,
      content: raw.content,
    };
  };

  if (!retry) return attempt();

  try {
    return await attempt();
  } catch (err) {
    if (!(err instanceof McpError)) throw err;

    // Terminal (4xx except 429) — don't retry, surface immediately
    if (err.isTerminal) throw err;

    // Rate-limited — wait exactly what the server asked (+ ±10% jitter)
    if (err.isRateLimited) {
      const base = (err.data as { retryAfterMs?: number } | undefined)
        ?.retryAfterMs ?? 1_000;
      await sleep(withJitter(base));
      return attempt();
    }

    // Transient 5xx / network — short exponential backoff before one retry
    await sleep(withJitter(500));
    return attempt();
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Adds ±10% random jitter to a delay to avoid thundering-herd retries. */
function withJitter(ms: number): number {
  return ms * (0.9 + Math.random() * 0.2);
}
