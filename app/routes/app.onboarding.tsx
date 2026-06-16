import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const VOICE_PRESETS = [
  {
    value: "friendly and helpful",
    label: "Friendly & helpful",
    preview: "Hey there! 😊 Let me know if you need help finding anything!",
  },
  {
    value: "professional and concise",
    label: "Professional & concise",
    preview: "Hello. How can I assist you with your order today?",
  },
  {
    value: "playful and fun",
    label: "Playful & fun",
    preview: "Heyyy! 🎉 What are we shopping for today?",
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

  const apiUrl = `${process.env.SHOPIFY_APP_URL ?? ""}/api/chat`;

  return { shop, merchant, apiUrl };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") === "skip") {
    await prisma.merchant.update({
      where: { shopDomain: session.shop },
      data: { onboardedAt: new Date() },
    });
    return redirect("/app");
  }

  const maxDiscountPct = Math.min(20, Math.max(0, Number(formData.get("maxDiscountPct")) || 0));
  const vipCartThresholdDollars = Number(formData.get("vipCartThreshold")) || 0;

  await prisma.merchant.update({
    where: { shopDomain: session.shop },
    data: {
      widgetColor: String(formData.get("widgetColor") ?? "#1a1a1a"),
      widgetGreeting: String(formData.get("widgetGreeting") ?? ""),
      brandVoice: String(formData.get("brandVoice") ?? "friendly and helpful"),
      maxDiscountPct,
      vipCartThreshold: Math.round(vipCartThresholdDollars * 100),
      personalizationEnabled: formData.get("personalizationEnabled") === "true",
      onboardedAt: new Date(),
    },
  });

  return redirect("/app");
};

async function sendTestMessage(shop: string): Promise<string> {
  const res = await fetch("/api/chat", {
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

export default function Onboarding() {
  const { shop, merchant, apiUrl } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [step, setStep] = useState(1);
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

  const skip = () => fetcher.submit({ intent: "skip" }, { method: "POST" });

  const finish = () => {
    fetcher.submit(
      {
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
      const text = await sendTestMessage(shop);
      setTestResult(text);
    } catch {
      setTestResult("Something went wrong reaching the assistant. Try again.");
    } finally {
      setTestLoading(false);
    }
  };

  return (
    <s-page heading="Welcome to NeonPing">
      {step === 1 && (
        <s-section heading="Step 1 of 4 — Brand setup">
          <s-text-field
            label="Opening greeting"
            value={widgetGreeting}
            onInput={(e: Event) => setWidgetGreeting((e.target as HTMLInputElement).value)}
          ></s-text-field>
          <s-color-field
            label="Widget color"
            value={widgetColor}
            onInput={(e: Event) => setWidgetColor((e.target as HTMLInputElement).value)}
          ></s-color-field>
          <s-stack direction="inline" gap="base">
            <s-button onClick={skip} variant="tertiary">
              Skip setup
            </s-button>
            <s-button onClick={() => setStep(2)} variant="primary">
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
            <s-button onClick={() => setStep(1)} variant="tertiary">
              Back
            </s-button>
            <s-button onClick={() => setStep(3)} variant="primary">
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
            <s-button onClick={() => setStep(2)} variant="tertiary">
              Back
            </s-button>
            <s-button onClick={() => setStep(4)} variant="primary">
              Next
            </s-button>
          </s-stack>
        </s-section>
      )}

      {step === 4 && (
        <s-section heading="Step 4 of 4 — Go live">
          <s-paragraph>
            Add NeonPing to your storefront: open your theme editor's App Embeds panel
            and paste this API URL into the NeonPing Chat block's settings.
          </s-paragraph>
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-text>{apiUrl}</s-text>
          </s-box>
          <s-link
            href={`https://${shop}/admin/themes/current/editor?context=apps`}
            target="_blank"
          >
            Open theme editor
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
            <s-button onClick={() => setStep(3)} variant="tertiary">
              Back
            </s-button>
            <s-button onClick={finish} variant="primary">
              Finish
            </s-button>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}
