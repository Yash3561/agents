import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { WidgetPreview } from "~/components/WidgetPreview";

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
  // Default checkout to excluded for new merchants (showing widget during checkout hurts conversion)
  const excludedPages: string[] = merchant.excludedPages?.length
    ? (merchant.excludedPages as string[])
    : ["checkout"];
  return { merchant: { ...merchant, excludedPages }, waAppId: process.env.WHATSAPP_APP_ID ?? "" };
};

const VALID_POSITIONS = new Set(["bottom-right", "bottom-left"]);
const VALID_VOICES = new Set(["friendly and helpful", "professional and concise", "playful and fun", "premium and polished"]);
const HARDCODED_PAGES = ["checkout", "cart", "account", "blog"];
// Validates a custom URL path: must start with / and only contain safe chars
const CUSTOM_PATH_RE = /^\/[a-zA-Z0-9\-_/.*]*$/;
const HEX_RE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const personalizationEnabled = formData.get("personalizationEnabled") === "true";
  const escalationEmailEnabled = formData.get("escalationEmailEnabled") === "true";
  const proactiveEngagementEnabled = formData.get("proactiveEngagementEnabled") === "true";
  const hardcodedExcluded = (formData.getAll("excludedPages") as string[]).filter((p) => HARDCODED_PAGES.includes(p));
  const customPaths = (formData.getAll("customExcludedPaths") as string[]).filter(
    (p) => CUSTOM_PATH_RE.test(p) && p.length <= 200,
  );
  const excludedPages = [...hardcodedExcluded, ...customPaths];
  const botName = String(formData.get("botName") ?? "").trim().slice(0, 30) || "NeonPing";

  const rawColor = String(formData.get("widgetColor") ?? "").trim();
  const widgetColor = HEX_RE.test(rawColor) ? rawColor : "#1a1a1a";

  const rawPosition = String(formData.get("widgetPosition") ?? "");
  const widgetPosition = VALID_POSITIONS.has(rawPosition) ? rawPosition : "bottom-right";

  const rawVoice = String(formData.get("brandVoice") ?? "");
  const brandVoice = VALID_VOICES.has(rawVoice) ? rawVoice : "friendly and helpful";

  let merchant;
  try {
    merchant = await prisma.merchant.update({
      where: { shopDomain: session.shop },
      data: {
        widgetGreeting: String(formData.get("widgetGreeting") ?? "").slice(0, 500),
        botName,
        widgetColor,
        widgetPosition,
        brandVoice,
        supportEmail: String(formData.get("supportEmail") ?? "").trim() || null,
        whatsappNumber: String(formData.get("whatsappNumber") ?? "").trim() || null,
        personalizationEnabled,
        escalationEmailEnabled,
        proactiveEngagementEnabled,
        excludedPages,
      },
    });
  } catch {
    return { error: "Failed to save settings. Please try again." };
  }

  return { merchant, saved: true };
};

