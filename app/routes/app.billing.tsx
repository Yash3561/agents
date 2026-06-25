import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getUsage, PLAN_LIMITS, PLAN_CONFIG } from "../lib/billing.server";
import db from "../db.server";

const VALID_PLANS = ["spark", "pulse", "surge"] as const;
type PlanKey = (typeof VALID_PLANS)[number];

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const usage = await getUsage(session.shop);

  let activeSubscription: { id: string; name: string } | null = null;
  try {
    const result = await admin.graphql(`#graphql
      {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
            test
            lineItems {
              plan {
                pricingDetails {
                  ... on AppRecurringPricing {
                    price { amount }
                  }
                }
              }
            }
          }
        }
      }
    `);
    const data = await result.json() as {
      data?: { currentAppInstallation?: { activeSubscriptions?: Array<{ id: string; name: string; status: string; test: boolean; lineItems: Array<{ plan: { pricingDetails: { amount?: string } } }> }> } }
    };
    const subs = data.data?.currentAppInstallation?.activeSubscriptions ?? [];
    const activeSub = subs.find(s => s.status === "ACTIVE" || s.status === "PENDING");
    if (activeSub) {
      activeSubscription = { id: activeSub.id, name: activeSub.name };
      const planName = activeSub.name.toLowerCase();
      if (VALID_PLANS.includes(planName as PlanKey) && planName !== usage.plan) {
        await db.merchant.update({
          where: { shopDomain: session.shop },
          data: { plan: planName },
        });
        usage.plan = planName;
        usage.limit = PLAN_LIMITS[planName as PlanKey] ?? 0;
      }
    } else {
      // No active subscription — if DB shows a paid plan, downgrade to free
      if (VALID_PLANS.includes(usage.plan as PlanKey)) {
        await db.merchant.update({ where: { shopDomain: session.shop }, data: { plan: "free" } });
        usage.plan = "free";
        usage.limit = 0;
      }
    }
  } catch (e) {
    console.error("[billing] subscription check failed:", e);
  }

  // Pull actual reset date from DB so the display matches billing.server.ts's
  // UTC-month-boundary logic, not a hard-coded "1st of next calendar month".
  const merchant = await db.merchant.findUnique({
    where: { shopDomain: session.shop },
    select: { conversationResetAt: true },
  });
  const lastReset = merchant?.conversationResetAt ?? new Date();
  // Next reset = exactly 30 days after last reset (matches EVERY_30_DAYS Shopify billing cycle).
  // conversationResetAt is anchored to subscription activatedOn via the subscriptions webhook.
  const nextReset = new Date(lastReset.getTime() + 30 * 24 * 60 * 60 * 1000);
  const now = new Date();
  const daysUntilReset = Math.ceil((nextReset.getTime() - now.getTime()) / 86400000);
  const resetAtStr = nextReset.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

  return { usage, activeSubscription, resetAtStr, daysUntilReset };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const plan = String(formData.get("plan"));

  if (!VALID_PLANS.includes(plan as PlanKey)) {
    return { error: "Invalid plan" };
  }

  const config = PLAN_CONFIG[plan as PlanKey];
  const isTest = process.env.BILLING_TEST_MODE === "true";
  // Return to the app ROOT only — not a sub-path. Shopify stores this URL as
  // the "Manage" link in its billing settings. Sub-paths like /app/billing cause
  // a Shopify admin server-side 404 because embedded app deep links only work
  // client-side via App Bridge. Merchant navigates to Billing via the nav after landing.
  const shopHandle = session.shop.replace(".myshopify.com", "");
  const returnUrl = `https://admin.shopify.com/store/${shopHandle}/apps/${process.env.SHOPIFY_API_KEY}`;

  try {
    const response = await admin.graphql(
      `#graphql
      mutation AppSubscriptionCreate(
        $name: String!, $returnUrl: URL!, $test: Boolean!,
        $trialDays: Int, $price: Decimal!
      ) {
        appSubscriptionCreate(
          name: $name returnUrl: $returnUrl test: $test trialDays: $trialDays
          lineItems: [{ plan: { appRecurringPricingDetails: {
            price: { amount: $price, currencyCode: USD }
            interval: EVERY_30_DAYS
          } } }]
        ) {
          userErrors { field message }
          confirmationUrl
          appSubscription { id status }
        }
      }`,
      {
        variables: {
          name: config.name,
          returnUrl,
          test: isTest,
          trialDays: config.trialDays,
          price: String(config.amount),
        },
      },
    );

    const data = await response.json() as {
      data?: { appSubscriptionCreate?: { userErrors: { message: string }[]; confirmationUrl?: string } };
    };
    const result = data.data?.appSubscriptionCreate;

    if (result?.userErrors?.length) {
      console.error("[billing] userErrors:", result.userErrors);
      return { error: "billing_error", detail: result.userErrors[0].message };
    }

    if (!result?.confirmationUrl) {
      console.error("[billing] no confirmationUrl:", JSON.stringify(data));
      return { error: "billing_error", detail: "No confirmation URL returned" };
    }

    console.log("[billing] subscription created, redirecting to payment page");
    return { redirectUrl: result.confirmationUrl };
  } catch (e) {
    console.error("[billing] unexpected error:", e);
    return { error: "billing_error", detail: String(e) };
  }
}

