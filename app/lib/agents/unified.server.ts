/**
 * Unified agent — replaces the orchestrator + 3 specialist agents with a
 * single gpt-4o-mini call that has all tools available and picks the right
 * ones itself. Eliminates the extra LLM hop (500ms–1s) with no loss of
 * capability since the specialists never ran in parallel anyway.
 */

import { tool } from "ai";
import { z } from "zod";
import { deployments, runAgentStream } from "~/lib/llm.server";
import {
  buildShoppingPrompt,
  buildSupportPrompt,
  type CustomerMemory,
} from "~/lib/prompt.server";
import { assertCartNotEmpty, assertDiscountNegotiationAllowed } from "~/lib/guardrails.server";
import { searchCatalog, getProduct, lookupCatalog } from "~/lib/mcp/catalog.server";
import { createCart, getCart, updateCart } from "~/lib/mcp/cart.server";
import { checkoutFromCart } from "~/lib/mcp/checkout.server";
import { searchPoliciesAndFaqs } from "~/lib/mcp/policy.server";
import { getOrder } from "~/lib/mcp/order.server";
import { getCustomerOrders } from "~/lib/mcp/customer-accounts.server";
import { getActiveDiscounts } from "~/lib/mcp/discounts.server";
import type { ConversationSession } from "~/lib/session.server";
import type { Merchant } from "@prisma/client";

// ---------------------------------------------------------------------------
// Output type (same shape as OutboundMessage in orchestrator.server.ts)
// ---------------------------------------------------------------------------

export interface UnifiedAgentOutput {
  text: string;
  products?: unknown[];
  cart?: unknown;
  checkout_url?: string;
  discount_code?: string;
  quick_replies?: string[];
  escalate_to_human?: boolean;
  agent_trace: string[];
  last_search_query?: string;
  route_reason?: string;
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildUnifiedPrompt(
  merchant: Merchant,
  session: ConversationSession,
  memory: CustomerMemory,
  discountOfferCount: number,
  discountsRemaining: number,
  availableDiscounts: Array<{ code: string; summary: string; type: string; value: number }>,
  offeredCodes: string[],
  cartTotalCents: number,
): string {
  const shoppingPart = buildShoppingPrompt(merchant, session, memory);
  const supportPart = buildSupportPrompt(merchant);

  const cartDollars = (cartTotalCents / 100).toFixed(2);
  const freshCodes = availableDiscounts.filter((c) => !offeredCodes.includes(c.code));
  const codesStr = freshCodes
    .map((c, i) => `[${i}] code="${c.code}" type=${c.type} value=${c.value} summary="${c.summary}"`)
    .join("\n");
  const alreadyOffered =
    offeredCodes.length > 0
      ? `Already offered this conversation (do NOT offer again): ${offeredCodes.join(", ")}`
      : "No codes offered yet this conversation.";

  const discountSection =
    merchant.personalizationEnabled && freshCodes.length > 0
      ? `
## DISCOUNT / PERSONALIZATION
You may offer a discount code ONLY if discount_offers_remaining > 0.
discount_offers_remaining: ${discountsRemaining} (total offered so far: ${discountOfferCount}/3)
Cart total: $${cartDollars}
${alreadyOffered}

AVAILABLE DISCOUNT CODES (sorted cheapest → most generous):
${codesStr}

DISCOUNT RULES:
- Only offer when customer signals real intent (not casual browsing)
- Choose code that makes business sense: cart > $80 + strong intent → be generous; cart < $20 → start lowest
- Never volunteer a code unprompted unless the customer mentions "discount", "promo", "code", "deal", "offer", "save", "voucher", or is abandoning cart
- When you decide to offer a code, call the offer_discount tool with the chosen code and your message — do NOT just mention the code in free text. The tool call is how you formally offer a discount.
- After offer_discount returns success, you may confirm naturally in your reply text (e.g. "Here's a code for you!") but do NOT repeat the code string in your reply text — the UI surfaces it from the tool result.`
      : "";

  return `${shoppingPart}

---

## SUPPORT CAPABILITIES
${supportPart}

---

## ROUTING GUIDANCE
You handle shopping, support, AND personalization yourself — pick the right tools.
- Shopping: search_catalog, get_product, lookup_catalog, create_cart, get_cart, update_cart, get_checkout_url
- Support: search_policies_and_faqs, get_order, get_customer_orders (READ-ONLY — never modify orders)
- Greetings/small talk/off-topic: respond directly without calling any tool
- If intent is unclear (confidence < 0.6): ask the customer to rephrase; offer quick options
${discountSection}`;
}

// ---------------------------------------------------------------------------
// Main unified agent function
// ---------------------------------------------------------------------------

export async function runUnifiedAgent(opts: {
  shopDomain: string;
  agentMessage: string; // clean user message (cart actions are handled before this is called)
  session: ConversationSession;
  merchant: Merchant;
  memory: CustomerMemory;
  accessToken: string;
  customerId?: string;
  customerAccessToken?: string;
  cartTotalCents?: number;
}): Promise<UnifiedAgentOutput> {
  const {
    shopDomain,
    agentMessage,
    session,
    merchant,
    memory,
    accessToken,
    customerAccessToken,
    cartTotalCents = 0,
  } = opts;

  const agentTrace: string[] = ["unified"];
  const toolsCalled: string[] = [];
  let products: unknown[] | undefined;
  let cart: unknown | undefined;
  let checkoutUrl: string | undefined;
  let lastSearchQuery: string | undefined;
  let discountCode: string | undefined;
  let escalateToHuman = false;

  // Discount state from session
  const { offered_codes, level: discountLevel } = session.discount_negotiation;
  const discountsRemaining = Math.max(0, 3 - discountLevel);

  // Fetch active discounts upfront (cheap, cached by Shopify CDN usually)
  const availableDiscounts =
    merchant.personalizationEnabled && discountsRemaining > 0
      ? await getActiveDiscounts(shopDomain, accessToken)
      : [];

  // Build combined system prompt
  const systemPrompt = buildUnifiedPrompt(
    merchant,
    session,
    memory,
    discountLevel,
    discountsRemaining,
    availableDiscounts,
    offered_codes,
    cartTotalCents,
  );

  // Build conversation messages (last 10 turns + current)
  const history = session.conversation_history
    .slice(-10)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...history,
    { role: "user", content: agentMessage },
  ];