export default function Settings() {
  const { merchant, waAppId } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const formRef = useRef<HTMLFormElement>(null);
  const [searchParams] = useSearchParams();

  const [widgetGreeting, setWidgetGreeting] = useState(merchant.widgetGreeting);
  const [botName, setBotName] = useState(merchant.botName || "NeonPing");
  const [widgetColor, setWidgetColor] = useState(merchant.widgetColor);
  const [widgetPosition, setWidgetPosition] = useState(merchant.widgetPosition);
  const [brandVoice, setBrandVoice] = useState(merchant.brandVoice);
  const [supportEmail, setSupportEmail] = useState(merchant.supportEmail ?? "");
  const [whatsappNumber, setWhatsappNumber] = useState(merchant.whatsappNumber ?? "");
  const [personalizationEnabled, setPersonalizationEnabled] = useState(merchant.personalizationEnabled);
  const [escalationEmailEnabled, setEscalationEmailEnabled] = useState(merchant.escalationEmailEnabled);
  const [proactiveEngagementEnabled, setProactiveEngagementEnabled] = useState(merchant.proactiveEngagementEnabled);
  const [excludedPages, setExcludedPages] = useState(merchant.excludedPages);
  const [customPathInput, setCustomPathInput] = useState("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const customPathFieldRef = useRef<any>(null);

  const addCustomPath = () => {
    const path = customPathInput.trim();
    if (path && CUSTOM_PATH_RE.test(path) && !excludedPages.includes(path)) {
      setExcludedPages((prev) => [...prev, path]);
    }
    setCustomPathInput("");
  };

  useEffect(() => {
    const el = customPathFieldRef.current;
    if (!el) return;
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addCustomPath();
      }
    };
    el.addEventListener("keydown", handleKeyDown);
    return () => el.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customPathInput, excludedPages]);

  useEffect(() => {
    if (fetcher.data?.saved) {
      shopify.toast.show("Settings saved");
    }
    if ((fetcher.data as { error?: string } | undefined)?.error) {
      shopify.toast.show((fetcher.data as { error: string }).error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  // Load FB SDK for Meta Embedded Signup
  useEffect(() => {
    type WinWithFB = { FB?: { init: (opts: object) => void } };
    const win = window as unknown as WinWithFB;
    if (!waAppId || win.FB) return;
    const script = document.createElement("script");
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.defer = true;
    document.body.appendChild(script);
    script.onload = () => {
      (window as unknown as WinWithFB).FB?.init({ appId: waAppId, version: "v19.0" });
    };
  }, [waAppId]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData();
    formData.append("botName", botName);
    formData.append("widgetGreeting", widgetGreeting);
    formData.append("widgetColor", widgetColor);
    formData.append("widgetPosition", widgetPosition);
    formData.append("brandVoice", brandVoice);
    formData.append("supportEmail", supportEmail);
    formData.append("whatsappNumber", whatsappNumber);
    formData.append("personalizationEnabled", String(personalizationEnabled));
    formData.append("escalationEmailEnabled", String(escalationEmailEnabled));
    formData.append("proactiveEngagementEnabled", String(proactiveEngagementEnabled));
    excludedPages.filter((p) => HARDCODED_PAGES.includes(p)).forEach((page) => formData.append("excludedPages", page));
    excludedPages.filter((p) => !HARDCODED_PAGES.includes(p)).forEach((path) => formData.append("customExcludedPaths", path));
    fetcher.submit(formData, { method: "POST" });
  };

  return (
    <s-page heading="Settings">
      <form ref={formRef} data-save-bar onSubmit={handleSubmit}>
        {/* ---- Appearance ---- */}
        <s-section heading="Appearance">
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Bot name"
              name="botName"
              value={botName}
              maxLength={30}
              onInput={(e: Event) => setBotName((e.target as HTMLInputElement).value)}
              help-text="Appears in the widget header (max 30 characters). Give your bot a friendly name customers will recognize."
            ></s-text-field>
            <s-text-field
              label="Opening greeting"
              name="widgetGreeting"
              value={widgetGreeting}
              onInput={(e: Event) => setWidgetGreeting((e.target as HTMLInputElement).value)}
              help-text="The first message customers see. Keep it friendly and inviting."
            ></s-text-field>
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
                  border: "2px solid var(--color-border)",
                  marginTop: "24px",
                  flexShrink: 0,
                }}
              />
            </div>
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
          </s-stack>

          <div style={{ marginTop: "24px" }}>
            <s-box background="subdued" padding="base" borderRadius="base">
              <s-text tone="neutral">Live preview — this is how your widget looks on the storefront:</s-text>
            </s-box>
          </div>
          <div style={{ marginTop: "12px" }}>
            <WidgetPreview color={widgetColor} position={widgetPosition} greeting={widgetGreeting} botName={botName} />
          </div>
        </s-section>

        {/* ---- Widget Visibility (moved up; proactive engagement at bottom) ---- */}
        <s-section heading="Widget Visibility">
          <div style={{ marginBottom: "16px" }}>
            <s-box padding="base" background="subdued" borderRadius="base">
              <s-text tone="neutral">Hide the chat widget on these pages to avoid distracting customers during critical flows:</s-text>
            </s-box>
          </div>
          {["checkout", "cart", "account", "blog"].map((page) => (
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
          <div style={{ marginTop: "20px", borderTop: "1px solid #e1e1e1", paddingTop: "16px" }}>
            <p style={{ margin: "0 0 8px", fontSize: "13px", fontWeight: 600, color: "#333" }}>
              Custom URL exclusions
            </p>
            <p style={{ margin: "0 0 12px", fontSize: "12px", color: "#666" }}>
              Enter URL paths to hide the widget on specific pages. Use <code>*</code> as a wildcard (e.g. <code>/blogs/*</code> hides all blog posts, <code>/pages/sale</code> hides one page).
            </p>
            <div style={{ display: "flex", gap: "8px", alignItems: "flex-end", marginBottom: "12px" }}>
              <div style={{ flex: 1 }}>
                <s-text-field
                  ref={customPathFieldRef}
                  label="Add URL path"
                  value={customPathInput}
                  placeholder="/pages/wholesale"
                  help-text='Must start with /. Use * for wildcards (e.g. /collections/*).'
                  onInput={(e: Event) => setCustomPathInput((e.target as HTMLInputElement).value)}
                ></s-text-field>
              </div>
              <div style={{ paddingBottom: "22px" }}>
                <s-button
                  variant="secondary"
                  onClick={(e: Event) => {
                    e.preventDefault();
                    addCustomPath();
                  }}
                >
                  Add
                </s-button>
              </div>
            </div>
            {excludedPages.filter((p) => !HARDCODED_PAGES.includes(p)).length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {excludedPages.filter((p) => !HARDCODED_PAGES.includes(p)).map((path) => (
                  <div
                    key={path}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      background: "var(--color-surface)",
                      border: "1px solid var(--color-border)",
                      borderRadius: "16px",
                      padding: "4px 10px",
                      fontSize: "12px",
                      fontFamily: "monospace",
                      color: "var(--color-text)",
                    }}
                  >
                    <span>{path}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${path}`}
                      onClick={() => setExcludedPages(excludedPages.filter((p) => p !== path))}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: 0,
                        lineHeight: 1,
                        color: "var(--color-neutral)",
                        fontSize: "14px",
                        fontWeight: 700,
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{ marginTop: "20px", borderTop: "1px solid #e1e1e1", paddingTop: "16px" }}>
            <s-checkbox
              name="proactiveEngagementEnabled"
              label="Proactive engagement"
              help-text="When enabled, the widget automatically opens after 30 seconds or when the customer moves to leave the page. Disable for a more passive experience."
              checked={proactiveEngagementEnabled}
              onChange={(e: Event) => setProactiveEngagementEnabled((e.target as HTMLInputElement).checked)}
            ></s-checkbox>
          </div>
        </s-section>

        {/* ---- AI Behavior (brand voice + personalization only) ---- */}
        <s-section heading="AI Behavior">
          <s-stack direction="block" gap="base">
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
            <s-switch
              label="Enable personalized discounts"
              name="personalizationEnabled"
              help-text="When enabled, the AI can share discount codes from your Shopify Discounts tab when customers ask, or to recover abandoned carts."
              checked={personalizationEnabled}
              onChange={(e: Event) => setPersonalizationEnabled((e.target as HTMLInputElement).checked)}
            ></s-switch>
          </s-stack>
        </s-section>

        {/* ---- Support & Escalation ---- */}
        <s-section heading="Support & Escalation">
          <s-stack direction="block" gap="base">
            <div>
              <s-switch
                label="Email me when AI escalates to human support"
                name="escalationEmailEnabled"
                help-text="Sends an email to your support address when the bot can't resolve a customer issue."
                checked={escalationEmailEnabled}
                onChange={(e: Event) => setEscalationEmailEnabled((e.target as HTMLInputElement).checked)}
              ></s-switch>
              <s-banner tone="warning">Email notifications are coming soon — no emails are currently sent. We&apos;ll notify you when this is live.</s-banner>
            </div>
            <s-email-field
              label="Support email"
              name="supportEmail"
              value={supportEmail}
              onInput={(e: Event) => setSupportEmail((e.target as HTMLInputElement).value)}
              help-text="Where escalated conversations and support alerts are sent."
            ></s-email-field>
            <s-text-field
              label="WhatsApp number"
              name="whatsappNumber"
              value={whatsappNumber}
              onInput={(e: Event) => setWhatsappNumber((e.target as HTMLInputElement).value)}
              help-text="Customers can tap to reach you on WhatsApp when they need human help. Include country code, e.g. +1234567890"
            ></s-text-field>
          </s-stack>
        </s-section>

        <div style={{ padding: "16px 0" }}>
          <s-button type="submit" variant="primary" disabled={fetcher.state === "submitting"}>
            {fetcher.state === "submitting" ? "Saving..." : "Save settings"}
          </s-button>
        </div>
      </form>

      {/* ---- Integrations — outside form; connect/disconnect calls fetch() directly ---- */}
      <s-section heading="Integrations">
        {searchParams.get("whatsapp") === "connected" && (
          <div style={{ marginBottom: "16px" }}>
            <s-banner tone="success">WhatsApp Business connected successfully!</s-banner>
          </div>
        )}
        {searchParams.get("whatsapp") === "error" && (
          <div style={{ marginBottom: "16px" }}>
            <s-banner tone="critical">WhatsApp connection failed. Please try again.</s-banner>
          </div>
        )}
        {merchant.waConnectedAt ? (
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            <s-badge tone="success">Connected</s-badge>
            <s-text>{merchant.waPhone ?? merchant.waPhoneNumberId}</s-text>
            <s-button
              variant="tertiary"
              tone="critical"
              onClick={async () => {
                await fetch("/api/whatsapp/disconnect", { method: "POST" });
                window.location.reload();
              }}
            >
              Disconnect
            </s-button>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: "13px", color: "#666", marginBottom: "16px", marginTop: 0 }}>
              Connect your WhatsApp Business number so customers can chat with your AI assistant on WhatsApp.
            </p>
            <s-button
              type="button"
              variant="primary"
              onClick={() => {
                type WinWithFBLogin = { FB?: { login: (cb: (r: { authResponse?: { code?: string } }) => void, opts: object) => void } };
                const fb = (window as unknown as WinWithFBLogin).FB;
                if (!fb || !waAppId) return;
                fb.login(
                  (response) => {
                    if (response.authResponse?.code) {
                      window.location.href = `/api/whatsapp/connect?code=${response.authResponse.code}`;
                    }
                  },
                  {
                    config_id: waAppId,
                    response_type: "code",
                    override_default_response_type: true,
                    extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
                  },
                );
              }}
            >
              Connect WhatsApp Business
            </s-button>
          </div>
        )}
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
