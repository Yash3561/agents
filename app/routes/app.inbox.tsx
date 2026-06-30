import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useRouteError, useSearchParams, useNavigation } from "react-router";
import type { Prisma } from "@prisma/client";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { adminGraphql } from "../lib/mcp/admin.server";
import { sendTextMessage, decryptToken } from "../lib/whatsapp.server";
import { runQAJudge } from "../lib/agents/merchant-analyst.server";
import { FilterButtonGroup } from "~/components/FilterButtonGroup";
import { JourneyFunnel } from "~/components/JourneyFunnel";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: string;
  content: string;
  timestamp?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string | null> = {
  search_catalog: "🔍 Searched product catalog",
  lookup_catalog: "🔍 Looked up product details",
  get_product: "🔍 Fetched product info",
  create_cart: "🛒 Created cart",
  update_cart: "🛒 Updated cart",
  get_cart: "🛒 Checked cart contents",
  get_checkout_url: "✓ Generated checkout link",
  offer_discount: "🏷 Offered discount code",
  search_policies_and_faqs: "📋 Checked store policies",
  get_order: "📦 Looked up order",
  get_customer_orders: "📦 Fetched order history",
  unified: null, // internal routing — skip
};

const DATE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
] as const;

const OUTCOME_OPTIONS = [
  { value: "all", label: "All" },
  { value: "live", label: "🟢 Live" },
  { value: "purchased", label: "Purchased" },
  { value: "incart", label: "In Cart" },
  { value: "escalated", label: "Escalated" },
  { value: "ended", label: "Ended" },
] as const;

