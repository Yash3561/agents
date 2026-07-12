import { useFetcher } from "react-router";
import { MessageBubble } from "~/components/MessageBubble";
import { ChannelIndicator } from "./ChannelIndicator";
import { EmptyState } from "./EmptyState";
import { ReplyBox } from "./ReplyBox";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { formatPhone, statusLabel, statusTone, type ChatMessage, type StatusKey } from "~/lib/inbox-shared";
import type { InboxLoaderData } from "~/lib/inbox.server";

// The list-row select shape, not the full loader "selected" row — both the
// virtualized-list-derived value and the loader's findFirst fallback (a
// superset of these fields) are structurally assignable to this narrower type.
type ConvItem = InboxLoaderData["conversations"][number];

interface TranscriptPanelProps {
  selected: ConvItem;
  selectedStatus: StatusKey;
  isAiPaused: boolean;
  otherViewers: number;
  quickReplies: string[];
  currencyCode: string;
  ratingOverrides: Record<number, "up" | "down" | undefined>;
  onRateMessage: (conversationId: string, messageTimestamp: number, rating: "up" | "down" | undefined) => void;
  onPauseToggle: (pause: boolean) => void;
  pauseFetcherState: "idle" | "loading" | "submitting";
  dimmed?: boolean;
}

export function TranscriptPanel({
  selected,
  selectedStatus,
  isAiPaused,
  otherViewers,
  quickReplies,
  currencyCode,
  ratingOverrides,
  onRateMessage,
  onPauseToggle,
  pauseFetcherState,
  dimmed,
}: TranscriptPanelProps) {
  const resolveFetcher = useFetcher();

  const msgs = Array.isArray(selected.messages) ? (selected.messages as unknown as ChatMessage[]) : [];
  const isSelectedFlagged = Boolean((selected.qaMeta as { flagged?: boolean } | null)?.flagged);

  // WhatsApp only allows free-form replies within 24h of the customer's last
  // inbound message — outside that window, Meta silently rejects the send and
  // only template messages work. Warn before the merchant hits that wall.
  const lastUserMsg = selected.channel === "whatsapp" ? [...msgs].reverse().find((m) => m.role === "user" && m.timestamp != null) : undefined;
  const isOutsideWaWindow = lastUserMsg?.timestamp != null && Date.now() - lastUserMsg.timestamp > 24 * 60 * 60 * 1000;

  const fmtMoney = (dollars: number) =>
    new Intl.NumberFormat("en", { style: "currency", currency: currencyCode }).format(dollars);
  const agentTraceArr = Array.isArray(selected.agentTrace) ? (selected.agentTrace as string[]) : [];
  const journeyBrowsed = agentTraceArr.includes("search_catalog");
  const journeySummary = [
    "Started",
    ...(journeyBrowsed || selected.cartId || selected.orderId ? ["Browsed"] : []),
    ...(selected.cartId ? [selected.cartValue != null ? `Cart ${fmtMoney(selected.cartValue)}` : "Cart added"] : []),
    ...(selected.orderId ? [selected.orderRevenueCents != null ? `Purchased ${fmtMoney(selected.orderRevenueCents / 100)}` : "Purchased"] : []),
  ].join(" → ");

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", borderRight: "1px solid var(--color-border)", opacity: dimmed ? 0.5 : 1, transition: "opacity 120ms ease", pointerEvents: dimmed ? "none" : undefined }}>
      <div style={{ padding: "var(--spacing-md-sm) var(--spacing-md)", borderBottom: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", background: "var(--color-surface-default)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-md-sm)", minWidth: 0 }}>
          <ChannelIndicator channel={selected.channel} size={28} />
          <span style={{ fontWeight: 600, fontSize: "var(--type-panel-title)", flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {selected.customerName ?? (selected.channel === "whatsapp" ? formatPhone(selected.sessionId) : "Visitor")}
          </span>
          {journeySummary && (
            <span style={{ fontSize: "var(--type-metadata)", color: "var(--color-neutral)", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-pill)", padding: "2px 8px", flexShrink: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              Journey: {journeySummary}
            </span>
          )}
          <s-badge tone={statusTone(selectedStatus)}>
            {statusLabel(selectedStatus)}{selectedStatus === "needsReply" && isAiPaused ? " · AI paused" : ""}
          </s-badge>
          {otherViewers > 0 && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
              <s-badge tone="warning">{otherViewers + 1} viewing</s-badge>
              <s-icon type="info" interestFor="viewer-count-tip"></s-icon>
              <s-tooltip id="viewer-count-tip">
                {otherViewers === 1
                  ? "Someone else is also viewing this conversation — coordinate before replying."
                  : `${otherViewers} others are also viewing this conversation.`}
              </s-tooltip>
            </span>
          )}
        </div>
        {!selected.resolved && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "var(--spacing-sm)", flexShrink: 0 }}>
            <resolveFetcher.Form method="POST">
              <input type="hidden" name="intent" value="resolve" />
              <input type="hidden" name="conversationId" value={selected.id} />
              <s-button variant="tertiary" type="submit">Resolve</s-button>
            </resolveFetcher.Form>
            <s-button
              variant="tertiary"
              tone={isAiPaused ? "critical" : "neutral"}
              onClick={() => onPauseToggle(!isAiPaused)}
              {...(pauseFetcherState !== "idle" ? { loading: true } : {})}
            >
              {isAiPaused ? "Return to AI" : "Take over"}
            </s-button>
          </div>
        )}
      </div>

      {selected.resolved && (
        <div style={{ padding: "8px 12px", background: "var(--color-surface)", borderBottom: "1px solid var(--color-border)", display: "flex", gap: "8px", alignItems: "center" }}>
          <s-badge tone="success">Resolved</s-badge>
          {selected.resolvedAt && (
            <s-text tone="neutral">{new Date(selected.resolvedAt as unknown as string).toLocaleDateString()}</s-text>
          )}
        </div>
      )}

      {(selected.escalated && !selected.resolved) || isAiPaused ? (
        <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--color-border)" }}>
          <s-banner tone="warning">
            {selected.escalated && !selected.resolved && isAiPaused
              ? "Merchant reply enabled and AI is paused — replies you send are from you, not the AI."
              : selected.escalated && !selected.resolved
              ? "Merchant reply enabled — use the box below to respond directly."
              : "AI is paused — you're handling this conversation."}
          </s-banner>
        </div>
      ) : null}

      {/* Messages — consecutive same-sender messages are grouped with a tighter
          gap and a single trailing timestamp, standard chat-UI convention. */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px", display: "flex", flexDirection: "column", gap: "8px" }}>
        {msgs.length === 0 ? (
          <EmptyState heading="No messages yet" subtext="Transcript messages will appear here as the conversation progresses." />
        ) : msgs.map((msg, i) => {
          if (msg.role === "pending_approval") {
            return <PendingApprovalCard key={i} conversationId={selected.id} message={msg} />;
          }
          if (msg.role === "withdrawn") {
            return (
              <div key={i} style={{ margin: "4px 0", padding: "8px 12px", background: "var(--color-surface)", border: "1px dashed var(--color-border)", borderRadius: "var(--radius-base)", opacity: 0.6 }}>
                <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, marginBottom: "4px" }}>Draft rejected — not sent to customer</div>
                <div style={{ fontSize: "13px", color: "var(--color-text)", whiteSpace: "pre-wrap", wordBreak: "break-word", textDecoration: "line-through" }}>{msg.content}</div>
              </div>
            );
          }
          if (msg.role === "note") {
            return (
              <div key={i} style={{ margin: "4px 0", padding: "8px 12px", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-base)", borderLeft: isSelectedFlagged ? "3px solid var(--color-warning)" : "1px solid var(--color-border)" }}>
                <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, marginBottom: "4px" }}>Internal note</div>
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
          // Grouping: hide this bubble's own top margin when the previous message
          // shares the same role — MessageBubble already applies its own bottom
          // margin, so we only need to close the gap from this side.
          const prevMsg = msgs[i - 1];
          const isGrouped = prevMsg && prevMsg.role === msg.role && prevMsg.role !== "note";
          return (
            <div key={i} style={isGrouped ? { marginTop: "-4px" } : undefined}>
              <MessageBubble
                role={msg.role}
                content={msg.content}
                timestamp={msg.timestamp}
                merchantRating={currentRating}
                onRate={
                  msg.timestamp != null
                    ? (rating) => onRateMessage(selected.id, msg.timestamp!, rating)
                    : undefined
                }
              />
            </div>
          );
        })}
      </div>

      {(selected.escalated || isAiPaused) && !selected.resolved ? (
        <>
          {isOutsideWaWindow && (
            <div style={{ padding: "8px 16px", borderTop: "1px solid var(--color-border)" }}>
              <s-banner tone="warning">
                Outside the 24-hour WhatsApp window — this customer hasn&apos;t messaged in over a day, so a free-form reply won&apos;t deliver. Only a pre-approved template message can reach them now.
              </s-banner>
            </div>
          )}
          <ReplyBox conversationId={selected.id} channel={selected.channel} quickReplies={quickReplies} />
        </>
      ) : !selected.resolved ? (
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--color-border)", background: "var(--color-surface)", fontSize: "12px", color: "var(--color-neutral-light)" }}>
          AI is handling this conversation · Escalate from sidebar to reply manually
        </div>
      ) : null}
    </div>
  );
}
