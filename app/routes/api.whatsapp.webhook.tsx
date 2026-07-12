/**
 * GET  /api/whatsapp/webhook — Meta webhook verification handshake
 * POST /api/whatsapp/webhook — Inbound WhatsApp messages from Meta Cloud API
 */

import { createHash } from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { checkAndIncrementUsage } from "~/lib/billing.server";
import { extractCheckoutToken, sendEscalationEmail } from "~/lib/conversation.server";
import {
  verifyWebhookSignature,
  decryptToken,
  sendTextMessage,
  sendReplyButtons,
  sendCarousel,
  sendVariantList,
  sendCheckoutMessage,
  sendListMessage,
} from "~/lib/whatsapp.server";
import { getSession, setSession, appendMessage, deleteSession } from "~/lib/session.server";
import { runWhatsAppAgent } from "~/lib/agents/whatsapp.server";
import { formatCarousel } from "~/lib/agents/whatsapp-formatter.server";
import { lookupCustomerByPhone, fetchProductRatings, adminGraphql } from "~/lib/mcp/admin.server";
import { createCart, updateCart } from "~/lib/mcp/cart.server";
import { fetchWhatsAppMemory, updateWhatsAppMemory } from "~/lib/agents/memory.server";

function logGuardrail(event: string, type: string, phone: string, shopDomain: string) {
  const h = createHash("sha256").update(phone).digest("hex").slice(0, 12);
  console.log(JSON.stringify({ event, type, phone_hash: h, shop: shopDomain, ts: Date.now() }));
}

/**
 * Payment options offered after add-to-cart. "Cash on Delivery" is store-specific —
 * only shown when the merchant has explicitly confirmed (via Settings) that their
 * store actually supports it, since offering it otherwise leads to a checkout dead-end.
 */
export function buildPaymentButtons(codEnabled: boolean): Array<{ id: string; title: string }> {
  return [
    { id: "pay_prepaid", title: "💳 Pay Online" },
    ...(codEnabled ? [{ id: "pay_cod", title: "💵 Cash on Delivery" }] : []),
    { id: "post_checkout_shop", title: "🛍️ Keep Shopping" },
  ];
}

const JAILBREAK_RE = [
  /ignore\s+(previous|all|your)\s+(instructions?|prompt|rules?)/i,
  /you\s+are\s+now\s+(a\s+)?(different|new|an?)\s+(ai|bot|assistant)/i,
  /repeat\s+(your\s+)?(system\s+)?prompt/i,
  /forget\s+(everything|your|all)\s+(previous\s+)?(instructions?|rules?|prompt)/i,
  /\bjailbreak\b/i,
  /\bDAN\b/,
  /act\s+as\s+(?!a\s+shopping)/i,
  /pretend\s+(you\s+(are|were)|to\s+be)\s+(?!a\s+shopping)/i,
];

const UNSAFE_OUTPUT_RE = [
  /\b(kill\s+yourself|kys)\b/i,
  /\bhow\s+to\s+(make|build)\s+(a\s+)?(bomb|weapon|explosive)/i,
];

// ---------------------------------------------------------------------------
// Currency helpers — dynamic price tiers for filter list
// ---------------------------------------------------------------------------

const CURRENCY_SYM_EXT: Record<string, string> = {
  USD: "$", CAD: "CA$", AUD: "A$", NZD: "NZ$", SGD: "S$", HKD: "HK$", MXN: "MX$", BRL: "R$",
  INR: "₹", PKR: "₨", BDT: "৳", NPR: "₨", LKR: "₨",
  EUR: "€", GBP: "£", CHF: "CHF ", SEK: "kr ", NOK: "kr ", DKK: "kr ", PLN: "zł ",
  JPY: "¥", CNY: "¥", KRW: "₩",
  AED: "AED ", SAR: "SAR ", QAR: "QAR ", KWD: "KWD ",
  ZAR: "R", THB: "฿", MYR: "RM ", IDR: "Rp ", PHP: "₱", VND: "₫",
};

type PriceTierDef = { id: string; title: string; description: string; agentQuery: string };

function buildPriceTiers(sym: string, code: string): PriceTierDef[] {
  const noLimit: PriceTierDef = { id: "price|any", title: "No price limit", description: "Show everything", agentQuery: "Show me popular products across all price ranges" };
  if (["JPY", "KRW"].includes(code)) return [
    { id: "price|t1", title: `Under ${sym}3,000`, description: "Budget-friendly picks", agentQuery: `Show me products under ${sym}3000` },
    { id: "price|t2", title: `${sym}3K – ${sym}10K`, description: "Mid-range options", agentQuery: `Show me products between ${sym}3000 and ${sym}10000` },
    { id: "price|t3", title: `${sym}10K – ${sym}30K`, description: "Premium selection", agentQuery: `Show me products between ${sym}10000 and ${sym}30000` },
    { id: "price|t4", title: `${sym}30,000+`, description: "Luxury & high-end", agentQuery: `Show me premium products over ${sym}30000` },
    noLimit,
  ];
  if (["INR", "PKR", "BDT", "NPR", "LKR"].includes(code)) return [
    { id: "price|t1", title: `Under ${sym}500`, description: "Budget-friendly picks", agentQuery: `Show me products under ${sym}500` },
    { id: "price|t2", title: `${sym}500 – ${sym}2,000`, description: "Mid-range options", agentQuery: `Show me products between ${sym}500 and ${sym}2000` },
    { id: "price|t3", title: `${sym}2,000 – ${sym}5,000`, description: "Premium selection", agentQuery: `Show me products between ${sym}2000 and ${sym}5000` },
    { id: "price|t4", title: `${sym}5,000+`, description: "Luxury & high-end", agentQuery: `Show me premium products over ${sym}5000` },
    noLimit,
  ];
  if (["IDR", "VND"].includes(code)) return [
    { id: "price|t1", title: `Under ${sym}100K`, description: "Budget-friendly picks", agentQuery: `Show me products under ${sym}100000` },
    { id: "price|t2", title: `${sym}100K – ${sym}500K`, description: "Mid-range options", agentQuery: `Show me products between ${sym}100000 and ${sym}500000` },
    { id: "price|t3", title: `${sym}500K – ${sym}1.5M`, description: "Premium selection", agentQuery: `Show me products between ${sym}500000 and ${sym}1500000` },
    { id: "price|t4", title: `${sym}1.5M+`, description: "Luxury & high-end", agentQuery: `Show me premium products over ${sym}1500000` },
    noLimit,
  ];
  // Default: USD/EUR/GBP/CAD/AUD/AED/CHF etc.
  return [
    { id: "price|t1", title: `Under ${sym}25`, description: "Budget-friendly picks", agentQuery: `Show me products under ${sym}25` },
    { id: "price|t2", title: `${sym}25 – ${sym}100`, description: "Mid-range options", agentQuery: `Show me products between ${sym}25 and ${sym}100` },
    { id: "price|t3", title: `${sym}100 – ${sym}300`, description: "Premium selection", agentQuery: `Show me products between ${sym}100 and ${sym}300` },
    { id: "price|t4", title: `${sym}300+`, description: "Luxury & high-end", agentQuery: `Show me premium products over ${sym}300` },
    noLimit,
  ];
}

