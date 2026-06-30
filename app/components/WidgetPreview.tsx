/**
 * Lightweight visual mock of the real widget (launcher + open panel header +
 * first bot bubble), styled to match extensions/chat-widget/assets/
 * neonping-widget.css so merchants see an accurate live preview while
 * editing — not just a rough approximation.
 */

interface WidgetPreviewProps {
  color: string;
  greeting: string;
  position: string;
  botName: string;
}

export function WidgetPreview({ color, position, greeting, botName }: WidgetPreviewProps) {
  const isLeft = position === "bottom-left";
  const side: "left" | "right" = isLeft ? "left" : "right";

  return (
    <div
      style={{
        position: "relative",
        height: 240,
        background: "#f0f0f3",
        borderRadius: 12,
        border: "1px solid #e1e1e1",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 10,
          left: 12,
          fontSize: 11,
          color: "#9a9a9a",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        Your storefront
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 64,
          [side]: 16,
          width: 200,
          borderRadius: 14,
          background: "#fff",
          boxShadow: "0 8px 24px rgba(0,0,0,.18)",
          overflow: "hidden",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div
          style={{
            background: color || "#1a1a1a",
            color: "#fff",
            padding: "10px 12px",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {botName || "NeonPing"}
        </div>
        <div style={{ padding: 10, background: "#fff" }}>
          <div
            style={{
              display: "inline-block",
              background: "#f1f1f1",
              color: "#111",
              borderRadius: 10,
              borderBottomLeftRadius: 3,
              padding: "7px 10px",
              fontSize: 11,
              maxWidth: "90%",
              wordBreak: "break-word",
            }}
          >
            {greeting || "Hi! How can I help you today?"}
          </div>
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 16,
          [side]: 16,
          width: 40,
          height: 40,
          borderRadius: "50%",
          background: color || "#1a1a1a",
          boxShadow: "0 4px 12px rgba(0,0,0,.25)",
        }}
      />
    </div>
  );
}
