import { useEffect, useRef } from "react";
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
    },
  });

  return { merchant, saved: true };
};

export default function Settings() {
  const { merchant } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const formRef = useRef<HTMLFormElement>(null);

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
            value={merchant.widgetGreeting}
          ></s-text-field>
          <s-color-field
            label="Widget color"
            name="widgetColor"
            value={merchant.widgetColor}
          ></s-color-field>
          <s-select label="Position" name="widgetPosition" value={merchant.widgetPosition}>
            <s-option value="bottom-right">Bottom right</s-option>
            <s-option value="bottom-left">Bottom left</s-option>
          </s-select>
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
        </s-section>
        <s-section heading="Support">
          <s-email-field
            label="Support email"
            name="supportEmail"
            value={merchant.supportEmail ?? ""}
          ></s-email-field>
        </s-section>
        <s-button type="submit" variant="primary">
          Save
        </s-button>
      </form>
    </s-page>
  );
}
