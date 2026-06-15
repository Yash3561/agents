import { adminGraphql } from "~/lib/mcp/admin.server";
import { generateSummary } from "~/lib/llm.server";
import type { ConversationSession, Message } from "~/lib/session.server";

const NAMESPACE = "neonping_chat";
const MAX_METAFIELD_BYTES = 2000;
const SUMMARIZE_AFTER_TURNS = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomerMemory {
  preferences?: Record<string, string>;   // { size: "M", color: "black" }
  last_search?: string;
  summary?: string;                        // 2-sentence compressed history
  abandoned_cart?: { items: unknown[]; total: number; timestamp: string };
}

// ---------------------------------------------------------------------------
// Pre-turn: fetch customer memory
// ---------------------------------------------------------------------------

/**
 * Read all neonping_chat metafields for a customer.
 * Returns empty CustomerMemory (no throw) for new/anonymous customers.
 */
export async function fetchCustomerMemory(
  shopDomain: string,
  accessToken: string,
  customerId: string,
): Promise<CustomerMemory> {
  if (!customerId) return {};

  try {
    const data = await adminGraphql<{
      customer: {
        metafields: { edges: Array<{ node: { key: string; value: string } }> };
      };
    }>(
      shopDomain,
      accessToken,
      `query GetMemory($id: ID!, $ns: String!) {
        customer(id: $id) {
          metafields(namespace: $ns, first: 10) {
            edges { node { key value } }
          }
        }
      }`,
      { id: customerId, ns: NAMESPACE },
    );

    const fields = data.customer?.metafields?.edges ?? [];
    const memory: CustomerMemory = {};

    for (const { node } of fields) {
      try {
        const parsed = JSON.parse(node.value);
        if (node.key === "preferences") memory.preferences = parsed;
        else if (node.key === "last_search") memory.last_search = parsed;
        else if (node.key === "summary") memory.summary = parsed;
        else if (node.key === "abandoned_cart") memory.abandoned_cart = parsed;
      } catch {
        // Corrupted metafield — skip silently
      }
    }

    return memory;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Post-turn: extract signals and write back
// ---------------------------------------------------------------------------

/**
 * Extract signals from the completed turn and persist to customer metafields.
 * Called async after the response is sent — never blocks the user.
 */
export async function updateCustomerMemory(
  shopDomain: string,
  accessToken: string,
  customerId: string,
  session: ConversationSession,
  lastSearchQuery?: string,
  cartItems?: unknown[],
  cartAbandoned?: boolean,
): Promise<void> {
  if (!customerId) return;

  try {
    const current = await fetchCustomerMemory(shopDomain, accessToken, customerId);
    const updated: CustomerMemory = { ...current };

    if (lastSearchQuery) updated.last_search = lastSearchQuery;

    if (cartItems?.length) {
      updated.preferences = extractPreferences(cartItems, current.preferences);
    }

    if (cartAbandoned && session.cart_id) {
      updated.abandoned_cart = {
        items: cartItems ?? [],
        total: 0,
        timestamp: new Date().toISOString(),
      };
    } else if (!cartAbandoned && session.checkout_id) {
      // Cart converted to checkout — clear abandoned signal
      updated.abandoned_cart = undefined;
    }

    // Summarize when conversation is long enough
    if (
      session.conversation_history.length >= SUMMARIZE_AFTER_TURNS &&
      !isSummaryFresh(updated.summary, session.conversation_history)
    ) {
      updated.summary = await summarize(session.conversation_history).catch(
        () => current.summary,
      );
    }

    await writeMemory(shopDomain, accessToken, customerId, updated);
  } catch {
    // Memory update is best-effort — never throw to caller
  }
}

// ---------------------------------------------------------------------------
// GDPR: wipe all neonping_chat metafields for a customer
// ---------------------------------------------------------------------------

export async function wipeCustomerMemory(
  shopDomain: string,
  accessToken: string,
  customerId: string,
): Promise<void> {
  try {
    // Fetch all metafield IDs in our namespace
    const data = await adminGraphql<{
      customer: {
        metafields: { edges: Array<{ node: { id: string } }> };
      };
    }>(
      shopDomain,
      accessToken,
      `query GetMemoryIds($id: ID!, $ns: String!) {
        customer(id: $id) {
          metafields(namespace: $ns, first: 10) {
            edges { node { id } }
          }
        }
      }`,
      { id: customerId, ns: NAMESPACE },
    );

    const ids = (data.customer?.metafields?.edges ?? []).map((e) => e.node.id);
    for (const id of ids) {
      await adminGraphql(
        shopDomain,
        accessToken,
        `mutation DeleteMetafield($id: ID!) {
          metafieldDelete(input: { id: $id }) {
            userErrors { field message }
          }
        }`,
        { id },
      ).catch(() => null);
    }
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function writeMemory(
  shopDomain: string,
  accessToken: string,
  customerId: string,
  memory: CustomerMemory,
): Promise<void> {
  const entries: Array<{ key: string; value: string }> = [];

  const add = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    const str = JSON.stringify(value);
    if (new TextEncoder().encode(str).length <= MAX_METAFIELD_BYTES) {
      entries.push({ key, value: str });
    }
  };

  add("preferences", memory.preferences);
  add("last_search", memory.last_search);
  add("summary", memory.summary);
  add("abandoned_cart", memory.abandoned_cart);

  if (!entries.length) return;

  await adminGraphql(
    shopDomain,
    accessToken,
    `mutation SetMemory($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`,
    {
      metafields: entries.map((e) => ({
        ownerId: customerId,
        namespace: NAMESPACE,
        key: e.key,
        type: "json",
        value: e.value,
      })),
    },
  );
}

function extractPreferences(
  cartItems: unknown[],
  existing?: Record<string, string>,
): Record<string, string> {
  // Merge existing preferences with signals from cart items.
  // Items are ProductVariant objects — extract option values.
  const prefs: Record<string, string> = { ...existing };
  for (const item of cartItems) {
    const i = item as Record<string, unknown>;
    if (typeof i.size === "string") prefs.size = i.size;
    if (typeof i.color === "string") prefs.color = i.color;
  }
  return prefs;
}

function isSummaryFresh(summary: string | undefined, history: Message[]): boolean {
  // Consider summary fresh if we have one and history hasn't grown much since
  return !!summary && history.length < SUMMARIZE_AFTER_TURNS + 3;
}

async function summarize(history: Message[]): Promise<string> {
  const transcript = history
    .slice(-20)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  return generateSummary(
    "Summarize this shopping conversation in 1-2 sentences. Focus on what the customer bought or was interested in, their preferences, and any patterns. No PII.",
    transcript,
  );
}
