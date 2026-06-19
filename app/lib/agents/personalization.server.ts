import { getActiveDiscounts, type ActiveDiscount } from "~/lib/mcp/discounts.server";
import {
  assertDiscountNegotiationAllowed,
  GuardrailError,
} from "~/lib/guardrails.server";
import type { ConversationSession } from "~/lib/session.server";
import type { CustomerMemory } from "~/lib/agents/memory.server";
import type { Merchant } from "@prisma/client";

export interface PersonalizationAgentOutput {
  text: string | null;
  discountCode?: string;
  toolsCalled: string[];
}

// Words that signal the customer wants a better deal than what was offered
const RESISTANCE_WORDS = [
  "more", "better", "higher", "bigger", "extra", "additional",
  "increase", "less", "another", "improve", "beat", "match",
  "anything else", "best you can", "best deal", "lower price",
  "cheaper", "not enough", "not much", "that's it",
];

function detectResistance(message: string): boolean {
  const lower = message.toLowerCase();
  return RESISTANCE_WORDS.some((w) => lower.includes(w));
}

const DISCOUNT_REQUEST_WORDS = [
  "discount", "promo", "coupon", "code", "offer",
  "deal", "save", "promotion", "voucher",
];

function customerAskedForDiscount(message: string): boolean {
  const lower = message.toLowerCase();
  return DISCOUNT_REQUEST_WORDS.some((w) => lower.includes(w));
}

function pickDiscount(
  discounts: ActiveDiscount[],
  level: number,
  offeredCodes: string[],
): ActiveDiscount | null {
  // Filter out codes we've already mentioned
  const fresh = discounts.filter((d) => !offeredCodes.includes(d.code));
  if (fresh.length === 0) return null;

  // Clamp level to available fresh discounts
  const idx = Math.min(level, fresh.length - 1);
  return fresh[idx];
}

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
  const { shopDomain, accessToken, session, merchant, memory, currentMessage } = opts;
  const toolsCalled: string[] = [];

  if (!merchant.personalizationEnabled) return { text: null, toolsCalled };

  // Guard: max offers per conversation
  try {
    assertDiscountNegotiationAllowed(session);
  } catch (err) {
    if (err instanceof GuardrailError) {
      // We've hit the cap — if customer is still pushing back, acknowledge gracefully
      if (detectResistance(currentMessage) && session.discount_negotiation.offered_codes.length > 0) {
        const lastCode = session.discount_negotiation.offered_codes[session.discount_negotiation.offered_codes.length - 1];
        return {
          text: `I've shared all the discounts I have available — the best I can offer is **${lastCode}**. That's our top deal right now!`,
          toolsCalled,
        };
      }
      return { text: null, toolsCalled };
    }
    throw err;
  }

  toolsCalled.push("admin_graphql:code_discount_nodes");
  const discounts = await getActiveDiscounts(shopDomain, accessToken);
  if (discounts.length === 0) return { text: null, toolsCalled };

  const { offered_codes, level } = session.discount_negotiation;
  const hasOfferedBefore = offered_codes.length > 0;

  // Determine situation
  const isAbandonedCart = Boolean(memory.abandoned_cart);
  const isResisting = hasOfferedBefore && detectResistance(currentMessage);
  const isAsking = customerAskedForDiscount(currentMessage);

  // Decide what level to offer at
  let offerLevel: number;

  if (isAbandonedCart && !hasOfferedBefore) {
    // Abandoned cart: start at level 1 (mid-tier) — customer is already leaving,
    // bottom-tier may not be compelling enough to recover the cart
    offerLevel = Math.min(1, discounts.length - 1);
  } else if (isResisting) {
    // Customer pushed back — escalate one level
    offerLevel = level; // level already incremented on the previous turn
  } else if (isAsking || isAbandonedCart) {
    offerLevel = level;
  } else {
    // Not asking, not resisting, not abandoned cart → don't offer
    return { text: null, toolsCalled };
  }

  const chosen = pickDiscount(discounts, offerLevel, offered_codes);
  if (!chosen) {
    // All codes already offered
    if (hasOfferedBefore) {
      return {
        text: `I've already shared all the discounts I have — use **${offered_codes[offered_codes.length - 1]}** for the best deal available!`,
        toolsCalled,
      };
    }
    return { text: null, toolsCalled };
  }

  // Build message based on situation
  let text: string;
  if (isAbandonedCart) {
    text = `Still thinking about your cart? Here's a little nudge — use **${chosen.code}** at checkout for ${chosen.summary}. Want me to add those items back?`;
  } else if (isResisting && hasOfferedBefore) {
    const prevCode = offered_codes[offered_codes.length - 1];
    text = `I hear you — let me do better. Use **${chosen.code}** for ${chosen.summary}. That's a step up from ${prevCode}!`;
  } else {
    text = `Here's a discount for you: **${chosen.code}** — ${chosen.summary}.`;
  }

  return { text, discountCode: chosen.code, toolsCalled };
}
