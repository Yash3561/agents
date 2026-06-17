/**
 * POST /api/chat
 *
 * SSE streaming endpoint consumed by the storefront widget.
 * Authenticates the request, loads session + memory + merchant config,
 * runs the orchestrator, streams the response, and persists state.
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
import { runOrchestrator } from "~/lib/agents/orchestrator.server";
import { persistConversationTurn, extractCheckoutToken } from "~/lib/conversation.server";
import { getStorefrontAccessToken } from "~/lib/auth.server";
import { checkChatRateLimit, getClientIp } from "~/lib/rate-limit.server";
import { checkAndIncrementUsage } from "~/lib/billing.server";
import type { Merchant } from "@prisma/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InboundMessage {
  session_id: string;
  shop: string;
  message: string;
  customer_id?: string;
  customer_access_token?: string;
  cart_total_cents?: number;
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

  const { session_id, shop, message, customer_id, customer_access_token, cart_total_cents } = body;

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

  // Usage limit check — blocks before any LLM/MCP work if the shop is over its plan limit
  const usage = await checkAndIncrementUsage(shop);
  if (!usage.allowed) {
    return new Response(
      JSON.stringify({ error: "usage_limit_exceeded", used: usage.used, limit: usage.limit }),
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
    cart_total_cents,
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
  cart_total_cents?: number;
}): ReadableStream<Uint8Array> {
  const {
    shop,
    session_id,
    message,
    accessToken,
    merchant,
    customer_id,
    customer_access_token,
    cart_total_cents,
  } = opts;

  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: string) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      };

      try {
        // 1. Reset per-turn counters (hop_count, agent_calls)
        const session = await resetTurn(shop, session_id);

        // 2. Append the user message to history
        await appendMessage(shop, session_id, {
          role: "user",
          content: message,
          timestamp: Date.now(),
        });

        // 3. Fetch customer memory (graceful — returns {} on miss)
        const memory = customer_id
          ? await fetchCustomerMemory(shop, accessToken, customer_id)
          : {};

        // 4. Run the orchestrator (all agents behind this call)
        const result = await runOrchestrator({
          shopDomain: shop,
          currentMessage: message,
          session,
          merchant,
          memory,
          accessToken,
          customerId: customer_id,
          customerAccessToken: customer_access_token,
          cartTotalCents: cart_total_cents,
        });

        // 5. Stream the text response as deltas (word-level for widget UX)
        const words = result.text.split(" ");
        for (let i = 0; i < words.length; i++) {
          const chunk = i === 0 ? words[i] : ` ${words[i]}`;
          send("delta", JSON.stringify({ text: chunk }));
        }

        // 6. Emit structured meta (products, cart, URLs, etc.)
        const meta: Record<string, unknown> = {};
        if (result.products?.length) meta.products = result.products;
        if (result.cart) meta.cart = result.cart;
        if (result.checkout_url) meta.checkout_url = result.checkout_url;
        if (result.discount_code) meta.discount_code = result.discount_code;
        if (result.quick_replies?.length) meta.quick_replies = result.quick_replies;
        if (result.escalate_to_human) meta.escalate_to_human = true;
        meta.agent_trace = result.agent_trace;

        send("meta", JSON.stringify(meta));

        // 7. Persist assistant reply + updated session
        await appendMessage(shop, session_id, {
          role: "assistant",
          content: result.text,
          timestamp: Date.now(),
        });

        // Update session with any cart/checkout state the agent may have set
        const updatedSession = await getSession(shop, session_id);
        if (result.cart) {
          const cartId = (result.cart as { id?: string }).id;
          if (cartId) updatedSession.cart_id = cartId;
        }
        if (result.checkout_url && !result.escalate_to_human) {
          updatedSession.checkout_id = session_id; // mark checkout initiated
          updatedSession.checkout_token = extractCheckoutToken(result.checkout_url);
        }
        if (result.discount_code) {
          updatedSession.discount_applied = true;
        }
        // Also flag if the customer applied their own code via update_cart
        const cartDiscounts = (result.cart as { discountCodes?: unknown[] } | undefined)?.discountCodes;
        if (cartDiscounts && (cartDiscounts as unknown[]).length > 0) {
          updatedSession.discount_applied = true;
        }
        await setSession(shop, session_id, updatedSession);

        // 8. Async Postgres persistence (fire-and-forget, never blocks response)
        void persistConversationTurn({
          shopDomain: shop,
          sessionId: session_id,
          customerId: customer_id,
          session: updatedSession,
          checkoutUrl: result.checkout_url,
          discountCode: result.discount_code,
          escalateToHuman: result.escalate_to_human,
          agentTrace: result.agent_trace,
          routeReason: result.route_reason,
        }).catch((err) => console.error("[conversation] persist failed:", err));

        // 9. Async memory update (fire-and-forget, never blocks response)
        if (customer_id) {
          const lastSearch = result.last_search_query;
          const cartLines = result.cart
            ? ((result.cart as { lines?: unknown[] }).lines ?? [])
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