async function getShopCurrency(shopDomain: string): Promise<{ code: string; sym: string }> {
  const { redis } = await import("~/redis.server");
  const cached = await redis.get(`wa:currency:${shopDomain}`).catch(() => null);
  if (cached) {
    const sep = cached.indexOf("|");
    return { code: cached.slice(0, sep), sym: cached.slice(sep + 1) };
  }
  let code = "USD";
  try {
    const sess = await prisma.session.findFirst({
      where: { shop: shopDomain, isOnline: false },
      select: { accessToken: true },
    });
    if (sess?.accessToken) {
      const res = await fetch(`https://${shopDomain}/admin/api/2026-04/shop.json`, {
        headers: { "X-Shopify-Access-Token": sess.accessToken },
      });
      if (res.ok) {
        const data = await res.json() as { shop?: { currency?: string } };
        code = data.shop?.currency ?? "USD";
      }
    }
  } catch { /* fall back to USD */ }
  const sym = CURRENCY_SYM_EXT[code] ?? `${code} `;
  await redis.set(`wa:currency:${shopDomain}`, `${code}|${sym}`, "EX", 86400).catch(() => null);
  return { code, sym };
}

// ---------------------------------------------------------------------------
// GET — Meta verification handshake
// ---------------------------------------------------------------------------

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

