export function ThreePanelSkeleton({ fullHeight }: { fullHeight?: boolean }) {
  const line = (width: string, height = "12px") => (
    <div style={{ width, height, borderRadius: "var(--radius-pill)", background: "var(--color-skeleton)" }} />
  );
  return (
    <div style={{ display: "flex", height: fullHeight ? "100vh" : "calc(100vh - 120px)", minHeight: 600 }}>
      <div style={{ width: 300, flexShrink: 0, borderRight: "1px solid var(--color-border)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "var(--spacing-sm) var(--spacing-md-sm)", borderBottom: "1px solid var(--color-border)", display: "flex", gap: "var(--spacing-sm)" }}>{line("52px")}{line("68px")}</div>
        <div style={{ padding: "var(--spacing-sm) var(--spacing-md-sm)", borderBottom: "1px solid var(--color-border)" }}>{line("100%", "32px")}</div>
        <div style={{ padding: "var(--spacing-md-sm)", display: "flex", flexDirection: "column", gap: "var(--spacing-md-sm)" }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} style={{ display: "flex", gap: "var(--spacing-md-sm)", alignItems: "center" }}>
              {line("32px", "32px")}
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>{line("70%")}{line("90%")}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, borderRight: "1px solid var(--color-border)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "var(--spacing-md-sm) var(--spacing-md)", borderBottom: "1px solid var(--color-border)", display: "flex", gap: "var(--spacing-md-sm)", alignItems: "center" }}>{line("32px", "32px")}{line("180px")}</div>
        <div style={{ padding: "var(--spacing-md)", borderBottom: "1px solid var(--color-border)" }}>{line("100%", "52px")}</div>
        <div style={{ flex: 1, padding: "var(--spacing-md)", display: "flex", flexDirection: "column", gap: "var(--spacing-md-sm)" }}>{line("55%", "36px")}{line("68%", "36px")}{line("45%", "36px")}</div>
      </div>
      <div style={{ width: 280, flexShrink: 0, padding: "var(--spacing-md)", display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>{line("80px")}{line("140px")}{line("120px")}{line("160px")}</div>
    </div>
  );
}
