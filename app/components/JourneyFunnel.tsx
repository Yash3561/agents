interface JourneyFunnelProps {
  browsed: boolean;
  inCart: boolean;
  purchased: boolean;
  cartValue?: number | null;
  orderRevenue?: number | null;
  currency?: string;
  compact?: boolean; // true = inbox (smaller), false = detail page (default)
}

export function JourneyFunnel({
  browsed,
  inCart,
  purchased,
  cartValue,
  orderRevenue,
  currency = "USD",
  compact = false,
}: JourneyFunnelProps) {
  const fmtMoney = (val: number) =>
    new Intl.NumberFormat("en", { style: "currency", currency }).format(val);

  const size = compact ? 28 : 32;

  const steps = [
    { label: "Started", done: true, detail: undefined as string | undefined },
    { label: "Browsed", done: browsed, detail: undefined as string | undefined },
    { label: "Cart Added", done: inCart, detail: cartValue ? fmtMoney(cartValue) : undefined },
    { label: "Purchased", done: purchased, detail: orderRevenue ? fmtMoney(orderRevenue / 100) : undefined },
  ];

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)" }}>
      {steps.map((step, i) => (
        <div
          key={step.label}
          style={{ display: "flex", alignItems: "center", flex: i < steps.length - 1 ? 1 : "none", minWidth: 0 }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              minWidth: compact ? "64px" : "76px",
            }}
          >
            <div
              style={{
                width: `${size}px`,
                height: `${size}px`,
                borderRadius: "50%",
                background: step.done ? "var(--color-success)" : "var(--color-surface-default)",
                border: `1px solid ${step.done ? "var(--color-success)" : "var(--color-border)"}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: step.done ? "var(--color-text-inverse)" : "var(--color-neutral)",
              }}
            >
              {step.done ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M3.5 8.5 6.5 11.5 12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <circle cx="8" cy="8" r="4.5" />
                </svg>
              )}
            </div>
            <div
              style={{
                fontSize: "var(--type-row)",
                fontWeight: 600,
                marginTop: "var(--spacing-xs)",
                color: step.done ? "var(--color-success)" : "var(--color-neutral)",
                textAlign: "center",
              }}
            >
              {step.label}
            </div>
            {step.detail && (
              <div style={{ fontSize: "var(--type-metadata)", color: "var(--color-success)", marginTop: "var(--spacing-xs)" }}>{step.detail}</div>
            )}
          </div>
          {i < steps.length - 1 && (
            <div
              style={{
                flex: 1,
                height: "2px",
                background: step.done ? "var(--color-success)" : "var(--color-border)",
                margin: "0 var(--spacing-sm)",
                marginBottom: "var(--spacing-lg)",
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
