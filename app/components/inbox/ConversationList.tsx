import { useRef } from "react";
import type React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChannelIndicator } from "./ChannelIndicator";
import { EmptyState } from "./EmptyState";
import { FilterButtonGroup } from "~/components/FilterButtonGroup";
import { DATE_OPTIONS, formatPhone, getConversationStatus, statusLabel, statusTone, relTime } from "~/lib/inbox-shared";
import type { InboxLoaderData } from "~/lib/inbox.server";

type ConvItem = InboxLoaderData["conversations"][number];

interface ConversationListProps {
  conversations: ConvItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  totalCount: number;
  purchasedCount: number;
  inCartCount: number;
  escalatedCount: number;
  liveCount: number;
  thumbsUp: number;
  thumbsDown: number;
  search: string;
  onSearchChange: (value: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement>;
  activeTab: string;
  onTabChange: (tab: string) => void;
  dateRange: string;
  onDateRangeChange: (v: string) => void;
  hasMore: boolean;
  onLoadMore: () => void;
  /** Panel-only extras — omit for the full-screen view */
  notifPermission?: NotificationPermission;
  onRequestNotifPermission?: () => void;
  onOpenFullScreen?: () => void;
}

const STATUS_TABS = [
  { key: "open", label: "Needs reply" },
  { key: "pending", label: "AI handling" },
  { key: "resolved", label: "Resolved" },
] as const;

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  totalCount, purchasedCount, inCartCount, escalatedCount, liveCount, thumbsUp, thumbsDown,
  search, onSearchChange, searchInputRef,
  activeTab, onTabChange,
  dateRange, onDateRangeChange,
  hasMore, onLoadMore,
  notifPermission, onRequestNotifPermission, onOpenFullScreen,
}: ConversationListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: conversations.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 80,
    overscan: 5,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  return (
    <div style={{ width: 300, flexShrink: 0, borderRight: "1px solid var(--color-border)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Notification permission prompt (panel view only) */}
      {notifPermission === "default" && (
        <div style={{ padding: "8px 12px", background: "var(--color-surface)", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <s-text tone="neutral">Enable notifications to get alerted when customers message</s-text>
          <s-button variant="tertiary" onClick={onRequestNotifPermission}>Enable</s-button>
        </div>
      )}

      {/* Summary bar */}
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--color-border)", fontSize: "12px", color: "var(--color-neutral)", display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
        <span>{totalCount} total</span>
        {purchasedCount > 0 && <span>{purchasedCount} purchased</span>}
        {inCartCount > 0 && <span>{inCartCount} in cart</span>}
        {escalatedCount > 0 && <span>{escalatedCount} needs reply</span>}
        {liveCount > 0 && <span>{liveCount} live</span>}
        {thumbsUp + thumbsDown > 0 && (
          <span title={`${thumbsUp} rated helpful, ${thumbsDown} rated not helpful`}>
            {Math.round((thumbsUp / (thumbsUp + thumbsDown)) * 100)}% helpful
          </span>
        )}
        {onOpenFullScreen && (
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              onClick={onOpenFullScreen}
              style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, padding: "4px 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)", background: "var(--color-surface-default)", cursor: "pointer" }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Full screen
            </button>
          </span>
        )}
      </div>

      {/* Search */}
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--color-border)" }}>
        <input
          ref={searchInputRef}
          type="search"
          placeholder="Search conversations..."
          defaultValue={search}
          onChange={(e) => onSearchChange(e.target.value)}
          style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", fontSize: "13px", boxSizing: "border-box", outline: "none" }}
        />
      </div>

      {/* Status tabs */}
      <div style={{ display: "flex", borderBottom: "2px solid var(--color-border)", padding: "4px 4px 0" }}>
        {STATUS_TABS.map((tab) => (
          <s-button
            key={tab.key}
            variant={activeTab === tab.key ? "primary" : "tertiary"}
            onClick={() => onTabChange(tab.key)}
          >
            {tab.label}
          </s-button>
        ))}
      </div>

      {/* Filters — channel filter hidden while WhatsApp is the only active
          channel; the inbox query is hard-scoped to WhatsApp server-side
          (see inbox.server.ts), so old website conversations aren't shown
          here at all. Bring CHANNEL_OPTS back if the widget is re-enabled. */}
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: "4px" }}>
        <FilterButtonGroup options={DATE_OPTIONS} value={dateRange} onChange={onDateRangeChange} />
      </div>

      {/* Conversation rows */}
      <div ref={listRef} style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {conversations.length === 0 ? (
          <div style={{ padding: "var(--spacing-lg) var(--spacing-md)" }}>
            <EmptyState
              heading={search || dateRange !== "all" ? "No matching conversations" : "No conversations yet"}
              subtext={search || dateRange !== "all" ? "Try a different search or date filter." : "Customer conversations will appear here when NeonPing receives them."}
            />
          </div>
        ) : (
          <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const conv = conversations[virtualRow.index];
              const isWA = conv.channel === "whatsapp";
              const rowStatus = getConversationStatus(conv);
              const hasRevenue = conv.orderRevenueCents != null && conv.orderRevenueCents > 0;
              const displayName = conv.customerName ?? (isWA ? formatPhone(conv.sessionId) : "Visitor");
              const isSelected = conv.id === selectedId;
              const convMsgs = Array.isArray(conv.messages) ? (conv.messages as Array<{ role: string }>) : [];
              const lastRole = convMsgs.length > 0 ? convMsgs[convMsgs.length - 1]?.role : null;
              const isUnread = rowStatus === "needsReply" && lastRole === "user";
              return (
                <div
                  key={conv.id}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={conv.firstUserMessage ?? "Conversation"}
                    onClick={() => onSelect(conv.id)}
                    onKeyDown={(e) => e.key === "Enter" && onSelect(conv.id)}
                    style={{
                      padding: "var(--spacing-md-sm) var(--spacing-md)",
                      cursor: "pointer",
                      background: "var(--color-surface-default)",
                      borderBottom: "1px solid var(--color-border)",
                      borderLeft: isSelected ? "3px solid var(--color-selection)" : "3px solid transparent",
                      display: "flex",
                      alignItems: "flex-start",
                      gap: "var(--spacing-sm)",
                      minHeight: 72,
                    }}
                  >
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: isUnread ? "var(--color-warning)" : "transparent", marginTop: "var(--spacing-md-sm)", flexShrink: 0 }} />
                    <ChannelIndicator channel={conv.channel} size={24} />

                    <div style={{ flex: 1, minWidth: 0 }}>
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
                        <s-badge tone={statusTone(rowStatus)}>
                          {statusLabel(rowStatus)}{rowStatus === "needsReply" && conv.aiPaused ? " · AI paused" : ""}
                        </s-badge>
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
            <s-button variant="tertiary" onClick={onLoadMore}>
              Load more conversations
            </s-button>
          </div>
        )}
      </div>
    </div>
  );
}
