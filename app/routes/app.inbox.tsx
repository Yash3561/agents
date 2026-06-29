import { useEffect, useRef } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useRouteError, useSearchParams, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { adminGraphql } from "../lib/mcp/admin.server";
import { sendTextMessage, decryptToken } from "../lib/whatsapp.server";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: string;
  content: string;
  timestamp?: number;
}


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
  const channelFilter = url.searchParams.get("channel") ?? "all";
  const statusFilter = url.searchParams.get("status") ?? "all";

  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);

  const channelWhere =
    channelFilter === "whatsapp" ? { channel: "whatsapp" }
    : channelFilter === "web" ? { NOT: { channel: "whatsapp" } }
    : {};

  const statusWhere =
    statusFilter === "open" ? { resolved: false, escalated: false }
    : statusFilter === "escalated" ? { escalated: true, resolved: false }
    : statusFilter === "resolved" ? { resolved: true }
    : {};

  const conversations = await prisma.conversation.findMany({
    where: { shopDomain: shop, ...channelWhere, ...statusWhere },
    orderBy: { lastMessageAt: "desc" },
    take: 100,
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
      orderRevenueCents: true,
      orderId: true,
    },
  });

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
    channelFilter,
    statusFilter,
    currencyCode,
    storeHandle,
    tenMinAgo: tenMinAgo.toISOString(),
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

    if (conversation.channel === "whatsapp") {
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
        ).catch(() => null); // best-effort — already appended to history below
      }
    }

    const existing = Array.isArray(conversation.messages)
      ? (conversation.messages as object[])
      : [];
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        messages: [...existing, { role: "assistant", content: `[Merchant] ${message}`, timestamp: Date.now() }],
        lastMessageAt: new Date(),
      },
    });
  } else if (intent === "resolve") {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { resolved: true, resolvedAt: new Date(), escalated: false },
    });
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
  if (escalated && !resolved) return <span style={{ color: "#dc2626", fontSize: "10px" }}>●</span>;
  if (isActive) return <span style={{ color: "#d97706", fontSize: "10px" }}>●</span>;
  if (resolved) return <span style={{ color: "#9ca3af", fontSize: "10px" }}>●</span>;
  return <span style={{ color: "#6b7280", fontSize: "10px" }}>●</span>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Inbox() {
  const { conversations, selected, channelFilter, statusFilter, currencyCode, storeHandle } =
    useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const prevNavState = useRef("idle");

  // Clear the textarea AFTER submission completes — not in onSubmit (which fires before form data is read)
  useEffect(() => {
    if (prevNavState.current === "submitting" && navigation.state === "idle") {
      if (replyRef.current) replyRef.current.value = "";
    }
    prevNavState.current = navigation.state;
  }, [navigation.state]);

  const isSubmitting = navigation.state === "submitting";

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    next.set(key, value);
    next.delete("id"); // clear selection when filter changes
    setSearchParams(next);
  }

  function selectConversation(id: string) {
    const next = new URLSearchParams(searchParams);
    next.set("id", id);
    setSearchParams(next);
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

  const browsed = agentTraceArr.includes("search_catalog");
  const inCart = selected ? !!selected.cartId : false;
  const purchased = selected ? !!selected.orderId : false;

  const funnelSteps = selected ? [
    { label: "Started", done: true, detail: undefined as string | undefined },
    { label: "Browsed", done: browsed },
    { label: "Cart Added", done: inCart, detail: selected.cartValue ? fmtMoney(selected.cartValue) : undefined },
    { label: "Purchased", done: purchased, detail: selected.orderRevenueCents ? fmtMoney(selected.orderRevenueCents / 100) : undefined },
  ] : [];

  const CHANNEL_OPTS = [
    { value: "all", label: "All" },
    { value: "web", label: "🌐 Web" },
    { value: "whatsapp", label: "💚 WhatsApp" },
  ] as const;

  const STATUS_OPTS = [
    { value: "all", label: "All" },
    { value: "open", label: "Open" },
    { value: "escalated", label: "🔴 Escalated" },
    { value: "resolved", label: "Resolved" },
  ] as const;

  const filterBtn = (active: boolean, color = "#2c6ecb") => ({
    padding: "4px 12px",
    borderRadius: "5px",
    border: active ? `1px solid ${color}` : "1px solid #d1d1d1",
    background: active ? color : "transparent",
    color: active ? "#fff" : "#1a1a1a",
    cursor: "pointer",
    fontWeight: active ? 600 : 400,
    fontSize: "12px",
  });

  return (
    <s-page heading="Inbox">
      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr 280px", gap: "0", height: "calc(100vh - 120px)", minHeight: "600px" }}>

        {/* ── Left Panel: Conversation List ────────────────────────────────── */}
        <div style={{ borderRight: "1px solid #e1e3e5", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Channel filter */}
          <div style={{ padding: "12px", borderBottom: "1px solid #f0f0f0" }}>
            <div style={{ display: "flex", gap: "4px", marginBottom: "8px" }}>
              {CHANNEL_OPTS.map((opt) => (
                <button key={opt.value} onClick={() => setFilter("channel", opt.value)} style={filterBtn(channelFilter === opt.value)}>
                  {opt.label}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: "4px" }}>
              {STATUS_OPTS.map((opt) => (
                <button key={opt.value} onClick={() => setFilter("status", opt.value)} style={filterBtn(statusFilter === opt.value, "#6b7280")}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Conversation rows */}
          <div style={{ flex: 1, overflowY: "auto" }}>
            {conversations.length === 0 ? (
              <div style={{ padding: "24px 16px", fontSize: "13px", color: "#8c9196", textAlign: "center" }}>
                No conversations match these filters.
              </div>
            ) : conversations.map((c) => {
              const isSelected = selected?.id === c.id;
              const isEscalated = c.escalated && !c.resolved;
              return (
                <div
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => selectConversation(c.id)}
                  onKeyDown={(e) => e.key === "Enter" && selectConversation(c.id)}
                  style={{
                    padding: "12px 14px",
                    borderBottom: "1px solid #f0f0f0",
                    cursor: "pointer",
                    background: isSelected ? "#f0f4ff" : isEscalated ? "#fff5f5" : "#fff",
                    borderLeft: isSelected ? "3px solid #2c6ecb" : isEscalated ? "3px solid #dc2626" : "3px solid transparent",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "3px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                      <span style={{ fontSize: "12px" }}>{c.channel === "whatsapp" ? "💚" : "🌐"}</span>
                      <span style={{ fontSize: "13px", fontWeight: 500, color: "#202223" }}>
                        {c.customerId ? "Customer" : "Anonymous"}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                      <StatusDot escalated={c.escalated} resolved={c.resolved} lastMessageAt={c.lastMessageAt} />
                      <span style={{ fontSize: "11px", color: "#8c9196" }}>{relativeTime(c.lastMessageAt)}</span>
                    </div>
                  </div>
                  <div style={{ fontSize: "12px", color: "#6d7175", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.firstUserMessage
                      ? c.firstUserMessage.length > 58
                        ? c.firstUserMessage.slice(0, 58) + "…"
                        : c.firstUserMessage
                      : "—"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Center Panel: Transcript ──────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", borderRight: "1px solid #e1e3e5" }}>
          {!selected ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#8c9196", fontSize: "14px" }}>
              Select a conversation to view the transcript
            </div>
          ) : (
            <>
              {/* Journey funnel */}
              <div style={{ padding: "14px 16px", borderBottom: "1px solid #f0f0f0", background: "#fafafa" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0" }}>
                  {funnelSteps.map((step, i) => (
                    <div key={step.label} style={{ display: "flex", alignItems: "center", flex: i < funnelSteps.length - 1 ? 1 : "none" }}>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: "60px" }}>
                        <div style={{
                          width: "24px", height: "24px", borderRadius: "50%",
                          background: step.done ? "#008060" : "#e0e0e0",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          color: step.done ? "#fff" : "#999", fontSize: "12px", fontWeight: 700,
                        }}>
                          {step.done ? "✓" : "○"}
                        </div>
                        <div style={{ fontSize: "10px", fontWeight: 600, marginTop: "2px", color: step.done ? "#008060" : "#999" }}>
                          {step.label}
                        </div>
                        {step.detail && <div style={{ fontSize: "10px", color: "#15803d" }}>{step.detail}</div>}
                      </div>
                      {i < funnelSteps.length - 1 && (
                        <div style={{ flex: 1, height: "2px", background: step.done ? "#008060" : "#e0e0e0", margin: "0 2px", marginBottom: "16px" }} />
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Escalation note */}
              {selected.escalated && !selected.resolved && (
                <div style={{ padding: "8px 16px", background: "#fff5f5", borderBottom: "1px solid #fca5a5", display: "flex", alignItems: "center", gap: "8px" }}>
                  <s-badge tone="critical">Escalated</s-badge>
                  <span style={{ fontSize: "13px", color: "#dc2626" }}>Merchant reply enabled below</span>
                </div>
              )}

              {/* Messages */}
              <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: "4px" }}>
                {msgs.length === 0 ? (
                  <span style={{ color: "#8c9196", fontSize: "13px" }}>No messages recorded.</span>
                ) : msgs.map((msg, i) => {
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

              {/* Reply box — only on escalated, unresolved conversations */}
              {selected.escalated && !selected.resolved ? (
                <div style={{ padding: "12px 16px", borderTop: "1px solid #e1e3e5", background: "#fff" }}>
                  <Form method="post">
                    <input type="hidden" name="intent" value="reply" />
                    <input type="hidden" name="conversationId" value={selected.id} />
                    <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
                      <textarea
                        ref={replyRef}
                        name="message"
                        placeholder="Reply as store (customer will see this)…"
                        rows={2}
                        style={{
                          flex: 1, padding: "8px 10px", borderRadius: "6px",
                          border: "1px solid #c9cccf", fontSize: "13px",
                          resize: "none", fontFamily: "inherit",
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
                          padding: "8px 16px", background: "#2c6ecb", color: "#fff",
                          border: "none", borderRadius: "6px", cursor: isSubmitting ? "wait" : "pointer",
                          fontSize: "13px", fontWeight: 600, flexShrink: 0,
                        }}
                      >
                        {isSubmitting ? "…" : "Send"}
                      </button>
                    </div>
                    <div style={{ fontSize: "11px", color: "#8c9196", marginTop: "4px" }}>
                      {selected.channel === "whatsapp" ? "Sends via WhatsApp to customer" : "Stored in conversation — AI picks up on next reply"}
                    </div>
                  </Form>
                </div>
              ) : selected && !selected.resolved ? (
                <div style={{ padding: "10px 16px", borderTop: "1px solid #e1e3e5", background: "#fafafa", fontSize: "12px", color: "#8c9196" }}>
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
                <div style={{ fontSize: "11px", color: "#6d7175", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "6px" }}>Channel</div>
                <span style={{
                  background: selected.channel === "whatsapp" ? "#e8fff0" : "#e8f4fd",
                  color: selected.channel === "whatsapp" ? "#166534" : "#1e3a5f",
                  padding: "4px 10px", borderRadius: "10px", fontSize: "12px", fontWeight: 600,
                }}>
                  {selected.channel === "whatsapp" ? "💚 WhatsApp" : "🌐 Web Widget"}
                </span>
              </div>

              {/* Customer */}
              <div>
                <div style={{ fontSize: "11px", color: "#6d7175", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "6px" }}>Customer</div>
                {selected.customerId ? (
                  <a
                    href={`https://admin.shopify.com/store/${storeHandle}/customers/${selected.customerId.replace("gid://shopify/Customer/", "")}`}
                    target="_blank" rel="noreferrer"
                    style={{ fontSize: "13px", color: "#2c6ecb" }}
                  >
                    View in Shopify →
                  </a>
                ) : (
                  <span style={{ fontSize: "13px", color: "#6d7175" }}>Anonymous</span>
                )}
              </div>

              {/* Contact (WhatsApp phone — masked) */}
              {selected.channel === "whatsapp" && (
                <div>
                  <div style={{ fontSize: "11px", color: "#6d7175", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "6px" }}>Phone</div>
                  <span style={{ fontSize: "13px", color: "#202223" }}>
                    {"****" + selected.sessionId.replace("whatsapp_", "").slice(-4)}
                  </span>
                </div>
              )}

              {/* Cart value */}
              {selected.cartValue ? (
                <div>
                  <div style={{ fontSize: "11px", color: "#6d7175", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "6px" }}>Cart Value</div>
                  <span style={{ fontSize: "16px", fontWeight: 600, color: "#1d4ed8" }}>
                    {fmtMoney(selected.cartValue)}
                  </span>
                </div>
              ) : null}

              {/* Order */}
              {selected.orderId && (
                <div>
                  <div style={{ fontSize: "11px", color: "#6d7175", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "6px" }}>Order</div>
                  <a
                    href={`https://admin.shopify.com/store/${storeHandle}/orders/${selected.orderId}`}
                    target="_blank" rel="noreferrer"
                    style={{ fontSize: "13px", color: "#15803d", fontWeight: 600 }}
                  >
                    {selected.orderId} →
                  </a>
                  {selected.orderRevenueCents && (
                    <div style={{ fontSize: "12px", color: "#15803d", marginTop: "2px" }}>
                      {fmtMoney(selected.orderRevenueCents / 100)}
                    </div>
                  )}
                </div>
              )}

              {/* Metadata */}
              <div>
                <div style={{ fontSize: "11px", color: "#6d7175", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "6px" }}>Details</div>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 10px", fontSize: "12px" }}>
                  <span style={{ color: "#6d7175" }}>Started</span>
                  <span>{new Date(selected.startedAt).toLocaleDateString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
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
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid #e1e3e5", paddingTop: "16px" }}>
                {!selected.resolved && (
                  <Form method="post">
                    <input type="hidden" name="intent" value="resolve" />
                    <input type="hidden" name="conversationId" value={selected.id} />
                    <button
                      type="submit"
                      style={{
                        width: "100%", padding: "8px", borderRadius: "6px",
                        border: "1px solid #c9cccf", background: "#fff",
                        cursor: "pointer", fontSize: "13px", color: "#202223",
                      }}
                    >
                      Mark as Resolved
                    </button>
                  </Form>
                )}
                {!selected.escalated && !selected.resolved && (
                  <Form method="post">
                    <input type="hidden" name="intent" value="escalate" />
                    <input type="hidden" name="conversationId" value={selected.id} />
                    <button
                      type="submit"
                      style={{
                        width: "100%", padding: "8px", borderRadius: "6px",
                        border: "1px solid #fca5a5", background: "#fff5f5",
                        cursor: "pointer", fontSize: "13px", color: "#dc2626",
                      }}
                    >
                      Escalate — Enable Reply
                    </button>
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
