import { getActiveDiscounts } from "~/lib/mcp/discounts.server";
import type { ActiveDiscount } from "~/lib/mcp/discounts.server";
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
// Smart discount selection
// ---------------------------------------------------------------------------

type Situation = "abandoned_cart" | "asked_for_discount";

function pickBestDiscount(
  discounts: ActiveDiscount[],
  situation: Situation,
): ActiveDiscount {
  // For abandoned cart: free shipping is the #1 checkout barrier remover — prefer it
  // Then fall back to highest-value % off (most motivating to complete purchase)
  // Then fixed amount, then anything else
  if (situation === "abandoned_cart") {
    const freeShipping = discounts.find((d) => d.type === "free_shipping");
    if (freeShipping) return freeShipping;

    const percentages = discounts
      .filter((d) => d.type === "percentage")
      .sort((a, b) => b.value - a.value);
    if (percentages.length > 0) return percentages[0];

    const fixed = discounts
      .filter((d) => d.type === "fixed_amount")
      .sort((a, b) => b.value - a.value);
    if (fixed.length > 0) return fixed[0];

    return discounts[0];
  }

  // For direct ask ("do you have a discount?"): customer wants the best deal
  // Prefer highest % off (feels most rewarding), then fixed amount (concrete saving),
  // then free shipping, then anything
  const percentages = discounts
    .filter((d) => d.type === "percentage")
    .sort((a, b) => b.value - a.value);
  if (percentages.length > 0) return percentages[0];

  const fixed = discounts
    .filter((d) => d.type === "fixed_amount")
    .sort((a, b) => b.value - a.value);
  if (fixed.length > 0) return fixed[0];

  const freeShipping = discounts.find((d) => d.type === "free_shipping");
  if (freeShipping) return freeShipping;

  return discounts[0];
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

  // Case 1: Abandoned cart recovery — nudge customer back with a discount
  if (memory.abandoned_cart) {
    const best = pickBestDiscount(discounts, "abandoned_cart");
    return {
      text: `Still thinking about what you had in your cart? Use code **${best.code}** at checkout — ${best.summary}. I can add those items back for you!`,
      discountCode: best.code,
      toolsCalled,
    };
  }

  // Case 2: Customer explicitly asked for a discount/promo
  if (customerAskedForDiscount(currentMessage)) {
    const best = pickBestDiscount(discounts, "asked_for_discount");
    return {
      text: `Here's a discount code for you: **${best.code}** — ${best.summary}.`,
      discountCode: best.code,
      toolsCalled,
    };
  }

  // Otherwise — no unsolicited discounts
  return { text: null, toolsCalled };
}
