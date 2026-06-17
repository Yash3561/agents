import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, Form } from "react-router";
import { authenticate } from "../shopify.server";
import { getUsage } from "../lib/billing.server";
import db from "../db.server";

const VALID_PLANS = ["starter", "growth", "pro"] as const;
type PlanKey = (typeof VALID_PLANS)[number];

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, billing } = await authenticate.admin(request);
  const usage = await getUsage(session.shop);

  let activeSubscription: { id: string; name: string } | null = null;
  try {
    const result = await billing.check({
      plans: [...VALID_PLANS],
      isTest: true,
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

  return { usage, activeSubscription };
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
    isTest: process.env.NODE_ENV !== "production",
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
}> = [
  {
    key: "starter",
    name: "Starter",
    price: "$29",
    conversations: "500 conversations/mo",
    features: [
      "AI-powered chat widget",
      "Product recommendations",
      "Basic analytics",
    ],
  },
  {
    key: "growth",
    name: "Growth",
    price: "$79",
    conversations: "2,000 conversations/mo",
    features: [
      "Everything in Starter",
      "Abandoned cart recovery",
      "Revenue attribution",
    ],
  },
  {
    key: "pro",
    name: "Pro",
    price: "$199",
    conversations: "Unlimited conversations",
    features: [
      "Everything in Growth",
      "Priority support",
      "Custom AI personas",
    ],
  },
];

export default function BillingPage() {
  const { usage, activeSubscription } = useLoaderData<typeof loader>();

  const usedPct =
    usage.limit > 0
      ? Math.min(100, Math.round((usage.used / usage.limit) * 100))
      : 0;
  const limitDisplay =
    usage.limit >= 999_000 ? "Unlimited" : usage.limit.toLocaleString();
  const planLabel =
    usage.plan.charAt(0).toUpperCase() + usage.plan.slice(1);

  // Inline progress bar since s-progress-bar is not in Polaris web types
  const barColor =
    usedPct >= 100 ? "#d82c0d" : usedPct >= 80 ? "#b98900" : "#008060";

  return (
    <s-page heading="Plan &amp; Billing">
      <s-section heading="Current Usage">
        <s-box padding="base" background="subdued" borderRadius="base">
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
            <s-text>Current plan:</s-text>
            <s-badge tone={usage.plan === "free" ? "neutral" : "success"}>
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
                width: `${usedPct}%`,
                background: barColor,
                borderRadius: "4px",
                transition: "width 0.3s ease",
              }}
            />
          </div>
          <div style={{ marginTop: "4px" }}>
            <s-text tone="neutral">{usedPct}% used</s-text>
          </div>
        </s-box>
      </s-section>

      <s-section heading="Choose a Plan">
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
          {PLANS.map((plan) => {
            const isCurrent = usage.plan === plan.key;
            return (
              <div
                key={plan.key}
                style={{
                  flex: "1 1 240px",
                  border: isCurrent
                    ? "2px solid #008060"
                    : "1px solid #e1e3e5",
                  borderRadius: "8px",
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
                  <s-heading>{plan.name}</s-heading>
                  {isCurrent && <s-badge tone="success">Current</s-badge>}
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
                <div style={{ marginTop: "auto" }}>
                  <Form method="post">
                    <input type="hidden" name="plan" value={plan.key} />
                    <button
                      type="submit"
                      disabled={isCurrent}
                      style={{
                        width: "100%",
                        padding: "10px 16px",
                        background: isCurrent ? "#e1e3e5" : "#008060",
                        color: isCurrent ? "#6d7175" : "#ffffff",
                        border: "none",
                        borderRadius: "6px",
                        cursor: isCurrent ? "default" : "pointer",
                        fontWeight: 600,
                        fontSize: "14px",
                      }}
                    >
                      {isCurrent
                        ? "Current plan"
                        : `Upgrade to ${plan.name}`}
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
    </s-page>
  );
}
