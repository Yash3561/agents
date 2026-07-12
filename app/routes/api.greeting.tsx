/**
 * GET /api/greeting?shop=...&customer_id=...
 *
 * Lightweight lookup the widget calls before showing its opening greeting.
 * Returns a personalized greeting — abandoned-cart recovery takes priority
 * over a recent-search nudge — or { greeting: null } to fall back to the
 * merchant's static configured greeting (anonymous visitors, first-timers).
 */
import type { LoaderFunctionArgs } from "react-router";
import { fetchCustomerMemory } from "~/lib/agents/memory.server";
import { getStorefrontAccessToken } from "~/lib/auth.server";
import { checkChatRateLimit, getClientIp } from "~/lib/rate-limit.server";
import prisma from "~/db.server";

const ABANDONED_MIN_AGE_MS = 60 * 60 * 1000; // 1 hour — don't nag mid-session
const ABANDONED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days — beyond this the cart is likely stale

async function findAbandonedCartGreeting(
  shop: string,
  customerId: string,
  firstName?: string,
): Promise<string | null> {
  const conversation = await prisma.conversation.findFirst({
    where: { shopDomain: shop, customerId },
    orderBy: { lastMessageAt: "desc" },
  });

  if (!conversation?.cartId || conversation.orderId) return null;

  const ageMs = Date.now() - conversation.lastMessageAt.getTime();
  if (ageMs < ABANDONED_MIN_AGE_MS || ageMs > ABANDONED_MAX_AGE_MS) return null;

  const namePrefix = firstName ? `Welcome back, ${firstName}!` : "Welcome back!";
  return `${namePrefix} You still have an item waiting in your cart — want to finish checking out?`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const customerId = url.searchParams.get("customer_id");

  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  // customer_first_name is injected by Liquid ({{ customer.first_name }}) — no API call needed
  const liquidFirstName = url.searchParams.get("first_name") || undefined;

  if (!shop || !customerId) {
    return new Response(JSON.stringify({ greeting: null }), { headers });
  }

  // customer_id is client-supplied and unverified (no access-token check here) — an
  // enumerable GID could otherwise be used to scrape PII (name/cart) at unbounded
  // rate, each hit also costing an Admin API call. Reuse the chat endpoint's
  // per-IP/per-shop limiter to bound that, same as api.chat.tsx does.
  const rateLimit = await checkChatRateLimit(shop, getClientIp(request));
  if (!rateLimit.allowed) {
    return new Response(JSON.stringify({ greeting: null }), { headers });
  }

  try {
    const accessToken = await getStorefrontAccessToken(request, shop);
    const memory = await fetchCustomerMemory(shop, accessToken, customerId);

    // Liquid-sourced name is always reliable; fall back to memory API result
    const firstName = liquidFirstName || memory.firstName;

    const abandonedGreeting = await findAbandonedCartGreeting(shop, customerId, firstName);
    if (abandonedGreeting) {
      return new Response(JSON.stringify({ greeting: abandonedGreeting }), { headers });
    }

    let greeting: string | null = null;
    if (memory.last_search) {
      const namePrefix = firstName ? `Welcome back, ${firstName}!` : "Welcome back!";
      greeting = `${namePrefix} Still looking for "${memory.last_search}"? Happy to help you pick up where you left off.`;
    } else if (firstName) {
      greeting = `Hi ${firstName}! How can I help you today?`;
    }

    return new Response(JSON.stringify({ greeting }), { headers });
  } catch {
    return new Response(JSON.stringify({ greeting: null }), { headers });
  }
}
