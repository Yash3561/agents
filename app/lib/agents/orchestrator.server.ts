import { z } from "zod";
import { generateStructured, deployments } from "~/lib/llm.server";
import { buildOrchestratorPrompt } from "~/lib/prompt.server";
import { assertHopBudget, GuardrailError } from "~/lib/guardrails.server";
import { runShoppingAgent } from "~/lib/agents/shopping.server";
import { runSupportAgent } from "~/lib/agents/support.server";
import { runPersonalizationAgent } from "~/lib/agents/personalization.server";
import type { ConversationSession } from "~/lib/session.server";
import type { CustomerMemory } from "~/lib/agents/memory.server";
import type { Merchant } from "@prisma/client";

// ---------------------------------------------------------------------------
// Orchestrator structured output schema
// ---------------------------------------------------------------------------

const OrchestratorSchema = z.object({
  route: z.enum(["shopping", "support", "personalization", "direct"]),
  route_reason: z.string(),
  context_for_specialist: z.string(),
  buyer_confirmed: z.boolean(),
  confidence: z.number().min(0).max(1),
  direct_response: z.string().nullable(),
});

type OrchestratorOutput = z.infer<typeof OrchestratorSchema>;

// ---------------------------------------------------------------------------
// Final outbound message type (channel-agnostic)
// ---------------------------------------------------------------------------

export interface OutboundMessage {
  text: string;
  products?: unknown[];
  cart?: unknown;
  checkout_url?: string;
  discount_code?: string;
  quick_replies?: string[];
  confidence: number;
  escalate_to_human?: boolean;
  agent_trace: string[];
}

// ---------------------------------------------------------------------------
// Main orchestrator function — called once per conversation turn
// ---------------------------------------------------------------------------

export async function runOrchestrator(opts: {
  shopDomain: string;
  currentMessage: string;
  session: ConversationSession;
  merchant: Merchant;
  memory: CustomerMemory;
  accessToken: string;
  customerId?: string;
  customerAccessToken?: string;
  cartTotalCents?: number;
}): Promise<OutboundMessage> {
  const {
    shopDomain,
    currentMessage,
    session,
    merchant,
    memory,
    accessToken,
    customerId,
    customerAccessToken,
    cartTotalCents,
  } = opts;

  const agentTrace: string[] = [];

  // Build the full conversation prompt for the orchestrator
  const systemPrompt = buildOrchestratorPrompt(merchant, session, memory);
  const userPrompt = formatConversationForOrchestrator(
    session,
    currentMessage,
  );

  // Step 1: Orchestrator classifies intent
  let routing: OrchestratorOutput;
  try {
    routing = await generateStructured({
      deployment: deployments.orchestrator(),
      system: systemPrompt,
      prompt: userPrompt,
      schema: OrchestratorSchema,
      maxOutputTokens: 500,
    });
  } catch (err) {
    console.error("[orchestrator] generateStructured failed:", err);
    return fallbackResponse(agentTrace);
  }

  agentTrace.push(`orchestrator:${routing.route}`);

  // Low confidence → ask to rephrase (no specialist call)
  if (routing.confidence < 0.6) {
    return {
      text: routing.direct_response ?? "I'm not sure I understood that — could you rephrase?",
      confidence: routing.confidence,
      quick_replies: ["Search products", "Check order", "Return policy"],
      agent_trace: agentTrace,
    };
  }

  // Direct response (greeting, off-topic)
  if (routing.route === "direct") {
    return {
      text: routing.direct_response ?? "How can I help you today?",
      confidence: routing.confidence,
      quick_replies: ["Browse products", "Track order", "Return policy"],
      agent_trace: agentTrace,
    };
  }

  // Check hop budget before calling specialist
  try {
    assertHopBudget(session);
  } catch (err) {
    if (err instanceof GuardrailError) {
      return {
        text: `I'm having trouble completing that request. You can browse directly at https://${shopDomain}.`,
        confidence: 0,
        agent_trace: agentTrace,
      };
    }
    throw err;
  }

  // Increment hop count in the session snapshot passed to specialists
  const sessionWithHop: ConversationSession = {
    ...session,
    hop_count: session.hop_count + 1,
    agent_calls: [...session.agent_calls, routing.route],
  };

  // Step 2: Run the specialist
  let result: OutboundMessage;

  switch (routing.route) {
    case "shopping": {
      agentTrace.push("shopping");
      const out = await runShoppingAgent({
        shopDomain,
        contextForSpecialist: routing.context_for_specialist,
        session: sessionWithHop,
        merchant,
        memory,
        buyerConfirmed: routing.buyer_confirmed,
      });
      result = {
        text: out.text,
        products: out.products,
        cart: out.cart,
        checkout_url: out.checkoutUrl,
        confidence: routing.confidence,
        agent_trace: [...agentTrace, ...out.toolsCalled],
      };
      break;
    }

    case "support": {
      agentTrace.push("support");
      const out = await runSupportAgent({
        shopDomain,
        contextForSpecialist: routing.context_for_specialist,
        session: sessionWithHop,
        merchant,
        customerAccessToken,
      });
      result = {
        text: out.text,
        escalate_to_human: out.escalate_to_human,
        confidence: routing.confidence,
        agent_trace: [...agentTrace, ...out.toolsCalled],
      };
      break;
    }

    case "personalization": {
      agentTrace.push("personalization");
      const out = await runPersonalizationAgent({
        shopDomain,
        accessToken,
        customerId,
        session: sessionWithHop,
        merchant,
        memory,
        cartTotalCents,
      });
      // If no discount was surfaced, fall through to shopping for context
      if (!out.text) {
        const shopOut = await runShoppingAgent({
          shopDomain,
          contextForSpecialist: routing.context_for_specialist,
          session: sessionWithHop,
          merchant,
          memory,
          buyerConfirmed: routing.buyer_confirmed,
        });
        result = {
          text: shopOut.text,
          products: shopOut.products,
          cart: shopOut.cart,
          checkout_url: shopOut.checkoutUrl,
          confidence: routing.confidence,
          agent_trace: [...agentTrace, ...out.toolsCalled, ...shopOut.toolsCalled],
        };
      } else {
        result = {
          text: out.text,
          discount_code: out.discountCode,
          confidence: routing.confidence,
          agent_trace: [...agentTrace, ...out.toolsCalled],
        };
      }
      break;
    }

    default:
      result = fallbackResponse(agentTrace);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatConversationForOrchestrator(
  session: ConversationSession,
  currentMessage: string,
): string {
  const history = session.conversation_history
    .slice(-10) // last 10 turns for context
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  return history
    ? `${history}\nUSER: ${currentMessage}`
    : `USER: ${currentMessage}`;
}

function fallbackResponse(agentTrace: string[]): OutboundMessage {
  return {
    text: "I'm having a little trouble right now. Please try again in a moment or browse our store directly.",
    confidence: 0,
    agent_trace: agentTrace,
  };
}
