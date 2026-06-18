import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const VOICE_PRESETS = [
  {
    value: "friendly and helpful",
    label: "Friendly & helpful",
  },
  {
    value: "professional and concise",
    label: "Professional & concise",
  },
  {
    value: "playful and fun",
    label: "Playful & fun",
  },
  {
    value: "premium and polished",
    label: "Premium & polished",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const merchant = await prisma.merchant.upsert({
    where: { shopDomain: session.shop },
    update: {},
    create: { shopDomain: session.shop },
  });
  return { merchant };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const maxDiscountPct = Math.min(20, Math.max(0, Number(formData.get("maxDiscountPct")) || 0));
  const vipCartThresholdDollars = Number(formData.get("vipCartThreshold")) || 0;
  const personalizationEnabled = formData.get("personalizationEnabled") === "true";
  const escalationEmailEnabled = formData.get("escalationEmailEnabled") === "true";
  const proactiveEngagementEnabled = formData.get("proactiveEngagementEnabled") === "true";
  const excludedPages = formData.getAll("excludedPages") as string[];
  const botName = String(formData.get("botName") ?? "").trim() || "NeonPing";

  const merchant = await prisma.merchant.update({
    where: { shopDomain: session.shop },
    data: {
      widgetGreeting: String(formData.get("widgetGreeting") ?? ""),
      botName,
      widgetColor: String(formData.get("widgetColor") ?? "#1a1a1a"),
      widgetPosition: String(formData.get("widgetPosition") ?? "bottom-right"),
      brandVoice: String(formData.get("brandVoice") ?? "friendly and helpful"),
      maxDiscountPct,
      vipCartThreshold: Math.round(vipCartThresholdDollars * 100),
      supportEmail: String(formData.get("supportEmail") ?? "") || null,
      personalizationEnabled,
      escalationEmailEnabled,
      proactiveEngagementEnabled,
      excludedPages,
    },
  });

  return { merchant, saved: true };
};

/**
 * Lightweight visual mock of the real widget (launcher + open panel header +
 * first bot bubble), styled to match extensions/chat-widget/assets/
 * neonping-widget.css so merchants see an accurate live preview while
 * editing — not just a rough approximation.
 */
function WidgetPreview({
  color,
  position,
  greeting,
  botName,
}: {
  color: string;
  position: string;
  greeting: string;
  botName: string;
}) {
  const isLeft = position === "bottom-left";
  const side: "left" | "right" = isLeft ? "left" : "right";

  return (
    <div
      style={{
        position: "relative",
        height: 240,
        background: "#f0f0f3",
        borderRadius: 12,
        border: "1px solid #e1e1e1",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 10,
          left: 12,
          fontSize: 11,
          color: "#9a9a9a",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        Your storefront
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 64,
          [side]: 16,
          width: 200,
          borderRadius: 14,
          background: "#fff",
          boxShadow: "0 8px 24px rgba(0,0,0,.18)",
          overflow: "hidden",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div
          style={{
            background: color || "#1a1a1a",
            color: "#fff",
            padding: "10px 12px",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {botName || "NeonPing"}
        </div>
        <div style={{ padding: 10, background: "#fff" }}>
          <div
            style={{
              display: "inline-block",
              background: "#f1f1f1",
              color: "#111",
              borderRadius: 10,
              borderBottomLeftRadius: 3,
              padding: "7px 10px",
              fontSize: 11,
              maxWidth: "90%",
              wordBreak: "break-word",
            }}
          >
            {greeting || "Hi! How can I help you today?"}
          </div>
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 16,
          [side]: 16,
          width: 40,
          height: 40,
          borderRadius: "50%",
          background: color || "#1a1a1a",
          boxShadow: "0 4px 12px rgba(0,0,0,.25)",
        }}
      />
    </div>
  );
}

export default function Settings() {
  const { merchant } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const formRef = useRef<HTMLFormElement>(null);

  const [widgetGreeting, setWidgetGreeting] = useState(merchant.widgetGreeting);
  const [botName, setBotName] = useState(merchant.botName || "NeonPing");
  const [widgetColor, setWidgetColor] = useState(merchant.widgetColor);
  const [widgetPosition, setWidgetPosition] = useState(merchant.widgetPosition);
  const [brandVoice, setBrandVoice] = useState(merchant.brandVoice);
  const [maxDiscountPct, setMaxDiscountPct] = useState(String(merchant.maxDiscountPct));
  const [vipCartThreshold, setVipCartThreshold] = useState(String(merchant.vipCartThreshold / 100));
  const [supportEmail, setSupportEmail] = useState(merchant.supportEmail ?? "");
  const [personalizationEnabled, setPersonalizationEnabled] = useState(merchant.personalizationEnabled);
  const [escalationEmailEnabled, setEscalationEmailEnabled] = useState(merchant.escalationEmailEnabled);
  const [proactiveEngagementEnabled, setProactiveEngagementEnabled] = useState(merchant.proactiveEngagementEnabled);
  const [excludedPages, setExcludedPages] = useState(merchant.excludedPages ?? []);

  useEffect(() => {
    if (fetcher.data?.saved) {
      shopify.toast.show("Settings saved");
    }
  }, [fetcher.data, shopify]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData();
    formData.append("botName", botName);
    formData.append("widgetGreeting", widgetGreeting);
    formData.append("widgetColor", widgetColor);
    formData.append("widgetPosition", widgetPosition);
    formData.append("brandVoice", brandVoice);
    formData.append("maxDiscountPct", maxDiscountPct);
    formData.append("vipCartThreshold", vipCartThreshold);
    formData.append("supportEmail", supportEmail);
    formData.append("personalizationEnabled", String(personalizationEnabled));
    formData.append("escalationEmailEnabled", String(escalationEmailEnabled));
    formData.append("proactiveEngagementEnabled", String(proactiveEngagementEnabled));
    excludedPages.forEach((page) => formData.append("excludedPages", page));
    fetcher.submit(formData, { method: "POST" });
  };

  return (
    <s-page heading="Widget Settings">
      <form ref={formRef} data-save-bar onSubmit={handleSubmit}>
        <s-section heading="🎨 Appearance">
          <div style={{ marginBottom: "16px" }}>
            <s-text-field
              label="Bot name"
              name="botName"
              value={botName}
              maxLength={30}
              onInput={(e: Event) => setBotName((e.target as HTMLInputElement).value)}
              help-text="Appears in the widget header (max 30 characters). Give your bot a friendly name customers will recognize."
            ></s-text-field>
          </div>
          <div style={{ marginBottom: "16px" }}>
            <s-text-field
              label="Opening greeting"
              name="widgetGreeting"
              value={widgetGreeting}
              onInput={(e: Event) => setWidgetGreeting((e.target as HTMLInputElement).value)}
              help-text="The first message customers see. Keep it friendly and inviting."
            ></s-text-field>
          </div>
          <div style={{ marginBottom: "16px" }}>
            <div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <s-color-field
                  label="Widget color"
                  name="widgetColor"
                  value={widgetColor}
                  onInput={(e: Event) => setWidgetColor((e.target as HTMLInputElement).value)}
                  help-text="The button and accent color of your chat widget. Choose a brand color."
                ></s-color-field>
              </div>
              <div
                style={{
                  width: "60px",
                  height: "60px",
                  borderRadius: "8px",
                  background: widgetColor,
                  border: "2px solid #e0e0e0",
                  marginTop: "24px",
                  flexShrink: 0,
                }}
              />
            </div>
          </div>
          <div style={{ marginBottom: "16px" }}>
            <s-select
              label="Position"
              name="widgetPosition"
              value={widgetPosition}
              onChange={(e: Event) => setWidgetPosition((e.target as HTMLSelectElement).value)}
              help-text="Where the chat button appears on your storefront."
            >
              <s-option value="bottom-right">Bottom right</s-option>
              <s-option value="bottom-left">Bottom left</s-option>
            </s-select>
          </div>

          <div
            style={{
              marginTop: "24px",
              padding: "12px",
              background: "#f5f5f5",
              borderRadius: "8px",
              borderLeft: "4px solid #1a1a1a",
            }}
          >
            <s-text tone="neutral">
              <strong>Live Preview</strong>
            </s-text>
            <p style={{ fontSize: "12px", color: "#666", margin: "8px 0 0" }}>
              This is how your widget looks on the storefront:
            </p>
          </div>
          <div style={{ marginTop: "12px" }}>
            <WidgetPreview color={widgetColor} position={widgetPosition} greeting={widgetGreeting} botName={botName} />
          </div>
        </s-section>
        <s-section heading="🤖 AI Behavior">
          <div style={{ marginBottom: "16px" }}>
            <s-select
              label="Brand voice"
              name="brandVoice"
              value={brandVoice}
              onChange={(e: Event) => setBrandVoice((e.target as HTMLSelectElement).value)}
              help-text="Choose the tone and personality your AI assistant should use when talking to customers."
            >
              {VOICE_PRESETS.map((p) => (
                <s-option key={p.value} value={p.value}>{p.label}</s-option>
              ))}
            </s-select>
          </div>
          <div style={{ marginBottom: "16px" }}>
            <s-number-field
              label="Max discount %"
              name="maxDiscountPct"
              value={maxDiscountPct}
              onInput={(e: Event) => setMaxDiscountPct((e.target as HTMLInputElement).value)}
              min={0}
              max={20}
              help-text="The highest discount percentage the AI can offer (0-20%). Protects your margins."
            ></s-number-field>
          </div>
          <div style={{ marginBottom: "16px" }}>
            <s-money-field
              label="VIP free-shipping cart threshold"
              name="vipCartThreshold"
              value={vipCartThreshold}
              onInput={(e: Event) => setVipCartThreshold((e.target as HTMLInputElement).value)}
              min={0}
              help-text="Carts above this value unlock VIP offers. Example: $50 cart gets free shipping."
            ></s-money-field>
          </div>
          <div style={{ marginBottom: "16px" }}>
            <s-switch
              label="Enable personalized discounts"
              name="personalizationEnabled"
              help-text="When enabled, the AI can offer discounts to VIP customers and loyal shoppers."
              checked={personalizationEnabled}
              onChange={(e: Event) => setPersonalizationEnabled((e.target as HTMLInputElement).checked)}
            ></s-switch>
          </div>
          <div style={{ marginBottom: "16px" }}>
            <s-switch
              label="Email me when AI escalates to human support"
              name="escalationEmailEnabled"
              help-text="Sends an email to your support address when the bot can't resolve a customer issue."
              checked={escalationEmailEnabled}
              onChange={(e: Event) => setEscalationEmailEnabled((e.target as HTMLInputElement).checked)}
            ></s-switch>
            <p style={{ color: "#b45309", fontSize: "12px", marginTop: "8px" }}>
              ⚠️ Email notifications are coming soon — no emails are currently sent. We'll notify you when this is live.
            </p>
          </div>
          <div style={{ marginBottom: "16px" }}>
            <s-checkbox
              name="proactiveEngagementEnabled"
              label="Proactive engagement"
              help-text="When enabled, the widget automatically opens after 30 seconds or when the customer moves to leave the page. Disable for a more passive experience."
              checked={proactiveEngagementEnabled}
              onChange={(e: Event) => setProactiveEngagementEnabled((e.target as HTMLInputElement).checked)}
            ></s-checkbox>
          </div>
        </s-section>
        <s-section heading="📧 Support">
          <div style={{ marginBottom: "16px" }}>
            <s-email-field
              label="Support email"
              name="supportEmail"
              value={supportEmail}
              onInput={(e: Event) => setSupportEmail((e.target as HTMLInputElement).value)}
              help-text="Where escalated conversations and support alerts are sent."
            ></s-email-field>
          </div>
        </s-section>
        <s-section heading="👁️ Widget Visibility">
          <div
            style={{
              padding: "12px",
              background: "#f5f5f5",
              borderRadius: "8px",
              marginBottom: "16px",
            }}
          >
            <p style={{ margin: 0, fontSize: "13px", color: "#666" }}>
              Hide the chat widget on these pages to avoid distracting customers during critical flows:
            </p>
          </div>
          {['checkout', 'cart', 'account', 'blog'].map((page) => (
            <div key={page} style={{ marginBottom: "12px" }}>
              <s-checkbox
                name="excludedPages"
                value={page}
                label={page.charAt(0).toUpperCase() + page.slice(1) + (page === "checkout" ? " (recommended)" : "")}
                checked={excludedPages.includes(page)}
                onChange={(e: Event) => {
                  const isChecked = (e.target as HTMLInputElement).checked;
                  setExcludedPages(isChecked ? [...excludedPages, page] : excludedPages.filter((p) => p !== page));
                }}
              ></s-checkbox>
            </div>
          ))}
        </s-section>
        <div style={{ padding: "16px 0" }}>
          <s-button type="submit" variant="primary" disabled={fetcher.state === "submitting"}>
            {fetcher.state === "submitting" ? "Saving..." : "Save settings"}
          </s-button>
        </div>
      </form>
    </s-page>
  );
}