// ---------------------------------------------------------------------------
// POST — inbound message
// ---------------------------------------------------------------------------

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // 1. Read raw body for HMAC verification
  const rawBody = await request.text();
  const sig = request.headers.get("x-hub-signature-256") ?? "";
  const appSecret = process.env.WHATSAPP_APP_SECRET ?? "";

  if (!verifyWebhookSignature(rawBody, sig, appSecret)) {
    console.warn("[wa-webhook] invalid signature");
    return new Response("Forbidden", { status: 403 });
  }

  // 2. Parse
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new Response("OK", { status: 200 }); // malformed but ack anyway
  }

  // 3. Extract message data — silently ack if structure doesn't match
  try {
    const entry = (body.entry as unknown[])?.[0] as Record<string, unknown> | undefined;
    const change = (entry?.changes as unknown[])?.[0] as Record<string, unknown> | undefined;
    const value = change?.value as Record<string, unknown> | undefined;
    if (!value) return new Response("OK", { status: 200 });
    const messages = value.messages as unknown[] | undefined;
    if (!messages?.length) return new Response("OK", { status: 200 }); // status update, not a message

    const msg = messages[0] as Record<string, unknown>;
    const from = msg.from as string;
    const messageId = msg.id as string;
    const textBody = (msg.text as Record<string, string> | undefined)?.body;
    const interactive = msg.interactive as Record<string, unknown> | undefined;
    // Carousel quick_reply taps arrive as type="button" with msg.button.payload (not interactive)
    const templateButtonPayload = (msg.button as Record<string, string> | undefined)?.payload;
    const buttonReplyPayload =
      templateButtonPayload ??
      (interactive?.type === "button_reply"
        ? (interactive.button_reply as Record<string, string> | undefined)?.id
        : undefined);
    const listReply =
      interactive?.type === "list_reply"
        ? (interactive.list_reply as Record<string, string> | undefined)
        : undefined;
    if (!textBody && !buttonReplyPayload && !listReply) return new Response("OK", { status: 200 });

    const metadata = value.metadata as Record<string, string> | undefined;
    const phoneNumberId = metadata?.phone_number_id;
    if (!phoneNumberId) return new Response("OK", { status: 200 });

    // 4. Look up merchant by WA phone number ID
    const merchant = await prisma.merchant.findFirst({
      where: { waPhoneNumberId: phoneNumberId },
    });
    if (!merchant || !merchant.waAccessToken) return new Response("OK", { status: 200 });

    const accessToken = decryptToken(merchant.waAccessToken);
    const shopDomain = merchant.shopDomain;
    const sessionId = `whatsapp_${from}`;

    const { redis } = await import("~/redis.server");
    // Deduplicate — Meta retries if we take >20s; a second delivery must not send a second reply
    const isNew = await redis.set(`wamsg:${messageId}`, 1, "EX", 86400, "NX");
    if (isNew === null) return new Response("OK", { status: 200 });

    // STOP compliance — legal requirement; must run before any other processing.
    // Opt-out check applies to EVERY inbound message type (text, button tap, list
    // reply) — it was previously scoped to `if (textBody)` only, which let an
    // opted-out user keep receiving replies by tapping buttons instead of typing.
    const STOP_RE = /^(stop|unsubscribe|opt[\s-]?out|cancel|quit|end)\s*$/i;
    const START_RE = /^start\s*$/i;
    if (textBody) {
      const trimmed = textBody.trim();
      if (STOP_RE.test(trimmed)) {
        await redis.set(`wa:optout:${from}`, "1");
        await sendTextMessage(phoneNumberId, accessToken, from,
          "You've been unsubscribed and won't receive further messages. Reply START to opt back in."
        ).catch(() => null);
        logGuardrail("optout_registered", "stop_word", from, shopDomain);
        return new Response("OK", { status: 200 });
      }
      if (START_RE.test(trimmed)) {
        await redis.del(`wa:optout:${from}`);
        await sendTextMessage(phoneNumberId, accessToken, from,
          "Welcome back! You're now opted in. How can I help you shop today?"
        ).catch(() => null);
        return new Response("OK", { status: 200 });
      }
    }
    if (await redis.exists(`wa:optout:${from}`)) {
      logGuardrail("optout_blocked", "opted_out", from, shopDomain);
      return new Response("OK", { status: 200 });
    }

    // Per-phone rate limit — 20 msgs/hour prevents one user burning merchant's quota
    const phoneRlKey = `wa:rl:${shopDomain}:${from}`;
    const phoneCount = await redis.incr(phoneRlKey);
    if (phoneCount === 1) await redis.expire(phoneRlKey, 3600);
    if (phoneCount > 20) {
      await sendTextMessage(phoneNumberId, accessToken, from,
        "You've sent too many messages. Please try again in an hour."
      ).catch(() => null);
      logGuardrail("rate_limit_hit", "per_phone", from, shopDomain);
      return new Response("OK", { status: 200 });
    }

    // Per-merchant billing gate — same plan limits as web widget
    const usageCheck = await checkAndIncrementUsage(shopDomain, sessionId).catch(() => ({ allowed: true, used: 0, limit: 0 }));
    if (!usageCheck.allowed) {
      await sendTextMessage(phoneNumberId, accessToken, from,
        "This store's messaging limit has been reached for the month. Please contact the store directly."
      ).catch(() => null);
      logGuardrail("usage_limit_hit", "merchant_quota", from, shopDomain);
      return new Response("OK", { status: 200 });
    }

    // ponytail: agentInput set by button path (greeting fallthrough) or text path below
    let agentInput: string | undefined;

    // Handle carousel button taps — no agent needed
    if (buttonReplyPayload) {
      // Greeting reply buttons fall through to agent with mapped text; all others return early
      // greeting_browse / greeting_question handled inline below (no agent needed)
      if (buttonReplyPayload === "filter_price") {
        const { code, sym } = await getShopCurrency(shopDomain);
        const tiers = buildPriceTiers(sym, code);
        await sendListMessage(phoneNumberId, accessToken, from,
          "Choose your price range:",
          "Select Range",
          [{ title: "Price ranges", rows: tiers.map(({ id, title, description }) => ({ id, title, description })) }],
        ).catch(() => null);
        return new Response("OK", { status: 200 });
      }
      if (buttonReplyPayload === "refine_search") {
        await sendTextMessage(phoneNumberId, accessToken, from,
          "Sure! Tell me what you're looking for — product type, color, occasion, or anything specific 🔍"
        ).catch(() => null);
        return new Response("OK", { status: 200 });
      }
      if (buttonReplyPayload === "pay_prepaid") {
        const pendingUrl = await redis.get(`wa:pending_checkout:${from}`).catch(() => null);
        await sendTextMessage(phoneNumberId, accessToken, from,
          `Great choice! 💳 Complete your payment securely:\n${pendingUrl ?? `https://${shopDomain}`}`
        ).catch(() => null);
        return new Response("OK", { status: 200 });
      }
      if (buttonReplyPayload === "pay_cod") {
        const pendingUrl = await redis.get(`wa:pending_checkout:${from}`).catch(() => null);
        await sendTextMessage(phoneNumberId, accessToken, from,
          `No problem! 💵 Cash on Delivery selected. Complete your order here:\n${pendingUrl ?? `https://${shopDomain}`}\n\nWe'll notify you before delivery.`
        ).catch(() => null);
        return new Response("OK", { status: 200 });
      }
      if (buttonReplyPayload === "greeting_question") {
        await sendTextMessage(phoneNumberId, accessToken, from,
          "Sure! I can help with orders, returns, sizing, shipping, or anything else — what do you need? 😊"
        ).catch(() => null);
        return new Response("OK", { status: 200 });
      }
      const greetingMap: Record<string, string> = {
        greeting_browse: "Show me your featured and popular products",
        greeting_bestsellers: "Show me your best sellers and most popular products",
        greeting_track: "What is the status of my latest order?",
        greeting_shopagain: "Show me products similar to what I bought before",
        post_checkout_track: "What is the status of my latest order?",
        post_checkout_shop: "Show me more products I might like",
      };
      if (greetingMap[buttonReplyPayload]) {
        agentInput = greetingMap[buttonReplyPayload];
        // fall through to session load, customer lookup, agent call below
      } else if (buttonReplyPayload.startsWith("add_cart|")) {
        const parts = buttonReplyPayload.split("|");

        // Multi-variant: show picker list instead of adding directly
        if (parts[1] === "select_variant") {
          const productId = parts[2];
          const relativeUrl = parts[3] ?? "";
          try {
            const cached = await redis.get(`wa:variants:${productId}`);
            const variants = cached
              ? (JSON.parse(String(cached)) as Array<{ id: string; title: string; price: string; currency?: string }>)
              : [];
            if (variants.length > 0) {
              await sendVariantList(phoneNumberId, accessToken, from, variants, relativeUrl);
            } else {
              await sendTextMessage(phoneNumberId, accessToken, from, "Please reply with your preferred size/color to add it to cart.").catch(() => null);
            }
          } catch {
            await sendTextMessage(phoneNumberId, accessToken, from, "Tap the product link to choose your option.").catch(() => null);
          }
          return new Response("OK", { status: 200 });
        }

        // Single-variant: reuse existing cart or create new
        const variantId = parts[1];
        const relativeProductUrl = parts[2] ?? "";
        try {
          const waMem = await fetchWhatsAppMemory(shopDomain, from);
          let cart;
          if (waMem.cart_id) {
            try {
              cart = await updateCart(shopDomain, waMem.cart_id, { add: [{ product_variant_id: variantId, quantity: 1 }] });
            } catch {
              cart = await createCart(shopDomain, [{ item: { id: variantId }, quantity: 1 }]);
            }
          } else {
            cart = await createCart(shopDomain, [{ item: { id: variantId }, quantity: 1 }]);
          }
          const addedTitle = cart.lines?.[0]?.merchandise?.product?.title ?? cart.lines?.[0]?.merchandise?.title;
          void updateWhatsAppMemory(shopDomain, from, {
            cart_id: cart.id,
            ...(addedTitle ? { recent_products: [...(waMem.recent_products ?? []), addedTitle].slice(0, 5) } : {}),
          }).catch(() => null);
          const checkoutUrl = `${cart.checkoutUrl}${cart.checkoutUrl.includes("?") ? "&" : "?"}checkout[phone]=%2B${from}`;
          const productPageUrl = relativeProductUrl ? `https://${shopDomain}${relativeProductUrl}` : `https://${shopDomain}`;
          await sendCheckoutMessage(phoneNumberId, accessToken, from, addedTitle ?? "your item", "", checkoutUrl, productPageUrl);
          await redis.set(`wa:pending_checkout:${from}`, checkoutUrl, "EX", 1800).catch(() => null);
          await sendReplyButtons(phoneNumberId, accessToken, from,
            "How would you like to pay?",
            buildPaymentButtons(merchant.codEnabled),
          ).catch(() => null);
        } catch {
          await sendTextMessage(phoneNumberId, accessToken, from, "Couldn't add to cart. Visit the store to complete your purchase.").catch(() => null);
        }
      } else if (buttonReplyPayload.startsWith("know_more|")) {
        const parts = buttonReplyPayload.split("|");
        const relativeProductUrl = parts[2] ?? "";
        const productPageUrl = relativeProductUrl ? `https://${shopDomain}${relativeProductUrl}` : `https://${shopDomain}`;
        await sendReplyButtons(phoneNumberId, accessToken, from,
          `Tap to add it or view full details:\n${productPageUrl}`,
          [
            { id: `add_cart|${parts[1]}|${relativeProductUrl}`, title: "Add to Cart" },
            { id: `view|${productPageUrl}`, title: "View Product" },
          ],
        ).catch(() => null);
      } else if (buttonReplyPayload.startsWith("view|")) {
        await sendTextMessage(phoneNumberId, accessToken, from, buttonReplyPayload.slice("view|".length)).catch(() => null);
      } else if (buttonReplyPayload.startsWith("prepaid|")) {
        const url = buttonReplyPayload.slice("prepaid|".length);
        await sendTextMessage(phoneNumberId, accessToken, from,
          `Great choice! Complete payment here: ${url}`
        ).catch(() => null);
        return new Response("OK", { status: 200 });
      } else if (buttonReplyPayload.startsWith("cod_keep|")) {
        const name = buttonReplyPayload.slice("cod_keep|".length);
        await sendTextMessage(phoneNumberId, accessToken, from,
          `No problem! Your COD order ${name} is confirmed. We'll notify you before delivery.`
        ).catch(() => null);
        return new Response("OK", { status: 200 });
      } else if (buttonReplyPayload.startsWith("addupsell|")) {
        const orderId = buttonReplyPayload.slice("addupsell|".length);
        const raw = await redis.get(`wa:upsell:${orderId}`).catch(() => null);
        if (!raw) {
          await sendTextMessage(phoneNumberId, accessToken, from, "Sorry, that offer has expired.").catch(() => null);
        } else {
          await redis.del(`wa:upsell:${orderId}`).catch(() => null); // one-shot, no replay
          try {
            const rec = JSON.parse(raw) as { variantId: string; title: string };
            const session = await prisma.session.findFirst({ where: { shop: shopDomain, isOnline: false }, select: { accessToken: true } });
            if (!session?.accessToken) throw new Error("no offline session");
            const draft = await adminGraphql<{
              draftOrderCreate: { draftOrder?: { invoiceUrl: string }; userErrors?: Array<{ message: string }> };
            }>(
              shopDomain,
              session.accessToken,
              `mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { invoiceUrl } userErrors { message } } }`,
              { input: { lineItems: [{ variantId: rec.variantId, quantity: 1 }] } },
            );
            const url = draft.draftOrderCreate.draftOrder?.invoiceUrl;
            if (url) {
              await sendTextMessage(phoneNumberId, accessToken, from, `Here's your link to add ${rec.title}: ${url}`).catch(() => null);
            } else {
              throw new Error("no invoiceUrl");
            }
          } catch {
            await sendTextMessage(phoneNumberId, accessToken, from, "Sorry, couldn't add that item — please visit the store to order it separately.").catch(() => null);
          }
        }
        return new Response("OK", { status: 200 });
      } else if (buttonReplyPayload === "skip|") {
        return new Response("OK", { status: 200 });
      } else if (buttonReplyPayload.startsWith("review_good|")) {
        await sendTextMessage(
          phoneNumberId, accessToken, from,
          `Amazing! Leave us a quick review here — it means a lot:\nhttps://${shopDomain}`,
        ).catch(() => null);
      } else if (buttonReplyPayload.startsWith("review_issue|")) {
        await sendTextMessage(
          phoneNumberId, accessToken, from,
          "We're sorry to hear that! A team member will reach out shortly.",
        ).catch(() => null);
        await sendReplyButtons(
          phoneNumberId, accessToken, from,
          "Would you like to speak with someone from the store?",
          [{ id: `support|${shopDomain}`, title: "Get Help 💬" }],
        ).catch(() => null);
      } else if (buttonReplyPayload.startsWith("support|")) {
        const domain = buttonReplyPayload.slice("support|".length);
        await sendTextMessage(phoneNumberId, accessToken, from,
          `You can reach the store directly at https://${domain}/pages/contact or reply to continue chatting.`
        ).catch(() => null);
      }
      // Greeting payloads set agentInput and fall through; everything else returns here
      if (!agentInput) return new Response("OK", { status: 200 });
    }

    // Handle list reply — variant picker or dynamic filter selection
    if (listReply) {
      const parts = listReply.id?.split("|") ?? [];
      if (parts[0] === "vadd" && parts[1]) {
        // Variant selected from picker — add directly to cart
        const variantId = parts[1];
        const relativeProductUrl = parts[2] ?? "";
        try {
          const waMem = await fetchWhatsAppMemory(shopDomain, from);
          let cart;
          if (waMem.cart_id) {
            try {
              cart = await updateCart(shopDomain, waMem.cart_id, { add: [{ product_variant_id: variantId, quantity: 1 }] });
            } catch {
              cart = await createCart(shopDomain, [{ item: { id: variantId }, quantity: 1 }]);
            }
          } else {
            cart = await createCart(shopDomain, [{ item: { id: variantId }, quantity: 1 }]);
          }
          const addedTitle = cart.lines?.[0]?.merchandise?.product?.title ?? cart.lines?.[0]?.merchandise?.title;
          void updateWhatsAppMemory(shopDomain, from, { cart_id: cart.id }).catch(() => null);
          const checkoutUrl = `${cart.checkoutUrl}${cart.checkoutUrl.includes("?") ? "&" : "?"}checkout[phone]=%2B${from}`;
          const productPageUrl = relativeProductUrl ? `https://${shopDomain}${relativeProductUrl}` : `https://${shopDomain}`;
          await sendCheckoutMessage(phoneNumberId, accessToken, from, addedTitle ?? listReply.title ?? "your item", "", checkoutUrl, productPageUrl);
          await redis.set(`wa:pending_checkout:${from}`, checkoutUrl, "EX", 1800).catch(() => null);
          await sendReplyButtons(phoneNumberId, accessToken, from,
            "How would you like to pay?",
            buildPaymentButtons(merchant.codEnabled),
          ).catch(() => null);
        } catch {
          await sendTextMessage(phoneNumberId, accessToken, from, "Couldn't add to cart. Please try again.").catch(() => null);
        }
        return new Response("OK", { status: 200 });
      }

      // Price filter list reply — resolve currency dynamically, fall through to agent
      if (listReply.id?.startsWith("price|")) {
        const { code, sym } = await getShopCurrency(shopDomain);
        const tiers = buildPriceTiers(sym, code);
        const tier = tiers.find((t) => t.id === listReply.id);
        agentInput = tier?.agentQuery ?? "Show me popular products across all price ranges";
        // fall through to session/agent below
      } else if (listReply.id === "recovery_help") {
        await sendTextMessage(phoneNumberId, accessToken, from,
          "You can reach the store directly at https://" + shopDomain + "/pages/contact or just type your question here."
        ).catch(() => null);
        return new Response("OK", { status: 200 });
      } else if (listReply.id === "recovery_bestsellers") {
        agentInput = "Show me your best sellers and most popular products";
        // fall through
      } else if (listReply.id === "recovery_new") {
        agentInput = "Show me your newest arrivals";
        // fall through
      } else {
        return new Response("OK", { status: 200 });
      }
      // price|* and recovery_* fall through to session load + agent call below
    }

    if (textBody) {
      // Input validation — strip non-printable, hard cap 500 chars
      // eslint-disable-next-line no-control-regex
      const validatedText = textBody.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim().slice(0, 500);
      if (!validatedText) return new Response("OK", { status: 200 });
      // Jailbreak blocklist — fast regex reject before any DB/agent work
      if (JAILBREAK_RE.some((re) => re.test(validatedText))) {
        const storeName = shopDomain.replace(".myshopify.com", "");
        await sendTextMessage(phoneNumberId, accessToken, from,
          `I can only help with shopping at ${storeName}. What can I find for you?`
        ).catch(() => null);
        logGuardrail("guardrail_triggered", "jailbreak", from, shopDomain);
        return new Response("OK", { status: 200 });
      }
      agentInput = validatedText;
    }
    if (!agentInput) return new Response("OK", { status: 200 });

    // 5. Load session from Redis
    const session = await getSession(shopDomain, sessionId);
    // Capture BEFORE append — appendMessage mutates session.conversation_history in-place
    const isFirstMessage = session.conversation_history.length === 0;

    // 6. Append user message to history
    await appendMessage(shopDomain, sessionId, {
      role: "user",
      content: agentInput,
      timestamp: Date.now(),
    });

    // 7. Get Shopify access token for catalog/cart tools
    const shopifySession = await prisma.session.findFirst({
      where: { shop: shopDomain, isOnline: false },
      select: { accessToken: true },
    });
    const shopifyAccessToken = shopifySession?.accessToken ?? "";

    // 8. Look up Shopify customer by phone for unified persona
    const shopifyCustomer = await lookupCustomerByPhone(shopDomain, shopifyAccessToken, from);

    // Greeting shortcut — warm reply + buttons for first contact; skip agent
    const GREETING_RE = /^(hi|hello|hey|hola|namaste|नमस्ते|yo|sup|hiya|ola)\b/i;
    const isGreeting = GREETING_RE.test(agentInput);
    // Reset stale session when customer re-opens with a greeting — treat as fresh start
    if (isGreeting && !isFirstMessage) {
      await deleteSession(shopDomain, sessionId);
      session.conversation_history = [];
    }
    if (isGreeting) {
      const isReturning = (shopifyCustomer?.numberOfOrders ?? 0) > 0;
      const firstName = shopifyCustomer?.displayName?.split(" ")[0] ?? shopifyCustomer?.firstName;
      const nameStr = firstName ? ` ${firstName}` : " there";
      let greetingText: string;
      let greetingButtons: Array<{ id: string; title: string }>;
      if (isReturning) {
        greetingText = `Hey${nameStr}! 👋 Good to see you again. What can I help you with?`;
        greetingButtons = [
          { id: "greeting_track", title: "📦 Track My Order" },
          { id: "greeting_shopagain", title: "🛍️ Shop Again" },
          { id: "greeting_question", title: "💬 Get Help" },
        ];
      } else {
        const storeName = shopDomain.replace(".myshopify.com", "");
        greetingText = `Hi${nameStr}! 👋 Welcome to ${storeName}. What can I help you with?`;
        greetingButtons = [
          { id: "greeting_browse", title: "🛍️ Browse Products" },
          { id: "greeting_bestsellers", title: "🔥 Best Sellers" },
          { id: "greeting_question", title: "💬 Get Help" },
        ];
      }
      await sendReplyButtons(phoneNumberId, accessToken, from, greetingText, greetingButtons).catch((e: unknown) => console.error("[wa-greeting] sendReplyButtons failed:", e));
      await appendMessage(shopDomain, sessionId, { role: "assistant", content: greetingText, timestamp: Date.now() });
      const updatedGreetingSession = await getSession(shopDomain, sessionId);
      await setSession(shopDomain, sessionId, updatedGreetingSession);
      const contactNameG = (value?.contacts as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
      const customerEmailG = (contactNameG?.profile as Record<string, string> | undefined)?.email ?? null;
      void prisma.conversation.upsert({
        where: { shopDomain_sessionId: { shopDomain, sessionId } },
        update: {
          messages: updatedGreetingSession.conversation_history as unknown as import("@prisma/client").Prisma.InputJsonValue,
          messageCount: updatedGreetingSession.conversation_history.length,
          channel: "whatsapp",
          lastMessageAt: new Date(),
          ...(customerEmailG ? { customerEmail: customerEmailG } : {}),
          resolved: false,
          resolvedAt: null,
        },
        create: {
          shopDomain,
          sessionId,
          messages: updatedGreetingSession.conversation_history as unknown as import("@prisma/client").Prisma.InputJsonValue,
          messageCount: updatedGreetingSession.conversation_history.length,
          channel: "whatsapp",
          firstUserMessage: agentInput.slice(0, 255),
          ...(customerEmailG ? { customerEmail: customerEmailG } : {}),
        },
      }).catch((err) => console.error("[wa-webhook] conversation persist failed:", err));
      return new Response("OK", { status: 200 });
    }

    // 9. Run WhatsApp agent (no streaming — memory handled internally)
    const result = await runWhatsAppAgent({
      shopDomain,
      sessionId,
      customerPhone: from,
      customerId: shopifyCustomer?.id,
      agentMessage: agentInput,
      session,
      merchant,
      accessToken: shopifyAccessToken,
    });

    const replyText = result.text?.trim() || "I'm not sure how to help with that. Could you rephrase?";

    // Human handoff detection — the escalate_human tool is the reliable signal (fires on an
    // explicit "talk to a human" ask); the regex is a fallback net for replies that read as
    // stuck/unhelpful even when the model didn't call the tool.
    const NEEDS_HUMAN_RE = /contact support|order not found|unable to help|i['’]m not sure/i;
    const needsHuman = !!result.escalate_to_human || NEEDS_HUMAN_RE.test(replyText);

    // Output safety filter + PII scrub before any send
    const filteredReply = (
      UNSAFE_OUTPUT_RE.some((re) => re.test(replyText))
        ? "I'm not able to help with that. What can I find for you today?"
        : replyText
    )
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[removed]")
      .replace(/(\+\d{1,3}[\s-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g, "[removed]");

    // 9b. Approval gate — opt-in (Merchant.requireApprovalForOffers, default off).
    // High-stakes replies (discount code, refund, order cancel/change) are held as
    // a draft for the merchant to approve/edit/reject in the Inbox instead of being
    // sent to the customer. The draft lives only in Postgres (Conversation.messages),
    // not in the Redis session — mirrors how merchant "notes" already work, so the
    // AI never sees an unsent draft as something it already said.
    if (result.requires_approval) {
      const currentSession = await getSession(shopDomain, sessionId);
      const pendingMsg = { role: "pending_approval", content: filteredReply, timestamp: Date.now() };
      const messagesWithDraft = [...currentSession.conversation_history, pendingMsg];
      await prisma.conversation.upsert({
        where: { shopDomain_sessionId: { shopDomain, sessionId } },
        update: {
          messages: messagesWithDraft as unknown as import("@prisma/client").Prisma.InputJsonValue,
          messageCount: messagesWithDraft.length,
          channel: "whatsapp",
          lastMessageAt: new Date(),
          escalated: true,
          resolved: false,
        },
        create: {
          shopDomain,
          sessionId,
          messages: messagesWithDraft as unknown as import("@prisma/client").Prisma.InputJsonValue,
          messageCount: messagesWithDraft.length,
          channel: "whatsapp",
          firstUserMessage: agentInput.slice(0, 255),
          escalated: true,
        },
      }).catch((err) => console.error("[wa-webhook] pending-approval persist failed:", err));
      console.log(`[wa-webhook] held for approval, msg ${messageId} from ${from} on ${shopDomain}`);
      return new Response("OK", { status: 200 });
    }

    // 10. Send reply — when ≥2 products, carousel replaces the text message
    const products = result.products;
    const CURRENCY_SYM: Record<string, string> = { USD: "$", INR: "₹", EUR: "€", GBP: "£" };
    console.log(`[wa-webhook] products found: ${products?.length ?? 0}`);
    if (products && products.length >= 2) {
      // Fetch ratings for carousel products — cached 1h per product, best-effort
      const ratingsMap = await fetchProductRatings(
        shopDomain, shopifyAccessToken, products.slice(0, 3).map((p) => p.id),
      ).catch(() => new Map<string, { rating: number; count: number }>());

      // Try formatter first; fall back to template if it throws
      const formatted = await formatCarousel(agentInput, products, replyText).catch(() => null);

      const t = formatted?.intro ?? filteredReply.trim();
      const cut = t.lastIndexOf(" ", 80);
      const introText = (cut > 0 ? t.slice(0, cut) : t.slice(0, 80)) || "Here are some options:";

      const cards = products.slice(0, 3).map((p, i) => {
        const fc = formatted?.cards[i];
        const sym = CURRENCY_SYM[p.currency ?? ""] ?? p.currency ?? "";
        const cardBody = fc
          ? [fc.heading, fc.description, fc.price].filter(Boolean).join("\n")
          : (() => {
              const wbSlice = (s: string, max: number) => {
                if (s.length <= max) return s;
                const cut = s.lastIndexOf(" ", max);
                return cut > 0 ? s.slice(0, cut) : s.slice(0, max);
              };
              const rawDesc = p.description
                ? p.description
                    .replace(/<[^>]*>/g, "")
                    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
                    .replace(/\s+/g, " ").trim()
                : "";
              const sentEnd = rawDesc.search(/[.!?]/);
              const firstSentence = sentEnd > 0 ? rawDesc.slice(0, sentEnd + 1) : rawDesc;
              const ptags = (p as { tags?: string[] }).tags ?? [];
              const personaPrefix = /gift|for my|for him|for her/i.test(agentInput)
                ? "Perfect gift · "
                : /budget|cheap|affordable|under \$/i.test(agentInput)
                  ? "Best value · "
                  : /premium|luxury|quality/i.test(agentInput)
                    ? "Premium quality · "
                    : "";
              const prefix =
                /eco|organic|sustainable/i.test(agentInput) && ptags.some((tag) => /eco|organic|sustainable/i.test(tag))
                  ? "Eco-friendly · "
                  : personaPrefix;
              const shortTitle = wbSlice(p.title, 25);
              const descLine = rawDesc ? prefix + wbSlice(firstSentence, 108 - prefix.length) : "";
              const boldPrice = p.price_min ? `*from ${sym}${p.price_min}*` : "";
              // ponytail: no outer wbSlice — fields are already individually bounded; sendCarousel clips to 160 anyway
              return [shortTitle, descLine, boldPrice].filter(Boolean).join("\n");
            })();
        // Variant detection — cache variants for picker; variantId prefix drives button payload
        const availableVariants = (p.variants ?? []).filter((v) => v.available);
        let variantId: string;
        if (availableVariants.length > 1) {
          void redis.set(
            `wa:variants:${p.id}`,
            JSON.stringify(availableVariants.map((v) => ({ id: v.id, title: v.title, price: v.price, currency: v.currency }))),
            "EX", 3600,
          ).catch(() => null);
          variantId = `select_variant|${p.id}|${p.url ?? ""}`;
        } else {
          variantId = `${availableVariants[0]?.id ?? p.variants?.[0]?.id ?? p.id}|${p.url ?? ""}`;
        }
        const productRating = ratingsMap.get(p.id);
        const ratingLine = productRating
          ? `⭐ ${productRating.rating.toFixed(1)} (${productRating.count.toLocaleString()} reviews)\n`
          : "";
        return { imageUrl: p.image_url, body: ratingLine + cardBody, variantId };
      });

      await sendCarousel(phoneNumberId, accessToken, from, cards, introText).catch(async (e: unknown) => {
        console.error("[wa-webhook] carousel failed, falling back to text:", (e as Error).message);
        await sendTextMessage(phoneNumberId, accessToken, from, formatted?.fallbackText ?? filteredReply).catch(() => null);
      });
      await sendReplyButtons(phoneNumberId, accessToken, from,
        "Want to narrow it down?",
        [
          { id: "filter_price", title: "💰 Filter by Price" },
          { id: "refine_search", title: "🔄 Try Different" },
          { id: "greeting_question", title: "💬 Get Help" },
        ],
      ).catch(() => null);
    } else if (products && products.length === 1) {
      await sendTextMessage(phoneNumberId, accessToken, from, filteredReply);
      const p = products[0];
      await sendReplyButtons(
        phoneNumberId,
        accessToken,
        from,
        `${p.title}${p.price_min ? ` — ${p.price_min}` : ""}`,
        [
          { id: `add_cart|${p.variants?.[0]?.id ?? p.id}|${p.url ?? ""}`, title: "Add to Cart" },
          { id: `view|https://${shopDomain}${p.url ?? ""}`, title: "View Product" },
        ],
        p.image_url,
      ).catch(() => null);
    } else if (result.checkout_url && result.cart_lines?.length) {
      // Cart view — send interactive CTA message with itemised summary
      const itemSummary = result.cart_lines
        .map((l) => `• ${l.title}${l.quantity > 1 ? ` ×${l.quantity}` : ""}${l.price ? ` — ${l.price}` : ""}`)
        .join("\n");
      const cartBody = `Your cart:\n\n${itemSummary}`;
      await sendCheckoutMessage(
        phoneNumberId, accessToken, from,
        cartBody, "", result.checkout_url, `https://${shopDomain}`,
      ).catch(async () => {
        await sendTextMessage(phoneNumberId, accessToken, from,
          `${cartBody}\n\nCheckout: ${result.checkout_url}`
        ).catch(() => null);
      });
    } else {
      await sendTextMessage(phoneNumberId, accessToken, from, filteredReply);
      if (needsHuman) {
        await sendListMessage(phoneNumberId, accessToken, from,
          "I wasn't able to find what you need. Here are some options:",
          "Browse Options",
          [{
            title: "Quick Browse",
            rows: [
              { id: "recovery_bestsellers", title: "🔥 Best Sellers", description: "Our most popular items" },
              { id: "recovery_new", title: "✨ New Arrivals", description: "Just landed in store" },
              { id: "recovery_help", title: "💬 Talk to Support", description: "Get human help" },
            ],
          }],
        ).catch(() => null);
      } else {
        await sendReplyButtons(phoneNumberId, accessToken, from,
          "Anything else I can help with?",
          [
            { id: "post_checkout_shop", title: "🛍️ Browse More" },
            { id: "post_checkout_track", title: "📦 My Orders" },
            { id: "greeting_question", title: "💬 Get Help" },
          ],
        ).catch(() => null);
      }
    }

    // 11. Append assistant reply and persist session
    await appendMessage(shopDomain, sessionId, {
      role: "assistant",
      content: filteredReply,
      timestamp: Date.now(),
    });
    const updatedSession = await getSession(shopDomain, sessionId);
    // Persist the full post-turn negotiation state — covers successful offers
    // AND blocked/not-applicable attempts, not just the last successful code.
    updatedSession.discount_negotiation = result.discount_negotiation;
    await setSession(shopDomain, sessionId, updatedSession);

    // 12. Persist to DB (fire-and-forget)
    const contactName = (value?.contacts as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
    const customerEmail = (contactName?.profile as Record<string, string> | undefined)?.email ?? null;

    const waCheckoutToken = result.checkout_url ? extractCheckoutToken(result.checkout_url) : undefined;
    const escalated = !!result.escalate_to_human;

    void prisma.conversation.upsert({
      where: { shopDomain_sessionId: { shopDomain, sessionId } },
      update: {
        messages: updatedSession.conversation_history as unknown as import("@prisma/client").Prisma.InputJsonValue,
        messageCount: updatedSession.conversation_history.length,
        channel: "whatsapp",
        lastMessageAt: new Date(),
        ...(customerEmail ? { customerEmail } : {}),
        ...(result.agent_trace?.length ? { agentTrace: result.agent_trace } : {}),
        ...(result.route_reason ? { routeReason: result.route_reason } : {}),
        ...(result.cart_id ? { cartId: result.cart_id } : {}),
        ...(result.cart_value_cents != null ? { cartValue: result.cart_value_cents / 100 } : {}),
        ...(waCheckoutToken ? { checkoutToken: waCheckoutToken } : {}),
        ...(escalated ? { escalated: true } : {}),
        // New inbound message reopens a previously-resolved conversation so it
        // resurfaces in the inbox (matches persistConversationTurn's fix).
        resolved: false,
        resolvedAt: null,
      },
      create: {
        shopDomain,
        sessionId,
        messages: updatedSession.conversation_history as unknown as import("@prisma/client").Prisma.InputJsonValue,
        messageCount: updatedSession.conversation_history.length,
        channel: "whatsapp",
        firstUserMessage: agentInput.slice(0, 255),
        ...(customerEmail ? { customerEmail } : {}),
        ...(result.agent_trace?.length ? { agentTrace: result.agent_trace } : {}),
        ...(result.route_reason ? { routeReason: result.route_reason } : {}),
        ...(result.cart_id ? { cartId: result.cart_id } : {}),
        ...(result.cart_value_cents != null ? { cartValue: result.cart_value_cents / 100 } : {}),
        escalated,
        ...(waCheckoutToken ? { checkoutToken: waCheckoutToken } : {}),
      },
    }).catch((err) => console.error("[wa-webhook] conversation persist failed:", err));

    if (escalated && merchant.escalationEmailEnabled && merchant.supportEmail) {
      sendEscalationEmail(
        merchant.supportEmail,
        sessionId,
        updatedSession.conversation_history,
        shopDomain,
      ).catch((err) => console.error("[wa-webhook] escalation email failed:", err));
    }

    console.log(`[wa-webhook] handled msg ${messageId} from ${from} on ${shopDomain}`);
  } catch (err) {
    console.error("[wa-webhook] error:", err);
    // Still return 200 — if we 5xx, Meta retries aggressively
  }

  return new Response("OK", { status: 200 });
}
