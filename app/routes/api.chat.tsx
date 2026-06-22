/**
 * POST /api/chat
 *
 * SSE streaming endpoint consumed by the storefront widget.
 * Authenticates the request, loads session + memory + merchant config,
 * runs the unified agent, streams the response, and persists state.
 *
 * Request body (JSON):
 *   {
 *     session_id: string,        // UUID, generated client-side per visitor
 *     shop: string,              // myshop.myshopify.com
 *     message: string,           // raw user text
 *     customer_id?: string,      // Shopify GID for logged-in buyers
 *     customer_access_token?: string,
 *     cart_total_cents?: number,
 *   }
 *
 * SSE event stream:
 *   event: delta     — text chunk
 *   event: meta      — JSON with products/cart/checkout_url/discount_code/quick_replies
 *   event: error     — JSON { code, message }
 *   event: done      — signals end of stream
 *
 * Returns plain (non-SSE) HTTP 429 with a Retry-After header if the
 * per-shop or per-IP rate limit is exceeded — see app/lib/rate-limit.server.ts
 *
 * Returns plain (non-SSE) HTTP 402 if the shop is over its monthly plan
 * conversation limit — see app/lib/billing.server.ts
 */

import type { ActionFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { getSession, setSession, resetTurn, appendMessage } from "~/lib/session.server";
import { fetchCustomerMemory, updateCustomerMemory } from "~/lib/agents/memory.server";
import { runUnifiedAgent } from "~/lib/agents/unified.server";
import { persistConversationTurn, extractCheckoutToken } from "~/lib/conversation.server";
import { getStorefrontAccessToken } from "~/lib/auth.server";
import { checkChatRateLimit, getClientIp } from "~/lib/rate-limit.server";
import { checkAndIncrementUsage } from "~/lib/billing.server";
import { updateCart, createCart } from "~/lib/mcp/cart.server";
import type { Merchant } from "@prisma/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CartAction {
  variantId: string;
  quantity: number;
}

interface InboundMessage {
  session_id: string;
  shop: string;
  message: string;
  customer_id?: string;
  customer_access_token?: string;
  customer_first_name?: string;
  cart_total_cents?: number;
  cartAction?: CartAction;
}

