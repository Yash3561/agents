import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData } from "react-router";
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

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") === "save-step") {
    await prisma.merchant.update({
      where: { shopDomain: session.shop },
      data: { onboardingStep: Number(formData.get("step")) || 1 },
    });
    return { ok: true };
  }

  const maxDiscountPct = Math.min(20, Math.max(0, Number(formData.get("maxDiscountPct")) || 0));
  const vipCartThresholdDollars = Number(formData.get("vipCartThreshold")) || 0;

  await prisma.merchant.update({
    where: { shopDomain: session.shop },
    data: {
      widgetColor: String(formData.get("widgetColor") ?? "#1a1a1a"),
      widgetGreeting: String(formData.get("widgetGreeting") ?? ""),
      botName: String(formData.get("botName") ?? "").trim() || "NeonPing",
      brandVoice: String(formData.get("brandVoice") ?? "friendly and helpful"),
      maxDiscountPct,
      vipCartThreshold: Math.round(vipCartThresholdDollars * 100),
      personalizationEnabled: formData.get("personalizationEnabled") === "true",
      onboardedAt: new Date(),
      onboardingStep: 4,
    },
  });

  return redirect("/app");
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

  const [step, setStep] = useState(merchant.onboardingStep || 1);
  const [botName, setBotName] = useState(merchant.botName || "");
  const [widgetColor, setWidgetColor] = useState(merchant.widgetColor);
  const [widgetGreeting, setWidgetGreeting] = useState(merchant.widgetGreeting);
  const [brandVoice, setBrandVoice] = useState(merchant.brandVoice);
  const [maxDiscountPct, setMaxDiscountPct] = useState(String(merchant.maxDiscountPct));
  const [vipCartThreshold, setVipCartThreshold] = useState(
    String(merchant.vipCartThreshold / 100),
  );
  const [personalizationEnabled, setPersonalizationEnabled] = useState(
    merchant.personalizationEnabled,
  );
  const [themeConfirmed, setThemeConfirmed] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testLoading, setTestLoading] = useState(false);

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
        maxDiscountPct,
        vipCartThreshold,
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

  const themeEditorUrl = `https://admin.shopify.com/store/${shop.replace(".myshopify.com", "")}/themes/current/editor?context=apps`;

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
          ></s-switch>
          {personalizationEnabled ? (
            <>
              <s-number-field
                label="Max discount %"
                value={maxDiscountPct}
                min={0}
                max={20}
                onInput={(e: Event) => setMaxDiscountPct((e.target as HTMLInputElement).value)}
              ></s-number-field>
              <s-money-field
                label="VIP free-shipping cart threshold"
                value={vipCartThreshold}
                min={0}
                onInput={(e: Event) => setVipCartThreshold((e.target as HTMLInputElement).value)}
              ></s-money-field>
            </>
          ) : null}
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
            Open Theme Editor - App Embeds
          </s-link>
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
