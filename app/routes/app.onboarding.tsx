import { useState, useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const merchant = await prisma.merchant.upsert({
    where: { shopDomain: shop },
    update: {},
    create: { shopDomain: shop },
  });

  if (merchant.onboardedAt) {
    throw redirect("/app");
  }

  return { shop, merchant, appUrl: process.env.SHOPIFY_APP_URL ?? "" };
};

const VALID_VOICES_ONBOARDING = new Set([
  "friendly and helpful",
  "professional and concise",
  "playful and fun",
  "premium and polished",
]);
const HEX_RE_ONBOARDING = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") === "save-step") {
    try {
      await prisma.merchant.update({
        where: { shopDomain: session.shop },
        data: { onboardingStep: Number(formData.get("step")) || 1 },
      });
    } catch {
      return { error: "Failed to save settings. Please try again." };
    }
    return { ok: true };
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
        personalizationEnabled: formData.get("personalizationEnabled") === "true",
        onboardedAt: new Date(),
        onboardingStep: 4,
      },
    });
  } catch {
    return { error: "Failed to save settings. Please try again." };
  }

  const url = new URL(request.url);
  return redirect(`/app/billing?${url.searchParams.toString()}`);
};

async function sendTestMessage(shop: string, appUrl: string): Promise<string> {
  const res = await fetch(`${appUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: `onboarding-test-${Date.now()}`,
      shop,
      message: "hello",
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const raw = await res.text();
  let text = "";
  for (const block of raw.split("\n\n")) {
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
    const eventLine = block.split("\n").find((l) => l.startsWith("event:"));
    if (eventLine?.slice(6).trim() === "delta" && dataLine) {
      try {
        text += JSON.parse(dataLine.slice(5).trim()).text;
      } catch {
        // skip malformed chunk
      }
    }
  }
  return text || "(no response text)";
}

// Fix G — WidgetPreview now accepts botName prop
function WidgetPreview({ color, greeting, botName }: { color: string; greeting: string; botName?: string }) {
  return (
    <div style={{ position: "relative", height: 200, background: "#f0f0f3", borderRadius: 12, border: "1px solid #e1e1e1", overflow: "hidden", marginTop: "16px" }}>
      <div style={{ position: "absolute", top: 10, left: 12, fontSize: 11, color: "#9a9a9a", fontFamily: "system-ui, sans-serif" }}>Your storefront</div>
      <div style={{ position: "absolute", bottom: 56, right: 16, width: 190, borderRadius: 14, background: "#fff", boxShadow: "0 8px 24px rgba(0,0,0,.18)", overflow: "hidden", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ background: color || "#1a1a1a", color: "#fff", padding: "8px 12px", fontSize: 12, fontWeight: 600 }}>
          {botName || "Your store assistant"}
        </div>
        <div style={{ padding: 10, background: "#fff", fontSize: 11, color: "#111" }}>{greeting || "Hi! How can I help you today?"}</div>
      </div>
      <div style={{ position: "absolute", bottom: 12, right: 16, width: 36, height: 36, borderRadius: "50%", background: color || "#1a1a1a" }} />
    </div>
  );
}

export default function Onboarding() {
  const { shop, merchant, appUrl } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [step, setStep] = useState(merchant.onboardingStep || 1);
  const [botName, setBotName] = useState(merchant.botName || "");
  const [widgetColor, setWidgetColor] = useState(merchant.widgetColor);
  const [widgetGreeting, setWidgetGreeting] = useState(merchant.widgetGreeting);
  const [brandVoice, setBrandVoice] = useState(merchant.brandVoice);
  const [personalizationEnabled, setPersonalizationEnabled] = useState(
    merchant.personalizationEnabled,
  );
  const [themeConfirmed, setThemeConfirmed] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  useEffect(() => {
    const data = fetcher.data as { error?: string } | undefined;
    if (fetcher.state === "idle" && data?.error) {
      shopify.toast.show(data.error, { isError: true });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const selectedPreset = VOICE_PRESETS.find((p) => p.value === brandVoice);

  const goToStep = (nextStep: number) => {
    setStep(nextStep);
    fetcher.submit({ intent: "save-step", step: String(nextStep) }, { method: "POST" });
  };

  const finish = () => {
    fetcher.submit(
      {
        botName,
        widgetColor,
        widgetGreeting,
        brandVoice,
        personalizationEnabled: String(personalizationEnabled),
      },
      { method: "POST" },
    );
  };

  const runTest = async () => {
    setTestLoading(true);
    setTestResult(null);
    try {
      const text = await sendTestMessage(shop, appUrl);
      setTestResult(text);
    } catch {
      setTestResult("Something went wrong reaching the assistant. Try again.");
    } finally {
      setTestLoading(false);
    }
  };

  const storeHandle = shop.replace(".myshopify.com", "");
  const themeEditorUrl = `https://admin.shopify.com/store/${storeHandle}/themes`;

  return (
    <s-page heading="Welcome to NeonPing">
      {/* Fix H — Visual step progress bar */}
      <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "24px", padding: "0 4px" }}>
        {[1, 2, 3, 4].map((s) => (
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
            {s < 4 && <div style={{ width: "40px", height: "2px", background: s < step ? "#1a1a1a" : "#e1e1e1" }} />}
          </div>
        ))}
      </div>

      {step === 1 && (
        <s-section heading="Step 1 of 4 — Brand setup">
          {/* Fix G — Bot name field */}
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
          <WidgetPreview color={widgetColor} greeting={widgetGreeting} botName={botName} />
          <s-stack direction="inline" gap="base">
            <s-button onClick={() => goToStep(2)} variant="primary">
              Next
            </s-button>
          </s-stack>
        </s-section>
      )}

      {step === 2 && (
        <s-section heading="Step 2 of 4 — AI personality">
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
              <s-text>"{selectedPreset.preview}"</s-text>
            </s-paragraph>
          ) : null}
          <s-stack direction="inline" gap="base">
            <s-button onClick={() => goToStep(1)} variant="tertiary">
              Back
            </s-button>
            <s-button onClick={() => goToStep(3)} variant="primary">
              Next
            </s-button>
          </s-stack>
        </s-section>
      )}

      {step === 3 && (
        <s-section heading="Step 3 of 4 — Discount rules">
          <s-switch
            label="Enable personalized discounts"
            checked={personalizationEnabled}
            onChange={(e: Event) =>
              setPersonalizationEnabled((e.target as HTMLInputElement).checked)
            }
            help-text="When enabled, NeonPing shares active discount codes from your Shopify Discounts tab when customers ask, or to recover abandoned carts."
          ></s-switch>
          <s-stack direction="inline" gap="base">
            <s-button onClick={() => goToStep(2)} variant="tertiary">
              Back
            </s-button>
            <s-button onClick={() => goToStep(4)} variant="primary">
              Next
            </s-button>
          </s-stack>
        </s-section>
      )}

      {step === 4 && (
        <s-section heading="Step 4 of 4 — Go live">
          <s-paragraph>
            Enable the NeonPing chat widget on your storefront by opening your theme editor
            and turning on the App Embed.
          </s-paragraph>
          <s-link href={themeEditorUrl} target="_blank">
            Open Theme Editor → Add Widget
          </s-link>
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
            <s-button onClick={() => goToStep(3)} variant="tertiary">
              Back
            </s-button>
            <s-button onClick={finish} variant="primary" disabled={!themeConfirmed}>
              Finish
            </s-button>
          </s-stack>
          {!themeConfirmed && (
            <p style={{ fontSize: "12px", color: "#b45309", marginTop: "8px" }}>
              ⚠️ Please confirm you've added the widget to your theme before finishing.
            </p>
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
