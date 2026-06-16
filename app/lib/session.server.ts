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

export interface ConversationSession {
  conversation_history: Message[];
  cart_id?: string;
  checkout_id?: string;
  checkout_token?: string;    // real Shopify cart/checkout token (parsed from checkout_url), used to match orders/paid webhooks
  discount_applied: boolean;  // one discount per conversation
  hop_count: number;          // reset each turn, max 3
  agent_calls: string[];      // current-turn trace e.g. ["shopping", "personalization"]
}

const DEFAULT_SESSION = (): ConversationSession => ({
  conversation_history: [],
  discount_applied: false,
  hop_count: 0,
  agent_calls: [],
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
    return JSON.parse(raw) as ConversationSession;
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

/** Reset hop_count and agent_calls at the start of each new turn. */
export async function resetTurn(
  shopDomain: string,
  sessionId: string,
): Promise<ConversationSession> {
  const session = await getSession(shopDomain, sessionId);
  const updated = { ...session, hop_count: 0, agent_calls: [] };
  await setSession(shopDomain, sessionId, updated);
  return updated;
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

/** Delete session (on explicit end-of-conversation). */
export async function expireSession(
  shopDomain: string,
  sessionId: string,
): Promise<void> {
  await redis.del(KEY(shopDomain, sessionId)).catch(() => null);
}
