/**
 * Tool definitions shared between the web widget agent (unified.server.ts)
 * and the WhatsApp agent (whatsapp.server.ts). These eight tools had
 * byte-for-byte identical execute() logic hand-copied into both files —
 * `set_intent`'s own comment literally said "keep the enum in sync with
 * whatsapp.server.ts's identical tool", i.e. manual sync was already the
 * acknowledged (and risky) strategy. A fix applied to one copy and forgotten
 * in the other is exactly how the earlier COD-detection bug shape happens.
 *
 * Tools NOT here (create_cart, update_cart, get_cart, get_customer_orders,
 * offer_discount) have real, intentional per-channel behavior — WhatsApp's
 * cart-assist nudges, a different order-history data source (Admin API by
 * customerId vs Storefront Customer Account API by access token), different
 * post-discount cart-state bookkeeping — and are kept local to each agent
 * file rather than forced through a shared shape that would risk losing
 * that behavior or growing an awkward number of callback parameters.
 */

import { tool } from "ai";
import { z } from "zod";
import { searchCatalog, getProduct, lookupCatalog } from "~/lib/mcp/catalog.server";
import type { CatalogProduct } from "~/lib/mcp/catalog.server";
import { getCart } from "~/lib/mcp/cart.server";
import { searchPoliciesAndFaqs } from "~/lib/mcp/policy.server";
import { getOrder } from "~/lib/mcp/order.server";

/** Mutated by the shared tools' execute() calls; read by the caller after the LLM run completes. */
export interface SharedToolsState {
  toolsCalled: string[];
  products?: CatalogProduct[];
  lastSearchQuery?: string;
  checkoutUrl?: string;
  cart?: unknown;
  routeReason?: string;
  escalateToHuman: boolean;
}

export function createSharedTools(opts: {
  shopDomain: string;
  onToolStart?: (toolName: string) => void;
  /** Longer, gift-intent-aware copy on the web widget; terser on WhatsApp to keep its prompt lean. */
  searchCatalogDescription: string;
  /** Differs by channel: web asks the customer to double-check, WhatsApp points to support. */
  orderNotFoundMessage: string;
}) {
  const state: SharedToolsState = {
    toolsCalled: [],
    escalateToHuman: false,
  };

  const start = (name: string) => {
    opts.onToolStart?.(name);
    state.toolsCalled.push(name);
  };

  const search_catalog = tool({
    description: opts.searchCatalogDescription,
    inputSchema: z.object({
      query: z.string(),
      maxPriceCents: z.number().optional(),
      currency: z.string().optional(),
      intent: z.string().optional().describe("The customer's real underlying need. For gift queries include: 'gift for [recipient]', occasion if known, and use-case/interest tags. For non-gift queries include budget signals, skill level, use case, or other context that changes which products rank best."),
      maxResults: z.number().min(1).max(3).optional(),
    }),
    execute: async (input) => {
      start("search_catalog");
      if (input.query) state.lastSearchQuery = input.query;
      const result = await searchCatalog(opts.shopDomain, input.query, {
        maxPriceCents: input.maxPriceCents,
        currency: input.currency,
        intent: input.intent,
      });
      const sliced = input.maxResults ? result.products.slice(0, input.maxResults) : result.products;
      // Accumulate across multiple search_catalog calls in the same turn (e.g. "show me
      // featured and popular products" triggers two searches) — a later, narrower search
      // that finds nothing must not wipe out real results an earlier search already found.
      const prior = state.products ?? [];
      const seen = new Set(prior.map((p) => p.id));
      state.products = [...prior, ...sliced.filter((p) => !seen.has(p.id))];
      return { ...result, products: sliced, total: sliced.length };
    },
  });

  const lookup_catalog = tool({
    description: "Look up specific product variants by GID",
    inputSchema: z.object({ ids: z.array(z.string()) }),
    execute: async (input) => {
      start("lookup_catalog");
      return lookupCatalog(opts.shopDomain, input.ids);
    },
  });

  const get_product = tool({
    description: "Get full product details including all variants",
    inputSchema: z.object({
      productId: z.string(),
      selectedOptions: z
        .array(z.object({ name: z.string(), label: z.string() }))
        .optional(),
    }),
    execute: async (input) => {
      start("get_product");
      return getProduct(opts.shopDomain, input.productId, input.selectedOptions);
    },
  });

  const get_checkout_url = tool({
    description: "Get the checkout URL for a cart so the buyer can complete their purchase.",
    inputSchema: z.object({ cartId: z.string() }),
    execute: async (input) => {
      start("get_checkout_url");
      const cartData = await getCart(opts.shopDomain, input.cartId);
      const url = cartData.checkoutUrl ?? cartData.continue_url ?? "";
      state.checkoutUrl = url;
      state.cart = cartData;
      return { continue_url: url, requires_escalation: !url };
    },
  });

  const search_policies_and_faqs = tool({
    description: "Search the merchant's shop policies and FAQs",
    inputSchema: z.object({
      query: z.string(),
      context: z.string().optional(),
    }),
    execute: async (input) => {
      start("search_policies_and_faqs");
      const result = await searchPoliciesAndFaqs(opts.shopDomain, input.query, input.context);
      if (!result) return { text: null, message: "No policy found for that query." };
      return result;
    },
  });

  const get_order = tool({
    description: "Look up an order by ID for status and tracking",
    inputSchema: z.object({ orderId: z.string() }),
    execute: async (input) => {
      start("get_order");
      try {
        return await getOrder(opts.shopDomain, input.orderId);
      } catch {
        // Not found is often just a typo — let the model ask the customer to double-check
        // rather than forcing escalation. Real "I want a human" requests go through
        // the dedicated escalate_human tool instead.
        return { error: "Order not found", message: opts.orderNotFoundMessage };
      }
    },
  });

  // Lightweight intent classifier — side-effect only, no extra token cost beyond the tool call.
  // Feeds route_reason, which the merchant dashboard groups conversations by (app._index.tsx).
  const set_intent = tool({
    description: "Call once after understanding what the customer needs to classify their intent.",
    inputSchema: z.object({
      intent: z.enum(["product_question", "order_tracking", "discount_request", "cart_help", "general"]),
    }),
    execute: async (input) => {
      start("set_intent");
      state.routeReason = input.intent;
      return { ok: true };
    },
  });

  const escalate_human = tool({
    description: "Call when the customer explicitly asks to speak with a human, live agent, real person, or support staff. Never call for any other reason.",
    inputSchema: z.object({}),
    execute: async () => {
      start("escalate_human");
      state.escalateToHuman = true;
      return { ok: true };
    },
  });

  return {
    tools: {
      search_catalog,
      lookup_catalog,
      get_product,
      get_checkout_url,
      search_policies_and_faqs,
      get_order,
      set_intent,
      escalate_human,
    },
    state,
  };
}
