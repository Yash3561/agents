import { tool } from "ai";
import { z } from "zod";
import { deployments, runAgentStream } from "~/lib/llm.server";
import { buildSupportPrompt } from "~/lib/prompt.server";
import { searchPoliciesAndFaqs } from "~/lib/mcp/policy.server";
import { getOrder } from "~/lib/mcp/order.server";
import { getCustomerOrders } from "~/lib/mcp/customer-accounts.server";
import type { ConversationSession } from "~/lib/session.server";
import type { Merchant } from "@prisma/client";

export interface SupportAgentOutput {
  text: string;
  escalate_to_human?: boolean;
  toolsCalled: string[];
}

export async function runSupportAgent(opts: {
  shopDomain: string;
  contextForSpecialist: string;
  session: ConversationSession;
  merchant: Merchant;
  customerAccessToken?: string;
}): Promise<SupportAgentOutput> {
  const { shopDomain, contextForSpecialist, merchant, customerAccessToken } = opts;

  const toolsCalled: string[] = [];
  let escalate = false;

  const tools = {
    search_policies_and_faqs: tool({
      description: "Search the merchant's shop policies and FAQs",
      inputSchema: z.object({
        query: z.string(),
        context: z.string().optional(),
      }),
      execute: async (input) => {
        toolsCalled.push("search_policies_and_faqs");
        const result = await searchPoliciesAndFaqs(shopDomain, input.query, input.context);
        if (!result) return { text: null, message: "No policy found for that query." };
        return result;
      },
    }),

    get_order: tool({
      description: "Look up an order by ID for status and tracking",
      inputSchema: z.object({ orderId: z.string() }),
      execute: async (input) => {
        toolsCalled.push("get_order");
        try {
          return await getOrder(shopDomain, input.orderId);
        } catch {
          escalate = true;
          return {
            error: "Order not found",
            message: "Please contact support for assistance with this order.",
          };
        }
      },
    }),

    get_customer_orders: tool({
      description: "Get order history for the logged-in customer",
      inputSchema: z.object({}),
      execute: async () => {
        toolsCalled.push("get_customer_orders");
        if (!customerAccessToken) return { error: "Customer not logged in", orders: [] };
        try {
          return { orders: await getCustomerOrders(shopDomain, customerAccessToken) };
        } catch {
          return { error: "Could not load orders", orders: [] };
        }
      },
    }),
  };

  const stream = runAgentStream({
    deployment: deployments.support(),
    system: buildSupportPrompt(merchant),
    messages: [{ role: "user", content: contextForSpecialist }],
    tools,
    maxOutputTokens: 600,
    maxSteps: 3,
  });

  let text = "";
  try {
    text = await (await stream).text;
  } catch {
    text = "I'm having trouble accessing that information right now. Please try again shortly.";
    escalate = true;
  }

  return { text, escalate_to_human: escalate || undefined, toolsCalled };
}