// ---------------------------------------------------------------------------
// Route action — only POST is accepted
// ---------------------------------------------------------------------------

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Parse body
  let body: InboundMessage;
  try {
    body = (await request.json()) as InboundMessage;
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { session_id, shop, message, customer_id, customer_access_token, customer_first_name, cart_total_cents, cartAction } = body;

  if (!session_id || !shop || !message?.trim()) {
    return new Response(JSON.stringify({ error: "missing_fields" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (message.length > 2000) {
    return new Response(JSON.stringify({ error: "message_too_long" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Rate limit before doing any real work — protects against unbounded LLM spend
  const clientIp = getClientIp(request);
  const rateLimit = await checkChatRateLimit(shop, clientIp);
  if (!rateLimit.allowed) {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        ...(rateLimit.retryAfterSeconds
          ? { "Retry-After": String(rateLimit.retryAfterSeconds) }
          : {}),
      },
    });
  }

  // Authenticate against Shopify — get the merchant access token
  const accessToken = await getStorefrontAccessToken(request, shop);

  // Load or upsert the Merchant config row
  const merchant = await prisma.merchant.upsert({
    where: { shopDomain: shop },
    update: {},
    create: { shopDomain: shop },
  });

  // Usage limit check — increments once per conversation session, not once per message.
  // session_id dedup in billing.server.ts ensures "500 conversations/mo" means
  // 500 distinct chat sessions, not 500 individual messages.
  const usage = await checkAndIncrementUsage(shop, session_id);
  if (!usage.allowed) {
    const noPlan = usage.limit === 0;
    return new Response(
      JSON.stringify({
        error: noPlan ? "no_active_plan" : "usage_limit_exceeded",
        message: noPlan
          ? "A paid plan is required to use NeonPing. Please subscribe at your store admin."
          : "Monthly conversation limit reached. Upgrade your plan to continue.",
        used: usage.used,
        limit: usage.limit,
      }),
      { status: 402, headers: { "Content-Type": "application/json" } },
    );
  }

  // Build the SSE stream
  const stream = buildSseStream({
    shop,
    session_id,
    message: message.trim(),
    accessToken,
    merchant,
    customer_id,
    customer_access_token,
    customer_first_name,
    cart_total_cents,
    cartAction,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ---------------------------------------------------------------------------
// CORS preflight for widget cross-origin requests
// ---------------------------------------------------------------------------

export async function loader({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  return new Response("Not Found", { status: 404 });
}

// ---------------------------------------------------------------------------
// SSE stream builder
// ---------------------------------------------------------------------------

function buildSseStream(opts: {
  shop: string;
  session_id: string;
  message: string;
  accessToken: string;
  merchant: Merchant;
  customer_id?: string;
  customer_access_token?: string;
  customer_first_name?: string;
  cart_total_cents?: number;
  cartAction?: CartAction;
}): ReadableStream<Uint8Array> {
  const {
    shop,
    session_id,
    message,
    accessToken,
    merchant,
    customer_id,
    customer_access_token,
    customer_first_name,
    cart_total_cents,
    cartAction,
  } = opts;

  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: string) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      };

      try {
        // 1. Load session
        const session = await resetTurn(shop, session_id);

        // 1b. Pre-handle cart action deterministically — no LLM parsing of GIDs needed
        let preCartResult: { cart?: unknown; checkoutUrl?: string } = {};
        let preCartFailed = false;
        if (cartAction) {
          if (session.cart_id) {
            try {
              const updated = await updateCart(shop, session.cart_id, {
                add: [{ product_variant_id: cartAction.variantId, quantity: cartAction.quantity }],
              });
              preCartResult = { cart: updated, checkoutUrl: updated.checkoutUrl };
            } catch {
              preCartFailed = true;
            }
          } else {
            try {
              const newCart = await createCart(shop, [
                { item: { id: cartAction.variantId }, quantity: cartAction.quantity },
              ]);
              preCartResult = { cart: newCart, checkoutUrl: newCart.checkoutUrl };
              session.cart_id = newCart.id; // store for this turn
              // Persist cart_id immediately so it's durable before any other write
              await setSession(shop, session_id, session);
            } catch {
              preCartFailed = true;
            }
          }
        }
        // Surface cart failure to the agent so it can inform the customer
        const agentMessage = cartAction && preCartFailed
          ? `[cart-add failed — could not add item to cart. Tell the customer something went wrong and suggest they try again.]\n${message}`
          : message;

        // 2 + 3. Append user message and fetch customer memory in parallel — they're independent
        const appendP = appendMessage(shop, session_id, {
          role: "user",
          content: message,
          timestamp: Date.now(),
        });
        const memoryP = customer_id
          ? fetchCustomerMemory(shop, accessToken, customer_id)
          : Promise.resolve<import("~/lib/agents/memory.server").CustomerMemory>({});
        const [, memory] = await Promise.all([appendP, memoryP]);
        // Liquid injects first_name directly — reliable fallback when memory fetch returns nothing
        if (!memory.firstName && customer_first_name) {
          memory.firstName = customer_first_name;
        }

        // 4. Run the unified agent (shopping + support + personalization in one LLM call)
        const result = await runUnifiedAgent({
          shopDomain: shop,
          agentMessage,
          session,
          merchant,
          memory,
          accessToken,
          customerAccessToken: customer_access_token,
          cartTotalCents: cart_total_cents,
        });

        // 5. Stream the text response as deltas (word-level for widget UX)
        const replyText = result.text?.trim() || "I'm not sure how to help with that. Could you rephrase?";
        const words = replyText.split(" ");
        for (let i = 0; i < words.length; i++) {
          const chunk = i === 0 ? words[i] : ` ${words[i]}`;
          send("delta", JSON.stringify({ text: chunk }));
        }

        // 6. Emit structured meta (products, cart, URLs, etc.)
        // Merge preCartResult (from deterministic cart update) with agent result —
        // agent result takes precedence if it also touched the cart (e.g. applied discount).
        const effectiveCart = result.cart ?? preCartResult.cart;
        const effectiveCheckoutUrl = result.checkout_url ?? preCartResult.checkoutUrl;
        const meta: Record<string, unknown> = {};
        if (result.products?.length) meta.products = result.products;
        if (effectiveCart) meta.cart = effectiveCart;
        if (effectiveCheckoutUrl) meta.checkout_url = effectiveCheckoutUrl;
        if (result.discount_code) meta.discount_code = result.discount_code;
        if (result.quick_replies?.length) meta.quick_replies = result.quick_replies;
        if (result.escalate_to_human) meta.escalate_to_human = true;
        meta.agent_trace = result.agent_trace;
        if (result.last_search_query) meta.last_search_query = result.last_search_query;

        send("meta", JSON.stringify(meta));

        // 7. Persist assistant reply + updated session
        await appendMessage(shop, session_id, {
          role: "assistant",
          content: replyText,
          timestamp: Date.now(),
        });

        // Update session with any cart/checkout state from agent or pre-cart step
        const updatedSession = await getSession(shop, session_id);
        if (effectiveCart) {
          const cartId = (effectiveCart as { id?: string }).id;
          if (cartId) updatedSession.cart_id = cartId;
        }
        if (effectiveCheckoutUrl && !result.escalate_to_human) {
          updatedSession.checkout_token = extractCheckoutToken(effectiveCheckoutUrl);
          // Also set checkout_id so memory.server.ts can detect cart→checkout conversion
          // and clear the abandoned_cart signal. It checks for presence, not a specific format.
          updatedSession.checkout_id = effectiveCheckoutUrl;
        }
        if (result.discount_code) {
          const neg = updatedSession.discount_negotiation;
          if (!neg.offered_codes.includes(result.discount_code)) {
            neg.offered_codes.push(result.discount_code);
          }
          neg.level = Math.min(neg.level + 1, 3);
          updatedSession.discount_negotiation = neg;
        }
        // Also track if customer applied their own code via update_cart
        const cartDiscounts = (effectiveCart as { discountCodes?: unknown[] } | undefined)?.discountCodes;
        if (cartDiscounts && (cartDiscounts as unknown[]).length > 0) {
          const neg = updatedSession.discount_negotiation;
          neg.level = 3; // cap negotiation — they've used a code
          updatedSession.discount_negotiation = neg;
        }
        await setSession(shop, session_id, updatedSession);

        // 8. Async Postgres persistence (fire-and-forget, never blocks response)
        void persistConversationTurn({
          shopDomain: shop,
          sessionId: session_id,
          customerId: customer_id,
          session: updatedSession,
          checkoutUrl: effectiveCheckoutUrl,
          discountCode: result.discount_code,
          escalateToHuman: result.escalate_to_human,
          agentTrace: result.agent_trace,
          routeReason: result.route_reason,
        }).catch((err) => console.error("[conversation] persist failed:", err));

        // 9. Async memory update (fire-and-forget, never blocks response)
        if (customer_id) {
          const lastSearch = result.last_search_query;
          const cartLines = effectiveCart
            ? ((effectiveCart as { lines?: unknown[] }).lines ?? [])
            : undefined;
          void updateCustomerMemory(
            shop,
            accessToken,
            customer_id,
            updatedSession,
            lastSearch,
            cartLines,
          ).catch(() => null);
        }

        send("done", "{}");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "An unexpected error occurred";
        send("error", JSON.stringify({ code: "internal_error", message }));
        send("done", "{}");
      } finally {
        controller.close();
      }
    },
  });
}
