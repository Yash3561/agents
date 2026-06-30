import { redis } from "~/redis.server";

const SESSION_TTL_S = 1800; // 30 min, resets on every message
const MAX_HISTORY = 20;
const KEY = (shop: string, id: string) => `session:${shop}:${id}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface DiscountNegotiationState {
  offered_codes: string[];  // codes already mentioned this conversation
  level: number;            // how many offers made so far (0 = none yet)
}

export interface ConversationSession {
  conversation_history: Message[];
  cart_id?: string;
  /** set when cart converts to checkout — used by memory.server.ts to clear abandoned_cart signal */
  checkout_id?: string;
  checkout_token?: string;    // real Shopify cart/checkout token (parsed from checkout_url), used to match orders/paid webhooks
  discount_negotiation: DiscountNegotiationState;
}

const DEFAULT_SESSION = (): ConversationSession => ({
  conversation_history: [],
  discount_negotiation: { offered_codes: [], level: 0 },
});

// ---------------------------------------------------------------------------
// R/W
// ---------------------------------------------------------------------------

/** Load session from Redis. Returns a fresh default if key doesn't exist. */
export async function getSession(
  shopDomain: string,
  sessionId: string,
): Promise<ConversationSession> {
  const raw = await redis.get(KEY(shopDomain, sessionId)).catch(() => null);
  if (!raw) return DEFAULT_SESSION();
  try {
    const parsed = JSON.parse(raw) as ConversationSession;
    // Migrate sessions written before discount_negotiation was introduced
    if (!parsed.discount_negotiation) {
      parsed.discount_negotiation = { offered_codes: [], level: 0 };
    }
    return parsed;
  } catch {
    return DEFAULT_SESSION();
  }
}

/** Save session back to Redis. Trims history to MAX_HISTORY and resets TTL. */
export async function setSession(
  shopDomain: string,
  sessionId: string,
  session: ConversationSession,
): Promise<void> {
  const toSave: ConversationSession = {
    ...session,
    conversation_history: session.conversation_history.slice(-MAX_HISTORY),
  };
  await redis
    .set(KEY(shopDomain, sessionId), JSON.stringify(toSave), "EX", SESSION_TTL_S)
    .catch(() => null);
}

export async function deleteSession(shopDomain: string, sessionId: string): Promise<void> {
  await redis.del(KEY(shopDomain, sessionId)).catch(() => null);
}

/** Append a message to conversation history and persist. */
export async function appendMessage(
  shopDomain: string,
  sessionId: string,
  message: Message,
): Promise<void> {
  const session = await getSession(shopDomain, sessionId);
  session.conversation_history.push(message);
  await setSession(shopDomain, sessionId, session);
}

