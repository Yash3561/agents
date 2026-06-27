import { adminGraphql } from "~/lib/mcp/admin.server";
import { generateSummary } from "~/lib/llm.server";
import type { ConversationSession, Message } from "~/lib/session.server";
import { redis } from "~/redis.server";

const NAMESPACE = "neonping_chat";
const MAX_METAFIELD_BYTES = 2000;
const SUMMARIZE_AFTER_TURNS = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomerMemory {
  recent_products?: string[];   // e.g. ["Fabric Resistance Bands (Pink)", "Silk Sleep Mask"] — most recent first, capped
  last_search?: string;
  summary?: string;                        // 2-sentence compressed history
  abandoned_cart?: { items: unknown[]; total: number; timestamp: string };
  firstName?: string;           // customer's first name from Shopify profile
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
        firstName: string | null;
        metafields: { edges: Array<{ node: { key: string; value: string } }> };
      };
    }>(
      shopDomain,
      accessToken,
      `query GetMemory($id: ID!, $ns: String!) {
        customer(id: $id) {
          firstName
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
        if (node.key === "recent_products") memory.recent_products = parsed;
        else if (node.key === "last_search") memory.last_search = parsed;
        else if (node.key === "summary") memory.summary = parsed;
        else if (node.key === "abandoned_cart") memory.abandoned_cart = parsed;
      } catch {
        // Corrupted metafield — skip silently
      }
    }

    if (data.customer?.firstName) memory.firstName = data.customer.firstName;

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
  cartLines?: unknown[],
): Promise<void> {
  if (!customerId) return;

  try {
    const current = await fetchCustomerMemory(shopDomain, accessToken, customerId);
    const updated: CustomerMemory = { ...current };

    if (lastSearchQuery) updated.last_search = lastSearchQuery;

    if (cartLines?.length) {
      updated.recent_products = extractRecentProducts(cartLines, current.recent_products);
    }

    if (session.checkout_id) {
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
// Write abandoned_cart signal from checkout webhooks
// ---------------------------------------------------------------------------

/**
 * Persists the abandoned cart signal to the customer metafield.
 * Called from checkouts/create and checkouts/update webhooks.
 * items should use merchandise GID format (gid://shopify/ProductVariant/<id>).
 */
export async function writeAbandonedCart(
  shopDomain: string,
  accessToken: string,
  customerId: string,
  items: Array<{ variantId: string; title: string; quantity: number; priceCents: number }>,
  totalCents: number,
): Promise<void> {
  if (!customerId || !items.length) return;
  try {
    const current = await fetchCustomerMemory(shopDomain, accessToken, customerId);
    const updated: CustomerMemory = {
      ...current,
      abandoned_cart: {
        items: items.map((item) => ({
          merchandise: {
            id: `gid://shopify/ProductVariant/${item.variantId}`,
            title: item.title,
          },
          quantity: item.quantity,
        })),
        total: totalCents,
        timestamp: new Date().toISOString(),
      },
    };
    await writeMemory(shopDomain, accessToken, customerId, updated);
  } catch {
    // Best-effort — never throw to caller
  }
}

// ---------------------------------------------------------------------------
// Clear abandoned_cart signal after successful cart pre-population
// ---------------------------------------------------------------------------

/**
 * Nulls out the abandoned_cart metafield so the recovery greeting
 * doesn't fire again on the customer's next visit.
 * Called fire-and-forget after pre-populating the cart from abandoned_cart.
 */
export async function clearAbandonedCart(
  shopDomain: string,
  accessToken: string,
  customerId: string,
): Promise<void> {
  if (!customerId) return;
  try {
    const current = await fetchCustomerMemory(shopDomain, accessToken, customerId);
    if (!current.abandoned_cart) return; // nothing to clear
    const updated: CustomerMemory = { ...current, abandoned_cart: undefined };
    await writeMemory(shopDomain, accessToken, customerId, updated);
  } catch {
    // Best-effort
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

  add("recent_products", memory.recent_products);
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

const MAX_RECENT_PRODUCTS = 5;

/**
 * Builds a "recently interested in" list from real Shopify cart lines
 * (Cart.lines, see cart.server.ts) — each line's merchandise only exposes
 * a product title and a combined variant title (e.g. "Pink", "Large / Blue"),
 * not separate structured size/color fields, so that's what we track.
 */
function extractRecentProducts(cartLines: unknown[], existing?: string[]): string[] {
  const newLabels: string[] = [];
  for (const line of cartLines) {
    const merchandise = (line as Record<string, unknown>).merchandise as
      | Record<string, unknown>
      | undefined;
    const productTitle = (merchandise?.product as Record<string, unknown> | undefined)
      ?.title as string | undefined;
    if (!productTitle) continue;
    const variantTitle = merchandise?.title as string | undefined;
    const label =
      variantTitle && variantTitle !== "Default Title"
        ? `${productTitle} (${variantTitle})`
        : productTitle;
    if (!newLabels.includes(label)) newLabels.push(label);
  }
  return Array.from(new Set([...newLabels, ...(existing ?? [])])).slice(
    0,
    MAX_RECENT_PRODUCTS,
  );
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

// ---------------------------------------------------------------------------
// WhatsApp memory — Redis-backed, keyed by phone number
// ---------------------------------------------------------------------------

const WA_MEM_TTL = 30 * 24 * 60 * 60; // 30 days in seconds

export async function fetchWhatsAppMemory(phone: string): Promise<CustomerMemory> {
  try {
    const val = await redis.get(`wamem:${phone}`);
    return val ? (JSON.parse(String(val)) as CustomerMemory) : {};
  } catch {
    return {};
  }
}

export async function updateWhatsAppMemory(
  phone: string,
  updates: Partial<CustomerMemory>,
): Promise<void> {
  try {
    const existing = await fetchWhatsAppMemory(phone);
    const merged = { ...existing, ...updates };
    if (merged.recent_products) {
      merged.recent_products = merged.recent_products.slice(0, 5);
    }
    await redis.setex(`wamem:${phone}`, WA_MEM_TTL, JSON.stringify(merged));
  } catch {
    // ponytail: fails open — never block the agent on memory writes
  }
}
