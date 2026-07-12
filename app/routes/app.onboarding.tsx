import { useState, useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData, useRevalidator, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { PLAN_CONFIG, PLAN_LIMITS } from "../lib/plans";
import { sendTestMessage } from "../lib/test-chat";
import { WidgetPreview } from "~/components/WidgetPreview";

const VOICE_PRESETS = [
  {
    value: "friendly and helpful",
    label: "Friendly & helpful",
    preview: "Hey there! Let me know if you need help finding anything!",
  },
  {
    value: "professional and concise",
    label: "Professional & concise",
    preview: "Hello. How can I assist you with your order today?",
  },
  {
    value: "playful and fun",
    label: "Playful & fun",
    preview: "Heyyy! What are we shopping for today?",
  },
  {
    value: "premium and polished",
    label: "Premium & polished",
    preview: "Welcome. I'm here to help you find exactly what you're looking for.",
  },
];

const VALID_PLANS_ONBOARDING = ["spark", "pulse", "surge"] as const;
type OnboardingPlanKey = (typeof VALID_PLANS_ONBOARDING)[number];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const merchant = await prisma.merchant.upsert({
    where: { shopDomain: shop },
    update: {},
    create: { shopDomain: shop },
  });

  if (merchant.onboardedAt) {
    const params = new URL(request.url).searchParams.toString();
    throw redirect(params ? `/app?${params}` : "/app");
  }

  // Whether a real Shopify subscription exists (ACTIVE or PENDING). Used to
  // distinguish "waiting for the billing webhook" from "merchant continued on
  // free" so the final plan step can show a 'verifying your subscription' state.
  let hasShopifySub = false;
  try {
    const result = await admin.graphql(
      `#graphql
      { currentAppInstallation { activeSubscriptions { status } } }`,
    );
    const data = await result.json() as {
      data?: { currentAppInstallation?: { activeSubscriptions?: Array<{ status: string }> } };
    };
    hasShopifySub = (data.data?.currentAppInstallation?.activeSubscriptions ?? [])
      .some((s) => s.status === "ACTIVE" || s.status === "PENDING");
  } catch {
    // fall back to false — merchant sees plan cards, worst case re-subscribing is blocked by Shopify
  }

  return { shop, merchant, hasShopifySub, appUrl: process.env.SHOPIFY_APP_URL ?? "" };
};

