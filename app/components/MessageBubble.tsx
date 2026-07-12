function ThumbIcon({ direction, filled }: { direction: "up" | "down"; filled: boolean }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 20 20"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.5"
      style={direction === "down" ? { transform: "rotate(180deg)" } : undefined}
    >
      <path
        d="M7 9v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3zm0 0 4.5-7a1.5 1.5 0 0 1 2.7.9L13.5 8H16a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 14.8 18H7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface Props {
  role: string;
  content: string;
  timestamp?: number;
  /** Only offered on genuine AI replies — undefined hides the buttons entirely (user/note/merchant messages). */
  merchantRating?: "up" | "down";
  /** undefined = clicking the already-active button, i.e. toggle the rating off */
  onRate?: (rating: "up" | "down" | undefined) => void;
}

export function MessageBubble({ role, content, timestamp, merchantRating, onRate }: Props) {
  const isUser = role === "user" || role === "customer";
  const isMerchant = content?.startsWith("[Merchant]");
  const isSystem = role === "tool" || role === "system";

  if (isSystem) return null;

  const displayContent = isMerchant ? content.replace("[Merchant] ", "") : content;
  const label = isMerchant ? "You (Merchant)" : "NeonPing AI";
  const showRating = !isUser && !isMerchant && !!onRate;
  const bubbleBackground = isUser
    ? "var(--color-neutral-subdued)"
    : isMerchant
    ? "var(--color-success-subdued)"
    : "var(--color-surface-default)";
  const bubbleBorder = isUser
    ? "var(--color-border)"
    : isMerchant
    ? "var(--color-success-border)"
    : "var(--color-border)";

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start", marginBottom: "var(--spacing-xs)" }}>
      {!isUser && (
        <span style={{ fontSize: "var(--type-metadata)", fontWeight: 500, color: "var(--color-neutral-border)", marginBottom: "var(--spacing-xs)", marginLeft: "var(--spacing-xs)" }}>
          {label}
        </span>
      )}
      <div style={{
        background: bubbleBackground,
        border: `1px solid ${bubbleBorder}`,
        padding: "var(--spacing-sm) var(--spacing-md-sm)",
        borderRadius: isUser ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
        maxWidth: "75%",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontSize: "var(--type-body)",
        lineHeight: "var(--line-body)",
        color: "var(--color-text)",
      }}>
        {displayContent}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", marginTop: "var(--spacing-xs)", paddingLeft: isUser ? 0 : "var(--spacing-xs)", paddingRight: isUser ? "var(--spacing-xs)" : 0 }}>
        {timestamp && (
          <span style={{ fontSize: "var(--type-metadata)", color: "var(--color-neutral-border)" }}>
            {new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
        {showRating && (
          <span style={{ display: "flex", gap: "var(--spacing-xs)" }}>
            <button
              type="button"
              aria-label="Mark this AI reply as helpful"
              aria-pressed={merchantRating === "up"}
              onClick={() => onRate!(merchantRating === "up" ? undefined : "up")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "1px solid transparent", borderRadius: "var(--radius-sm)", cursor: "pointer", padding: "var(--spacing-xs)",
                color: merchantRating === "up" ? "var(--color-success)" : "var(--color-border)",
              }}
            >
              <ThumbIcon direction="up" filled={merchantRating === "up"} />
            </button>
            <button
              type="button"
              aria-label="Mark this AI reply as not helpful"
              aria-pressed={merchantRating === "down"}
              onClick={() => onRate!(merchantRating === "down" ? undefined : "down")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "1px solid transparent", borderRadius: "var(--radius-sm)", cursor: "pointer", padding: "var(--spacing-xs)",
                color: merchantRating === "down" ? "var(--color-critical)" : "var(--color-border)",
              }}
            >
              <ThumbIcon direction="down" filled={merchantRating === "down"} />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
