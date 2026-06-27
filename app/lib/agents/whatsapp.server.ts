/**
 * WhatsApp agent — non-streaming, text-only.
 * Shares the same UCP/MCP tools as the website agent but has a
 * WhatsApp-specific prompt (concise, plain text, no markdown).
 * When a Shopify customer is identified by phone, uses unified metafield memory
 * and the full tool set (discounts, checkout URL, order history).
 */

import { tool, generateText, stepCountIs } from "ai";
import { z } from "zod";
import { deployments } from "~/lib/llm.server";
import { searchCatalog, getProduct, lookupCatalog } from "~/lib/mcp/catalog.server";
import { createCart, getCart, updateCart } from "~/lib/mcp/cart.server";
import { searchPoliciesAndFaqs } from "~/lib/mcp/policy.server";
import { getOrder } from "~/lib/mcp/order.server";
import { getActiveDiscounts } from "~/lib/mcp/discounts.server";
import { getCustomerOrdersAdmin } from "~/lib/mcp/admin.server";
import {
  fetchCustomerMemory,
  updateCustomerMemory,
  fetchWhatsAppMemory,
  updateWhatsAppMemory,
} from "~/lib/agents/memory.server";
import type { ConversationSession } from "~/lib/session.server";
import type { Merchant } from "@prisma/client";

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export interface WhatsAppAgentOutput {
  text: string;
  products?: unknown[];
  checkout_url?: string;
  discount_code?: string;
  last_search_query?: string;
  agent_trace: string[];
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildWhatsAppPrompt(
  merchant: Merchant,
  memory: { summary?: string; recent_products?: string[] },
  discountsAvailable: boolean,
): string {
  const botName = (merchant as unknown as Record<string, unknown>).botName as string | undefined ?? "NeonPing";
  const storeName = merchant.shopDomain.replace(".myshopify.com", "").replace(/-/g, " ");
  const brandVoice = (merchant as unknown as Record<string, unknown>).brandVoice as string | undefined;
  const customFaqs = (merchant as unknown as Record<string, unknown>).customFaqs as string | undefined;

  const faqSection = customFaqs
    ? `\n## STORE FAQS\n${customFaqs}`
    : "";

  const memorySection = [
    memory.summary ? `Returning customer context: ${memory.summary}` : "",
    memory.recent_products?.length
      ? `Customer has previously shown interest in: ${memory.recent_products.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const discountLine = discountsAvailable
    ? "You may offer a discount code when the customer signals real buying intent or asks about deals — call offer_discount tool, never mention codes in free text."
    : "Do not offer discount codes.";

  return `You are ${botName}, a shopping assistant for ${storeName} on WhatsApp.${brandVoice ? `\nBrand voice: ${brandVoice}` : ""}

Keep replies concise — under 200 characters when possible. Plain text only. No markdown, no asterisks, no bullet points, no numbered lists.
When recommending products, name them briefly with price in one line each.
${discountLine}
${memorySection ? `\n## CUSTOMER CONTEXT\n${memorySection}` : ""}
${faqSection}

## TOOLS
- Shopping: search_catalog, get_product, lookup_catalog, create_cart, get_cart, update_cart, get_checkout_url
- Support: search_policies_and_faqs, get_order, get_customer_orders
- Greetings/small talk: respond directly, no tool needed`;
}

// ---------------------------------------------------------------------------
// Main WhatsApp agent function
// ---------------------------------------------------------------------------

export async function runWhatsAppAgent(opts: {
  shopDomain: string;
  customerPhone: string;
  customerId?: string;
  agentMessage: string;
  session: ConversationSession;
  merchant: Merchant;
  accessToken: string;
}): Promise<WhatsAppAgentOutput> {
  const { shopDomain, customerPhone, customerId, agentMessage, session, merchant, accessToken } = opts;

  const toolsCalled: string[] = [];
  let products: unknown[] | undefined;
  let checkoutUrl: string | undefined;
  let discountCode: string | undefined;
  let lastSearchQuery: string | undefined;

  // Discount state from session (same as unified agent)
  const { offered_codes, level: discountLevel } = session.discount_negotiation;
  const discountsRemaining = Math.max(0, 3 - discountLevel);
  const offered_codes_local = [...offered_codes];
  let discountLevel_local = discountLevel;

  // Pre-fetch discounts only if personalization is on and budget allows
  const availableDiscounts =
    merchant.personalizationEnabled && discountsRemaining > 0
      ? await getActiveDiscounts(shopDomain, accessToken)
      : [];

  // Use unified metafield memory when customer is identified, else Redis fallback
  const memory = customerId
    ? await fetchCustomerMemory(shopDomain, accessToken, customerId)
    : await fetchWhatsAppMemory(customerPhone);

  const systemPrompt = buildWhatsAppPrompt(
    merchant,
    { summary: memory.summary, recent_products: memory.recent_products },
    merchant.personalizationEnabled && availableDiscounts.length > 0,
  );

  const history = session.conversation_history
    .slice(-10)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...history,
    { role: "user", content: agentMessage },
  ];

  const baseTools = {
    search_catalog: tool({
      description:
        "Search the merchant catalog. Pass intent alongside query, and maxPriceCents when a budget was mentioned.",
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
        toolsCalled.push("create_cart");
        const result = await createCart(shopDomain, input.lineItems, { currency: input.currency });
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
        checkoutUrl = result.checkoutUrl;
        return result;
      },
    }),

    update_cart: tool({
      description:
        "Add or update items in the cart, or apply a discount/gift card code the customer mentioned having.",
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
        const url = cartData.checkoutUrl ?? cartData.continue_url ?? "";
        checkoutUrl = url;
        return { continue_url: url, requires_escalation: !url };
      },
    }),

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
          return {
            error: "Order not found",
            message: "Please contact support for assistance with this order.",
          };
        }
      },
    }),

    get_customer_orders: tool({
      description: "Get recent order history for this customer",
      inputSchema: z.object({}),
      execute: async () => {
        toolsCalled.push("get_customer_orders");
        if (!customerId) {
          return { orders: [], message: "I need to verify your identity first." };
        }
        return { orders: await getCustomerOrdersAdmin(shopDomain, accessToken, customerId) };
      },
    }),
  };

  // Conditionally add offer_discount — same logic as unified agent
  if (merchant.personalizationEnabled && availableDiscounts.length > 0) {
    (baseTools as Record<string, unknown>)["offer_discount"] = tool({
      description:
        "Offer a discount code when the customer shows real buying intent or asks about deals. Only call when discount_offers_remaining > 0 and the code hasn't been offered yet.",
      inputSchema: z.object({
        code: z.string().describe("The exact discount code string to offer"),
        negotiationStance: z
          .enum(["firm", "generous", "final"])
          .describe("firm=starting low, generous=better deal, final=last/best offer"),
        message: z.string().describe("Natural language message to show when offering the code"),
      }),
      execute: async (input) => {
        toolsCalled.push("offer_discount");
        if (discountLevel_local >= 3) {
          return { error: "discount_cap_reached", message: "No more discount offers available." };
        }
        const isValid = availableDiscounts.some((d) => d.code === input.code);
        const alreadyOffered = offered_codes_local.includes(input.code);
        if (!isValid || alreadyOffered) {
          return { error: "Code not available or already offered" };
        }

        if (session.cart_id) {
          try {
            const testCart = await updateCart(shopDomain, session.cart_id, {
              discountCodes: [input.code],
            });
            const codes = testCart.discountCodes ?? testCart.discount_codes ?? [];
            const applicable = codes.length === 0
              ? true
              : codes.some((d) => d.code === input.code && d.applicable !== false);
            if (!applicable) {
              offered_codes_local.push(input.code);
              discountLevel_local += 1;
              return {
                error: "code_not_applicable",
                message: `Code ${input.code} doesn't meet cart conditions. Try a different code or say no codes apply.`,
              };
            }
          } catch {
            // Network failure — surface the code anyway; customer can apply manually
          }
        }

        discountCode = input.code;
        offered_codes_local.push(input.code);
        discountLevel_local += 1;
        return { success: true, code: input.code, stance: input.negotiationStance, auto_applied: !!session.cart_id };
      },
    });
  }

  // ponytail: no retry loop — WhatsApp has its own Meta retry on 5xx; let it bubble
  const result = await generateText({
    model: deployments.shopping(),
    system: systemPrompt,
    messages,
    tools: baseTools,
    maxOutputTokens: 300, // WhatsApp messages are short
    stopWhen: stepCountIs(3),
  }).catch((err) => {
    const is429 =
      String(err).includes("429") ||
      String(err).toLowerCase().includes("rate") ||
      (err as { statusCode?: number })?.statusCode === 429;
    return {
      text: is429
        ? "I'm briefly busy — please try again in a moment."
        : "I'm having trouble right now. Please try again.",
      steps: [] as unknown[],
    };
  });

  // Extract product titles from search_catalog tool results for memory update
  const searchedProductTitles: string[] = [];
  if ("steps" in result && Array.isArray(result.steps)) {
    for (const step of result.steps) {
      const s = step as { toolResults?: Array<{ toolName: string; result: unknown }> };
      for (const tr of s.toolResults ?? []) {
        if (tr.toolName === "search_catalog") {
          const r = tr.result as { products?: Array<{ title?: string }> } | undefined;
          for (const p of r?.products ?? []) {
            if (p.title) searchedProductTitles.push(p.title);
          }
        }
      }
    }
  }

  // Fire-and-forget memory update — use unified metafield memory when customer is identified
  if (lastSearchQuery || searchedProductTitles.length > 0) {
    if (customerId) {
      void updateCustomerMemory(shopDomain, accessToken, customerId, session, lastSearchQuery).catch(() => null);
    } else {
      void updateWhatsAppMemory(customerPhone, {
        ...(lastSearchQuery ? { last_search: lastSearchQuery } : {}),
        ...(searchedProductTitles.length > 0 ? { recent_products: searchedProductTitles } : {}),
      }).catch(() => null);
    }
  }

  return {
    text: result.text,
    products,
    checkout_url: checkoutUrl,
    discount_code: discountCode,
    last_search_query: lastSearchQuery,
    agent_trace: ["whatsapp", ...toolsCalled],
  };
}
