export function ChannelIndicator({ channel, size = 32 }: { channel?: string | null; size?: number }) {
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
