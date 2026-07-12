import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getShopCurrencyCode } from "~/lib/mcp/admin.server";
import { sendTextMessage, decryptToken } from "~/lib/whatsapp.server";
import { appendMessage } from "~/lib/session.server";
import { runQAJudge } from "~/lib/agents/merchant-analyst.server";

/**
 * Shared backend for both inbox route files (app.inbox.tsx panel view and
 * app.inbox-full.tsx full-screen view) — they were previously ~95% duplicate
 * files with byte-identical loader/action logic. This module is the single
 * source of truth; each route re-exports inboxLoader/inboxAction directly.
 */

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function getInboxData(opts: { request: Request; session: { shop: string; accessToken?: string } }) {
  const { request, session } = opts;
  const shop = session.shop;

  const url = new URL(request.url);
  const selectedId = url.searchParams.get("id") ?? null;
  const statusTab = url.searchParams.get("statusTab") ?? "pending";
  const dateRange = url.searchParams.get("dateRange") ?? "all";
  const search = url.searchParams.get("search") ?? "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1"));
  const offset = (page - 1) * 50;

  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);

  // Build main where clause
  const where: Prisma.ConversationWhereInput = { shopDomain: shop };

  if (dateRange !== "all") {
    const ms = dateRange === "24h" ? 86_400_000 : dateRange === "7d" ? 604_800_000 : 2_592_000_000;
    where.startedAt = { gte: new Date(Date.now() - ms) };
  }

  if (search.trim()) {
    where.OR = [
      { firstUserMessage: { contains: search.trim(), mode: "insensitive" } },
      { sessionId: { contains: search.trim(), mode: "insensitive" } },
    ];
  }

  // ponytail: hard-scoped to WhatsApp since it's the only active channel —
  // old website conversations are intentionally not reachable from the
  // inbox. Revert to a channel query-param toggle if the widget comes back.
  where.channel = "whatsapp";

  if (statusTab === "open") {
    where.escalated = true;
    where.resolved = false;
  } else if (statusTab === "resolved") {
    where.resolved = true;
  } else {
    // pending = AI handling or waiting on customer
    where.escalated = false;
    where.resolved = false;
  }

  // Summary counts use global shop scope (not filtered by date/outcome) but
  // stay WhatsApp-scoped like the row list, so the header numbers match.
  const countBase: Prisma.ConversationWhereInput = { shopDomain: shop, channel: "whatsapp" };

  const [conversations, totalCount, purchasedCount, inCartCount, escalatedCount, liveCount, pendingCount, resolvedCount, merchant, ratingAgg, selected, currencyCode] =
    await Promise.all([
      prisma.conversation.findMany({
        where,
        orderBy: [{ escalated: "desc" }, { lastMessageAt: "desc" }],
        take: 50,
        skip: offset,
        select: {
          id: true,
          sessionId: true,
          channel: true,
          firstUserMessage: true,
          lastMessageAt: true,
          escalated: true,
          resolved: true,
          customerId: true,
          customerName: true,
          cartValue: true,
          cartId: true,
          orderRevenueCents: true,
          orderId: true,
          qualityScore: true,
          qaMeta: true,
          aiPaused: true,
          messages: true,
          agentTrace: true,
          resolvedAt: true,
          discountCode: true,
          startedAt: true,
          messageCount: true,
        },
      }),
      prisma.conversation.count({ where: countBase }),
      prisma.conversation.count({ where: { ...countBase, orderId: { not: null } } }),
      prisma.conversation.count({ where: { ...countBase, cartId: { not: null }, orderId: null } }),
      prisma.conversation.count({ where: { ...countBase, escalated: true, resolved: false } }),
      prisma.conversation.count({ where: { ...countBase, lastMessageAt: { gte: fiveMinAgo }, resolved: false } }),
      prisma.conversation.count({ where: { ...countBase, escalated: false, resolved: false } }),
      prisma.conversation.count({ where: { ...countBase, resolved: true } }),
      prisma.merchant.findUnique({ where: { shopDomain: shop }, select: { quickReplies: true } }),
      prisma.conversation.aggregate({
        where: countBase,
        _sum: { merchantThumbsUp: true, merchantThumbsDown: true },
      }),
      selectedId
        ? prisma.conversation.findFirst({ where: { id: selectedId, shopDomain: shop } })
        : Promise.resolve(null),
      getShopCurrencyCode(session.shop, session.accessToken ?? ""),
    ]);

  const storeHandle = shop.replace(".myshopify.com", "");

  return {
    conversations,
    selected,
    totalCount, purchasedCount, inCartCount, escalatedCount, liveCount, pendingCount, resolvedCount,
    page, hasMore: conversations.length === 50,
    search, dateRange, statusTab, channel: "whatsapp" as const,
    currencyCode,
    storeHandle,
    quickReplies: merchant?.quickReplies ?? [],
    thumbsUp: ratingAgg._sum.merchantThumbsUp ?? 0,
    thumbsDown: ratingAgg._sum.merchantThumbsDown ?? 0,
  };
}

export type InboxLoaderData = Awaited<ReturnType<typeof getInboxData>>;

// ─── Action ───────────────────────────────────────────────────────────────────

