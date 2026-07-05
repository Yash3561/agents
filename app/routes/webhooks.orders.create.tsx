import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { decryptToken, normalizePhone, sendTextMessage, sendReplyButtons, sendTemplate } from "~/lib/whatsapp.server";
import { getActiveDiscounts } from "~/lib/mcp/discounts.server";

const COD_GATEWAYS = ["cash_on_delivery", "cod", "pay_on_delivery", "manual"];

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  try {
    const merchant = await prisma.merchant.findFirst({ where: { shopDomain: shop } });
    if (!merchant?.waPhoneNumberId || !merchant?.waAccessToken) return new Response();

    const rawPhone =
      (payload.customer as Record<string, unknown> | undefined)?.phone as string | undefined ??
      (payload.billing_address as Record<string, unknown> | undefined)?.phone as string | undefined ??
      (payload.shipping_address as Record<string, unknown> | undefined)?.phone as string | undefined;
    const phone = normalizePhone(rawPhone ?? "");
    if (!phone) return new Response();

    const { redis } = await import("~/redis.server");
    if (await redis.exists(`wa:optout:${phone}`)) return new Response();

    const accessToken = decryptToken(merchant.waAccessToken);
    const storeName = shop.replace(".myshopify.com", "");
    const orderName = payload.name as string | undefined ?? `#${payload.order_number}`;
    const gateway = (payload.payment_gateway as string | undefined ?? "").toLowerCase();
    const isCod = COD_GATEWAYS.some((g) => gateway.includes(g));
    const orderStatusUrl = payload.order_status_url as string | undefined;

    // Order confirmation — use template for COD (works outside 24h window), text for prepaid
    if (isCod) {
      try {
        const totalStr = String(Math.round(parseFloat((payload.total_price as string | undefined) ?? "0")));
        await sendTemplate(
          merchant.waPhoneNumberId,
          accessToken,
          phone,
          "neonping_cod_confirm",
          "en",
          [{ type: "body", parameters: [{ type: "text", text: storeName }, { type: "text", text: orderName }, { type: "text", text: totalStr }] }],
        );
      } catch {
        await sendTextMessage(
          merchant.waPhoneNumberId,
          accessToken,
          phone,
          `Your order ${orderName} at ${storeName} is confirmed! We'll keep you updated.`,
        );
      }
    } else {
      await sendTextMessage(
        merchant.waPhoneNumberId,
        accessToken,
        phone,
        `Your order ${orderName} at ${storeName} is confirmed! We'll keep you updated.`,
      );
    }

    // COD prepaid nudge — delayed interactive message (fire-and-forget)
    if (isCod && orderStatusUrl) {
      // ponytail: capture narrowed strings before IIFE so tsc is happy inside the closure
      const waPhoneNumberId = merchant.waPhoneNumberId;
      const capturedUrl = orderStatusUrl;
      void (async () => {
        await new Promise((r) => setTimeout(r, 30_000));
        try {
          const session = await prisma.session.findFirst({
            where: { shop, isOnline: false },
            select: { accessToken: true },
          });
          const discounts = session?.accessToken
            ? await getActiveDiscounts(shop, session.accessToken).catch(() => [] as import("~/lib/mcp/discounts.server").ActiveDiscount[])
            : [];
          const discount = discounts[0];
          const bodyText = discount
            ? `Switch to prepaid and save! Use code ${discount.code} at checkout for ${discount.value}% off + faster delivery:`
            : "Pay online for faster delivery and no cash hassle:";
          await sendReplyButtons(
            waPhoneNumberId,
            accessToken,
            phone,
            bodyText,
            [
              { id: `prepaid|${capturedUrl}`, title: "💳 Pay Online" },
              { id: `cod_keep|${orderName}`, title: "✅ Keep COD" },
            ],
          );
        } catch {
          // best-effort — never throw
        }
      })();
    }
  } catch (err) {
    console.error(`[orders/create] Error for ${shop}:`, err);
  }

  return new Response();
};
