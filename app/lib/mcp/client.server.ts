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
  /** Per-call timeout in ms. Default: 10 000. */
  timeoutMs?: number;
  /** Retry once on transient HTTP 5xx or network error. Default: true. */
  retry?: boolean;
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
  result: T;
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
    // JSON-RPC application errors (-32600 to -32700) and 4xx HTTP are terminal.
    return this.code >= 400 && this.code < 500;
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
 * @param options  Endpoint, auth, and retry/timeout settings.
 * @param toolName The MCP tool name, e.g. "search_catalog".
 * @param args     Tool arguments object (serialised into params.arguments).
 * @returns        The `result` field from the JSON-RPC 2.0 success response.
 * @throws         McpError on JSON-RPC application error, HTTP error, or timeout.
 */
export async function callMcpTool<T = unknown>(
  options: McpClientOptions,
  toolName: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { endpoint, auth, timeoutMs = 10_000, retry = true } = options;

  const attempt = async (): Promise<T> => {
    const body: JsonRpcRequest = {
      jsonrpc: "2.0",
      method: "tools/call",
      id: nextId(),
      params: { name: toolName, arguments: args },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (auth?.type === "bearer" && auth.token) {
      headers["Authorization"] = `Bearer ${auth.token}`;
    } else if (auth?.type === "admin" && auth.token) {
      // Admin GraphQL proxy: merchant's Shopify access token as bearer.
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

    return json.result;
  };

  // Single retry on transient failures (network blip, 5xx).
  // Terminal errors (auth denied, bad input) propagate immediately.
  if (!retry) return attempt();

  try {
    return await attempt();
  } catch (err) {
    if (err instanceof McpError && err.isTerminal) throw err;
    await sleep(300);
    return attempt();
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
