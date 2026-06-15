import { tool } from "ai";
import { z } from "zod";
import { deployments, runAgentStream } from "~/lib/llm.server";
import { buildShoppingPrompt, type CustomerMemory } from "~/lib/prompt.server";
import {
  assertCheckoutConfirmed,
  assertCartNotEmpty,
  GuardrailError,
} from "~/lib/guardrails.server";
import { searchCatalog, getProduct, lookupCatalog } from "~/lib/mcp/catalog.server";
import { createCart, getCart, updateCart, cancelCart } from "~/lib/mcp/cart.server";
import { createCheckout, completeCheckout } from "~/lib/mcp/checkout.server";
import type { ConversationSession } from "~/lib/session.server";
import type { Merchant } from "@prisma/client";

// ---------------------------------------------------------------------------
// Parameter schemas
// ---------------------------------------------------------------------------

const SearchSchema = z.object({
  query: z.string(),
  maxPriceCents: z.number().optional(),
  currency: z.string().optional(),
  intent: z.string().optional(),
});

const LookupSchema = z.object({ ids: z.array(z.string()) });

const GetProductSchema = z.object({
  productId: z.string(),
  selectedOptions: z.array(z.object({ name: z.string(), label: z.string() })).optional(),
});

const LineItemSchema = z.object({ item: z.object({ id: z.string() }), quantity: z.number() });

const CreateCartSchema = z.object({
  lineItems: z.array(LineItemSchema),
  currency: z.string().optional(),
});

const GetCartSchema = z.object({ cartId: z.string() });

const UpdateCartSchema = z.object({
  cartId: z.string(),
  lineItems: z.array(LineItemSchema),
});

const CancelCartSchema = z.object({ cartId: z.string() });
const CreateCheckoutSchema = z.object({ cartId: z.string() });
const CompleteCheckoutSchema = z.object({ checkoutId: z.string() });

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export interface ShoppingAgentOutput {
  text: string;
  products?: unknown[];
  cart?: unknown;
  checkoutUrl?: string;
  toolsCalled: string[];
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export async function runShoppingAgent(opts: {
  shopDomain: string;
  contextForSpecialist: string;
  session: ConversationSession;
  merchant: Merchant;
  memory: CustomerMemory;
  buyerConfirmed: boolean;
}): Promise<ShoppingAgentOutput> {
  const { shopDomain, contextForSpecialist, session, merchant, memory, buyerConfirmed } = opts;

  const toolsCalled: string[] = [];
  let products: unknown[] | undefined;
  let cart: unknown | undefined;
  let checkoutUrl: string | undefined;

  const tools = {
    search_catalog: tool({
      description: "Search the merchant catalog by natural language query",
      inputSchema: SearchSchema,
      execute: async (input) => {
        toolsCalled.push("search_catalog");
        const result = await searchCatalog(shopDomain, input.query, {
          maxPriceCents: input.maxPriceCents,
          currency: input.currency,
          intent: input.intent,
        });
        products = result.products;
        return result;
      },
    }),

    lookup_catalog: tool({
      description: "Look up specific product variants by GID",
      inputSchema: LookupSchema,
      execute: async (input) => {
        toolsCalled.push("lookup_catalog");
        return lookupCatalog(shopDomain, input.ids);
      },
    }),

    get_product: tool({
      description: "Get full product details including all variants",
      inputSchema: GetProductSchema,
      execute: async (input) => {
        toolsCalled.push("get_product");
        return getProduct(shopDomain, input.productId, input.selectedOptions);
      },
    }),

    create_cart: tool({
      description: "Create a new cart with the given line items",
      inputSchema: CreateCartSchema,
      execute: async (input) => {
        assertCartNotEmpty(input.lineItems);
        toolsCalled.push("create_cart");
        const result = await createCart(shopDomain, input.lineItems, { currency: input.currency });
        cart = result;
        return result;
      },
    }),

    get_cart: tool({
      description: "Fetch current cart state",
      inputSchema: GetCartSchema,
      execute: async (input) => {
        toolsCalled.push("get_cart");
        const result = await getCart(shopDomain, input.cartId);
        cart = result;
        return result;
      },
    }),

    update_cart: tool({
      description: "Replace cart contents — always pass the COMPLETE line_items array (full PUT, not a delta)",
      inputSchema: UpdateCartSchema,
      execute: async (input) => {
        assertCartNotEmpty(input.lineItems);
        toolsCalled.push("update_cart");
        const result = await updateCart(shopDomain, input.cartId, input.lineItems);
        cart = result;
        return result;
      },
    }),

    cancel_cart: tool({
      description: "Cancel a cart",
      inputSchema: CancelCartSchema,
      execute: async (input) => {
        toolsCalled.push("cancel_cart");
        await cancelCart(shopDomain, input.cartId);
        return { cancelled: true };
      },
    }),

    create_checkout: tool({
      description: "Convert a cart into a checkout session",
      inputSchema: CreateCheckoutSchema,
      execute: async (input) => {
        toolsCalled.push("create_checkout");
        const result = await createCheckout(shopDomain, input.cartId);
        checkoutUrl = result.continue_url;
        return result;
      },
    }),

    complete_checkout: tool({
      description: "Complete the checkout — only call when the buyer has explicitly confirmed the purchase",
      inputSchema: CompleteCheckoutSchema,
      execute: async (input) => {
        assertCheckoutConfirmed(
          { ...session, buyer_confirmed: buyerConfirmed },
          "complete_checkout",
        );
        toolsCalled.push("complete_checkout");
        const result = await completeCheckout(shopDomain, input.checkoutId);
        if (result.requires_escalation) checkoutUrl = result.continue_url;
        return result;
      },
    }),
  };

  const stream = runAgentStream({
    deployment: deployments.shopping(),
    system: buildShoppingPrompt(merchant, session, memory),
    messages: [{ role: "user", content: contextForSpecialist }],
    tools,
    maxOutputTokens: 600,
    maxSteps: 5,
  });

  let text = "";
  try {
    text = await (await stream).text;
  } catch (err) {
    if (err instanceof GuardrailError && err.code === "checkout_not_confirmed") {
      text = "Please confirm you'd like to complete the purchase and I'll process it right away.";
    } else {
      text = "I'm having trouble with that right now. Please try again in a moment.";
    }
  }

  return { text, products, cart, checkoutUrl, toolsCalled };
}
