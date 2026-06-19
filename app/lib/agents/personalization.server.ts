import { z } from "zod";
import { generateStructured, deployments } from "~/lib/llm.server";
import { getActiveDiscounts } from "~/lib/mcp/discounts.server";
import { buildPersonalizationPrompt } from "~/lib/prompt.server";
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

const NegotiationSchema = z.object({
  shouldOffer: z.boolean(),
  chosenCode: z.string().nullable(),
  negotiationStance: z.enum(["firm", "generous", "final"]),
  message: z.string(),
});

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
  const { shopDomain, accessToken, session, merchant, memory, currentMessage, cartTotalCents } = opts;
  const toolsCalled: string[] = [];

  if (!merchant.personalizationEnabled) return { text: null, toolsCalled };

  // Hard guardrail: cap at 3 offers per conversation
  try {
    assertDiscountNegotiationAllowed(session);
  } catch (err) {
    if (err instanceof GuardrailError) {
      // Cap reached — if still pushing back, acknowledge gracefully with last offered code
      const { offered_codes } = session.discount_negotiation;
      if (offered_codes.length > 0) {
        const lastCode = offered_codes[offered_codes.length - 1];
        return {
          text: `I've shared everything I have — **${lastCode}** is genuinely our best offer right now. I'd hate to see you miss out!`,
          toolsCalled,
        };
      }
      return { text: null, toolsCalled };
    }
    throw err;
  }

  // Fetch live active discount codes from Shopify
  toolsCalled.push("admin_graphql:code_discount_nodes");
  const discounts = await getActiveDiscounts(shopDomain, accessToken);

  if (discounts.length === 0) return { text: null, toolsCalled };

  const { offered_codes, level } = session.discount_negotiation;

  // Format recent conversation history (last 6 turns) for LLM context
  const recentHistory = session.conversation_history
    .slice(-6)
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  // Build system prompt with full context
  const systemPrompt = buildPersonalizationPrompt({
    shopDomain,
    brandVoice: merchant.brandVoice,
    availableCodes: discounts,
    cartTotalCents: cartTotalCents ?? 0,
    offeredCodes: offered_codes,
    negotiationLevel: level,
    memory,
    recentHistory,
  });

  // LLM makes the decision
  toolsCalled.push("llm:negotiation_decision");
  let decision: z.infer<typeof NegotiationSchema>;
  try {
    decision = await generateStructured({
      deployment: deployments.personalize(),
      system: systemPrompt,
      prompt: `Current customer message: "${currentMessage}"\n\nDecide whether to offer a discount, which code, and write the response message.`,
      schema: NegotiationSchema,
      maxOutputTokens: 200,
    });
  } catch {
    return { text: null, toolsCalled };
  }

  if (!decision.shouldOffer || !decision.chosenCode) return { text: null, toolsCalled };

  // Hard guardrail: LLM must pick a real code that hasn't been offered yet
  const validCode = discounts.find(
    d => d.code === decision.chosenCode && !offered_codes.includes(d.code)
  );
  if (!validCode) return { text: null, toolsCalled };

  return {
    text: decision.message,
    discountCode: validCode.code,
    toolsCalled,
  };
}
