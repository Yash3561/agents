import { getActiveDiscounts } from "~/lib/mcp/discounts.server";
import {
  assertDiscountNotApplied,
  GuardrailError,
} from "~/lib/guardrails.server";
import type { ConversationSession } from "~/lib/session.server";
import type { CustomerMemory } from "~/lib/agents/memory.server";
import type { Merchant } from "@prisma/client";

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export interface PersonalizationAgentOutput {
  text: string | null; // null = no discount offered (caller skips this turn)
  discountCode?: string;
  toolsCalled: string[];
}

// ---------------------------------------------------------------------------
// Intent detection — does the current message ask for a discount?
// ---------------------------------------------------------------------------

const DISCOUNT_INTENT_WORDS = [
  "discount",
  "promo",
  "coupon",
  "code",
  "offer",
  "deal",
  "save",
];

function customerAskedForDiscount(message: string): boolean {
  const lower = message.toLowerCase();
  return DISCOUNT_INTENT_WORDS.some((word) => lower.includes(word));
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
  currentMessage: string;
}): Promise<PersonalizationAgentOutput> {
  const { shopDomain, accessToken, session, merchant, memory, currentMessage } =
    opts;

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

  // Fetch live active discount codes from the merchant's Shopify store
  toolsCalled.push("admin_graphql:code_discount_nodes");
  const discounts = await getActiveDiscounts(shopDomain, accessToken);

  // No discounts configured → nothing to offer
  if (discounts.length === 0) return { text: null, toolsCalled };

  const first = discounts[0];

  // Case 1: Abandoned cart recovery — nudge customer back with a discount
  if (memory.abandoned_cart) {
    return {
      text: `Still thinking about what you had in your cart? Use code **${first.code}** at checkout — ${first.summary}. I can add those items back for you!`,
      discountCode: first.code,
      toolsCalled,
    };
  }

  // Case 2: Customer explicitly asked for a discount/promo
  if (customerAskedForDiscount(currentMessage)) {
    return {
      text: `Here's a discount code for you: **${first.code}** — ${first.summary}.`,
      discountCode: first.code,
      toolsCalled,
    };
  }

  // Otherwise — no unsolicited discounts
  return { text: null, toolsCalled };
}
