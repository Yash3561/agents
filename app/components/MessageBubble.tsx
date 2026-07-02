interface Props {
  role: string;
  content: string;
  timestamp?: number;
}

export function MessageBubble({ role, content, timestamp }: Props) {
  const isUser = role === "user";
  const isMerchant = content?.startsWith("[Merchant]");
  const isSystem = role === "tool" || role === "system";

  if (isSystem) return null;

  const displayContent = isMerchant ? content.replace("[Merchant] ", "") : content;
  const label = isMerchant ? "You (Merchant)" : "NeonPing AI";

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
      {timestamp && (
        <span style={{ fontSize: 10, color: "#9ca3af", marginTop: 2, paddingLeft: isUser ? 0 : 4, paddingRight: isUser ? 4 : 0 }}>
          {new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      )}
    </div>
  );
}