const CHANNEL_OPTS = [
  { value: "all", label: "All" },
  { value: "web", label: "🌐 Web" },
  { value: "whatsapp", label: "💚 WhatsApp" },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(date: string | Date): string {
  const diff = Date.now() - new Date(date).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(date).toLocaleDateString("en", { month: "short", day: "numeric" });
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const selectedId = url.searchParams.get("id") ?? null;
  const channel = url.searchParams.get("channel") ?? "all";
  const outcome = url.searchParams.get("outcome") ?? "all";
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

  if (outcome === "live") {
    where.lastMessageAt = { gte: fiveMinAgo };
    where.resolved = false;
  } else if (outcome === "purchased") {
    where.orderId = { not: null };
  } else if (outcome === "incart") {
    where.cartId = { not: null };
    where.orderId = null;
  } else if (outcome === "escalated") {
    where.escalated = true;
    where.resolved = false;
  } else if (outcome === "ended") {
    where.resolved = true;
  }

  // Summary counts use global shop scope (not filtered by date/outcome/channel)
  const countBase: Prisma.ConversationWhereInput = { shopDomain: shop };

  const [conversations, totalCount, purchasedCount, inCartCount, escalatedCount, liveCount] =
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
          cartValue: true,
          cartId: true,
          orderRevenueCents: true,
          orderId: true,
          qualityScore: true,
          qaMeta: true,
        },
      }),
      prisma.conversation.count({ where: countBase }),
      prisma.conversation.count({ where: { ...countBase, orderId: { not: null } } }),
      prisma.conversation.count({ where: { ...countBase, cartId: { not: null }, orderId: null } }),
      prisma.conversation.count({ where: { ...countBase, escalated: true, resolved: false } }),
      prisma.conversation.count({ where: { ...countBase, lastMessageAt: { gte: fiveMinAgo }, resolved: false } }),
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
    totalCount, purchasedCount, inCartCount, escalatedCount, liveCount,
    page, hasMore: conversations.length === 50,
    search, dateRange, outcome, channel,
    currencyCode,
    storeHandle,
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
      if (merchant?.waPhoneNumberId && merchant?.waAccessToken) {
        await sendTextMessage(
          merchant.waPhoneNumberId,
          decryptToken(merchant.waAccessToken),
          phone,
          message,
        ).catch(() => null);
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
      const faqs = Array.isArray(merchant?.customFaqs) ? (merchant!.customFaqs as { q: string; a: string }[]) : [];
      if (faqs.length < 20) {
        await prisma.merchant.update({
          where: { shopDomain: shop },
          data: { customFaqs: [...faqs, { q: question, a: answer }] },
        });
      }
    }
  } else if (intent === "escalate") {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { escalated: true, resolved: false },
    });
  }

  return null;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusDot({ escalated, resolved, lastMessageAt }: { escalated: boolean; resolved: boolean; lastMessageAt: Date | string }) {
  const isActive = new Date(lastMessageAt) > new Date(Date.now() - 10 * 60 * 1000);
  if (escalated && !resolved) return <span aria-label="Escalated" title="Escalated" style={{ color: "var(--color-critical)", fontSize: "10px" }}>●</span>;
  if (isActive) return <span aria-label="Active now" title="Active now" style={{ color: "var(--color-warning)", fontSize: "10px" }}>●</span>;
  if (resolved) return <span aria-label="Resolved" title="Resolved" style={{ color: "#9ca3af", fontSize: "10px" }}>●</span>;
  return <span aria-label="Inactive" title="Inactive" style={{ color: "#6b7280", fontSize: "10px" }}>●</span>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Inbox() {
  const {
    conversations, selected,
    totalCount, purchasedCount, inCartCount, escalatedCount, liveCount,
    page, hasMore,
    search, dateRange, outcome, channel,
    currencyCode, storeHandle,
  } = useLoaderData<typeof loader>();

  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const prevNavState = useRef("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Reply mode: "reply" sends to customer, "note" saves as internal note
  const [replyMode, setReplyMode] = useState<"reply" | "note">("reply");

  // SSE real-time: track last update time and hold merged updates
  type ConvItem = typeof conversations[number];
  const [lastSeen, setLastSeen] = useState(() => new Date().toISOString());
  const [realtimeConvs, setRealtimeConvs] = useState<ConvItem[]>([]);

  useEffect(() => {
    const es = new EventSource(`/api/events?since=${encodeURIComponent(lastSeen)}`);

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

    es.addEventListener("reconnect", () => {
      es.close();
      setTimeout(() => setLastSeen(new Date().toISOString()), 1000);
    });

    es.onerror = () => {
      es.close();
      setTimeout(() => setLastSeen(new Date().toISOString()), 5000);
    };

    return () => es.close();
  }, [lastSeen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Merge SSE updates into loader conversations
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

  // Clear textarea and reset mode after submission
  useEffect(() => {
    if (prevNavState.current === "submitting" && navigation.state === "idle") {
      if (replyRef.current) replyRef.current.value = "";
      setReplyMode("reply");
    }
    prevNavState.current = navigation.state;
  }, [navigation.state]);

  // Sync search input when URL param changes (e.g. after filter reset)
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
    const next = new URLSearchParams(searchParams);
    next.set("id", id);
    setSearchParams(next);
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
      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr 280px", gap: "0", height: "calc(100vh - 120px)", minHeight: "600px" }}>

        {/* ── Left Panel: Conversation List ────────────────────────────────── */}
        <div style={{ borderRight: "1px solid var(--color-border)", display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Summary bar */}
          <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--color-border)", fontSize: "12px", color: "var(--color-neutral)", display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
            <span>{totalCount} total</span>
            {purchasedCount > 0 && <span style={{ color: "var(--color-success)" }}>● {purchasedCount} purchased</span>}
            {inCartCount > 0 && <span style={{ color: "var(--color-primary)" }}>● {inCartCount} in cart</span>}
            {escalatedCount > 0 && <span style={{ color: "var(--color-critical)" }}>● {escalatedCount} escalated</span>}
            {liveCount > 0 && <span style={{ color: "#22c55e", fontWeight: 600 }}>⬤ {liveCount} live</span>}
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "4px" }}>
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#22c55e", display: "inline-block" }} />
              <span style={{ fontSize: "11px", color: "var(--color-neutral)" }}>Live</span>
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
              style={{ width: "100%", padding: "6px 10px", border: "1px solid var(--color-border)", borderRadius: "6px", fontSize: "13px", boxSizing: "border-box", outline: "none" }}
            />
          </div>

          {/* Filters */}
          <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: "4px" }}>
            <FilterButtonGroup options={DATE_OPTIONS} value={dateRange} onChange={(v) => setFilter("dateRange", v)} />
            <FilterButtonGroup options={OUTCOME_OPTIONS} value={outcome} onChange={(v) => setFilter("outcome", v)} />
            <FilterButtonGroup options={CHANNEL_OPTS} value={channel} onChange={(v) => setFilter("channel", v)} />
          </div>

          {/* Conversation rows */}
          <div style={{ flex: 1, overflowY: "auto" }}>
            {allConversations.length === 0 ? (
              <div style={{ padding: "24px 16px", textAlign: "center" }}>
                <s-text tone="neutral">No conversations match these filters.</s-text>
              </div>
            ) : allConversations.map((conv) => {
              const isSelected = selected?.id === conv.id;
              const isEscalated = conv.escalated && !conv.resolved;
              const isFlagged = conv.qaMeta && (conv.qaMeta as { flagged?: boolean }).flagged === true;
              return (
                <div
                  key={conv.id}
                  role="button"
                  tabIndex={0}
                  aria-label={conv.firstUserMessage ?? "Conversation"}
                  onClick={() => selectConversation(conv.id)}
                  onKeyDown={(e) => e.key === "Enter" && selectConversation(conv.id)}
                  style={{
                    padding: "10px 12px",
                    borderBottom: "1px solid var(--color-border)",
                    cursor: "pointer",
                    background: isSelected ? "#f0f4ff" : "transparent",
                    borderLeft: isEscalated
                      ? "3px solid var(--color-critical)"
                      : isSelected
                      ? "3px solid var(--color-primary)"
                      : "3px solid transparent",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2px" }}>
                    <span style={{ fontWeight: 600, fontSize: "13px", color: "var(--color-text)" }}>
                      {conv.customerId ? "Customer" : "Anonymous"}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                      {isFlagged && <span title="AI quality flagged" style={{ fontSize: "11px" }}>🔍</span>}
                      <StatusDot escalated={conv.escalated} resolved={conv.resolved} lastMessageAt={conv.lastMessageAt} />
                      <span style={{ fontSize: "11px", color: "var(--color-neutral)" }}>
                        {relativeTime(conv.lastMessageAt)}
                      </span>
                    </div>
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--color-neutral)", marginBottom: "4px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {conv.firstUserMessage ?? "No message"}
                  </div>
                  <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                    {conv.channel === "whatsapp" && <s-badge tone="success">WhatsApp</s-badge>}
                    {conv.orderId && conv.orderRevenueCents != null && (
                      <span style={{ fontSize: "11px", color: "var(--color-success)", fontWeight: 600 }}>
                        ${(conv.orderRevenueCents / 100).toFixed(0)} order
                      </span>
                    )}
                    {!conv.orderId && conv.cartId && conv.cartValue != null && (
                      <span style={{ fontSize: "11px", color: "var(--color-primary)", fontWeight: 600 }}>
                        ${conv.cartValue.toFixed(0)} in cart
                      </span>
                    )}
                    {isEscalated && <s-badge tone="critical">Escalated</s-badge>}
                    {conv.resolved && <s-badge tone="neutral">Resolved</s-badge>}
                  </div>
                </div>
              );
            })}

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
        <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", borderRight: "1px solid var(--color-border)" }}>
          {!selected ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#8c9196", fontSize: "14px" }}>
              Select a conversation to view the transcript
            </div>
          ) : (
            <>
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
              <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--color-border)", background: "var(--color-surface)" }}>
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

              {/* Messages */}
              <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: "4px" }}>
                {msgs.length === 0 ? (
                  <span style={{ color: "#8c9196", fontSize: "13px" }}>No messages recorded.</span>
                ) : msgs.map((msg, i) => {
                  if (msg.role === "note") {
                    return (
                      <div key={i} style={{ margin: "8px 0", padding: "8px 12px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "8px", borderLeft: "3px solid var(--color-warning)" }}>
                        <div style={{ fontSize: "11px", color: "var(--color-warning)", fontWeight: 600, marginBottom: "4px" }}>🔒 Internal note</div>
                        <div style={{ fontSize: "13px", color: "var(--color-text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{msg.content}</div>
                        {msg.timestamp && (
                          <div style={{ fontSize: "10px", color: "#aaa", marginTop: "4px" }}>
                            {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </div>
                        )}
                      </div>
                    );
                  }
                  const isUser = msg.role === "user";
                  const isMerchant = msg.content?.startsWith("[Merchant]");
                  return (
                    <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start" }}>
                      {!isUser && (
                        <span style={{ fontSize: "10px", color: "#555", marginBottom: "2px", marginLeft: "4px" }}>
                          {isMerchant ? "You (Merchant)" : "NeonPing AI"}
                        </span>
                      )}
                      <div style={{
                        background: isUser ? "#f0f0f0" : isMerchant ? "#e8ffe8" : "#e8f4fd",
                        padding: "7px 10px", margin: "2px", borderRadius: "8px",
                        maxWidth: "75%", whiteSpace: "pre-wrap", wordBreak: "break-word",
                        fontSize: "13px",
                      }}>
                        {isMerchant ? msg.content.replace("[Merchant] ", "") : msg.content}
                      </div>
                      {msg.timestamp && (
                        <div style={{ fontSize: "10px", color: "#aaa", marginTop: "1px", textAlign: isUser ? "right" : "left" }}>
                          {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Reply box (escalated only) or status hint */}
              {selected.escalated && !selected.resolved ? (
                <div style={{ borderTop: "1px solid var(--color-border)", background: "#fff" }}>
                  {/* Mode tabs */}
                  <div style={{ display: "flex", borderBottom: "1px solid var(--color-border)" }}>
                    <button
                      type="button"
                      onClick={() => setReplyMode("reply")}
                      style={{ padding: "6px 16px", border: "none", background: "none", cursor: "pointer", fontSize: "13px", fontWeight: replyMode === "reply" ? 600 : 400, color: replyMode === "reply" ? "var(--color-primary)" : "var(--color-neutral)", borderBottom: replyMode === "reply" ? "2px solid var(--color-primary)" : "2px solid transparent" }}
                    >
                      Reply
                    </button>
                    <button
                      type="button"
                      onClick={() => setReplyMode("note")}
                      style={{ padding: "6px 16px", border: "none", background: "none", cursor: "pointer", fontSize: "13px", fontWeight: replyMode === "note" ? 600 : 400, color: replyMode === "note" ? "var(--color-warning)" : "var(--color-neutral)", borderBottom: replyMode === "note" ? "2px solid var(--color-warning)" : "2px solid transparent" }}
                    >
                      🔒 Note
                    </button>
                  </div>
                  <div style={{ padding: "12px 16px" }}>
                  <Form method="post">
                    <input type="hidden" name="intent" value="reply" />
                    <input type="hidden" name="conversationId" value={selected.id} />
                    <input type="hidden" name="isNote" value={replyMode === "note" ? "true" : "false"} />
                    <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
                      <textarea
                        ref={replyRef}
                        name="message"
                        placeholder={replyMode === "note" ? "Leave an internal note (customer won't see this)…" : "Reply as store (customer will see this)…"}
                        rows={2}
                        style={{
                          flex: 1, padding: "8px 10px", borderRadius: "6px",
                          border: `1px solid ${replyMode === "note" ? "#fde68a" : "var(--color-border)"}`,
                          fontSize: "13px", resize: "none", fontFamily: "inherit",
                          background: replyMode === "note" ? "#fffbeb" : "#fff",
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            (e.currentTarget.form as HTMLFormElement).requestSubmit();
                          }
                        }}
                      />
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        style={{
                          padding: "8px 16px",
                          background: isSubmitting ? "var(--color-neutral)" : replyMode === "note" ? "#d97706" : "var(--color-primary)",
                          color: "#fff", border: "none",
                          borderRadius: "var(--radius-sm)",
                          cursor: isSubmitting ? "wait" : "pointer",
                          fontSize: "13px", fontWeight: 600, flexShrink: 0,
                          transition: "background 0.1s ease",
                        }}
                      >
                        {isSubmitting ? "Saving…" : replyMode === "note" ? "Save Note" : "Send"}
                      </button>
                    </div>
                    <div style={{ fontSize: "11px", color: "#8c9196", marginTop: "4px" }}>
                      {replyMode === "note" ? "Internal only — not sent to customer or AI" : selected.channel === "whatsapp" ? "Sends via WhatsApp to customer" : "Stored in conversation — AI picks up on next reply"}
                    </div>
                  </Form>
                  </div>
                </div>
              ) : selected && !selected.resolved ? (
                <div style={{ padding: "10px 16px", borderTop: "1px solid var(--color-border)", background: "var(--color-surface)", fontSize: "12px", color: "#8c9196" }}>
                  AI is handling this conversation · Escalate from sidebar to reply manually
                </div>
              ) : null}
            </>
          )}
        </div>

        {/* ── Right Panel: Customer Sidebar ─────────────────────────────────── */}
        <div style={{ overflowY: "auto", padding: "16px" }}>
          {!selected ? (
            <div style={{ fontSize: "13px", color: "#8c9196" }}>No conversation selected</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              {/* Channel */}
              <div>
                <div style={{ fontSize: "11px", color: "var(--color-neutral)", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "6px" }}>Channel</div>
                <s-badge tone={selected.channel === "whatsapp" ? "success" : "info"}>
                  {selected.channel === "whatsapp" ? "WhatsApp" : "Web Widget"}
                </s-badge>
              </div>

              {/* Customer */}
              <div>
                <div style={{ fontSize: "11px", color: "var(--color-neutral)", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "6px" }}>Customer</div>
                {selected.customerId ? (
                  <s-link
                    href={`https://admin.shopify.com/store/${storeHandle}/customers/${selected.customerId.replace("gid://shopify/Customer/", "")}`}
                    target="_blank"
                  >
                    View in Shopify →
                  </s-link>
                ) : (
                  <span style={{ fontSize: "13px", color: "#6d7175" }}>Anonymous</span>
                )}
              </div>

              {/* Phone (WhatsApp only) */}
              {selected.channel === "whatsapp" && (
                <div>
                  <div style={{ fontSize: "11px", color: "var(--color-neutral)", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "6px" }}>Phone</div>
                  <span style={{ fontSize: "13px", color: "#202223" }}>
                    {"****" + selected.sessionId.replace("whatsapp_", "").slice(-4)}
                  </span>
                </div>
              )}

              {/* Cart value */}
              {selected.cartValue != null && (
                <div>
                  <div style={{ fontSize: "11px", color: "var(--color-neutral)", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "6px" }}>Cart Value</div>
                  <span style={{ fontSize: "16px", fontWeight: 600, color: "var(--color-primary)" }}>
                    {fmtMoney(selected.cartValue)}
                  </span>
                </div>
              )}

              {/* Order */}
              {selected.orderId && (
                <div>
                  <div style={{ fontSize: "11px", color: "var(--color-neutral)", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "6px" }}>Order</div>
                  <s-link
                    href={`https://admin.shopify.com/store/${storeHandle}/orders/${selected.orderId}`}
                    target="_blank"
                  >
                    {selected.orderId} →
                  </s-link>
                  {selected.orderRevenueCents != null && (
                    <div style={{ fontSize: "12px", color: "var(--color-success)", marginTop: "2px" }}>
                      {fmtMoney(selected.orderRevenueCents / 100)}
                    </div>
                  )}
                </div>
              )}

              {/* Discount code */}
              {selected.discountCode && (
                <div>
                  <div style={{ fontSize: "11px", color: "var(--color-neutral)", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "6px" }}>Discount Used</div>
                  <s-badge>{selected.discountCode}</s-badge>
                </div>
              )}

              {/* AI Actions */}
              {aiActions.length > 0 && (
                <div>
                  <div style={{ fontSize: "11px", color: "var(--color-neutral)", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "6px" }}>AI Actions</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                    {aiActions.map((a, i) => (
                      <div key={i} style={{ fontSize: "12px", color: "var(--color-neutral)" }}>{a}</div>
                    ))}
                  </div>
                </div>
              )}

              {/* Details */}
              <div>
                <div style={{ fontSize: "11px", color: "var(--color-neutral)", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "6px" }}>Details</div>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 10px", fontSize: "12px" }}>
                  <span style={{ color: "#6d7175" }}>Started</span>
                  <span>{new Date(selected.startedAt as unknown as string).toLocaleDateString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                  <span style={{ color: "#6d7175" }}>Messages</span>
                  <span>{selected.messageCount}</span>
                  <span style={{ color: "#6d7175" }}>Status</span>
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
                      <span style={{ color: "#6d7175" }}>AI Quality</span>
                      <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                        <span style={{
                          fontWeight: 600, fontSize: "13px",
                          color: selected.qualityScore >= 4 ? "#15803d" : selected.qualityScore >= 3 ? "#d97706" : "#dc2626",
                        }}>
                          {selected.qualityScore.toFixed(1)}/5
                        </span>
                        {(selected.qaMeta as { flagged?: boolean } | null)?.flagged && (
                          <span style={{ fontSize: "11px", color: "#dc2626" }}>● Needs review</span>
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

              {/* Actions */}
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
                    <div style={{ width: "100%" }}><s-button type="submit" tone="critical">Escalate — Enable Reply</s-button></div>
                  </Form>
                )}
              </div>
            </div>
          )}
        </div>

      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
