import { useEffect } from "react";
import { useFetcher } from "react-router";

// ponytail: plan dot colors kept here since they're visual-only and don't belong in plans.ts
const planDotColor: Record<string, string> = {
  spark: "#2563eb",
  pulse: "#7c3aed",
  surge: "#d97706",
};

const PLAN_ORDER: Record<string, number> = { spark: 0, pulse: 1, surge: 2 };

export interface PlanCardPlan {
  key: string;
  name: string;
  price: string;
  conversations: string;
  recommended?: boolean;
}

export interface PlanCardProps {
  plan: PlanCardPlan;
  isCurrent: boolean;
  currentPlanRank: number;
  features: string[];
}

export function PlanCard({ plan, isCurrent, currentPlanRank, features }: PlanCardProps) {
  // ponytail: useFetcher typed as any here — PlanCard doesn't own the action type.
  // Callers pass features; billing.tsx owns ALL_FEATURES.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetcher = useFetcher<any>();
  const isSubmitting = fetcher.state === "submitting";
  const billingError = fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;
  const redirectUrl = fetcher.data && "redirectUrl" in fetcher.data ? fetcher.data.redirectUrl : null;

  useEffect(() => {
    if (redirectUrl) {
      window.open(redirectUrl as string, "_top");
    }
  }, [redirectUrl]);

  return (
    <s-box
      padding="base"
      background="subdued"
      border-radius="base"
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          flex: "1 1 240px",
          minWidth: "240px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <s-heading>
            <span style={{ color: planDotColor[plan.key] ?? "var(--color-neutral)", marginRight: "6px" }}>●</span>
            {plan.name}
          </s-heading>
          <div style={{ display: "flex", gap: "6px" }}>
            {plan.recommended && !isCurrent && <s-badge tone="info">Most Popular</s-badge>}
            {isCurrent && <s-badge tone="success">Current</s-badge>}
          </div>
        </div>

        <div>
          <span style={{ fontSize: "28px", fontWeight: 700 }}>{plan.price}</span>
          <span style={{ color: "var(--color-neutral)" }}> / month</span>
        </div>

        <s-text tone="neutral">{plan.conversations}</s-text>

        <s-stack direction="block" gap="base">
          {features.map((f) => (
            <s-text key={f}>{f}</s-text>
          ))}
        </s-stack>

        <div style={{ marginTop: "auto" }}>
          {billingError && (
            <div
              style={{
                marginBottom: "8px",
                padding: "8px 12px",
                background: "#fff0f0",
                border: "1px solid #fca5a5",
                borderRadius: "var(--radius-sm)",
              }}
            >
              <s-text tone="critical">
                {"detail" in (fetcher.data ?? {})
                  ? `Billing error: ${(fetcher.data as { detail?: string }).detail}`
                  : "Something went wrong with billing. Please try again."}
              </s-text>
            </div>
          )}
          <fetcher.Form method="POST">
            <input type="hidden" name="plan" value={plan.key} />
            <div style={{ width: "100%" }}>
              {isCurrent ? (
                <s-button disabled variant="secondary">
                  Current plan
                </s-button>
              ) : (
                <s-button type="submit" variant="primary" disabled={isSubmitting}>
                  {isSubmitting
                    ? "Loading..."
                    : currentPlanRank === -1
                    ? `Choose ${plan.name}`
                    : PLAN_ORDER[plan.key] > currentPlanRank
                    ? `Upgrade to ${plan.name}`
                    : `Switch to ${plan.name}`}
                </s-button>
              )}
            </div>
          </fetcher.Form>
        </div>
      </div>
    </s-box>
  );
}
