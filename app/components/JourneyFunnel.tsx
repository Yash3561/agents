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

  const size = compact ? 24 : 28;
  const fontSize = compact ? "11px" : "12px";

  const steps = [
    { label: "Started", done: true, detail: undefined as string | undefined },
    { label: "Browsed", done: browsed, detail: undefined as string | undefined },
    { label: "Cart Added", done: inCart, detail: cartValue ? fmtMoney(cartValue) : undefined },
    { label: "Purchased", done: purchased, detail: orderRevenue ? fmtMoney(orderRevenue / 100) : undefined },
  ];

  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      {steps.map((step, i) => (
        <div
          key={step.label}
          style={{ display: "flex", alignItems: "center", flex: i < steps.length - 1 ? 1 : "none" }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              minWidth: `${size + 32}px`,
            }}
          >
            <div
              style={{
                width: `${size}px`,
                height: `${size}px`,
                borderRadius: "50%",
                background: step.done ? "var(--color-success)" : "var(--color-border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: step.done ? "#fff" : "var(--color-neutral)",
                fontSize: fontSize,
                fontWeight: 700,
              }}
            >
              {step.done ? "✓" : "○"}
            </div>
            <div
              style={{
                fontSize: fontSize,
                fontWeight: 600,
                marginTop: "2px",
                color: step.done ? "var(--color-success)" : "var(--color-neutral)",
              }}
            >
              {step.label}
            </div>
            {step.detail && (
              <div style={{ fontSize: "10px", color: "var(--color-success)" }}>{step.detail}</div>
            )}
          </div>
          {i < steps.length - 1 && (
            <div
              style={{
                flex: 1,
                height: "2px",
                background: step.done ? "var(--color-success)" : "var(--color-border)",
                margin: "0 2px",
                marginBottom: "16px",
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