const ALL_FEATURES = [
  "AI-powered chat widget on your storefront",
  "Live catalog search (always real-time, never stale)",
  "Personalized product recommendations",
  "Customer memory & personalized greetings",
  "Abandoned cart recovery",
  "Multi-tier discount negotiation",
  "Revenue attribution dashboard",
  "Widget customization (color, position, greeting)",
  "GDPR compliant",
];

const PLANS: Array<{
  key: PlanKey;
  name: string;
  price: string;
  conversations: string;
  recommended?: boolean;
}> = [
  {
    key: "spark",
    name: "Spark",
    price: "$29",
    conversations: "500 conversations/mo",
  },
  {
    key: "pulse",
    name: "Pulse",
    price: "$79",
    conversations: "2,500 conversations/mo",
    recommended: true,
  },
  {
    key: "surge",
    name: "Surge",
    price: "$199",
    conversations: "10,000 conversations/mo",
  },
];

const PLAN_ORDER: Record<string, number> = { spark: 0, pulse: 1, surge: 2 };
const planDotColor: Record<string, string> = {
  spark: "#2563eb",
  pulse: "#7c3aed",
  surge: "#d97706",
};

interface PlanCardProps {
  plan: (typeof PLANS)[number];
  isCurrent: boolean;
  currentPlanRank: number;
}

function PlanCard({ plan, isCurrent, currentPlanRank }: PlanCardProps) {
  const fetcher = useFetcher<typeof action>();
  const isSubmitting = fetcher.state === "submitting";
  const billingError = fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;
  const redirectUrl = fetcher.data && "redirectUrl" in fetcher.data ? fetcher.data.redirectUrl : null;

  // When billing.request() succeeds it throws a 3xx redirect that useFetcher
  // won't follow automatically. We receive the URL as data and must navigate
  // the top-level Shopify admin window (not just the embedded iframe).
  useEffect(() => {
    if (redirectUrl) {
      window.open(redirectUrl, "_top");
    }
  }, [redirectUrl]);

  return (
    <div
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
        <s-heading>
          <span style={{ color: planDotColor[plan.key] ?? "#6b7280", marginRight: "6px" }}>●</span>
          {plan.name}
        </s-heading>
        <div style={{ display: "flex", gap: "6px" }}>
          {plan.recommended && !isCurrent && <s-badge tone="info">Most Popular</s-badge>}
          {isCurrent && <s-badge tone="success">Current</s-badge>}
        </div>
      </div>
      <div>
        <span style={{ fontSize: "28px", fontWeight: 700 }}>{plan.price}</span>
        <span style={{ color: "#6d7175" }}> / month</span>
      </div>
      <s-text tone="neutral">{plan.conversations}</s-text>
      <ul style={{ margin: "0", paddingLeft: "20px", color: "#202223" }}>
        {ALL_FEATURES.map((f) => (
          <li key={f} style={{ marginBottom: "4px" }}>
            <s-text>{f}</s-text>
          </li>
        ))}
      </ul>
      <div style={{ marginTop: "auto" }}>
        {billingError && (
          <div style={{ marginBottom: "8px", padding: "8px 12px", background: "#fff0f0", border: "1px solid #fca5a5", borderRadius: "6px" }}>
            <s-text tone="critical">
              {"detail" in (fetcher.data ?? {})
                ? `Billing error: ${(fetcher.data as { detail?: string }).detail}`
                : "Something went wrong with billing. Please try again."}
            </s-text>
          </div>
        )}
        <fetcher.Form method="POST">
          <input type="hidden" id={`plan-input-${plan.key}`} name="plan" value={plan.key} />
          <button
            id={`plan-submit-${plan.key}`}
            type="submit"
            disabled={isCurrent || isSubmitting}
            style={{
              width: "100%",
              padding: "10px 16px",
              background: isCurrent ? "#e1e3e5" : "#008060",
              color: isCurrent ? "#6d7175" : "#ffffff",
              border: "none",
              borderRadius: "6px",
              cursor: isCurrent || isSubmitting ? "default" : "pointer",
              fontWeight: 600,
              fontSize: "14px",
              opacity: isSubmitting ? 0.7 : 1,
            }}
          >
            {isCurrent
              ? "Current plan"
              : isSubmitting
              ? "Loading..."
              : currentPlanRank === -1
              ? `Choose ${plan.name}`
              : PLAN_ORDER[plan.key] > currentPlanRank
              ? `Upgrade to ${plan.name}`
              : `Switch to ${plan.name}`}
          </button>
        </fetcher.Form>
      </div>
    </div>
  );
}

