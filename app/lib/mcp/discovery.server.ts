import { redis } from "~/redis.server";

const CACHE_TTL_S = 3600; // 60-min cache per IMPLEMENTATION_PLAN
const CACHE_KEY = (shop: string) => `mcp:endpoint:${shop}`;

interface UcpDocument {
  ucp?: {
    services?: {
      "dev.ucp.shopping"?: Array<{
        transport: string;
        endpoint: string;
      }>;
    };
  };
}

/**
 * Returns the MCP endpoint for a merchant store.
 * Fetches /.well-known/ucp on first call, caches in Redis for 60 minutes.
 * Falls back to https://{shop}/api/ucp/mcp if discovery fails.
 */
export async function getMcpEndpoint(shopDomain: string): Promise<string> {
  const cacheKey = CACHE_KEY(shopDomain);

  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return cached;

  const endpoint = await fetchEndpoint(shopDomain);
  await redis.set(cacheKey, endpoint, "EX", CACHE_TTL_S).catch(() => null);
  return endpoint;
}

/** Busts the cached endpoint — call if a merchant migrates their MCP URL. */
export async function bustMcpEndpointCache(shopDomain: string): Promise<void> {
  await redis.del(CACHE_KEY(shopDomain)).catch(() => null);
}

async function fetchEndpoint(shopDomain: string): Promise<string> {
  const fallback = `https://${shopDomain}/api/ucp/mcp`;

  try {
    const res = await fetch(`https://${shopDomain}/.well-known/ucp`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return fallback;

    const doc = (await res.json()) as UcpDocument;
    const services = doc?.ucp?.services?.["dev.ucp.shopping"];
    const mcp = Array.isArray(services)
      ? services.find((s) => s.transport === "mcp")
      : undefined;

    return mcp?.endpoint ?? fallback;
  } catch {
    return fallback;
  }
}
