import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, Form, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { getUsage } from "../lib/billing.server";
import db from "../db.server";

const VALID_PLANS = ["spark", "pulse", "surge"] as const;
type PlanKey = (typeof VALID_PLANS)[number];

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, billing } = await authenticate.admin(request);
  const usage = await getUsage(session.shop);

  const merchant = await db.merchant.findUnique({
    where: { shopDomain: session.shop },
    select: { conversationResetAt: true },
  });

  let activeSubscription: { id: string; name: string } | null = null;
  try {
    const result = await billing.check({
      plans: [...VALID_PLANS],
      isTest: process.env.BILLING_TEST_MODE === "true",
    });
    if (result.hasActivePayment && result.appSubscriptions?.length > 0) {
      const sub = result.appSubscriptions[0];
      activeSubscription = { id: sub.id, name: sub.name };
      const planName = sub.name.toLowerCase();
      if (VALID_PLANS.includes(planName as PlanKey) && planName !== usage.plan) {
        await db.merchant.update({
          where: { shopDomain: session.shop },
          data: { plan: planName },
        });
        usage.plan = planName;
      }
    }
  } catch (e) {
    console.log("[billing] check failed:", e);
  }

  const now = new Date();
  const resetAt = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const resetAtStr = resetAt.toLocaleDateString("en-US", { month: "long", day: "numeric" });

  return { usage, activeSubscription, resetAt: merchant?.conversationResetAt ?? null, resetAtStr };
}

export async function action({ request }: ActionFunctionArgs) {
  const { billing } = await authenticate.admin(request);
  const formData = await request.formData();
  const plan = String(formData.get("plan"));

  if (!VALID_PLANS.includes(plan as PlanKey)) {
    return { error: "Invalid plan" };
  }

  await billing.request({
    plan: plan as PlanKey,
    isTest: process.env.BILLING_TEST_MODE === "true",
    returnUrl: `${process.env.SHOPIFY_APP_URL}/app/billing`,
  });

  return null; // unreachable — billing.request redirects
}

const PLANS: Array<{
  key: PlanKey;
  name: string;
  price: string;
  conversations: string;
  features: string[];
  pitch: string;
  recommended?: boolean;
}> = [
  {
    key: "spark",
    name: "Spark",
    price: "$29",
    conversations: "500 conversations/mo",
    pitch: "One recovered sale a month pays for 6 months.",
    features: [
      "Live catalog search (always real-time)",
      "AI product recommendations",
      "Widget customization",
      "Single-tier discount offers",
      "Revenue attribution dashboard",
    ],
  },
  {
    key: "pulse",
    name: "Pulse",
    price: "$79",
    conversations: "2,500 conversations/mo",
    pitch: "Personalized AI that remembers your customers — for less than two lattes a day.",
    recommended: true,
    features: [
      "Everything in Spark",
      "Customer memory & personalization",
      "Personalized greetings by name",
      "Abandoned cart recovery",
      "Multi-tier discount negotiation (5→10→15%)",
      "Cart recovery rate KPI",
    ],
  },
  {
    key: "surge",
    name: "Surge",
    price: "$199",
    conversations: "10,000 conversations/mo",
    pitch: "At $100K/mo GMV, one recovered cart pays for 3 months of Surge.",
    features: [
      "Everything in Pulse",
      "Advanced funnel analytics",
      "Custom discount tiers",
      "Multi-language responses",
      "Priority support (24h response)",
      "Early access to new features",
    ],
  },
];

