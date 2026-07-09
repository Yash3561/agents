function ThumbIcon({ direction, filled }: { direction: "up" | "down"; filled: boolean }) {
  return (
    <svg
      width="12" height="12" viewBox="0 0 20 20"
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
  const isUser = role === "user";
  const isMerchant = content?.startsWith("[Merchant]");
  const isSystem = role === "tool" || role === "system";

  if (isSystem) return null;

  const displayContent = isMerchant ? content.replace("[Merchant] ", "") : content;
  const label = isMerchant ? "You (Merchant)" : "NeonPing AI";
  const showRating = !isUser && !isMerchant && !!onRate;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start", marginBottom: 2 }}>
      {!isUser && (
        <span style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.04em", color: "#9ca3af", marginBottom: 3, marginLeft: 4 }}>
          {label}
        </span>
      )}
      <div style={{
        background: isUser
          ? "#f3f4f6"
          : isMerchant
          ? "#f0fdf4"
          : "#eff6ff",
        border: `1px solid ${isUser ? "#e5e7eb" : isMerchant ? "#bbf7d0" : "#bfdbfe"}`,
        padding: "8px 12px",
        borderRadius: isUser ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
        maxWidth: "75%",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontSize: 13,
        lineHeight: 1.5,
        color: "#1f2937",
      }}>
        {displayContent}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2, paddingLeft: isUser ? 0 : 4, paddingRight: isUser ? 4 : 0 }}>
        {timestamp && (
          <span style={{ fontSize: 10, color: "#9ca3af" }}>
            {new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
        {showRating && (
          <span style={{ display: "flex", gap: 2 }}>
            <button
              type="button"
              aria-label="Mark this AI reply as helpful"
              aria-pressed={merchantRating === "up"}
              onClick={() => onRate!(merchantRating === "up" ? undefined : "up")}
              style={{
                display: "flex", background: "none", border: "none", cursor: "pointer", padding: "2px",
                color: merchantRating === "up" ? "#008060" : "#c9cccf",
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
                display: "flex", background: "none", border: "none", cursor: "pointer", padding: "2px",
                color: merchantRating === "down" ? "#d82c0d" : "#c9cccf",
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
