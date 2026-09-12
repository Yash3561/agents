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

/** Minimal context for follow-up questions in the store-agnostic concierge. */
export interface GlobalProductContext {
  title: string;
  sellerName: string;
  price: string;
  currency: string;
  rating?: number;
  imageUrl?: string;
  checkoutUrl: string;
}

export interface ConversationSession {
  conversation_history: Message[];
  cart_id?: string;
  /** set when cart converts to checkout — used by memory.server.ts to clear abandoned_cart signal */
  checkout_id?: string;
  checkout_token?: string;    // real Shopify cart/checkout token (parsed from checkout_url), used to match orders/paid webhooks
  discount_negotiation: DiscountNegotiationState;
  /** one-shot cap — set true after the first in-session cart-assist suggestion (free-shipping nudge or passive assist) */
  cart_assist_shown?: boolean;
  /** Last Global Catalog cards, so "the second one" and "cheapest" have a referent. */
  last_global_results?: GlobalProductContext[];
  last_global_query?: string;
}

const DEFAULT_SESSION = (): ConversationSession => ({
  conversation_history: [],
  discount_negotiation: { offered_codes: [], level: 0 },
});

// ---------------------------------------------------------------------------
// R/W
// ponytail: getSession → mutate → setSession is a read-modify-write with no
// lock/CAS. Two overlapping turns for the same sessionId (double-tap send, or
// a slow LLM call still in flight when a retry lands) can clobber each other's
// writes. Add an optimistic version check (or a short Redis lock) if this is
// ever observed in practice — not worth the complexity pre-emptively.
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
