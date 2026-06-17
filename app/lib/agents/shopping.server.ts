import { tool } from "ai";
import { z } from "zod";
import { deployments, runAgentStream } from "~/lib/llm.server";
import { buildShoppingPrompt, type CustomerMemory } from "~/lib/prompt.server";
import { assertCartNotEmpty } from "~/lib/guardrails.server";
import { searchCatalog, getProduct, lookupCatalog } from "~/lib/mcp/catalog.server";
import { createCart, getCart, updateCart } from "~/lib/mcp/cart.server";
import { checkoutFromCart } from "~/lib/mcp/checkout.server";
import type { ConversationSession } from "~/lib/session.server";
import type { Merchant } from "@prisma/client";

// ---------------------------------------------------------------------------
// Parameter schemas
// ---------------------------------------------------------------------------

const SearchSchema = z.object({
  query: z.string().describe(
    "The literal search term — keywords for what the customer is looking for.",
  ),
  maxPriceCents: z
    .number()
    .optional()
    .describe(
      "Hard price ceiling in cents if the customer mentioned a budget (e.g. 'under $30' -> 3000). Excludes anything above this — only set when the customer gave a real number.",
    ),
  currency: z.string().optional(),
  intent: z
    .string()
    .optional()
    .describe(
      "Soft context that improves ranking without excluding anything — the customer's actual underlying need, not just their keywords. Examples: 'gift for a coworker, doesn't know their taste', 'needs to be durable for daily outdoor use', 'first-time buyer, wants something beginner-friendly'. Infer this from the conversation even if the customer didn't say it explicitly — this is what makes results actually match what they need instead of just what they typed.",
    ),
  maxResults: z
    .number()
    .min(1)
    .max(3)
    .optional()
    .describe(
      "How many product cards to show the customer. Use 1 when the customer named a specific product or described something very precise ('do you have X', 'show me the blue one'). Use 2-3 for open browsing ('what do you have for yoga', 'show me options under $50'). Default: 3.",
    ),
});

const LookupSchema = z.object({ ids: z.array(z.string()) });

const GetProductSchema = z.object({
  productId: z.string(),
  selectedOptions: z
    .array(z.object({ name: z.string(), label: z.string() }))
    .optional(),
});

const CreateCartSchema = z.object({
  lineItems: z.array(
    z.object({
      item: z.object({ id: z.string() }),
      quantity: z.number(),
    }),
  ),
  currency: z.string().optional(),
});

const GetCartSchema = z.object({ cartId: z.string() });

const UpdateCartSchema = z.object({
  cartId: z.string(),
  add: z
    .array(z.object({ product_variant_id: z.string(), quantity: z.number() }))
    .optional(),
  update: z
    .array(z.object({ id: z.string(), quantity: z.number() }))
    .optional(),
  discountCodes: z
    .array(z.string())
    .optional()
    .describe("Discount/promo codes to apply. Only set this when the customer explicitly mentions having a code — never ask proactively."),
  giftCardCodes: z
    .array(z.string())
    .optional()
    .describe("Gift card codes to apply. Only set this when the customer explicitly mentions having one — never ask proactively."),
});

const CheckoutSchema = z.object({ cartId: z.string() });

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export interface ShoppingAgentOutput {
  text: string;
  products?: unknown[];
  cart?: unknown;
  checkoutUrl?: string;
  toolsCalled: string[];
  lastSearchQuery?: string;
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
}): Promise<ShoppingAgentOutput> {
  const { shopDomain, contextForSpecialist, session, merchant, memory } = opts;

  const toolsCalled: string[] = [];
  let products: unknown[] | undefined;
  let cart: unknown | undefined;
  let checkoutUrl: string | undefined;
  let lastSearchQuery: string | undefined;

  const tools = {
    search_catalog: tool({
      description:
        "Search the merchant catalog. Always pass intent (the customer's real underlying need) alongside query, and maxPriceCents whenever a budget was mentioned — these meaningfully change which results rank highest, not just what gets filtered out.",
      inputSchema: SearchSchema,
      execute: async (input) => {
        toolsCalled.push("search_catalog");
        if (input.query) lastSearchQuery = input.query;
        const result = await searchCatalog(shopDomain, input.query, {
          maxPriceCents: input.maxPriceCents,
          currency: input.currency,
          intent: input.intent,
        });
        // Respect LLM's decision on how many cards to surface
        const sliced = input.maxResults ? result.products.slice(0, input.maxResults) : result.products;
        products = sliced;
        return { ...result, products: sliced, total: sliced.length };
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
      inputSchema: GetCartSchema,
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
        "Add or update items in the cart, or apply a discount/gift card code the customer mentioned having. Use add[] for new variants, update[] to change quantities (quantity 0 removes the item), discountCodes/giftCardCodes when the customer offers a code.",
      inputSchema: UpdateCartSchema,
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
      description:
        "Get the checkout URL for a cart so the buyer can complete their purchase. Call this when the buyer is ready to pay.",
      inputSchema: CheckoutSchema,
      execute: async (input) => {
        toolsCalled.push("get_checkout_url");
        const cartData = await getCart(shopDomain, input.cartId);
        const checkout = checkoutFromCart(cartData);
        checkoutUrl = checkout.continue_url;
        cart = cartData;
        return checkout;
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
  } catch {
    text = "I'm having trouble with that right now. Please try again in a moment.";
  }

  return { text, products, cart, checkoutUrl, toolsCalled, lastSearchQuery };
}