  // ---------------------------------------------------------------------------
  // Tool definitions
  // ---------------------------------------------------------------------------

  const tools = {
    // -- Shopping tools --
    search_catalog: tool({
      description:
        "Search the merchant catalog. Always pass intent (the customer's real underlying need) alongside query, and maxPriceCents whenever a budget was mentioned.",
      inputSchema: z.object({
        query: z.string(),
        maxPriceCents: z.number().optional(),
        currency: z.string().optional(),
        intent: z.string().optional(),
        maxResults: z.number().min(1).max(3).optional(),
      }),
      execute: async (input) => {
        toolsCalled.push("search_catalog");
        if (input.query) lastSearchQuery = input.query;
        const result = await searchCatalog(shopDomain, input.query, {
          maxPriceCents: input.maxPriceCents,
          currency: input.currency,
          intent: input.intent,
        });
        const sliced = input.maxResults ? result.products.slice(0, input.maxResults) : result.products;
        products = sliced;
        return { ...result, products: sliced, total: sliced.length };
      },
    }),

    lookup_catalog: tool({
      description: "Look up specific product variants by GID",
      inputSchema: z.object({ ids: z.array(z.string()) }),
      execute: async (input) => {
        toolsCalled.push("lookup_catalog");
        return lookupCatalog(shopDomain, input.ids);
      },
    }),

    get_product: tool({
      description: "Get full product details including all variants",
      inputSchema: z.object({
        productId: z.string(),
        selectedOptions: z
          .array(z.object({ name: z.string(), label: z.string() }))
          .optional(),
      }),
      execute: async (input) => {
        toolsCalled.push("get_product");
        return getProduct(shopDomain, input.productId, input.selectedOptions);
      },
    }),

    create_cart: tool({
      description: "Create a new cart with the given line items",
      inputSchema: z.object({
        lineItems: z.array(
          z.object({
            item: z.object({ id: z.string() }),
            quantity: z.number(),
          }),
        ),
        currency: z.string().optional(),
      }),
      execute: async (input) => {
        assertCartNotEmpty(input.lineItems);
        toolsCalled.push("create_cart");
        const result = await createCart(shopDomain, input.lineItems, {
          currency: input.currency,
        });
        cart = result;
        checkoutUrl = result.checkoutUrl;
        return result;
      },
    }),

    get_cart: tool({
      description: "Fetch current cart state",
      inputSchema: z.object({ cartId: z.string() }),
      execute: async (input) => {
        toolsCalled.push("get_cart");
        const result = await getCart(shopDomain, input.cartId);
        cart = result;
        checkoutUrl = result.checkoutUrl;
        return result;
      },
    }),

    update_cart: tool({
      description:
        "Add or update items in the cart, or apply a discount/gift card code the customer mentioned having. Use add[] for new variants, update[] to change quantities (quantity 0 removes), discountCodes/giftCardCodes when the customer offers a code.",
      inputSchema: z.object({
        cartId: z.string(),
        add: z
          .array(z.object({ product_variant_id: z.string(), quantity: z.number() }))
          .optional(),
        update: z
          .array(z.object({ id: z.string(), quantity: z.number() }))
          .optional(),
        discountCodes: z.array(z.string()).optional(),
        giftCardCodes: z.array(z.string()).optional(),
      }),
      execute: async (input) => {
        toolsCalled.push("update_cart");
        const result = await updateCart(shopDomain, input.cartId, {
          add: input.add,
          update: input.update,
          discountCodes: input.discountCodes,
          giftCardCodes: input.giftCardCodes,
        });
        cart = result;
        checkoutUrl = result.checkoutUrl;
        return result;
      },
    }),

    get_checkout_url: tool({
      description: "Get the checkout URL for a cart so the buyer can complete their purchase.",
      inputSchema: z.object({ cartId: z.string() }),
      execute: async (input) => {
        toolsCalled.push("get_checkout_url");
        const cartData = await getCart(shopDomain, input.cartId);
        const checkout = checkoutFromCart(cartData);
        checkoutUrl = checkout.continue_url;
        cart = cartData;
        return checkout;
      },
    }),

    // -- Support tools --
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
          escalateToHuman = true;
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

    // -- Discount tool --
    offer_discount: tool({
      description:
        "Call this tool when you decide to offer a discount code to the customer. Only call it when: (1) discount_offers_remaining > 0, (2) the customer has shown real buying intent or asked about discounts/deals, (3) the chosen code has not been offered yet this conversation. Do NOT call this tool for casual browsers or just to be nice.",
      inputSchema: z.object({
        code: z.string().describe("The exact discount code string to offer"),
        negotiationStance: z
          .enum(["firm", "generous", "final"])
          .describe(
            "firm=starting low testing acceptance, generous=proactively giving a better deal, final=genuinely last/best offer",
          ),
        message: z.string().describe("The natural language message to show the customer when offering this code. Must sound human, vary phrasing, reference context."),
      }),
      execute: async (input) => {
        toolsCalled.push("offer_discount");
        // Enforce centralized guardrail — throws GuardrailError if cap (3) reached
        assertDiscountNegotiationAllowed(session);
        // Validate the code is in our available list and not already offered
        const isValid = availableDiscounts.some((d) => d.code === input.code);
        const alreadyOffered = offered_codes.includes(input.code);
        if (!isValid || alreadyOffered) {
          return { error: "Code not available or already offered" };
        }
        discountCode = input.code;
        return { success: true, code: input.code, stance: input.negotiationStance };
      },
    }),
  };

