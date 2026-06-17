import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

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
  const excludedPages = formData.getAll("excludedPages") as string[];

  const merchant = await prisma.merchant.update({
    where: { shopDomain: session.shop },
    data: {
      widgetGreeting: String(formData.get("widgetGreeting") ?? ""),
      widgetColor: String(formData.get("widgetColor") ?? "#1a1a1a"),
      widgetPosition: String(formData.get("widgetPosition") ?? "bottom-right"),
      brandVoice: String(formData.get("brandVoice") ?? "friendly and helpful"),
      maxDiscountPct,
      vipCartThreshold: Math.round(vipCartThresholdDollars * 100),
      supportEmail: String(formData.get("supportEmail") ?? "") || null,
      personalizationEnabled,
      escalationEmailEnabled,
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
}: {
  color: string;
  position: string;
  greeting: string;
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
          Chat with us
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
  const [widgetColor, setWidgetColor] = useState(merchant.widgetColor);
  const [widgetPosition, setWidgetPosition] = useState(merchant.widgetPosition);

  useEffect(() => {
    if (fetcher.data?.saved) {
      shopify.toast.show("Settings saved");
    }
  }, [fetcher.data, shopify]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    fetcher.submit(new FormData(event.currentTarget), { method: "POST" });
  };

  return (
    <s-page heading="Widget Settings">
      <form ref={formRef} data-save-bar onSubmit={handleSubmit}>
        <s-section heading="Chat appearance">
          <s-text-field
            label="Opening greeting"
            name="widgetGreeting"
            value={widgetGreeting}
            onInput={(e: Event) => setWidgetGreeting((e.target as HTMLInputElement).value)}
          ></s-text-field>
          <s-color-field
            label="Widget color"
            name="widgetColor"
            value={widgetColor}
            onInput={(e: Event) => setWidgetColor((e.target as HTMLInputElement).value)}
          ></s-color-field>
          <s-select
            label="Position"
            name="widgetPosition"
            value={widgetPosition}
            onChange={(e: Event) => setWidgetPosition((e.target as HTMLSelectElement).value)}
          >
            <s-option value="bottom-right">Bottom right</s-option>
            <s-option value="bottom-left">Bottom left</s-option>
          </s-select>

          <s-text tone="neutral">Live preview</s-text>
          <WidgetPreview color={widgetColor} position={widgetPosition} greeting={widgetGreeting} />
        </s-section>
        <s-section heading="AI behavior">
          <s-text-field
            label="Brand voice"
            name="brandVoice"
            value={merchant.brandVoice}
            placeholder="e.g. friendly and helpful"
          ></s-text-field>
          <s-number-field
            label="Max discount %"
            name="maxDiscountPct"
            value={String(merchant.maxDiscountPct)}
            min={0}
            max={20}
          ></s-number-field>
          <s-money-field
            label="VIP free-shipping cart threshold"
            name="vipCartThreshold"
            value={String(merchant.vipCartThreshold / 100)}
            min={0}
          ></s-money-field>
          <s-switch
            label="Enable personalized discounts"
            name="personalizationEnabled"
            help-text="When enabled, the AI can offer discounts to VIP customers and loyal shoppers."
            checked={merchant.personalizationEnabled}
          ></s-switch>
          <s-switch
            label="Email me when AI escalates to human support"
            name="escalationEmailEnabled"
            help-text="Sends an email to your support address when the bot can't resolve a customer issue."
            checked={merchant.escalationEmailEnabled}
          ></s-switch>
          {!merchant.supportEmail && (
            <p style={{color:'#666',fontSize:'13px'}}>Set your support email below to receive escalation alerts.</p>
          )}
        </s-section>
        <s-section heading="Support">
          <s-email-field
            label="Support email"
            name="supportEmail"
            value={merchant.supportEmail ?? ""}
          ></s-email-field>
        </s-section>
        <s-section heading="Widget Visibility">
          <s-box padding="base" background="subdued" borderRadius="base">
            <p>Hide the chat widget on these pages:</p>
            {['checkout', 'cart', 'account', 'blog'].map(page => (
              <s-checkbox
                key={page}
                name="excludedPages"
                value={page}
                label={page.charAt(0).toUpperCase() + page.slice(1) + (page === 'checkout' ? ' (recommended)' : '')}
                checked={merchant.excludedPages?.includes(page) || false}
              ></s-checkbox>
            ))}
          </s-box>
        </s-section>
        <s-button type="submit" variant="primary">
          Save
        </s-button>
      </form>
    </s-page>
  );
}
