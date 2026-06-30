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
    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
      {options.map((opt) => {
        const isActive = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              padding: "5px 12px",
              borderRadius: "var(--radius-sm)",
              border: isActive ? "1px solid var(--color-primary)" : "1px solid var(--color-border)",
              background: isActive ? "var(--color-primary)" : "transparent",
              color: isActive ? "#fff" : "var(--color-text)",
              cursor: "pointer",
              fontWeight: isActive ? 600 : 400,
              fontSize: "12px",
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