  // ---------------------------------------------------------------------------
  // Run
  // ---------------------------------------------------------------------------

  const stream = runAgentStream({
    deployment: deployments.shopping(), // gpt-4o-mini, same model as specialists
    system: systemPrompt,
    messages,
    tools,
    maxOutputTokens: 600,
    maxSteps: 6, // slightly more than shopping alone to allow support + tool combo
  });

  let text = "";
  try {
    text = await (await stream).text;
  } catch {
    text = "I'm having trouble with that right now. Please try again in a moment.";
  }

  // Merchant-configured quick replies for low-confidence / direct responses
  const DEFAULT_QUICK_REPLIES = ["Browse products", "Check order status", "Return policy"];
  const merchantQuickReplies =
    merchant.quickReplies && merchant.quickReplies.length > 0
      ? merchant.quickReplies
      : DEFAULT_QUICK_REPLIES;

  // Only emit quick_replies when no tool was called (direct/greeting responses)
  const quickReplies = toolsCalled.length === 0 ? merchantQuickReplies : undefined;

  return {
    text,
    products,
    cart,
    checkout_url: checkoutUrl,
    discount_code: discountCode,
    quick_replies: quickReplies,
    escalate_to_human: escalateToHuman || undefined,
    agent_trace: [...agentTrace, ...toolsCalled],
    last_search_query: lastSearchQuery,
    route_reason: "unified",
  };
}
