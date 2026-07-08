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
import { getSession, setSession, appendMessage } from "~/lib/session.server";
import { fetchCustomerMemory, updateCustomerMemory } from "~/lib/agents/memory.server";
import { runUnifiedAgent } from "~/lib/agents/unified.server";
import { persistConversationTurn, extractCheckoutToken } from "~/lib/conversation.server";
import { getStorefrontAccessToken } from "~/lib/auth.server";
import { checkChatRateLimit, getClientIp } from "~/lib/rate-limit.server";
import { checkAndIncrementUsage } from "~/lib/billing.server";
import { updateCart, createCart } from "~/lib/mcp/cart.server";
import { captureException } from "~/lib/sentry.server";
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
  customer_last_name?: string;
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

  const { session_id, shop, message, customer_id, customer_access_token, customer_first_name, customer_last_name, cart_total_cents, cartAction } = body;

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

  // Smoke-test bypass: CI passes X-Smoke-Test matching SMOKE_TEST_SECRET to skip
  // billing (the test shop has no paid plan in the staging DB). Only active when
  // the env var is set — no-ops in production if SMOKE_TEST_SECRET is not configured.
  const smokeSecret = process.env.SMOKE_TEST_SECRET;
  const isSmokeTest =
    smokeSecret &&
    smokeSecret.length > 0 &&
    request.headers.get("X-Smoke-Test") === smokeSecret;

  // Usage limit check — increments once per conversation session, not once per message.
  // session_id dedup in billing.server.ts ensures "500 conversations/mo" means
  // 500 distinct chat sessions, not 500 individual messages.
  if (!isSmokeTest) {
    const usage = await checkAndIncrementUsage(shop, session_id);
    if (!usage.allowed) {
      const noPlan = usage.limit === 0;
      return new Response(
        JSON.stringify({
          error: noPlan ? "no_active_plan" : "usage_limit_exceeded",
          // Customer-facing — this text renders in the storefront widget, so it must
          // never mention plans/billing (that's the merchant's business, not the shopper's)
          message: "Chat is temporarily unavailable. Please contact the store directly — we're happy to help!",
          used: usage.used,
          limit: usage.limit,
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // Check if AI is paused for this conversation — merchant has taken over manually
  const convPause = await prisma.conversation.findFirst({
    where: { shopDomain: shop, sessionId: session_id },
    select: { aiPaused: true },
  });
  if (convPause?.aiPaused) {
    const pauseBody =
      `event: delta\ndata: ${JSON.stringify({ text: "A team member is handling your conversation. We'll be with you shortly." })}\n\n` +
      `event: meta\ndata: ${JSON.stringify({ agent_trace: [] })}\n\n` +
      `event: done\ndata: {}\n\n`;
    return new Response(pauseBody, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
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
    customerName: [customer_first_name, customer_last_name].filter(Boolean).join(" ") || undefined,
    cart_total_cents,
    cartAction,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no", // tell reverse proxy (Envoy/nginx) not to buffer SSE chunks
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
  customerName?: string;
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
    customerName,
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
        const t0 = Date.now();

        // 1. Load session
        const session = await getSession(shop, session_id);

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
        // Surface cart outcome to the agent — success signal prevents a redundant update_cart tool call
        const agentMessage = cartAction
          ? preCartFailed
            ? `[cart-add failed — could not add item to cart. Tell the customer something went wrong and suggest they try again.]\n${message}`
            : `[cart-add already complete — item was added successfully. Just confirm cheerfully and offer checkout. Do NOT call update_cart again.]\n${message}`
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

        // Pre-populate cart from abandoned_cart so the agent has a live cart_id
        // before it runs and can skip the re-search/re-add cycle entirely.
        if (
          customer_id &&
          !session.cart_id &&
          memory.abandoned_cart?.items?.length
        ) {
          try {
            const abandonedItems = memory.abandoned_cart.items as Array<{
              merchandise?: { id?: string };
            }>;
            const lineItems = abandonedItems
              .filter((line) => line.merchandise?.id)
              .map((line) => ({
                item: { id: line.merchandise!.id! },
                quantity: 1,
              }));

            if (lineItems.length > 0) {
              const restoredCart = await createCart(shop, lineItems);
              session.cart_id = restoredCart.id;
              await setSession(shop, session_id, session);
              // Note: abandoned_cart metafield is cleared only in webhooks.orders.paid.tsx
              // once the order is confirmed — not here, so the signal persists if the
              // customer opens the widget but doesn't complete the purchase.
            }
          } catch {
            // Cart pre-population is best-effort — agent can still recover manually
          }
        }

        const t1 = Date.now();
        let firstToken = false;

        const thinkingTexts: Record<string, string> = {
          search_catalog: "Searching our catalog…",
          lookup_catalog: "Looking up products…",
          get_product: "Looking up product details…",
          create_cart: "Creating your cart…",
          update_cart: "Updating your cart…",
          get_cart: "Checking your cart…",
          get_checkout_url: "Preparing checkout…",
          offer_discount: "Checking available discounts…",
          search_policies_and_faqs: "Looking up our policies…",
          get_order: "Looking up your order…",
          get_customer_orders: "Fetching your order history…",
        };

        // 4. Run the unified agent — tokens stream to SSE in real-time via onToken.
        //    The LLM's first token fires the first delta immediately; no buffering.
        const result = await runUnifiedAgent({
          shopDomain: shop,
          agentMessage,
          session,
          merchant,
          memory,
          accessToken,
          customerAccessToken: customer_access_token,
          cartTotalCents: cart_total_cents,
          onToolStart: (toolName) => {
            // Only send thinking text if no real text has streamed yet
            if (!firstToken) {
              const text = thinkingTexts[toolName] ?? "Thinking…";
              send("thinking", JSON.stringify({ text }));
            }
          },
          onToken: (token) => {
            if (!firstToken) {
              firstToken = true;
              console.log(`[perf] shop=${shop} pre=${t1 - t0}ms ttft=${Date.now() - t1}ms`);
            }
            send("delta", JSON.stringify({ text: token }));
          },
        });

        // 5. Fallback — only fires if agent returned empty text (shouldn't happen normally)
        const replyText = result.text?.trim() || "I'm not sure how to help with that. Could you rephrase?";
        if (!result.text?.trim()) {
          send("delta", JSON.stringify({ text: replyText }));
        }

        // 6. Emit structured meta (products, cart, URLs, etc.)
        // Merge preCartResult (from deterministic cart update) with agent result —
        // agent result takes precedence if it also touched the cart (e.g. applied discount).
        const effectiveCart = result.cart ?? preCartResult.cart;
        const effectiveCheckoutUrl = result.checkout_url ?? preCartResult.checkoutUrl;

        // Compute effective cart value in cents — prefer live cart total, fall back to widget-reported value
        const liveCartTotal = (effectiveCart as { cost?: { total_amount?: { amount?: string } } } | undefined)?.cost?.total_amount?.amount;
        const effectiveCartValueCents = liveCartTotal
          ? Math.round(parseFloat(liveCartTotal) * 100)
          : cart_total_cents;

        // Contextual quick replies based on what happened this turn
        let quickReplies = result.quick_replies; // set when no tool was called (greeting/small talk)
        if (!quickReplies) {
          if (effectiveCart) {
            quickReplies = result.discount_code
              ? ["Checkout now", "Keep shopping"]
              : ["Apply a discount", "Checkout now", "Keep shopping"];
          } else if (result.products?.length) {
            quickReplies = ["Tell me more", "Add to cart", "See alternatives"];
          }
        }

        const meta: Record<string, unknown> = {};
        if (result.products?.length) meta.products = result.products;
        if (effectiveCart) meta.cart = effectiveCart;
        if (effectiveCheckoutUrl) meta.checkout_url = effectiveCheckoutUrl;
        if (result.discount_code) meta.discount_code = result.discount_code;
        if (quickReplies?.length) meta.quick_replies = quickReplies;
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
        // Persist the full post-turn negotiation state — covers successful offers
        // AND blocked/not-applicable attempts, not just the last successful code.
        updatedSession.discount_negotiation = result.discount_negotiation;
        // Also track if customer applied their own code via update_cart
        const cartDiscounts = (effectiveCart as { discountCodes?: unknown[]; discount_codes?: unknown[] } | undefined)?.discountCodes
          ?? (effectiveCart as { discount_codes?: unknown[] } | undefined)?.discount_codes;
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
          customerName,
          session: updatedSession,
          checkoutUrl: effectiveCheckoutUrl,
          discountCode: result.discount_code,
          escalateToHuman: result.escalate_to_human,
          agentTrace: result.agent_trace,
          routeReason: result.route_reason,
          cartValueCents: effectiveCartValueCents,
        }).catch((err) => {
          console.error("[conversation] persist failed:", err);
          captureException(err, { shop, session_id, context: "persist_conversation" });
        });

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
        captureException(err, { shop, session_id });
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
