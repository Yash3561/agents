interface FilterOption {
  value: string;
  label: string;
}

interface FilterButtonGroupProps {
  options: readonly FilterOption[];
  value: string;
  onChange: (value: string) => void;
}

export function FilterButtonGroup({ options, value, onChange }: FilterButtonGroupProps) {
  return (
    <div style={{ display: "flex", gap: "var(--spacing-xs)", flexWrap: "wrap" }}>
      {options.map((opt) => {
        const isActive = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              padding: "var(--spacing-xs) var(--spacing-md-sm)",
              borderRadius: "var(--radius-sm)",
              border: isActive ? "1px solid var(--color-selection)" : "1px solid var(--color-border)",
              background: isActive ? "var(--color-surface-selected)" : "transparent",
              color: "var(--color-text)",
              cursor: "pointer",
              fontWeight: isActive ? 600 : 400,
              fontSize: "var(--type-metadata)",
              transition: "all 0.1s ease",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
