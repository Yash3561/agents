/**
 * GET  /api/whatsapp/webhook — Meta webhook verification handshake
 * POST /api/whatsapp/webhook — Inbound WhatsApp messages from Meta Cloud API
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { verifyWebhookSignature, decryptToken, sendTextMessage } from "~/lib/whatsapp.server";
import { getSession, setSession, appendMessage } from "~/lib/session.server";
import { runWhatsAppAgent } from "~/lib/agents/whatsapp.server";
import { lookupCustomerByPhone } from "~/lib/mcp/admin.server";

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
    if (!textBody) return new Response("OK", { status: 200 }); // non-text (image/voice/etc.)

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

    // 5. Load session from Redis
    const session = await getSession(shopDomain, sessionId);

    // 6. Append user message to history
    await appendMessage(shopDomain, sessionId, {
      role: "user",
      content: textBody,
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

    // 9. Run WhatsApp agent (no streaming — memory handled internally)
    const result = await runWhatsAppAgent({
      shopDomain,
      customerPhone: from,
      customerId: shopifyCustomer?.id,
      agentMessage: textBody,
      session,
      merchant,
      accessToken: shopifyAccessToken,
    });

    const replyText = result.text?.trim() || "I'm not sure how to help with that. Could you rephrase?";

    // 10. Send reply
    await sendTextMessage(phoneNumberId, accessToken, from, replyText);

    // 11. Append assistant reply and persist session
    await appendMessage(shopDomain, sessionId, {
      role: "assistant",
      content: replyText,
      timestamp: Date.now(),
    });
    const updatedSession = await getSession(shopDomain, sessionId);
    await setSession(shopDomain, sessionId, updatedSession);

    // 12. Persist to DB (fire-and-forget)
    const contactName = (value?.contacts as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
    const customerEmail = (contactName?.profile as Record<string, string> | undefined)?.email ?? null;

    void prisma.conversation.upsert({
      where: { shopDomain_sessionId: { shopDomain, sessionId } },
      update: {
        messages: updatedSession.conversation_history as unknown as import("@prisma/client").Prisma.InputJsonValue,
        messageCount: updatedSession.conversation_history.length,
        channel: "whatsapp",
        lastMessageAt: new Date(),
        ...(customerEmail ? { customerEmail } : {}),
      },
      create: {
        shopDomain,
        sessionId,
        messages: updatedSession.conversation_history as unknown as import("@prisma/client").Prisma.InputJsonValue,
        messageCount: updatedSession.conversation_history.length,
        channel: "whatsapp",
        firstUserMessage: textBody.slice(0, 255),
        ...(customerEmail ? { customerEmail } : {}),
      },
    }).catch((err) => console.error("[wa-webhook] conversation persist failed:", err));

    // Log for dedup — Meta may resend if we're slow; idempotency by messageId would require Redis key
    console.log(`[wa-webhook] handled msg ${messageId} from ${from} on ${shopDomain}`);
  } catch (err) {
    console.error("[wa-webhook] error:", err);
    // Still return 200 — if we 5xx, Meta retries aggressively
  }

  return new Response("OK", { status: 200 });
}