export default function BillingPage() {
  const { usage, activeSubscription, resetAtStr, daysUntilReset } = useLoaderData<typeof loader>();

  const hasActivePlan = usage.plan in PLAN_LIMITS;
  const usagePct =
    usage.limit > 0
      ? Math.min(100, Math.round((usage.used / usage.limit) * 100))
      : 0;
  const limitDisplay =
    usage.limit >= 999_000 ? "Unlimited" : usage.limit.toLocaleString();

  // Inline progress bar since s-progress-bar is not in Polaris web types
  const barColor =
    usagePct >= 100 ? "#dc2626" : usagePct >= 80 ? "#d97706" : "#16a34a";

  const currentPlanRank = PLAN_ORDER[usage.plan] ?? -1; // -1 = no paid plan, all 3 show as "Choose"

  return (
    <s-page heading="Plan &amp; Billing">
      <s-section heading="Current Plan">
        {!hasActivePlan ? (
          <s-box padding="base" background="subdued" borderRadius="base">
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px" }}>
              <s-text>Current plan:</s-text>
              <s-badge tone="neutral">No active plan</s-badge>
              {activeSubscription && <s-badge tone="warning">Pending activation</s-badge>}
            </div>
            <s-text tone="neutral">
              Choose a plan below to activate your NeonPing chat widget. All plans include a 7-day free trial — no charge until the trial ends.
            </s-text>
          </s-box>
        ) : (
          <s-box padding="base" background="subdued" borderRadius="base">
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
              <s-text>Current plan:</s-text>
              <s-badge tone="success">
                {usage.plan.charAt(0).toUpperCase() + usage.plan.slice(1)}
              </s-badge>
              {activeSubscription && <s-badge tone="info">Active</s-badge>}
            </div>
            <s-text>
              <strong>{usage.used.toLocaleString()}</strong> / {limitDisplay} conversations used this month
            </s-text>
            <div style={{ marginTop: "8px", height: "8px", background: "#e1e3e5", borderRadius: "4px", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${usagePct}%`, background: barColor, borderRadius: "4px", transition: "width 0.3s ease" }} />
            </div>
            <div style={{ marginTop: "6px", display: "flex", justifyContent: "space-between" }}>
              <s-text tone="neutral">{usagePct}% used</s-text>
              <s-text tone="neutral">
                Resets {resetAtStr} ({daysUntilReset <= 0 ? "soon" : daysUntilReset === 1 ? "tomorrow" : `in ${daysUntilReset} days`})
              </s-text>
            </div>
            {usagePct >= 80 && usagePct < 100 && (
              <div style={{ marginTop: "12px" }}>
                <s-banner tone="warning">
                  {`You've used ${usagePct}% of your monthly conversations. `}
                  <a href="#plans" style={{ color: "inherit", fontWeight: 600 }}>Upgrade now</a>
                  {" to avoid hitting your limit mid-month."}
                </s-banner>
              </div>
            )}
            {usagePct >= 100 && (
              <div style={{ marginTop: "12px" }}>
                <s-banner tone="critical">
                  You&apos;ve reached your conversation limit. New chats are paused until your plan resets or you upgrade.
                </s-banner>
              </div>
            )}
          </s-box>
        )}
      </s-section>

      {!hasActivePlan && (
        <s-banner tone="info">
          <strong>Almost there!</strong> Choose a plan to activate your NeonPing AI assistant. All plans include a 7-day free trial — cancel any time.
        </s-banner>
      )}

      <s-section heading={hasActivePlan ? "Manage Plan" : "Choose a Plan"} id="plans">
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
          {PLANS.map((plan) => (
            <PlanCard
              key={plan.key}
              plan={plan}
              isCurrent={usage.plan === plan.key}
              currentPlanRank={currentPlanRank}
            />
          ))}
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

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
