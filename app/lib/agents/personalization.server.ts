import { adminGraphql } from "~/lib/mcp/admin.server";
import {
  assertDiscountNotApplied,
  GuardrailError,
} from "~/lib/guardrails.server";
import type { ConversationSession } from "~/lib/session.server";
import type { CustomerMemory } from "~/lib/agents/memory.server";
import type { Merchant } from "@prisma/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiscountEntry {
  code: string;
  label: string;
  eligibility: "vip" | "loyalty" | "cart" | "any";
}

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export interface PersonalizationAgentOutput {
  text: string | null;         // null = no discount offered (caller skips this turn)
  discountCode?: string;
  toolsCalled: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseAllowedDiscounts(raw: string): DiscountEntry[] {
  if (!raw || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as DiscountEntry[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Agent (deterministic logic — no LLM needed here)
// ---------------------------------------------------------------------------

export async function runPersonalizationAgent(opts: {
  shopDomain: string;
  accessToken: string;
  customerId?: string;
  session: ConversationSession;
  merchant: Merchant;
  memory: CustomerMemory;
  cartTotalCents?: number;
}): Promise<PersonalizationAgentOutput> {
  const { shopDomain, accessToken, customerId, session, merchant, memory, cartTotalCents } = opts;

  const toolsCalled: string[] = [];

  // Merchant has personalization disabled entirely
  if (!merchant.personalizationEnabled) return { text: null, toolsCalled };

  // Guard: one discount per conversation
  try {
    assertDiscountNotApplied(session);
  } catch (err) {
    if (err instanceof GuardrailError) return { text: null, toolsCalled };
    throw err;
  }

  // No customer ID = no personalization possible
  if (!customerId) return { text: null, toolsCalled };

  // Parse merchant-configured discount codes
  const allowedCodes = parseAllowedDiscounts(merchant.allowedDiscountCodes);

  try {
    // Fetch customer tags and order count
    toolsCalled.push("admin_graphql:customer_tags");
    const data = await adminGraphql<{
      customer: { tags: string[]; numberOfOrders: number };
    }>(
      shopDomain,
      accessToken,
      `query GetCustomerSignals($id: ID!) {
        customer(id: $id) {
          tags
          numberOfOrders
        }
      }`,
      { id: customerId },
    );

    const { tags, numberOfOrders } = data.customer;

    // Determine eligibility tiers (priority order: vip → loyalty → cart → any)
    const isVip = tags.includes("VIP");
    const isLoyal = numberOfOrders >= 3;
    const hasLargeCart = Boolean(cartTotalCents && cartTotalCents >= merchant.vipCartThreshold);

    // Find a matching pre-configured discount code in priority order
    const eligibilityOrder: Array<DiscountEntry["eligibility"]> = ["vip", "loyalty", "cart", "any"];

    let matchedEntry: DiscountEntry | undefined;

    for (const tier of eligibilityOrder) {
      // Check if the customer qualifies for this tier
      if (tier === "vip" && !isVip) continue;
      if (tier === "loyalty" && !isLoyal) continue;
      if (tier === "cart" && !hasLargeCart) continue;
      // "any" always qualifies (if we reach it)

      matchedEntry = allowedCodes.find((e) => e.eligibility === tier);
      if (matchedEntry) break;
    }

    if (matchedEntry) {
      return {
        text: `Here's a discount code for you: **${matchedEntry.code}**${matchedEntry.label ? ` — ${matchedEntry.label}` : ""}.`,
        discountCode: matchedEntry.code,
        toolsCalled,
      };
    }

    // No matching configured code — fall back to abandoned cart nudge if applicable
    if (memory.abandoned_cart) {
      return {
        text: `Still thinking about what you had in your cart? I can add those items back for you.`,
        toolsCalled,
      };
    }

    return { text: null, toolsCalled };
  } catch {
    // Admin MCP failure → skip silently (personalization is enhancement, not core)
    return { text: null, toolsCalled };
  }
}
