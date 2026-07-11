// Full-screen inbox overlay — rendered inside <s-app-window> via /app/inbox-full.
// No <s-page> wrapper; <ui-title-bar> registers the admin chrome heading.

import { useEffect, useMemo, useRef, useState } from "react";
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
  unified: null,
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function relTime(d: Date | string) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function formatPhone(sessionId: string) {
  const raw = sessionId.replace(/^whatsapp_/, "");
  if (raw.length < 6) return raw;
  return raw.slice(0, 2) + " •••• " + raw.slice(-4);
}

// ─── Loader ──────────────────────────────────────────────────────────────────

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
    where.escalated = false;
    where.resolved = false;
  }

  const countBase: Prisma.ConversationWhereInput = { shopDomain: shop };

  const [conversations, totalCount, purchasedCount, inCartCount, escalatedCount, liveCount, pendingCount, resolvedCount, merchant, ratingAgg] =
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
    ]);

  let selected = null;
  if (selectedId) {
    const raw = await prisma.conversation.findUnique({ where: { id: selectedId } });
    if (raw && raw.shopDomain === shop) selected = raw;
  }

  let currencyCode = "USD";
  try {
    const shopData = await adminGraphql<{ shop: { currencyCode: string } }>(
      session.shop,
      session.accessToken ?? "",
      `{ shop { currencyCode } }`,
    );
    currencyCode = shopData.shop?.currencyCode ?? "USD";
  } catch { /* fall back to USD */ }

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
      data: { messages: [...existing, newMsg], lastMessageAt: new Date() },
    });
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
    const rating = rawRating === "up" || rawRating === "down" ? rawRating : null;
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

// ─── Component ────────────────────────────────────────────────────────────────

