import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { decryptToken, normalizePhone, sendTextMessage, sendReplyButtons, sendTemplate } from "~/lib/whatsapp.server";
import { getActiveDiscounts } from "~/lib/mcp/discounts.server";
import { getProductRecommendation } from "~/lib/mcp/admin.server";

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

    // Post-purchase upsell — immediate, rides the free-form session window the
    // confirmation template/message just opened, so it costs zero extra Meta fees.
    // One-shot (30 min "ADD" window, enforced via redis key TTL, handled in
    // api/whatsapp/webhook's addupsell| branch).
    const lineItems = (payload.line_items as Array<{ product_id?: number }> | undefined) ?? [];
    const mainProductId = lineItems[0]?.product_id != null ? String(lineItems[0].product_id) : undefined;
    const orderId = payload.id != null ? String(payload.id) : undefined;

    if (mainProductId && orderId) {
      // ponytail: capture narrowed string before IIFE so tsc is happy inside the closure
      const waPhoneNumberId = merchant.waPhoneNumberId;
      void (async () => {
        try {
          const session = await prisma.session.findFirst({
            where: { shop, isOnline: false },
            select: { accessToken: true },
          });
          if (!session?.accessToken) return;

          const rec = await getProductRecommendation(shop, session.accessToken, mainProductId).catch(() => null);
          if (!rec) return;

          await redis.set(`wa:upsell:${orderId}`, JSON.stringify(rec), "EX", 1800);
          await sendReplyButtons(
            waPhoneNumberId,
            accessToken,
            phone,
            `People who bought this also loved ${rec.title} for $${(rec.priceCents / 100).toFixed(2)}. Add it to your order?`,
            [
              { id: `addupsell|${orderId}`, title: "➕ Yes, add it" },
              { id: "skip|", title: "No thanks" },
            ],
          );
        } catch {
          // best-effort — never throw
        }
      })();
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
