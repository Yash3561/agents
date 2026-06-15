import Redis from "ioredis";

// Singleton pattern — prevents connection pool exhaustion when React Router
// re-evaluates server modules during dev hot reloads.
declare global {
  // eslint-disable-next-line no-var
  var __redis: Redis | undefined;
}

function createClient(): Redis {
  const url = process.env.REDIS_URL;

  const client = url
    ? new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 })
    : new Redis({ host: "127.0.0.1", port: 6379, maxRetriesPerRequest: 3 });

  client.on("error", (err) => {
    // Log but don't crash — callers handle McpError/cache misses gracefully
    console.error("[redis] connection error:", err.message);
  });

  return client;
}

export const redis: Redis = global.__redis ?? (global.__redis = createClient());