export default function BillingPage() {
  const { usage, activeSubscription, resetAt, resetAtStr } = useLoaderData<typeof loader>();
  const navigation = useNavigation();

  const usagePct =
    usage.limit > 0
      ? Math.min(100, Math.round((usage.used / usage.limit) * 100))
      : 0;
  const limitDisplay =
    usage.limit >= 999_000 ? "Unlimited" : usage.limit.toLocaleString();
  const planLabel =
    usage.plan.charAt(0).toUpperCase() + usage.plan.slice(1);

  // Inline progress bar since s-progress-bar is not in Polaris web types
  const barColor =
    usagePct >= 100 ? "#dc2626" : usagePct >= 80 ? "#d97706" : "#16a34a";

  const PLAN_ORDER: Record<string, number> = { spark: 0, pulse: 1, surge: 2 };
  const currentPlanRank = PLAN_ORDER[usage.plan] ?? -1; // -1 = no paid plan, all 3 show as "Choose"

  return (
    <s-page heading="Plan &amp; Billing">
      <s-section heading="Current Usage">
        <s-box padding="base" background="subdued" borderRadius="base">
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
            <s-text>Current plan:</s-text>
            <s-badge tone="success">
              {planLabel}
            </s-badge>
            {activeSubscription && (
              <s-badge tone="info">Active subscription</s-badge>
            )}
          </div>
          <s-text>
            {usage.used.toLocaleString()} / {limitDisplay} conversations used
            this month
          </s-text>
          <div
            style={{
              marginTop: "8px",
              height: "8px",
              background: "#e1e3e5",
              borderRadius: "4px",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${usagePct}%`,
                background: barColor,
                borderRadius: "4px",
                transition: "width 0.3s ease",
              }}
            />
          </div>
          <div style={{ marginTop: "4px" }}>
            <s-text tone="neutral">{usagePct}% used</s-text>
          </div>
          {resetAt && (
            <div style={{ marginTop: "4px" }}>
              <s-text tone="neutral">Resets on {new Date(resetAt).toLocaleDateString()}</s-text>
            </div>
          )}
        </s-box>

        <div style={{ padding: "12px 0" }}>
          <s-text>
            <strong>This month's usage:</strong> {usage.used.toLocaleString()} / {usage.limit >= 999_000 ? "Unlimited" : usage.limit.toLocaleString()} conversations
          </s-text>
          <s-text tone="neutral">Resets {resetAtStr}</s-text>
        </div>

        {usagePct >= 80 && usagePct < 100 && (
          <s-banner tone="warning">
            {"You've used "}
            {usagePct}
            {"% of your monthly conversations. Upgrade now to avoid hitting your limit mid-month."}
            {" "}
            <a href="#plans" style={{ color: "inherit", fontWeight: 600 }}>View plans below</a>
          </s-banner>
        )}
        {usagePct >= 100 && (
          <s-banner tone="critical">
            {"You've reached your conversation limit. New chats are paused until your plan resets or you upgrade."}
          </s-banner>
        )}
      </s-section>

      <s-section heading="Choose a Plan" id="plans">
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
          {PLANS.map((plan) => {
            const isCurrent = usage.plan === plan.key;
            const planDotColor: Record<string, string> = {
              spark: "#2563eb",
              pulse: "#7c3aed",
              surge: "#d97706",
            };
            return (
              <div
                key={plan.key}
                style={{
                  flex: "1 1 240px",
                  border: isCurrent
                    ? "2px solid #008060"
                    : plan.recommended
                    ? "2px solid #7c3aed"
                    : "1px solid #e1e3e5",
                  borderRadius: "12px",
                  padding: "20px",
                  background: isCurrent ? "#f0faf6" : "#ffffff",
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <s-heading><span style={{ color: planDotColor[plan.key] ?? "#6b7280", marginRight: "6px" }}>●</span>{plan.name}</s-heading>
                  <div style={{ display: "flex", gap: "6px" }}>
                    {plan.recommended && !isCurrent && <s-badge tone="info">Most Popular</s-badge>}
                    {isCurrent && <s-badge tone="success">Current</s-badge>}
                  </div>
                </div>
                <div>
                  <span style={{ fontSize: "28px", fontWeight: 700 }}>
                    {plan.price}
                  </span>
                  <span style={{ color: "#6d7175" }}> / month</span>
                </div>
                <s-text tone="neutral">{plan.conversations}</s-text>
                <ul
                  style={{
                    margin: "0",
                    paddingLeft: "20px",
                    color: "#202223",
                  }}
                >
                  {plan.features.map((f) => (
                    <li key={f} style={{ marginBottom: "4px" }}>
                      <s-text>{f}</s-text>
                    </li>
                  ))}
                </ul>
                <div style={{ marginTop: "4px" }}>
                  <s-text tone="neutral"><em>{plan.pitch}</em></s-text>
                </div>
                <div style={{ marginTop: "auto" }}>
                  <Form method="post">
                    <input type="hidden" name="plan" value={plan.key} />
                    <button
                      type="submit"
                      disabled={isCurrent || navigation.state === "submitting"}
                      style={{
                        width: "100%",
                        padding: "10px 16px",
                        background: isCurrent ? "#e1e3e5" : "#008060",
                        color: isCurrent ? "#6d7175" : "#ffffff",
                        border: "none",
                        borderRadius: "6px",
                        cursor: isCurrent || navigation.state === "submitting" ? "default" : "pointer",
                        fontWeight: 600,
                        fontSize: "14px",
                        opacity: navigation.state === "submitting" ? 0.7 : 1,
                      }}
                    >
                      {isCurrent
                        ? "Current plan"
                        : navigation.state === "submitting"
                        ? "Loading..."
                        : currentPlanRank === -1
                        ? `Choose ${plan.name}`
                        : PLAN_ORDER[plan.key] > currentPlanRank
                        ? `Upgrade to ${plan.name}`
                        : `Switch to ${plan.name}`}
                    </button>
                  </Form>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: "16px" }}>
          <s-text tone="neutral">
            All plans include a 7-day free trial. You will not be charged until
            the trial ends.
          </s-text>
        </div>
      </s-section>

      <s-section heading="Manage subscription">
        <s-text tone="neutral">
          To cancel or change your billing, visit your Shopify subscription settings.
        </s-text>
        <div style={{ marginTop: "12px" }}>
          <a
            href="https://admin.shopify.com/settings/billing/subscriptions"
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: "13px", color: "#1a1a1a", fontWeight: 500 }}
          >
            Manage in Shopify Admin →
          </a>
        </div>
      </s-section>
    </s-page>
  );
}
