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
import { assertCartNotEmpty } from "~/lib/guardrails.server";
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
// Output type (same shape as the prior OutboundMessage type (orchestrator removed))
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
- When you decide to offer a code, call the offer_discount tool — do NOT mention codes in free text
- If offer_discount returns { error: "code_not_applicable" }: the code's conditions weren't met (minimum order or product restriction). Do NOT mention that code to the customer. Try the next available code silently, or if none work, say "I don't have any codes that apply to your current order right now."
- If offer_discount returns { success: true, auto_applied: true }: the discount is ALREADY on the cart. Say "I've applied X off to your order!" — do not say "here's a code to use". Customer doesn't need to do anything.
- If offer_discount returns { success: true, auto_applied: false } (no cart yet): say "Here's a code for you!" naturally — customer will use it at checkout.
- Never repeat the code string in your reply text — the UI shows it from the tool result.`
      : merchant.personalizationEnabled
        ? `\n## DISCOUNTS\nNo promotional codes are active right now. If the customer asks about discounts, deals, or promo codes, say: "We don't have any promotional codes running at the moment — but I can help you find the perfect product!"`
        : "";

  const discountGuidanceLine =
    merchant.personalizationEnabled && freshCodes.length > 0
      ? `\n- Discount/personalization: offer_discount (call this tool — do NOT mention codes in free text)`
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
- If intent is unclear (confidence < 0.6): ask the customer to rephrase; offer quick options${discountGuidanceLine}
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
  customerAccessToken?: string;
  cartTotalCents?: number;
  onToolStart?: (toolName: string) => void; // called when a tool begins executing
  onToken?: (token: string) => void; // called for each text token as it streams
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
    onToolStart,
    onToken,
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
  // Mutable local copies — updated within the turn so within-turn double-offers are blocked
  const offered_codes_local = [...offered_codes];
  let discountLevel_local = discountLevel;

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

  const baseTools = {
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
        onToolStart?.("search_catalog");
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
        onToolStart?.("lookup_catalog");
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
        onToolStart?.("get_product");
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
        onToolStart?.("create_cart");
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
        onToolStart?.("get_cart");
        toolsCalled.push("get_cart");
        const result = await getCart(shopDomain, input.cartId);
        cart = result;
        checkoutUrl = result.checkoutUrl;
        return result;
      },
    }),

    update_cart: tool({
      description:
        "Add or update items in the cart, or apply a discount/gift card code the customer mentioned having. Use add[] for new items (pass product_variant_id). To REMOVE or CHANGE QUANTITY of existing items, you MUST call get_cart first to get the line item IDs (they look like gid://shopify/CartLine/...), then pass those line item IDs in update[] — passing a variant GID in update[] will fail silently. quantity 0 removes the item. Use discountCodes/giftCardCodes when the customer provides a code.",
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
        onToolStart?.("update_cart");
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
        onToolStart?.("get_checkout_url");
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
        onToolStart?.("search_policies_and_faqs");
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
        onToolStart?.("get_order");
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
        onToolStart?.("get_customer_orders");
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

  // Conditionally add offer_discount only when there are fresh codes available
  if (merchant.personalizationEnabled && availableDiscounts.length > 0) {
    (baseTools as Record<string, unknown>)["offer_discount"] = tool({
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
        onToolStart?.("offer_discount");
        toolsCalled.push("offer_discount");
        if (discountLevel_local >= 3) {
          return { error: "discount_cap_reached", message: "No more discount offers available for this conversation." };
        }
        const isValid = availableDiscounts.some((d) => d.code === input.code);
        const alreadyOffered = offered_codes_local.includes(input.code);
        if (!isValid || alreadyOffered) {
          return { error: "Code not available or already offered" };
        }

        // When a cart already exists, validate the code actually applies before surfacing it.
        // This catches minimum-order failures BEFORE the customer gets excited about a code
        // that can't work on their current cart.
        if (session.cart_id) {
          try {
            const testCart = await updateCart(shopDomain, session.cart_id, {
              discountCodes: [input.code],
            });
            // Shopify Storefront MCP may return snake_case (discount_codes) or camelCase
            const codes = testCart.discountCodes ?? testCart.discount_codes ?? [];
            const applicable = codes.length === 0
              ? true  // MCP didn't return discount_codes at all — assume it applied (fail open)
              : codes.some((d) => d.code === input.code && d.applicable !== false);
            if (!applicable) {
              // Code exists but doesn't apply to this cart (minimum not met, wrong products, etc.)
              // Mark as offered so we don't retry it, but don't surface it to the customer.
              offered_codes_local.push(input.code);
              discountLevel_local += 1;
              return {
                error: "code_not_applicable",
                message: `Code ${input.code} requires conditions the current cart doesn't meet (minimum order or product restriction). Try a different code or tell the customer no applicable codes are available right now.`,
              };
            }
            // Code applied successfully — update cart state so caller gets the discount
            cart = testCart;
          } catch {
            // Network/MCP failure — still surface the code; customer can apply manually
          }
        }

        discountCode = input.code;
        offered_codes_local.push(input.code);
        discountLevel_local += 1;
        return { success: true, code: input.code, stance: input.negotiationStance, auto_applied: !!session.cart_id };
      },
    });
  }

  const tools = baseTools;

  // ---------------------------------------------------------------------------
  // Run
  // ---------------------------------------------------------------------------

  // Stream tokens in real-time via onToken callback.
  // Retry on 429 with exponential backoff (1s, 2s). 429 errors fire before
  // any tokens, so retrying a mid-stream failure is not a concern in practice.
  let text = "";
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * attempt)); // 1s, 2s
    }
    try {
      const stream = runAgentStream({
        deployment: deployments.shopping(),
        system: systemPrompt,
        messages,
        tools,
        maxOutputTokens: 600,
        maxSteps: 3, // 1 tool call + response covers 95% of cases; was 6 = up to 12s worst case
      });
      // Iterate token-by-token so the caller receives text as it generates,
      // not all at once after the full response is buffered.
      for await (const token of stream.textStream) {
        text += token;
        onToken?.(token);
      }
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      text = ""; // reset in case partial text was streamed before error
      const is429 =
        String(err).includes("429") ||
        String(err).toLowerCase().includes("rate") ||
        (err as { statusCode?: number })?.statusCode === 429;
      if (!is429) break;
    }
  }
  if (lastErr !== undefined) {
    const is429 =
      String(lastErr).includes("429") ||
      String(lastErr).toLowerCase().includes("rate") ||
      (lastErr as { statusCode?: number })?.statusCode === 429;
    text = is429
      ? "Our assistant is briefly busy — please send your message again in a moment."
      : "I'm having trouble with that right now. Please try again in a moment.";
    onToken?.(text); // emit error text so caller doesn't receive silence
  }

  // Merchant-configured quick replies for low-confidence / direct responses
  const DEFAULT_QUICK_REPLIES = ["What do you sell?", "Track my order", "Return policy"];
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