export async function handleInboxAction(opts: { request: Request; session: { shop: string } }) {
  const { request, session } = opts;
  const shop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const conversationId = formData.get("conversationId") as string;

  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation || conversation.shopDomain !== shop) {
    return { error: "Not found" };
  }

  if (intent === "reply") {
    const message = (formData.get("message") as string)?.trim();
    if (!message) return { error: "Empty message" };

    const isNote = formData.get("isNote") === "true";

    if (!isNote && conversation.channel === "whatsapp") {
      const phone = conversation.sessionId.replace("whatsapp_", "");
      const merchant = await prisma.merchant.findFirst({
        where: { shopDomain: shop },
        select: { waPhoneNumberId: true, waAccessToken: true },
      });
      if (!merchant?.waPhoneNumberId || !merchant?.waAccessToken) {
        return { error: "WhatsApp is not connected. Message was not sent." };
      }
      try {
        await sendTextMessage(
          merchant.waPhoneNumberId,
          decryptToken(merchant.waAccessToken),
          phone,
          message,
        );
      } catch {
        return { error: "WhatsApp send failed. Message was not sent." };
      }
    }

    const newMsg = isNote
      ? { role: "note", content: message, timestamp: Date.now() }
      : { role: "assistant", content: `[Merchant] ${message}`, timestamp: Date.now() };

    // Atomic Postgres JSONB append — was previously a JS-level read-modify-write
    // (read conversation.messages, splice in JS, write the whole array back),
    // which silently lost a message if two replies landed within the same
    // read/write window. `messages || $1::jsonb` concatenates arrays at the DB
    // level, so concurrent appends both survive regardless of write order.
    try {
      await prisma.$executeRaw`
        UPDATE "Conversation"
        SET messages = messages || ${JSON.stringify([newMsg])}::jsonb,
            "lastMessageAt" = now()
        WHERE id = ${conversationId}
      `;
    } catch {
      // The WhatsApp send (if any) already happened — tell the merchant plainly
      // rather than let this throw into a full navigation error boundary.
      return {
        error: isNote
          ? "Note was not saved — please try again."
          : "Message was sent to the customer, but saving it failed — refresh to confirm.",
      };
    }

    // Mirror real replies (not notes) into the Redis session so the AI has them
    // as context after resume, and so web customers receive them on their next
    // message while paused (api.chat.tsx paused branch).
    if (!isNote) {
      await appendMessage(shop, conversation.sessionId, {
        role: "assistant",
        content: `[Merchant] ${message}`,
        timestamp: Date.now(),
      }).catch(() => null);
    }
  } else if (intent === "resolve") {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { resolved: true, resolvedAt: new Date(), escalated: false },
    });
    void runQAJudge(conversationId);
  } else if (intent === "train") {
    const question = (formData.get("question") as string)?.trim();
    const answer = (formData.get("answer") as string)?.trim();
    if (question && answer) {
      const merchant = await prisma.merchant.findUnique({ where: { shopDomain: shop } });
      const faqs = Array.isArray(merchant?.customFaqs) ? (merchant!.customFaqs as { question: string; answer: string }[]) : [];
      if (faqs.length < 20) {
        await prisma.merchant.update({
          where: { shopDomain: shop },
          data: { customFaqs: [...faqs, { question, answer }] },
        });
      }
    }
  } else if (intent === "escalate") {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { escalated: true, resolved: false },
    });
  } else if (intent === "pause-ai") {
    const pause = formData.get("pause") === "true";
    await prisma.conversation.update({
      where: { id: conversationId },
      // Pausing the AI means the merchant is taking over — also enable the reply
      // box (escalated: true) in the same action, so "AI is paused" never leaves
      // the merchant with no way to actually reply. Resuming AI doesn't force
      // un-escalation, since the merchant may still want manual control.
      data: pause ? { aiPaused: true, escalated: true, resolved: false } : { aiPaused: false },
    });
  } else if (intent === "rate-message") {
    const messageTimestamp = Number(formData.get("messageTimestamp"));
    const rawRating = formData.get("rating");
    const rating = rawRating === "up" || rawRating === "down" ? rawRating : null; // null = un-rate
    if (!Number.isFinite(messageTimestamp)) return { error: "Invalid message" };

    const existing = Array.isArray(conversation.messages)
      ? (conversation.messages as Array<{ role?: string; content?: string; timestamp?: number; merchantRating?: "up" | "down" }>)
      : [];
    const target = existing.find(
      (m) => m.timestamp === messageTimestamp && m.role === "assistant" && !m.content?.startsWith("[Merchant]"),
    );
    if (!target) return { error: "Message not ratable" };

    const prevRating = target.merchantRating;
    if (rating) target.merchantRating = rating;
    else delete target.merchantRating;

    const upDelta = (rating === "up" ? 1 : 0) - (prevRating === "up" ? 1 : 0);
    const downDelta = (rating === "down" ? 1 : 0) - (prevRating === "down" ? 1 : 0);

    // Optimistic-lock guard: this path mutates an existing array element (not a
    // pure append), so the atomic-JSONB-concat trick used for replies doesn't
    // apply. Instead, require the row's lastMessageAt to match what we just
    // read — if another write landed in between, count() is 0 and we tell the
    // merchant to refresh instead of silently clobbering it. Lower stakes than
    // a lost customer reply (this is a thumbs-up/down flip), so detect-and-
    // reject is the right amount of engineering here.
    const { count } = await prisma.conversation.updateMany({
      where: { id: conversationId, lastMessageAt: conversation.lastMessageAt },
      data: {
        messages: existing as unknown as Prisma.InputJsonValue,
        ...(upDelta ? { merchantThumbsUp: { increment: upDelta } } : {}),
        ...(downDelta ? { merchantThumbsDown: { increment: downDelta } } : {}),
      },
    });
    if (count === 0) {
      return { error: "This conversation changed — refresh and try again." };
    }
  }

  return null;
}

export type InboxActionResult = Awaited<ReturnType<typeof handleInboxAction>>;

// ─── Route-ready wrappers ───────────────────────────────────────────────────

export async function inboxLoader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  return getInboxData({ request, session });
}

export async function inboxAction({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  return handleInboxAction({ request, session });
}
