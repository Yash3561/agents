import type React from "react";

export function EmptyState({
  heading,
  subtext,
  action,
}: {
  heading: string;
  subtext: string;
  action?: React.ReactNode;
}) {
  return (
    <div style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--spacing-sm)", color: "var(--color-neutral)" }}>
      <div style={{ width: 48, height: 48, borderRadius: "var(--radius-base)", background: "var(--color-surface-default)", border: "1px solid var(--color-border)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-neutral)" }}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="M5 6.5A3.5 3.5 0 0 1 8.5 3h7A3.5 3.5 0 0 1 19 6.5v5A3.5 3.5 0 0 1 15.5 15H11l-4.5 4v-4A3.5 3.5 0 0 1 5 11.5v-5Z" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9 8h6M9 11h4" strokeLinecap="round" />
        </svg>
      </div>
      <div style={{ fontSize: "var(--type-empty-heading)", fontWeight: 700, color: "var(--color-text)" }}>{heading}</div>
      <div style={{ fontSize: "var(--type-empty-subtext)", lineHeight: "var(--line-body)", maxWidth: 320 }}>{subtext}</div>
      {action}
    </div>
  );
}
