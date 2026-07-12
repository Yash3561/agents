import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useFetcher, useLoaderData, useRouteError, useSearchParams, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { Prisma } from "@prisma/client";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { adminGraphql } from "../lib/mcp/admin.server";
import { sendTextMessage, decryptToken } from "../lib/whatsapp.server";
import { appendMessage } from "../lib/session.server";
import { runQAJudge } from "../lib/agents/merchant-analyst.server";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MessageBubble } from "~/components/MessageBubble";
import { FilterButtonGroup } from "~/components/FilterButtonGroup";
import { JourneyFunnel } from "~/components/JourneyFunnel";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: string;
  content: string;
  timestamp?: number;
  merchantRating?: "up" | "down";
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string | null> = {
  search_catalog: "Searched product catalog",
  lookup_catalog: "Looked up product details",
  get_product: "Fetched product info",
  create_cart: "Created cart",
  update_cart: "Updated cart",
  get_cart: "Checked cart contents",
  get_checkout_url: "Generated checkout link",
  offer_discount: "Offered discount code",
  search_policies_and_faqs: "Checked store policies",
  get_order: "Looked up order",
  get_customer_orders: "Fetched order history",
  unified: null, // internal routing — skip
};

const DATE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
] as const;

const CHANNEL_OPTS = [
  { value: "all", label: "All" },
  { value: "web", label: "Web" },
  { value: "whatsapp", label: "WhatsApp" },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relTime(d: Date | string) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function formatPhone(sessionId: string): string {
  const digits = sessionId.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return `+${digits}`;
}

type StatusKey = "needsReply" | "aiHandling" | "aiPaused" | "resolved";

function getConversationStatus(conv: { resolved?: boolean | null; escalated?: boolean | null; aiPaused?: boolean | null }, isAiPaused?: boolean): StatusKey {
  if (conv.resolved) return "resolved";
  if (isAiPaused ?? conv.aiPaused) return "aiPaused";
  if (conv.escalated) return "needsReply";
  return "aiHandling";
}

function statusLabel(status: StatusKey) {
  return status === "needsReply"
    ? "Needs reply"
    : status === "aiHandling"
    ? "AI handling"
    : status === "aiPaused"
    ? "AI paused"
    : "Resolved";
}

function statusTone(status: StatusKey): "success" | "warning" | "info" {
  return status === "resolved" ? "success" : status === "needsReply" || status === "aiPaused" ? "warning" : "info";
}

function ChannelIndicator({ channel, size = 32 }: { channel?: string | null; size?: number }) {
  const isWA = channel === "whatsapp";
  return (
    <div style={{
      width: size,
      height: size,
      borderRadius: "50%",
      flexShrink: 0,
      background: "var(--color-surface-default)",
      border: `1px solid ${isWA ? "var(--color-channel-whatsapp)" : "var(--color-border)"}`,
      color: isWA ? "var(--color-channel-whatsapp)" : "var(--color-channel-web)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}>
      <svg width={size > 24 ? 16 : 12} height={size > 24 ? 16 : 12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        {isWA ? (
          <path d="M4.2 13.2 2.5 14l.5-1.9A6 6 0 1 1 4.2 13.2Zm1.5-7.7c.2-.2.5-.2.7 0l.8 1c.2.2.2.5 0 .7l-.4.5c.4.8 1 1.4 1.8 1.8l.5-.4c.2-.2.5-.2.7 0l1 .8c.2.2.2.5 0 .7-.4.5-.9.8-1.5.7-2.1-.3-4-2.2-4.3-4.3-.1-.6.2-1.1.7-1.5Z" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M2.5 4.5h11v7h-11v-7Zm4 9h3M8 11.5v2" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </div>
  );
}

function EmptyState({
  heading,
  subtext,
  action,
}: {
  heading: string;
  subtext: string;
  action?: React.ReactNode;
}) {
  return (
    <div style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--spacing-sm)", color: "var(--color-neutral)" }}>
      <div style={{ width: 48, height: 48, borderRadius: "var(--radius-base)", background: "var(--color-surface-default)", border: "1px solid var(--color-border)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-neutral)" }}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="M5 6.5A3.5 3.5 0 0 1 8.5 3h7A3.5 3.5 0 0 1 19 6.5v5A3.5 3.5 0 0 1 15.5 15H11l-4.5 4v-4A3.5 3.5 0 0 1 5 11.5v-5Z" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9 8h6M9 11h4" strokeLinecap="round" />
        </svg>
      </div>
      <div style={{ fontSize: "var(--type-empty-heading)", fontWeight: 700, color: "var(--color-text)" }}>{heading}</div>
      <div style={{ fontSize: "var(--type-empty-subtext)", lineHeight: "var(--line-body)", maxWidth: 320 }}>{subtext}</div>
      {action}
    </div>
  );
}

function ThreePanelSkeleton() {
  const line = (width: string, height = "12px") => (
    <div style={{ width, height, borderRadius: "var(--radius-pill)", background: "var(--color-skeleton)" }} />
  );
  return (
    <div style={{ display: "flex", height: "calc(100vh - 120px)", minHeight: 600 }}>
      <div style={{ width: 300, flexShrink: 0, borderRight: "1px solid var(--color-border)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "var(--spacing-sm) var(--spacing-md-sm)", borderBottom: "1px solid var(--color-border)", display: "flex", gap: "var(--spacing-sm)" }}>{line("52px")}{line("68px")}</div>
        <div style={{ padding: "var(--spacing-sm) var(--spacing-md-sm)", borderBottom: "1px solid var(--color-border)" }}>{line("100%", "32px")}</div>
        <div style={{ padding: "var(--spacing-md-sm)", display: "flex", flexDirection: "column", gap: "var(--spacing-md-sm)" }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} style={{ display: "flex", gap: "var(--spacing-md-sm)", alignItems: "center" }}>
              {line("32px", "32px")}
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>{line("70%")}{line("90%")}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, borderRight: "1px solid var(--color-border)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "var(--spacing-md-sm) var(--spacing-md)", borderBottom: "1px solid var(--color-border)", display: "flex", gap: "var(--spacing-md-sm)", alignItems: "center" }}>{line("32px", "32px")}{line("180px")}</div>
        <div style={{ padding: "var(--spacing-md)", borderBottom: "1px solid var(--color-border)" }}>{line("100%", "52px")}</div>
        <div style={{ flex: 1, padding: "var(--spacing-md)", display: "flex", flexDirection: "column", gap: "var(--spacing-md-sm)" }}>{line("55%", "36px")}{line("68%", "36px")}{line("45%", "36px")}</div>
      </div>
      <div style={{ width: 280, flexShrink: 0, padding: "var(--spacing-md)", display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>{line("80px")}{line("140px")}{line("120px")}{line("160px")}</div>
    </div>
  );
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const selectedId = url.searchParams.get("id") ?? null;
  const channel = url.searchParams.get("channel") ?? "all";
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

  if (channel === "whatsapp") {
    where.channel = "whatsapp";
  } else if (channel === "web") {
    where.NOT = { channel: "whatsapp" };
  }

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

  // Summary counts use global shop scope (not filtered by date/outcome/channel)
  const countBase: Prisma.ConversationWhereInput = { shopDomain: shop };

  const [conversations, totalCount, purchasedCount, inCartCount, escalatedCount, liveCount, pendingCount, resolvedCount, merchant, ratingAgg, selected, currencyResult] =
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
      adminGraphql<{ shop: { currencyCode: string } }>(
        session.shop,
        session.accessToken ?? "",
        `{ shop { currencyCode } }`,
      ).catch(() => null),
    ]);

  const currencyCode = currencyResult?.shop?.currencyCode ?? "USD";

  const storeHandle = shop.replace(".myshopify.com", "");

  return {
    conversations,
    selected,
    totalCount, purchasedCount, inCartCount, escalatedCount, liveCount, pendingCount, resolvedCount,
    page, hasMore: conversations.length === 50,
    search, dateRange, statusTab, channel,
    currencyCode,
    storeHandle,
    quickReplies: merchant?.quickReplies ?? [],
    thumbsUp: ratingAgg._sum.merchantThumbsUp ?? 0,
    thumbsDown: ratingAgg._sum.merchantThumbsDown ?? 0,
  };
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
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

    const existing = Array.isArray(conversation.messages)
      ? (conversation.messages as object[])
      : [];
    const newMsg = isNote
      ? { role: "note", content: message, timestamp: Date.now() }
      : { role: "assistant", content: `[Merchant] ${message}`, timestamp: Date.now() };
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        messages: [...existing, newMsg],
        lastMessageAt: new Date(),
      },
    });
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
      data: { aiPaused: pause },
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

    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        messages: existing as unknown as import("@prisma/client").Prisma.InputJsonValue,
        ...(upDelta ? { merchantThumbsUp: { increment: upDelta } } : {}),
        ...(downDelta ? { merchantThumbsDown: { increment: downDelta } } : {}),
      },
    });
  }

  return null;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

// ─── Component ────────────────────────────────────────────────────────────────

export default function Inbox() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const {
    conversations,
    totalCount, purchasedCount, inCartCount, escalatedCount, liveCount,
    page, hasMore,
    search, dateRange, statusTab, channel,
    currencyCode, storeHandle,
    quickReplies,
    thumbsUp, thumbsDown,
  } = loaderData;

  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const prevNavState = useRef("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Reply mode: "reply" sends to customer, "note" saves as internal note
  const [replyMode, setReplyMode] = useState<"reply" | "note">("reply");

  // Status tab (Needs reply / AI handling / Resolved)
  const [activeTab, setActiveTab] = useState(statusTab ?? "pending");

  // Controlled reply textarea + macro overlay
  const [replyText, setReplyText] = useState("");
  const [showMacros, setShowMacros] = useState(false);
  const [macroQuery, setMacroQuery] = useState("");

  // Browser notification permission state
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>(
    typeof window !== "undefined" && "Notification" in window ? Notification.permission : "denied",
  );

  // Pause/resume AI fetcher
  const pauseFetcher = useFetcher<typeof action>();

  // Message rating fetcher — optimistic local overrides keyed by message timestamp,
  // since the loader only refreshes on navigation/SSE and a rating click shouldn't wait for that
  const rateFetcher = useFetcher<typeof action>();
  const [ratingOverrides, setRatingOverrides] = useState<Record<number, "up" | "down" | undefined>>({});
  function rateMessage(conversationId: string, messageTimestamp: number, rating: "up" | "down" | undefined) {
    setRatingOverrides((prev) => ({ ...prev, [messageTimestamp]: rating }));
    rateFetcher.submit(
      { intent: "rate-message", conversationId, messageTimestamp: String(messageTimestamp), rating: rating ?? "" },
      { method: "POST" },
    );
  }

  useEffect(() => {
    const error = (rateFetcher.data as { error?: string } | undefined)?.error;
    if (rateFetcher.state === "idle" && error) {
      shopify.toast.show(error, { isError: true });
    }
  }, [rateFetcher.state, rateFetcher.data, shopify]);

  // SSE real-time: track last update time and hold merged updates
  type ConvItem = typeof conversations[number];
  const [lastSeen, setLastSeen] = useState(() => new Date().toISOString());
  const [realtimeConvs, setRealtimeConvs] = useState<ConvItem[]>([]);
  const [otherViewers, setOtherViewers] = useState(0);
  // ponytail: sseKey increments to restart the SSE effect on error/reconnect (lastSeen alone can't do this — it's excluded from deps)
  const [sseKey, setSseKey] = useState(0);
  // ponytail: local state drives instant selection — no loader round-trip on click
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(loaderData.selected?.id ?? null);

  // Merge SSE updates into loader conversations — must come before selected/selectedId
  const allConversations = useMemo<ConvItem[]>(() => {
    if (realtimeConvs.length === 0) return conversations;
    const map = new Map(conversations.map((c) => [c.id, c]));
    for (const c of realtimeConvs) {
      map.set(c.id, { ...map.get(c.id), ...c } as ConvItem);
    }
    return Array.from(map.values()).sort((a, b) => {
      if (a.escalated !== b.escalated) return a.escalated ? -1 : 1;
      return new Date(b.lastMessageAt as unknown as string).getTime() -
             new Date(a.lastMessageAt as unknown as string).getTime();
    });
  }, [conversations, realtimeConvs]);

  // Find selected from already-loaded list — instant, no loader round-trip
  const selected = useMemo(
    () => allConversations.find((c) => c.id === localSelectedId) ?? loaderData.selected ?? null,
    [allConversations, localSelectedId, loaderData.selected],
  );

  const selectedId = selected?.id ?? null;

  const isAiPaused = pauseFetcher.formData
    ? pauseFetcher.formData.get("pause") === "true"
    : selected?.aiPaused ?? false;
  const selectedStatus = selected ? getConversationStatus(selected, isAiPaused) : null;

  // One-time: auto-request notification permission on inbox load
  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().then(setNotifPermission).catch(() => {});
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams({ since: lastSeen });
    if (selectedId) params.set("conv", selectedId);
    const es = new EventSource(`/api/events?${params.toString()}`);

    es.addEventListener("update", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { conversations: ConvItem[]; ts: string };
        setLastSeen(data.ts);
        setRealtimeConvs((prev) => {
          const map = new Map(prev.map((c) => [c.id, c]));
          for (const c of data.conversations) {
            map.set(c.id, { ...map.get(c.id), ...c } as ConvItem);
          }
          return Array.from(map.values()).sort((a, b) => {
            if (a.escalated !== b.escalated) return a.escalated ? -1 : 1;
            return new Date(b.lastMessageAt as unknown as string).getTime() -
                   new Date(a.lastMessageAt as unknown as string).getTime();
          });
        });

        // Browser notification + audio ping when tab is not focused
        if (
          typeof document !== "undefined" &&
          document.visibilityState === "hidden" &&
          data.conversations.length > 0
        ) {
          // Visual notification
          if ("Notification" in window && Notification.permission === "granted") {
            const newest = data.conversations[0];
            const body = newest.firstUserMessage
              ? newest.firstUserMessage.slice(0, 100)
              : "New message received";
            const notif = new Notification("NeonPing — New message", {
              body,
              icon: "/favicon.ico",
              tag: `conv-${newest.id}`, // dedupes — same conv won't double-notify
              silent: false,
            });
            setTimeout(() => notif.close(), 5000);
            notif.onclick = () => {
              window.focus();
              notif.close();
              selectConversation(newest.id);
            };
          }

          // Audio ping via Web Audio API — no external file needed
          try {
            const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            const ctx = new AudioCtx();
            const oscillator = ctx.createOscillator();
            const gain = ctx.createGain();
            oscillator.connect(gain);
            gain.connect(ctx.destination);
            oscillator.type = "sine";
            oscillator.frequency.setValueAtTime(880, ctx.currentTime);
            gain.gain.setValueAtTime(0.1, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
            oscillator.start(ctx.currentTime);
            oscillator.stop(ctx.currentTime + 0.3);
          } catch { /* Web Audio not available — silent fail */ }
        }
      } catch { /* ignore parse errors */ }
    });

    es.addEventListener("presence", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { conv_id: string; viewer_count: number };
        if (data.conv_id === selectedId) {
          setOtherViewers(Math.max(0, data.viewer_count - 1));
        }
      } catch { /* ignore */ }
    });

    es.addEventListener("reconnect", () => {
      es.close();
      // ponytail: setSseKey (not setLastSeen) — sseKey IS in the dep array so this actually restarts the effect
      setTimeout(() => setSseKey((k) => k + 1), 1000);
    });

    es.onerror = () => {
      es.close();
      setTimeout(() => setSseKey((k) => k + 1), 5000);
    };

    return () => es.close();
  // lastSeen excluded: update events must not cause reconnects (would loop). sseKey triggers reconnects only on error/server-reconnect.
  }, [selectedId, sseKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const listRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: allConversations.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 80,
    overscan: 5,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  // Clear textarea and reset mode after submission
  useEffect(() => {
    if (prevNavState.current === "submitting" && navigation.state === "idle") {
      if ((actionData as { error?: string } | undefined)?.error) {
        prevNavState.current = navigation.state;
        return;
      }
      if (replyRef.current) replyRef.current.value = "";
      setReplyText("");
      setReplyMode("reply");
    }
    prevNavState.current = navigation.state;
  }, [navigation.state, actionData]);

  useEffect(() => {
    const error = (actionData as { error?: string } | undefined)?.error;
    if (error) {
      shopify.toast.show(error, { isError: true });
    }
  }, [actionData, shopify]);

  // Sync search input when URL param changes (e.g. after filter reset)
  useEffect(() => {
    if (searchInputRef.current) searchInputRef.current.value = search;
  }, [search]);

  const isSubmitting = navigation.state === "submitting";
  const isRouteLoading = navigation.state === "loading";

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    next.set(key, value);
    next.set("page", "1");
    next.delete("id");
    setSearchParams(next);
  }

  function selectConversation(id: string) {
    setLocalSelectedId(id);
    setOtherViewers(0);
    const next = new URLSearchParams(searchParams);
    next.set("id", id);
    setSearchParams(next, { replace: true });
  }

  function nextPage() {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(page + 1));
    setSearchParams(next);
  }

  function handleSearch(value: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (value.trim()) next.set("search", value.trim());
      else next.delete("search");
      next.set("page", "1");
      next.delete("id");
      setSearchParams(next);
    }, 400);
  }

  const fmtMoney = (dollars: number) =>
    new Intl.NumberFormat("en", { style: "currency", currency: currencyCode }).format(dollars);

  const filteredMacros = (quickReplies as string[]).filter((r) =>
    r.toLowerCase().includes(macroQuery.toLowerCase()),
  );

  const requestNotifPermission = async () => {
    if ("Notification" in window) {
      const result = await Notification.requestPermission();
      setNotifPermission(result);
    }
  };

  // Selected conversation data
  const msgs = selected && Array.isArray(selected.messages)
    ? (selected.messages as unknown as ChatMessage[])
    : [];

  const agentTraceArr = selected && Array.isArray(selected.agentTrace)
    ? (selected.agentTrace as string[])
    : [];

  const aiActions = agentTraceArr
    .map((step) => (step in TOOL_LABELS ? TOOL_LABELS[step] : null))
    .filter((a): a is string => a !== null);

  return (
    <s-page heading="Inbox">
      {/* ponytail: s-app-window is a Shopify web component; show() opens full-viewport overlay */}
      <s-app-window id="inbox-win" src="/app/inbox-full" />
      {isRouteLoading ? (
        <ThreePanelSkeleton />
      ) : (
      <div style={{ display: "flex", height: "calc(100vh - 120px)", minHeight: "600px" }}>

        {/* ── Left Panel: Conversation List ────────────────────────────────── */}
        <div style={{ width: 300, flexShrink: 0, borderRight: "1px solid var(--color-border)", display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Notification permission prompt */}
          {notifPermission === "default" && (
            <div style={{ padding: "8px 12px", background: "var(--color-surface)", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <s-text tone="neutral">Enable notifications to get alerted when customers message</s-text>
              <s-button variant="tertiary" onClick={requestNotifPermission}>Enable</s-button>
            </div>
          )}

          {/* Summary bar */}
          <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--color-border)", fontSize: "12px", color: "var(--color-neutral)", display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
            <span>{totalCount} total</span>
            {purchasedCount > 0 && <span style={{ color: "var(--color-success)" }}>● {purchasedCount} purchased</span>}
            {inCartCount > 0 && <span style={{ color: "var(--color-cart)" }}>● {inCartCount} in cart</span>}
            {escalatedCount > 0 && <span style={{ color: "var(--color-warning)" }}>● {escalatedCount} needs reply</span>}
            {liveCount > 0 && <s-badge tone="success">{liveCount} live</s-badge>}
            {thumbsUp + thumbsDown > 0 && (
              <span title={`${thumbsUp} rated helpful, ${thumbsDown} rated not helpful`}>
                {Math.round((thumbsUp / (thumbsUp + thumbsDown)) * 100)}% rated helpful ({thumbsUp} helpful, {thumbsDown} not helpful)
              </span>
            )}
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" }}>
              <s-badge tone="success">Live</s-badge>
              <button
                onClick={() => (document.getElementById("inbox-win") as unknown as { show(): void })?.show()}
                style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, padding: "4px 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)", background: "var(--color-surface-default)", cursor: "pointer" }}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Full screen
              </button>
            </span>
          </div>

          {/* Search */}
          <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--color-border)" }}>
            <input
              ref={searchInputRef}
              type="search"
              placeholder="Search conversations..."
              defaultValue={search}
              onChange={(e) => handleSearch(e.target.value)}
              style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", fontSize: "13px", boxSizing: "border-box", outline: "none" }}
            />
          </div>

          {/* Status tabs */}
          <div style={{ display: "flex", borderBottom: "2px solid var(--color-border)" }}>
            {([
              { key: "open", label: "Needs reply", activeColor: "var(--color-warning)" },
              { key: "pending", label: "AI handling", activeColor: "var(--color-neutral)" },
              { key: "resolved", label: "Resolved", activeColor: "var(--color-success)" },
            ] as const).map((tab) => (
              <button
                key={tab.key}
                onClick={() => { setActiveTab(tab.key); setFilter("statusTab", tab.key); }}
                style={{
                  flex: 1, padding: "var(--spacing-sm) var(--spacing-xs)", border: "none", background: "none", cursor: "pointer",
                  fontSize: "var(--type-metadata)", fontWeight: activeTab === tab.key ? 600 : 400,
                  color: activeTab === tab.key ? tab.activeColor : "var(--color-neutral)",
                  borderBottom: activeTab === tab.key ? `2px solid ${tab.activeColor}` : "2px solid transparent",
                  marginBottom: -2, display: "flex", alignItems: "center", justifyContent: "center", gap: "var(--spacing-xs)",
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Filters */}
          <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: "4px" }}>
            <FilterButtonGroup options={DATE_OPTIONS} value={dateRange} onChange={(v) => setFilter("dateRange", v)} />
            <FilterButtonGroup options={CHANNEL_OPTS} value={channel} onChange={(v) => setFilter("channel", v)} />
          </div>

          {/* Conversation rows */}
          <div ref={listRef} style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
            {allConversations.length === 0 ? (
              <div style={{ padding: "var(--spacing-lg) var(--spacing-md)" }}>
                <EmptyState
                  heading={search || channel !== "all" || dateRange !== "all" ? "No matching conversations" : "No conversations yet"}
                  subtext={search || channel !== "all" || dateRange !== "all" ? "Try a different search, channel, or date filter." : "Customer conversations will appear here when NeonPing receives them."}
                />
              </div>
            ) : (
              <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const conv = allConversations[virtualRow.index];
                  const isWA = conv.channel === "whatsapp";
                  const rowStatus = getConversationStatus(conv);
                  const hasRevenue = conv.orderRevenueCents != null && conv.orderRevenueCents > 0;
                  const displayName = conv.customerName ?? (isWA ? formatPhone(conv.sessionId) : "Visitor");
                  const isSelected = conv.id === localSelectedId;
                  const convMsgs = Array.isArray(conv.messages) ? (conv.messages as Array<{ role: string }>) : [];
                  const lastRole = convMsgs.length > 0 ? convMsgs[convMsgs.length - 1]?.role : null;
                  const isUnread = rowStatus === "needsReply" && lastRole === "user";
                  return (
                    <div
                      key={conv.id}
                      data-index={virtualRow.index}
                      ref={rowVirtualizer.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <div
                        role="button"
                        tabIndex={0}
                        aria-label={conv.firstUserMessage ?? "Conversation"}
                        onClick={() => selectConversation(conv.id)}
                        onKeyDown={(e) => e.key === "Enter" && selectConversation(conv.id)}
                        style={{
                          padding: "var(--spacing-md-sm) var(--spacing-md)",
                          cursor: "pointer",
                          background: "var(--color-surface-default)",
                          borderBottom: "1px solid var(--color-border)",
                          borderLeft: isSelected ? "3px solid var(--color-selection)" : "3px solid transparent",
                          display: "flex",
                          alignItems: "flex-start",
                          gap: "var(--spacing-md-sm)",
                          minHeight: 72,
                        }}
                      >
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: isUnread ? "var(--color-warning)" : "transparent", marginTop: "var(--spacing-md-sm)", flexShrink: 0 }} />
                        <ChannelIndicator channel={conv.channel} />

                        {/* Content */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {/* Row 1: name + time */}
                          <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", marginBottom: "var(--spacing-xs)" }}>
                            <span style={{ fontWeight: 600, fontSize: "var(--type-row)", color: "var(--color-text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {displayName}
                            </span>
                            <span style={{ fontSize: "var(--type-metadata)", color: "var(--color-neutral)", flexShrink: 0, opacity: 0.8 }}>
                              {relTime(conv.lastMessageAt)}
                            </span>
                          </div>

                          <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
                            <span style={{ fontSize: "var(--type-metadata)", color: "var(--color-neutral)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.85 }}>
                              {(conv.firstUserMessage ?? "").slice(0, 60) || "No messages yet"}
                            </span>
                            <s-badge tone={statusTone(rowStatus)}>{statusLabel(rowStatus)}</s-badge>
                            {hasRevenue && (
                              <s-badge tone="success">${((conv.orderRevenueCents ?? 0) / 100).toFixed(0)}</s-badge>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {hasMore && (
              <div style={{ padding: "12px", textAlign: "center" }}>
                <s-button variant="tertiary" onClick={nextPage}>
                  Load more conversations
                </s-button>
              </div>
            )}
          </div>
        </div>

        {/* ── Center Panel: Transcript ──────────────────────────────────────── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", borderRight: "1px solid var(--color-border)" }}>
          {!selected ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "var(--spacing-xl) var(--spacing-lg)", background: "var(--color-surface)" }}>
              <EmptyState heading="Select a conversation" subtext="Choose a conversation from the list to view the transcript and reply." />
            </div>
          ) : (
            <>
              <div style={{ padding: "var(--spacing-md-sm) var(--spacing-md)", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", gap: "var(--spacing-md-sm)", background: "var(--color-surface-default)", flexShrink: 0 }}>
                <ChannelIndicator channel={selected.channel} />
                <span style={{ fontWeight: 600, fontSize: "var(--type-panel-title)", flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {selected.customerName ?? (selected.channel === "whatsapp" ? formatPhone(selected.sessionId) : "Visitor")}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", flexShrink: 0 }}>
                  {selectedStatus && <s-badge tone={statusTone(selectedStatus)}>{statusLabel(selectedStatus)}</s-badge>}
                  {!selected.resolved && (
                    <Form method="post" style={{ display: "inline" }}>
                      <input type="hidden" name="intent" value="resolve" />
                      <input type="hidden" name="conversationId" value={selected.id} />
                      <button type="submit" style={{ fontSize: "var(--type-metadata)", padding: "var(--spacing-xs) var(--spacing-md-sm)", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)", background: "var(--color-surface-default)", cursor: "pointer" }}>Resolve</button>
                    </Form>
                  )}
                  {!selected.resolved && (
                    <pauseFetcher.Form method="POST" style={{ display: "inline" }}>
                      <input type="hidden" name="intent" value="pause-ai" />
                      <input type="hidden" name="conversationId" value={selected.id} />
                      <input type="hidden" name="pause" value={isAiPaused ? "false" : "true"} />
                      <button type="submit" style={{ fontSize: "var(--type-metadata)", padding: "var(--spacing-xs) var(--spacing-md-sm)", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)", background: "var(--color-surface-default)", cursor: "pointer", color: isAiPaused ? "var(--color-warning)" : "var(--color-neutral)" }}>
                        {isAiPaused ? "Resume AI" : "Pause AI"}
                      </button>
                    </pauseFetcher.Form>
                  )}
                </div>
              </div>

              {/* Collision banner — another browser tab or team member has this convo open */}
              {otherViewers > 0 && (
                <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--color-border)" }}>
                  <s-banner tone="warning">
                    {otherViewers === 1
                      ? "Someone else is also viewing this conversation — coordinate before replying."
                      : `${otherViewers} others are viewing this conversation.`}
                  </s-banner>
                </div>
              )}

              {/* Resolved banner */}
              {selected.resolved && (
                <div style={{ padding: "8px 12px", background: "var(--color-surface)", borderBottom: "1px solid var(--color-border)", display: "flex", gap: "8px", alignItems: "center" }}>
                  <s-badge tone="success">Resolved</s-badge>
                  {selected.resolvedAt && (
                    <s-text tone="neutral">{new Date(selected.resolvedAt as unknown as string).toLocaleDateString()}</s-text>
                  )}
                </div>
              )}

              {/* Journey funnel */}
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--color-border)", background: "var(--color-surface)" }}>
                <JourneyFunnel
                  browsed={agentTraceArr.includes("search_catalog")}
                  inCart={!!selected.cartId}
                  purchased={!!selected.orderId}
                  cartValue={selected.cartValue}
                  orderRevenue={selected.orderRevenueCents}
                  currency={currencyCode}
                  compact={true}
                />
              </div>

              {/* Escalation note */}
              {selected.escalated && !selected.resolved && (
                <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--color-border)" }}>
                  <s-banner tone="warning">Merchant reply enabled — use the box below to respond directly.</s-banner>
                </div>
              )}

              {/* AI paused banner */}
              {isAiPaused && (
                <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--color-border)" }}>
                  <s-banner tone="warning">
                    AI is paused — you&apos;re handling this conversation. Replies you send are from you, not the AI.
                  </s-banner>
                </div>
              )}

              {/* Messages */}
              <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: "4px" }}>
                {msgs.length === 0 ? (
                  <EmptyState heading="No messages yet" subtext="Transcript messages will appear here as the conversation progresses." />
                ) : msgs.map((msg, i) => {
                  if (msg.role === "note") {
                    return (
                      <div key={i} style={{ margin: "8px 0", padding: "8px 12px", background: "var(--color-warning-surface)", border: "1px solid var(--color-warning-border)", borderRadius: "var(--radius-base)", borderLeft: "3px solid var(--color-warning)" }}>
                        <div style={{ fontSize: "12px", color: "var(--color-warning)", fontWeight: 600, marginBottom: "4px" }}>Internal note</div>
                        <div style={{ fontSize: "13px", color: "var(--color-text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{msg.content}</div>
                        {msg.timestamp && (
                          <div style={{ fontSize: "12px", color: "var(--color-neutral-light)", marginTop: "4px" }}>
                            {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </div>
                        )}
                      </div>
                    );
                  }
                  const hasOverride = msg.timestamp != null && msg.timestamp in ratingOverrides;
                  const currentRating = hasOverride ? ratingOverrides[msg.timestamp!] : msg.merchantRating;
                  return (
                    <MessageBubble
                      key={i}
                      role={msg.role}
                      content={msg.content}
                      timestamp={msg.timestamp}
                      merchantRating={currentRating}
                      onRate={
                        selected && msg.timestamp != null
                          ? (rating) => rateMessage(selected.id, msg.timestamp!, rating)
                          : undefined
                      }
                    />
                  );
                })}
              </div>

              {/* Reply box (escalated only) or status hint */}
              {selected.escalated && !selected.resolved ? (
                <div style={{ borderTop: "1px solid var(--color-border)", background: "var(--color-surface-default)" }}>
                  {/* Mode tabs */}
                  <div style={{ display: "flex", borderBottom: "1px solid var(--color-border)" }}>
                    <button
                      type="button"
                      onClick={() => setReplyMode("reply")}
                      style={{ padding: "var(--spacing-sm) var(--spacing-md)", border: "none", background: "none", cursor: "pointer", fontSize: "var(--type-body)", fontWeight: replyMode === "reply" ? 600 : 400, color: replyMode === "reply" ? "var(--color-text)" : "var(--color-neutral)", borderBottom: replyMode === "reply" ? "2px solid var(--color-selection)" : "2px solid transparent" }}
                    >
                      Reply
                    </button>
                    <button
                      type="button"
                      onClick={() => setReplyMode("note")}
                      style={{ padding: "8px 16px", border: "none", background: "none", cursor: "pointer", fontSize: "13px", fontWeight: replyMode === "note" ? 600 : 400, color: replyMode === "note" ? "var(--color-warning)" : "var(--color-neutral)", borderBottom: replyMode === "note" ? "2px solid var(--color-warning)" : "2px solid transparent" }}
                    >
                      Note
                    </button>
                  </div>
                  <div style={{ padding: "12px 16px" }}>
                  <Form method="post">
                    <input type="hidden" name="intent" value="reply" />
                    <input type="hidden" name="conversationId" value={selected.id} />
                    <input type="hidden" name="isNote" value={replyMode === "note" ? "true" : "false"} />
                    <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
                      <div style={{ flex: 1, position: "relative" }}>
                        {showMacros && filteredMacros.length > 0 && (
                          <div style={{ position: "absolute", bottom: "100%", left: 0, right: 0, zIndex: 20, background: "var(--color-surface-default)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", boxShadow: "0 4px 12px var(--color-shadow-popover)", maxHeight: 192, overflowY: "auto", marginBottom: 4 }}>
                            {filteredMacros.slice(0, 6).map((r, i) => (
                              <div
                                key={i}
                                role="option"
                                aria-selected={false}
                                tabIndex={0}
                                onClick={() => { setReplyText(r); setShowMacros(false); }}
                                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { setReplyText(r); setShowMacros(false); } }}
                                style={{ padding: "8px 12px", cursor: "pointer", fontSize: 13, borderBottom: i < filteredMacros.length - 1 ? "1px solid var(--color-border)" : "none" }}
                                onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "var(--color-surface)"; }}
                                onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = ""; }}
                              >
                                {r}
                              </div>
                            ))}
                          </div>
                        )}
                        <textarea
                          ref={replyRef}
                          name="message"
                          value={replyText}
                          placeholder={replyMode === "note" ? "Leave an internal note (customer won't see this)…" : "Reply as store… (type / for quick replies, ⌘↵ to send)"}
                          rows={2}
                          style={{
                            width: "100%", padding: "8px 12px", borderRadius: "var(--radius-sm)",
                            border: `1px solid ${replyMode === "note" ? "var(--color-warning-border)" : "var(--color-border)"}`,
                            fontSize: "13px", resize: "none", fontFamily: "inherit",
                            background: replyMode === "note" ? "var(--color-warning-surface)" : "var(--color-surface-default)",
                            boxSizing: "border-box",
                          }}
                          onChange={(e) => {
                            const val = e.target.value;
                            setReplyText(val);
                            if (val.startsWith("/")) {
                              setMacroQuery(val.slice(1));
                              setShowMacros(true);
                            } else {
                              setShowMacros(false);
                            }
                          }}
                          onKeyDown={(e) => {
                            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                              e.preventDefault();
                              (e.currentTarget.form as HTMLFormElement).requestSubmit();
                            }
                            if (e.key === "Escape") setShowMacros(false);
                            if (e.key === "Enter" && !e.shiftKey && !showMacros) {
                              e.preventDefault();
                              (e.currentTarget.form as HTMLFormElement).requestSubmit();
                            }
                          }}
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        style={{
                          padding: "8px 16px",
                            background: isSubmitting ? "var(--color-neutral)" : replyMode === "note" ? "var(--color-warning)" : "var(--color-selection)",
                          color: "var(--color-text-inverse)", border: "none",
                          borderRadius: "var(--radius-sm)",
                          cursor: isSubmitting ? "wait" : "pointer",
                          fontSize: "13px", fontWeight: 600, flexShrink: 0,
                          transition: "background 0.1s ease",
                        }}
                      >
                        {isSubmitting ? "Saving…" : replyMode === "note" ? "Save Note" : "Send"}
                      </button>
                    </div>{/* end flex row */}
                    <div style={{ fontSize: "12px", color: "var(--color-neutral-light)", marginTop: "4px" }}>
                      {replyMode === "note" ? "Internal only — not sent to customer or AI" : selected.channel === "whatsapp" ? "Sends via WhatsApp to customer" : "Stored in conversation — AI picks up on next reply"}
                    </div>
                  </Form>
                  </div>
                </div>
              ) : selected && !selected.resolved ? (
                <div style={{ padding: "12px 16px", borderTop: "1px solid var(--color-border)", background: "var(--color-surface)", fontSize: "12px", color: "var(--color-neutral-light)" }}>
                  AI is handling this conversation · Escalate from sidebar to reply manually
                </div>
              ) : null}
            </>
          )}
        </div>

        {/* ── Right Panel: Customer Sidebar ─────────────────────────────────── */}
        <div style={{ width: 280, flexShrink: 0, overflowY: "auto", padding: "var(--spacing-md)", borderLeft: "1px solid var(--color-border)" }}>
          {!selected ? (
            <div style={{ minHeight: 240, display: "flex", alignItems: "center", justifyContent: "center", padding: "var(--spacing-lg) var(--spacing-md-sm)" }}>
              <EmptyState heading="No conversation selected" subtext="Customer details appear here after you select a conversation." />
            </div>
          ) : (
            <s-stack direction="block" gap="base">{/* Phase 5: Customer → Phone → Cart → Order → Discount → Escalate → AI trace → Details → Train → Channel */}
              {/* Customer — name at top, Shopify link below */}
              <div>
                <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>Customer</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text)" }}>
                  {selected.customerName ?? (selected.channel === "whatsapp" ? formatPhone(selected.sessionId) : "Visitor")}
                </div>
                {selected.customerId && (
                  <div style={{ marginTop: 4 }}>
                    <s-link
                      href={`https://admin.shopify.com/store/${storeHandle}/customers/${selected.customerId.replace("gid://shopify/Customer/", "")}`}
                      target="_blank"
                    >
                      View in Shopify →
                    </s-link>
                  </div>
                )}
              </div>

              {/* Phone (WhatsApp only) */}
              {selected.channel === "whatsapp" && (
                <div>
                  <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>Phone</div>
                  <span style={{ fontSize: "13px", color: "var(--color-text)" }}>
                    {formatPhone(selected.sessionId)}
                  </span>
                </div>
              )}

              {/* Cart value */}
              {selected.cartValue != null && (
                <div>
                  <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>Cart Value</div>
                  <span style={{ fontSize: "16px", fontWeight: 600, color: "var(--color-cart)" }}>
                    {fmtMoney(selected.cartValue)}
                  </span>
                </div>
              )}

              {/* Order card */}
              {selected.orderId && (
                <s-box padding="base" background="subdued" border="base" borderRadius="base">
                  <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Order</div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: "var(--color-text)" }}>
                        {selected.orderRevenueCents != null ? fmtMoney(selected.orderRevenueCents / 100) : "Order placed"}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--color-success)", marginTop: 4 }}>Revenue attributed ✓</div>
                    </div>
                    <a
                      href={`https://${storeHandle}.myshopify.com/admin/orders/${selected.orderId.replace("gid://shopify/Order/", "")}`}
                      target="_top"
                      style={{ fontSize: "var(--type-metadata)", color: "var(--color-text)", textDecoration: "none", fontWeight: 500 }}
                    >
                      View →
                    </a>
                  </div>
                </s-box>
              )}

              {/* Discount code */}
              {selected.discountCode && (
                <div>
                  <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>Discount Used</div>
                  <s-badge>{selected.discountCode}</s-badge>
                </div>
              )}

              {/* Quick Actions — Resolve moved to center header; Escalate stays here */}
              {!selected.escalated && !selected.resolved && (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid var(--color-border)", paddingTop: "16px" }}>
                  <Form method="post">
                    <input type="hidden" name="intent" value="escalate" />
                    <input type="hidden" name="conversationId" value={selected.id} />
                    <div style={{ width: "100%" }}><s-button type="submit" variant="secondary">Escalate — Enable Reply</s-button></div>
                  </Form>
                </div>
              )}

              {/* AI tool trace — collapsed by default */}
              {aiActions.length > 0 && (
                <details style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)" }}>
                  <summary style={{ padding: "8px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600, color: "var(--color-neutral)", textTransform: "uppercase", letterSpacing: "0.06em", listStyle: "none", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span>Tool calls · {aiActions.length}</span>
                    <span style={{ fontSize: 12, fontWeight: 500, letterSpacing: 0, textTransform: "none", color: "var(--color-neutral-light)" }}>Click to view ›</span>
                  </summary>
                  <div style={{ padding: "4px 12px 12px", display: "flex", flexDirection: "column", gap: 2 }}>
                    {aiActions.map((a, i) => (
                      <div key={i} style={{ fontSize: 12, color: "var(--color-neutral)" }}>{a}</div>
                    ))}
                  </div>
                </details>
              )}

              {/* Details */}
              <div>
                <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>Details</div>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: "12px" }}>
                  <span style={{ color: "var(--color-neutral)" }}>Started</span>
                  <span>{new Date(selected.startedAt as unknown as string).toLocaleDateString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                  <span style={{ color: "var(--color-neutral)" }}>Messages</span>
                  <span>{selected.messageCount}</span>
                  <span style={{ color: "var(--color-neutral)" }}>Status</span>
                  <span>
                    {selectedStatus && <s-badge tone={statusTone(selectedStatus)}>{statusLabel(selectedStatus)}</s-badge>}
                  </span>
                  {selected.qualityScore != null && (
                    <>
                      <span style={{ color: "var(--color-neutral)" }}>AI Quality</span>
                      <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                        <span style={{
                          fontWeight: 600, fontSize: "13px",
                          color: selected.qualityScore >= 4 ? "var(--color-success)" : selected.qualityScore >= 3 ? "var(--color-warning)" : "var(--color-critical)",
                        }}>
                          {selected.qualityScore.toFixed(1)}/5
                        </span>
                        {(selected.qaMeta as { flagged?: boolean } | null)?.flagged && (
                          <span style={{ fontSize: "12px", color: "var(--color-critical)" }}>● Needs review</span>
                        )}
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* Train from this — visible on flagged conversations */}
              {(selected.qaMeta as { flagged?: boolean } | null)?.flagged && (
                <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: "12px" }}>
                  <s-banner tone="warning">
                    <s-text><strong>AI flagged this conversation</strong></s-text>
                    <s-text tone="neutral">{(selected.qaMeta as { reason?: string } | null)?.reason ?? "Low quality response detected."}</s-text>
                  </s-banner>
                  <div style={{ marginTop: "12px" }}>
                    <Form method="post">
                      <input type="hidden" name="intent" value="train" />
                      <input type="hidden" name="conversationId" value={selected.id} />
                      <s-stack direction="block">
                        <s-text-field
                          label="Customer question"
                          name="question"
                          value={selected.firstUserMessage ?? ""}
                        ></s-text-field>
                        <s-text-field
                          label="Correct answer"
                          name="answer"
                          placeholder="Correct answer to add to FAQ…"
                        ></s-text-field>
                        <div>
                          <s-button type="submit" variant="primary">Add to Knowledge Base</s-button>
                        </div>
                      </s-stack>
                    </Form>
                  </div>
                </div>
              )}

              {/* Channel */}
              <div>
                <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>Channel</div>
                <s-badge tone={selected.channel === "whatsapp" ? "success" : "info"}>
                  {selected.channel === "whatsapp" ? "WhatsApp" : "Web Widget"}
                </s-badge>
              </div>
            </s-stack>
          )}
        </div>

      </div>
      )}
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