export default function InboxFull() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const {
    conversations,
    totalCount, purchasedCount, inCartCount, escalatedCount, liveCount, pendingCount, resolvedCount,
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

  const [replyMode, setReplyMode] = useState<"reply" | "note">("reply");
  const [activeTab, setActiveTab] = useState(statusTab ?? "pending");
  const [replyText, setReplyText] = useState("");
  const [showMacros, setShowMacros] = useState(false);
  const [macroQuery, setMacroQuery] = useState("");

  const pauseFetcher = useFetcher<typeof action>();
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

  useEffect(() => {
    if (searchInputRef.current) searchInputRef.current.value = search;
  }, [search]);

  const isSubmitting = navigation.state === "submitting";

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
    <>
      {/* ui-title-bar registers the heading in the app window chrome */}
      <ui-title-bar title="Inbox" />

      <div style={{ display: "flex", height: "100vh" }}>

        {/* ── Left Panel ───────────────────────────────────────────────────── */}
        <div style={{ width: 300, flexShrink: 0, borderRight: "1px solid var(--color-border)", display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Summary bar */}
          <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--color-border)", fontSize: "12px", color: "var(--color-neutral)", display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
            <span>{totalCount} total</span>
            {purchasedCount > 0 && <span style={{ color: "var(--color-success)" }}>● {purchasedCount} purchased</span>}
            {inCartCount > 0 && <span style={{ color: "var(--color-primary)" }}>● {inCartCount} in cart</span>}
            {escalatedCount > 0 && <span style={{ color: "var(--color-critical)" }}>● {escalatedCount} escalated</span>}
            {liveCount > 0 && <s-badge tone="success">{liveCount} live</s-badge>}
            {thumbsUp + thumbsDown > 0 && (
              <span title={`${thumbsUp} rated helpful, ${thumbsDown} rated not helpful`}>
                {Math.round((thumbsUp / (thumbsUp + thumbsDown)) * 100)}% rated helpful ({thumbsUp} helpful, {thumbsDown} not helpful)
              </span>
            )}
            <span style={{ marginLeft: "auto" }}>
              <s-badge tone="success">Live</s-badge>
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
              { key: "open", label: "Open", count: escalatedCount, activeColor: "var(--color-warning)", activeBg: "var(--color-warning-subdued)" },
              { key: "pending", label: "Pending", count: pendingCount, activeColor: "var(--color-primary)", activeBg: "var(--color-primary-subdued)" },
              { key: "resolved", label: "Resolved", count: resolvedCount, activeColor: "var(--color-neutral)", activeBg: "var(--color-neutral-subdued)" },
            ] as const).map((tab) => (
              <button
                key={tab.key}
                onClick={() => { setActiveTab(tab.key); setFilter("statusTab", tab.key); }}
                style={{
                  flex: 1, padding: "8px 4px", border: "none", background: "none", cursor: "pointer",
                  fontSize: 12, fontWeight: activeTab === tab.key ? 600 : 400,
                  color: activeTab === tab.key ? tab.activeColor : "var(--color-neutral)",
                  borderBottom: activeTab === tab.key ? `2px solid ${tab.activeColor}` : "2px solid transparent",
                  marginBottom: -2, display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                }}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: "var(--radius-pill)", background: activeTab === tab.key ? tab.activeBg : "var(--color-neutral-subdued)", color: activeTab === tab.key ? tab.activeColor : "var(--color-neutral)" }}>
                    {tab.count}
                  </span>
                )}
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
              <div style={{ padding: "24px 16px", textAlign: "center" }}>
                <s-text tone="neutral">No conversations match these filters.</s-text>
              </div>
            ) : (
              <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const conv = allConversations[virtualRow.index];
                  const isWA = conv.channel === "whatsapp";
                  const convMsgs = Array.isArray(conv.messages) ? (conv.messages as Array<{ role: string }>) : [];
                  const lastRole = convMsgs.length > 0 ? convMsgs[convMsgs.length - 1]?.role : null;
                  const isUnread = conv.escalated && !conv.resolved && lastRole === "user";
                  const customerDisplay = (conv as typeof conv & { customerName?: string | null }).customerName
                    ?? (isWA ? formatPhone(conv.sessionId) : "Visitor");
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
                          padding: "12px 12px",
                          borderBottom: "1px solid var(--color-border)",
                          cursor: "pointer",
                          background: selected?.id === conv.id ? "var(--color-primary-subdued)" : "var(--color-surface-default)",
                          borderLeft: selected?.id === conv.id
                            ? "3px solid var(--color-primary)"
                            : conv.escalated && !conv.resolved
                            ? "3px solid var(--color-warning)"
                            : conv.resolved
                            ? "3px solid var(--color-neutral-border)"
                            : "3px solid transparent",
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                          minHeight: 64,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {isUnread
                            ? <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--color-primary)", flexShrink: 0 }} />
                            : <span style={{ width: 8, flexShrink: 0 }} />}
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: isWA ? "var(--color-channel-whatsapp)" : "var(--color-channel-web)", flexShrink: 0, display: "inline-block" }} />
                          <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: isWA ? "var(--color-channel-whatsapp)" : "var(--color-channel-web)" }}>{isWA ? "WA" : "Web"}</span>
                          <span style={{ fontWeight: 600, fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--color-text)" }}>
                            {customerDisplay}
                          </span>
                          <span style={{ fontSize: 12, color: "var(--color-neutral)", opacity: 0.65, flexShrink: 0 }}>
                            {relTime(conv.lastMessageAt)}
                          </span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: 14 }}>
                          <span style={{ fontSize: 12, color: "var(--color-neutral)", opacity: 0.75, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {conv.firstUserMessage?.slice(0, 60) ?? "No message"}
                          </span>
                          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                            {conv.resolved && !conv.escalated && (
                              <s-badge tone="success">AI</s-badge>
                            )}
                            {conv.escalated && !conv.resolved && (
                              <s-badge tone="warning">Needs reply</s-badge>
                            )}
                            {conv.orderRevenueCents != null && (
                              <s-badge tone="success">${Math.round(conv.orderRevenueCents / 100)}</s-badge>
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
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "48px 24px", background: "var(--color-surface)" }}>
              <div style={{ maxWidth: 360, textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                <div style={{ width: 56, height: 56, borderRadius: "var(--radius-base)", background: "var(--color-primary-subdued)", border: "1px solid var(--color-primary-border)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-primary)" }}>
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                    <path d="M5 6.5A3.5 3.5 0 0 1 8.5 3h7A3.5 3.5 0 0 1 19 6.5v5A3.5 3.5 0 0 1 15.5 15H11l-4.5 4v-4A3.5 3.5 0 0 1 5 11.5v-5Z" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M9 8h6M9 11h4" strokeLinecap="round" />
                  </svg>
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "var(--color-text)" }}>Select a conversation</div>
                <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--color-neutral)" }}>
                  Choose a conversation from the list to view the transcript and reply.
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Conversation header */}
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", gap: 12, background: "var(--color-surface-default)", flexShrink: 0 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: selected.channel === "whatsapp" ? "var(--color-channel-whatsapp)" : "var(--color-channel-web)", flexShrink: 0, display: "inline-block" }} />
                <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: selected.channel === "whatsapp" ? "var(--color-channel-whatsapp)" : "var(--color-channel-web)", flexShrink: 0 }}>{selected.channel === "whatsapp" ? "WA" : "Web"}</span>
                <span style={{ fontWeight: 600, fontSize: 14, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {(selected as typeof selected & { customerName?: string | null }).customerName
                    ?? (selected.channel === "whatsapp" ? formatPhone(selected.sessionId) : "Visitor")}
                </span>
                {selected.resolved ? (
                  <s-badge tone="success">Resolved</s-badge>
                ) : selected.escalated ? (
                  <s-badge tone="warning">Needs reply</s-badge>
                ) : isAiPaused ? (
                  <s-badge tone="warning">AI paused</s-badge>
                ) : (
                  <s-badge tone="info">Pending</s-badge>
                )}
                {!selected.resolved && (
                  <pauseFetcher.Form method="POST" style={{ display: "inline" }}>
                    <input type="hidden" name="intent" value="pause-ai" />
                    <input type="hidden" name="conversationId" value={selected.id} />
                    <input type="hidden" name="pause" value={isAiPaused ? "false" : "true"} />
                    <button type="submit" style={{ fontSize: 12, padding: "4px 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)", background: "var(--color-surface-default)", cursor: "pointer", color: isAiPaused ? "var(--color-warning)" : "var(--color-neutral)" }}>
                      {isAiPaused ? "▶ Resume" : "⏸ Pause AI"}
                    </button>
                  </pauseFetcher.Form>
                )}
              </div>

              {/* Collision banner */}
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
                  <s-banner tone="critical">Merchant reply enabled — use the box below to respond directly.</s-banner>
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
                  <span style={{ color: "var(--color-neutral-light)", fontSize: "13px" }}>No messages recorded.</span>
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

              {/* Reply box */}
              {selected.escalated && !selected.resolved ? (
                <div style={{ borderTop: "1px solid var(--color-border)", background: "var(--color-surface-default)" }}>
                  <div style={{ display: "flex", borderBottom: "1px solid var(--color-border)" }}>
                    <button
                      type="button"
                      onClick={() => setReplyMode("reply")}
                      style={{ padding: "8px 16px", border: "none", background: "none", cursor: "pointer", fontSize: "13px", fontWeight: replyMode === "reply" ? 600 : 400, color: replyMode === "reply" ? "var(--color-primary)" : "var(--color-neutral)", borderBottom: replyMode === "reply" ? "2px solid var(--color-primary)" : "2px solid transparent" }}
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
                            placeholder={replyMode === "note" ? "Leave an internal note…" : "Reply as store… (type / for quick replies, ⌘↵ to send)"}
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
                            background: isSubmitting ? "var(--color-neutral)" : replyMode === "note" ? "var(--color-warning)" : "var(--color-primary)",
                            color: "var(--color-text-inverse)", border: "none",
                            borderRadius: "var(--radius-sm)",
                            cursor: isSubmitting ? "wait" : "pointer",
                            fontSize: "13px", fontWeight: 600, flexShrink: 0,
                            transition: "background 0.1s ease",
                          }}
                        >
                          {isSubmitting ? "Saving…" : replyMode === "note" ? "Save Note" : "Send"}
                        </button>
                      </div>
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
        <div style={{ width: 280, flexShrink: 0, overflowY: "auto", padding: "16px", borderLeft: "1px solid var(--color-border)" }}>
          {!selected ? (
            <div style={{ minHeight: 240, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "24px 12px" }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                <div style={{ width: 40, height: 40, borderRadius: "var(--radius-base)", background: "var(--color-neutral-subdued)", border: "1px solid var(--color-border)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-neutral)" }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                    <path d="M7 8h10M7 12h6" strokeLinecap="round" />
                    <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-4 3v-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--color-text)" }}>No conversation selected</div>
                <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--color-neutral)" }}>Customer details appear here after you select a conversation.</div>
              </div>
            </div>
          ) : (
            <s-stack direction="block" gap="base">
              <div>
                <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>Channel</div>
                <s-badge tone={selected.channel === "whatsapp" ? "success" : "info"}>
                  {selected.channel === "whatsapp" ? "WhatsApp" : "Web Widget"}
                </s-badge>
              </div>

              <div>
                <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>Customer</div>
                {selected.customerId ? (
                  <s-link
                    href={`https://admin.shopify.com/store/${storeHandle}/customers/${selected.customerId.replace("gid://shopify/Customer/", "")}`}
                    target="_blank"
                  >
                    View in Shopify →
                  </s-link>
                ) : (
                  <span style={{ fontSize: "13px", color: "var(--color-neutral)" }}>Anonymous</span>
                )}
              </div>

              {selected.channel === "whatsapp" && (
                <div>
                  <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>Phone</div>
                  <span style={{ fontSize: "13px", color: "var(--color-text)" }}>
                    {"****" + selected.sessionId.replace("whatsapp_", "").slice(-4)}
                  </span>
                </div>
              )}

              {selected.cartValue != null && (
                <div>
                  <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>Cart Value</div>
                  <span style={{ fontSize: "16px", fontWeight: 600, color: "var(--color-primary)" }}>
                    {fmtMoney(selected.cartValue)}
                  </span>
                </div>
              )}

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
                      style={{ fontSize: 12, color: "var(--color-primary)", textDecoration: "none", fontWeight: 500 }}
                    >
                      View →
                    </a>
                  </div>
                </s-box>
              )}

              {selected.discountCode && (
                <div>
                  <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>Discount Used</div>
                  <s-badge>{selected.discountCode}</s-badge>
                </div>
              )}

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

              <div>
                <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>Details</div>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: "12px" }}>
                  <span style={{ color: "var(--color-neutral)" }}>Started</span>
                  <span>{new Date(selected.startedAt as unknown as string).toLocaleDateString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                  <span style={{ color: "var(--color-neutral)" }}>Messages</span>
                  <span>{selected.messageCount}</span>
                  <span style={{ color: "var(--color-neutral)" }}>Status</span>
                  <span>
                    {selected.escalated && !selected.resolved
                      ? <s-badge tone="critical">Escalated</s-badge>
                      : selected.resolved
                        ? <s-badge tone="info">Resolved</s-badge>
                        : <s-badge tone="success">Open</s-badge>
                    }
                  </span>
                  {selected.qualityScore != null && (
                    <>
                      <span style={{ color: "var(--color-neutral)" }}>AI Quality</span>
                      <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                        <span style={{
                          fontWeight: 600, fontSize: "13px",
                          color: selected.qualityScore >= 4 ? "var(--color-channel-whatsapp)" : selected.qualityScore >= 3 ? "var(--color-warning)" : "var(--color-critical)",
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

              <div style={{ display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid var(--color-border)", paddingTop: "16px" }}>
                {!selected.resolved && (
                  <Form method="post">
                    <input type="hidden" name="intent" value="resolve" />
                    <input type="hidden" name="conversationId" value={selected.id} />
                    <div style={{ width: "100%" }}><s-button type="submit" variant="secondary">Mark as Resolved</s-button></div>
                  </Form>
                )}
                {!selected.escalated && !selected.resolved && (
                  <Form method="post">
                    <input type="hidden" name="intent" value="escalate" />
                    <input type="hidden" name="conversationId" value={selected.id} />
                    <div style={{ width: "100%" }}><s-button type="submit" variant="secondary">Escalate — Enable Reply</s-button></div>
                  </Form>
                )}
              </div>
            </s-stack>
          )}
        </div>

      </div>
    </>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