const VALID_VOICES_ONBOARDING = new Set([
  "friendly and helpful",
  "professional and concise",
  "playful and fun",
  "premium and polished",
]);
const HEX_RE_ONBOARDING = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") === "save-step") {
    try {
      const rawStep = Number(formData.get("step")) || 1;
      const updateData: Record<string, unknown> = { onboardingStep: Math.min(3, Math.max(1, rawStep)) };
      const botName = formData.get("botName");
      const widgetGreeting = formData.get("widgetGreeting");
      const widgetColor = formData.get("widgetColor");
      const brandVoice = formData.get("brandVoice");
      if (botName) updateData.botName = String(botName).trim().slice(0, 30) || "NeonPing";
      if (widgetGreeting) updateData.widgetGreeting = String(widgetGreeting).slice(0, 500);
      if (widgetColor) {
        const rawColor = String(widgetColor).trim();
        updateData.widgetColor = HEX_RE_ONBOARDING.test(rawColor) ? rawColor : "#1a1a1a";
      }
      if (brandVoice) {
        const rawVoice = String(brandVoice);
        updateData.brandVoice = VALID_VOICES_ONBOARDING.has(rawVoice) ? rawVoice : "friendly and helpful";
      }
      await prisma.merchant.update({
        where: { shopDomain: session.shop },
        data: updateData,
      });
    } catch {
      return { error: "Failed to save settings. Please try again." };
    }
    return { ok: true };
  }

  if (formData.get("intent") === "subscribe") {
    const plan = String(formData.get("plan"));
    if (!VALID_PLANS_ONBOARDING.includes(plan as OnboardingPlanKey)) {
      return { error: "Invalid plan selected." };
    }

    const config = PLAN_CONFIG[plan as OnboardingPlanKey];
    const isTest = process.env.BILLING_TEST_MODE === "true";
    const merchantTrial = await prisma.merchant.findUnique({
      where: { shopDomain: session.shop },
      select: { trialUsedAt: true },
    });
    const trialDays = merchantTrial?.trialUsedAt ? 0 : config.trialDays;
    const shopHandle = session.shop.replace(".myshopify.com", "");
    // Return merchant to onboarding after Shopify billing confirmation.
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
            trialDays,
            price: String(config.amount),
          },
        },
      );

      const data = await response.json() as {
        data?: { appSubscriptionCreate?: { userErrors: { message: string }[]; confirmationUrl?: string } };
      };
      const result = data.data?.appSubscriptionCreate;

      if (result?.userErrors?.length) {
        console.error("[onboarding/billing] userErrors:", result.userErrors);
        return { error: result.userErrors[0].message };
      }

      if (!result?.confirmationUrl) {
        console.error("[onboarding/billing] no confirmationUrl:", JSON.stringify(data));
        return { error: "No confirmation URL returned. Please try again." };
      }

      // Save step progress so merchant resumes at the final plan step if they return later.
      await prisma.merchant.update({
        where: { shopDomain: session.shop },
        data: { onboardingStep: 3 },
      }).catch(() => null);

      return { redirectUrl: result.confirmationUrl };
    } catch (e) {
      console.error("[onboarding/billing] unexpected error:", e);
      return { error: "Something went wrong with billing. Please try again." };
    }
  }

  if (formData.get("intent") === "skip-plan") {
    try {
      await prisma.merchant.update({
        where: { shopDomain: session.shop },
        data: { onboardingStep: 3 },
      });
    } catch {
      return { error: "Failed to save progress. Please try again." };
    }
    return { ok: true, skippedPlan: true };
  }

  // Final submit — validate widget config fields
  const rawColor = String(formData.get("widgetColor") ?? "").trim();
  const widgetColor = HEX_RE_ONBOARDING.test(rawColor) ? rawColor : "#1a1a1a";

  const rawVoice = String(formData.get("brandVoice") ?? "");
  const brandVoice = VALID_VOICES_ONBOARDING.has(rawVoice) ? rawVoice : "friendly and helpful";

  const botName = String(formData.get("botName") ?? "").trim().slice(0, 30) || "NeonPing";
  const widgetGreeting = String(formData.get("widgetGreeting") ?? "").slice(0, 500);

  try {
    await prisma.merchant.update({
      where: { shopDomain: session.shop },
      data: {
        widgetColor,
        widgetGreeting,
        botName,
        brandVoice,
        onboardedAt: new Date(),
        onboardingStep: 3,
      },
    });
  } catch {
    return { error: "Failed to save settings. Please try again." };
  }

  const url = new URL(request.url);
  return redirect(`/app?${url.searchParams.toString()}`);
};

// ─── Plan data for Step 3 ────────────────────────────────────────────────────

const ONBOARDING_PLANS: Array<{
  key: OnboardingPlanKey;
  name: string;
  price: string;
  priceNumber: number;
  conversations: string;
  tagline: string;
  recommended?: boolean;
}> = [
  {
    key: "spark",
    name: "Spark",
    price: "$29",
    priceNumber: 29,
    conversations: "500 conversations / mo",
    tagline: "Perfect for getting started",
  },
  {
    key: "pulse",
    name: "Pulse",
    price: "$79",
    priceNumber: 79,
    conversations: "2,500 conversations / mo",
    tagline: "Best for growing stores",
    recommended: true,
  },
  {
    key: "surge",
    name: "Surge",
    price: "$199",
    priceNumber: 199,
    conversations: "10,000 conversations / mo",
    tagline: "For high-volume stores",
  },
];

const PLAN_FEATURES = [
  "AI shopping assistant on your storefront",
  "Abandoned cart recovery",
  "Personalized customer greetings",
  "Live catalog search (always real-time)",
  "Revenue attribution dashboard",
  "GDPR compliant",
];

