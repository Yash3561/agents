import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { redis } from "~/redis.server";

const WA_STATE_TTL_SECONDS = 10 * 60;

function stateSecret(): string {
  return process.env.SHOPIFY_API_SECRET || process.env.SESSION_SECRET || process.env.SHOPIFY_API_KEY || "dev-wa-state-secret";
}

function signState(shop: string, nonce: string): string {
  return createHmac("sha256", stateSecret()).update(`${shop}:${nonce}`).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function createWhatsAppOAuthState(shop: string): Promise<string> {
  const nonce = randomBytes(16).toString("hex");
  const sig = signState(shop, nonce);
  await redis.set(`wa:oauth:${shop}:${nonce}`, "1", "EX", WA_STATE_TTL_SECONDS);
  return Buffer.from(JSON.stringify({ shop, nonce, sig }), "utf8").toString("base64url");
}

export async function verifyWhatsAppOAuthState(state: string | null): Promise<string | null> {
  if (!state) return null;

  let parsed: { shop?: string; nonce?: string; sig?: string };
  try {
    parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as typeof parsed;
  } catch {
    return null;
  }

  const { shop, nonce, sig } = parsed;
  if (!shop || !nonce || !sig) return null;

  const expected = signState(shop, nonce);
  if (!safeEqual(sig, expected)) return null;

  const nonceKey = `wa:oauth:${shop}:${nonce}`;
  const exists = await redis.get(nonceKey).catch(() => null);
  if (!exists) return null;
  await redis.del(nonceKey).catch(() => null);

  return shop;
}