const planAccentColor: Record<OnboardingPlanKey, string> = {
  spark: "#2563eb",
  pulse: "#7c3aed",
  surge: "#d97706",
};

interface OnboardingPlanCardProps {
  plan: (typeof ONBOARDING_PLANS)[number];
  onChoose: (key: OnboardingPlanKey) => void;
  isLoading: boolean;
  choosingPlan: string | null;
}

function OnboardingPlanCard({ plan, onChoose, isLoading, choosingPlan }: OnboardingPlanCardProps) {
  const isThisLoading = isLoading && choosingPlan === plan.key;
  return (
    <div
      style={{
        flex: "1 1 220px",
        border: plan.recommended ? "2px solid #7c3aed" : "1px solid #e1e3e5",
        borderRadius: "12px",
        padding: "20px",
        background: plan.recommended ? "#faf5ff" : "#ffffff",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        position: "relative",
      }}
    >
      {plan.recommended && (
        <div
          style={{
            position: "absolute",
            top: "-12px",
            left: "50%",
            transform: "translateX(-50%)",
            background: "#7c3aed",
            color: "#fff",
            fontSize: "11px",
            fontWeight: 700,
            padding: "3px 12px",
            borderRadius: "12px",
            whiteSpace: "nowrap",
          }}
        >
          RECOMMENDED
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ fontSize: "20px", color: planAccentColor[plan.key] }}>●</span>
        <span style={{ fontSize: "18px", fontWeight: 700, color: "#202223" }}>{plan.name}</span>
      </div>
      <div>
        <span style={{ fontSize: "32px", fontWeight: 800, color: "#202223" }}>{plan.price}</span>
        <span style={{ fontSize: "14px", color: "#6d7175" }}> / month</span>
      </div>
      <div style={{ fontSize: "13px", color: "#6d7175", fontStyle: "italic" }}>{plan.tagline}</div>
      <div style={{ fontSize: "13px", fontWeight: 600, color: planAccentColor[plan.key] }}>
        {plan.conversations}
      </div>
      <ul style={{ margin: "4px 0 0", paddingLeft: "18px", color: "#202223", fontSize: "13px" }}>
        {PLAN_FEATURES.map((f) => (
          <li key={f} style={{ marginBottom: "4px" }}>{f}</li>
        ))}
      </ul>
      <div style={{ marginTop: "auto", paddingTop: "12px" }}>
        <button
          type="button"
          onClick={() => onChoose(plan.key)}
          disabled={isLoading}
          style={{
            width: "100%",
            padding: "11px 16px",
            background: plan.recommended ? "#7c3aed" : "#1a1a1a",
            color: "#ffffff",
            border: "none",
            borderRadius: "8px",
            cursor: isLoading ? "default" : "pointer",
            fontWeight: 700,
            fontSize: "14px",
            opacity: isLoading ? 0.65 : 1,
            transition: "opacity 0.15s",
          }}
        >
          {isThisLoading ? "Loading..." : "Start 7-Day Free Trial"}
        </button>
        <div style={{ textAlign: "center", marginTop: "6px", fontSize: "11px", color: "#6d7175" }}>
          No charge today
        </div>
      </div>
    </div>
  );
}

function OnboardingFreePlanCard({ onContinue, isLoading }: { onContinue: () => void; isLoading: boolean }) {
  return (
    <div
      style={{
        flex: "1 1 220px",
        border: "1px solid #e1e3e5",
        borderRadius: "12px",
        padding: "20px",
        background: "#ffffff",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ fontSize: "20px", color: "#6d7175" }}>●</span>
        <span style={{ fontSize: "18px", fontWeight: 700, color: "#202223" }}>Free</span>
      </div>
      <div>
        <span style={{ fontSize: "32px", fontWeight: 800, color: "#202223" }}>$0</span>
        <span style={{ fontSize: "14px", color: "#6d7175" }}> / month</span>
      </div>
      <div style={{ fontSize: "13px", color: "#6d7175", fontStyle: "italic" }}>
        Start with the widget live and upgrade when you need more volume
      </div>
      <div style={{ fontSize: "13px", fontWeight: 600, color: "#6d7175" }}>
        {PLAN_LIMITS.free} conversations / mo
      </div>
      <ul style={{ margin: "4px 0 0", paddingLeft: "18px", color: "#202223", fontSize: "13px" }}>
        <li style={{ marginBottom: "4px" }}>AI shopping assistant on your storefront</li>
        <li style={{ marginBottom: "4px" }}>Basic storefront chat activation</li>
        <li style={{ marginBottom: "4px" }}>Upgrade any time from Billing</li>
      </ul>
      <div style={{ marginTop: "auto", paddingTop: "12px" }}>
        <button
          type="button"
          onClick={onContinue}
          disabled={isLoading}
          style={{
            width: "100%",
            padding: "11px 16px",
            background: "#1a1a1a",
            color: "#ffffff",
            border: "none",
            borderRadius: "8px",
            cursor: isLoading ? "default" : "pointer",
            fontWeight: 700,
            fontSize: "14px",
            opacity: isLoading ? 0.65 : 1,
            transition: "opacity 0.15s",
          }}
        >
          Continue on free
        </button>
        <div style={{ textAlign: "center", marginTop: "6px", fontSize: "11px", color: "#6d7175" }}>
          No subscription needed
        </div>
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function Onboarding() {
  const { shop, merchant, hasShopifySub, appUrl } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();

  const [step, setStep] = useState(Math.min(3, Math.max(1, merchant.onboardingStep || 1)));
  const [botName, setBotName] = useState(merchant.botName || "");
  const [widgetColor, setWidgetColor] = useState(merchant.widgetColor);
  const [widgetGreeting, setWidgetGreeting] = useState(merchant.widgetGreeting);
  const [brandVoice, setBrandVoice] = useState(merchant.brandVoice);
  const [themeConfirmed, setThemeConfirmed] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const [choosingPlan, setChoosingPlan] = useState<string | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);

  const isActivePlan = VALID_PLANS_ONBOARDING.includes(merchant.plan as OnboardingPlanKey);
  const verifyingSubscription = step === 3 && hasShopifySub && !isActivePlan;

  // ponytail: fixed poll interval, not exponential backoff — this is a rare
  // webhook-lag window (usually seconds), and the manual "Check now" button
  // below is the real escape hatch. Upgrade if webhook delays ever grow long.
  useEffect(() => {
    if (!verifyingSubscription) return;
    const id = setInterval(() => revalidator.revalidate(), 4000);
    return () => clearInterval(id);
  }, [verifyingSubscription, revalidator]);

  // Handle fetcher responses
  useEffect(() => {
    const data = fetcher.data as Record<string, unknown> | undefined;
    if (fetcher.state !== "idle" || !data) return;

    if ("error" in data && typeof data.error === "string") {
      setBillingError(data.error);
      shopify.toast.show(data.error, { isError: true });
      setChoosingPlan(null);
      return;
    }

    if ("redirectUrl" in data && typeof data.redirectUrl === "string") {
      // Navigate Shopify admin top frame to billing confirmation page
      window.open(data.redirectUrl, "_top");
      return;
    }

  }, [fetcher.state, fetcher.data, shopify]);

  const selectedPreset = VOICE_PRESETS.find((p) => p.value === brandVoice);

  const goToStep = (nextStep: number, extraData: Record<string, string> = {}) => {
    setStep(nextStep);
    fetcher.submit({ intent: "save-step", step: String(nextStep), ...extraData }, { method: "POST" });
  };

  const choosePlan = (planKey: OnboardingPlanKey) => {
    setBillingError(null);
    setChoosingPlan(planKey);
    fetcher.submit({ intent: "subscribe", plan: planKey }, { method: "POST" });
  };

  const skipPlan = () => {
    finish();
  };

  const finish = () => {
    fetcher.submit(
      {
        botName,
        widgetColor,
        widgetGreeting,
        brandVoice,
      },
      { method: "POST" },
    );
  };

  const runTest = async () => {
    setTestLoading(true);
    setTestResult(null);
    try {
      const { text } = await sendTestMessage(shop, "hello", appUrl);
      setTestResult(text || "(no response text)");
    } catch {
      setTestResult("Something went wrong reaching the assistant. Try again.");
    } finally {
      setTestLoading(false);
    }
  };

  const storeHandle = shop.replace(".myshopify.com", "");
  const themeEditorUrl = `https://admin.shopify.com/store/${storeHandle}/themes/current/editor?context=apps`;
  const isBillingLoading = fetcher.state !== "idle" && choosingPlan !== null;

  return (
    <s-page heading="Welcome to NeonPing">
      {/* Visual step progress bar */}
      <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "24px", padding: "0 4px" }}>
        {[1, 2, 3].map((s) => (
          <div key={s} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div
              style={{
                width: "28px",
                height: "28px",
                borderRadius: "50%",
                background: s < step ? "#1a1a1a" : s === step ? "#1a1a1a" : "#e1e1e1",
                color: s <= step ? "#fff" : "#999",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "12px",
                fontWeight: 700,
              }}
            >
              {s < step ? "✓" : s}
            </div>
            {s < 3 && <div style={{ width: "40px", height: "2px", background: s < step ? "#1a1a1a" : "#e1e1e1" }} />}
          </div>
        ))}
      </div>

      {step === 1 && (
        <s-section heading="Step 1 of 3 — Brand identity">
          <s-text-field
            label="Bot name"
            value={botName}
            onInput={(e: Event) => setBotName((e.target as HTMLInputElement).value)}
            help-text="The name shown in your chat widget header."
            placeholder="Store Assistant"
          ></s-text-field>
          <s-text-field
            label="Opening greeting"
            value={widgetGreeting}
            onInput={(e: Event) => setWidgetGreeting((e.target as HTMLInputElement).value)}
            help-text="The first message customers see when they open your chat widget."
          ></s-text-field>
          <s-color-field
            label="Widget color"
            value={widgetColor}
            onInput={(e: Event) => setWidgetColor((e.target as HTMLInputElement).value)}
            help-text="Choose a color that matches your brand."
          ></s-color-field>
          <s-select
            label="Brand voice"
            value={brandVoice}
            onChange={(e: Event) => setBrandVoice((e.target as HTMLSelectElement).value)}
          >
            {VOICE_PRESETS.map((p) => (
              <s-option key={p.value} value={p.value}>
                {p.label}
              </s-option>
            ))}
          </s-select>
          {selectedPreset ? (
            <s-paragraph>
              <s-text tone="neutral">Preview: </s-text>
              <s-text>{'"'}{selectedPreset.preview}{'"'}</s-text>
            </s-paragraph>
          ) : null}
          <WidgetPreview color={widgetColor} greeting={widgetGreeting} botName={botName} position="bottom-right" />
          <s-stack direction="inline" gap="base">
            <s-button onClick={() => goToStep(2, { botName, widgetGreeting, widgetColor, brandVoice })} variant="primary">
              Next
            </s-button>
          </s-stack>
        </s-section>
      )}

      {step === 2 && (
        <s-section heading="Step 2 of 3 — Go live">
          <s-paragraph>
            Enable the NeonPing chat widget on your storefront by opening your theme editor
            and turning on the App Embed.
          </s-paragraph>
          <div style={{ margin: "12px 0" }}>
            <a
              href={themeEditorUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                display: "inline-block",
                padding: "10px 20px",
                background: "#1a1a1a",
                color: "#ffffff",
                borderRadius: "8px",
                fontWeight: 700,
                fontSize: "14px",
                textDecoration: "none",
              }}
            >
              Open Theme Editor →
            </a>
          </div>
          <s-text tone="neutral">
            In the theme editor: click <strong>Add block</strong> → find <strong>NeonPing Chat Widget</strong> → click <strong>Save</strong>. That{"'"}s it — the widget is live on your store.
          </s-text>

          <s-checkbox
            label="I've added the widget to my theme"
            checked={themeConfirmed}
            onChange={(e: Event) => setThemeConfirmed((e.target as HTMLInputElement).checked)}
          ></s-checkbox>

          <s-button onClick={runTest} {...(testLoading ? { loading: true } : {})}>
            Send test message
          </s-button>
          {testResult ? (
            <s-box padding="base" background="subdued" borderRadius="base">
              <s-text>{testResult}</s-text>
            </s-box>
          ) : null}

          <s-stack direction="inline" gap="base">
            <s-button onClick={() => goToStep(1)} variant="tertiary">
              Back
            </s-button>
            <s-button onClick={() => goToStep(3)} variant="primary" disabled={!themeConfirmed || fetcher.state !== "idle"}>
              Continue
            </s-button>
          </s-stack>
          {!themeConfirmed && (
            <s-banner tone="warning">Please confirm you&apos;ve added the widget to your theme before continuing.</s-banner>
          )}
        </s-section>
      )}

      {step === 3 && (
        <s-section heading="Step 3 of 3 — Plan options">
          {isActivePlan ? (
            /* Merchant already subscribed — show confirmation state */
            <div>
              <div style={{ marginBottom: "20px" }}>
                <s-banner tone="success">
                  <s-text><strong>You&apos;re on the {merchant.plan.charAt(0).toUpperCase() + merchant.plan.slice(1)} plan</strong></s-text>
                  <s-text tone="neutral">Your plan is active and ready to go.</s-text>
                </s-banner>
              </div>
              <s-stack direction="inline" gap="base">
                <s-button onClick={() => goToStep(2)} variant="tertiary">
                  Back
                </s-button>
                <s-button onClick={finish} variant="primary" disabled={fetcher.state !== "idle"}>
                  Finish
                </s-button>
              </s-stack>
            </div>
          ) : verifyingSubscription ? (
            /* Real Shopify subscription exists but the webhook hasn't written the plan yet.
               Auto-polls via revalidator every 4s, plus a manual check + a skip escape
               hatch so a delayed/failed webhook never traps a paying merchant here (#199). */
            <div style={{ textAlign: "center", padding: "48px 24px" }}>
              <div style={{ fontSize: 32, marginBottom: 16 }}>⏳</div>
              <p style={{ fontWeight: 600, fontSize: 16, marginBottom: 8 }}>Verifying your subscription…</p>
              <p style={{ color: "#6d7175", fontSize: 14, marginBottom: 20 }}>
                Your Shopify subscription is being confirmed. This usually takes a few seconds.
              </p>
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-button
                  onClick={() => revalidator.revalidate()}
                  {...(revalidator.state !== "idle" ? { loading: true } : {})}
                >
                  Check now
                </s-button>
                <s-button onClick={finish} variant="tertiary">
                  Continue anyway
                </s-button>
              </s-stack>
            </div>
          ) : (
            /* Show plan selection cards */
            <div>
              <div style={{ marginBottom: "8px" }}>
                <s-text tone="neutral">
                  Your assistant is ready. Continue on free, or choose a paid plan for more monthly conversations.
                </s-text>
              </div>

              {billingError && (
                <div style={{ marginBottom: "16px" }}>
                  <s-banner tone="critical">{billingError}</s-banner>
                </div>
              )}

              <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", paddingTop: "16px" }}>
                <OnboardingFreePlanCard onContinue={skipPlan} isLoading={fetcher.state !== "idle"} />
                {ONBOARDING_PLANS.map((plan) => (
                  <OnboardingPlanCard
                    key={plan.key}
                    plan={plan}
                    onChoose={choosePlan}
                    isLoading={isBillingLoading}
                    choosingPlan={choosingPlan}
                  />
                ))}
              </div>

              <div style={{ marginTop: "24px" }}>
                <s-stack direction="inline" gap="base">
                  <s-button onClick={() => goToStep(2)} variant="tertiary">
                    Back
                  </s-button>
                </s-stack>
              </div>
            </div>
          )}
        </s-section>
      )}
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
