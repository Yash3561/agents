/**
 * GET /api/whatsapp/connect
 *
 * OAuth callback from Meta. Called inside a popup opened by the settings page.
 * Returns a self-closing HTML page so the popup closes and the parent reloads.
 *
 * Shop is passed via the `state` param (set in app.settings.tsx at popup open time).
 * No Shopify session needed — this is a plain OAuth callback, not an embedded route.
 */

import type { LoaderFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { encryptToken, sendTextMessage } from "~/lib/whatsapp.server";

const close = (msg: string) =>
  new Response(
    `<!DOCTYPE html><html><body><script>window.close();</script><p>${msg}</p></body></html>`,
    { headers: { "Content-Type": "text/html" } },
  );

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const shop = url.searchParams.get("state"); // shopDomain passed as state at popup open

  if (!code || !shop) return close("Missing params. You can close this window.");

  const redirectUri = `${process.env.SHOPIFY_APP_URL}/api/whatsapp/connect`;

  // Exchange code for access token
  const tokenRes = await fetch(
    `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${process.env.WHATSAPP_APP_ID}&client_secret=${process.env.WHATSAPP_APP_SECRET}&code=${code}&redirect_uri=${encodeURIComponent(redirectUri)}`,
  );
  const tokenData = (await tokenRes.json()) as { access_token?: string; error?: unknown };
  if (!tokenData.access_token) {
    console.error("[wa-connect] token exchange failed:", tokenData.error);
    return close("Connection failed. Please try again.");
  }

  let wabaId: string | null = null;
  let phoneNumberId: string | null = null;

  // Discover WABA
  const wabaRes = await fetch(
    `https://graph.facebook.com/v19.0/me/whatsapp_business_accounts?access_token=${tokenData.access_token}`,
  );
  const wabaData = (await wabaRes.json()) as { data?: Array<{ id: string }> };
  wabaId = wabaData.data?.[0]?.id ?? null;

  // Discover first phone number
  if (wabaId) {
    const phoneListRes = await fetch(
      `https://graph.facebook.com/v19.0/${wabaId}/phone_numbers?access_token=${tokenData.access_token}`,
    );
    const phoneListData = (await phoneListRes.json()) as { data?: Array<{ id: string }> };
    phoneNumberId = phoneListData.data?.[0]?.id ?? null;
  }

  // Get phone display string
  const phoneData = phoneNumberId
    ? ((await (
        await fetch(
          `https://graph.facebook.com/v19.0/${phoneNumberId}?fields=display_phone_number&access_token=${tokenData.access_token}`,
        )
      ).json()) as { display_phone_number?: string })
    : {};

  // Save — best-effort on wabaId/phoneNumberId, access_token is critical
  await prisma.merchant.update({
    where: { shopDomain: shop },
    data: {
      wabaId: wabaId ?? null,
      waPhoneNumberId: phoneNumberId ?? null,
      waAccessToken: encryptToken(tokenData.access_token),
      waPhone: (phoneData as { display_phone_number?: string }).display_phone_number ?? null,
      waConnectedAt: new Date(),
    },
  });

  // Send a test message so merchant knows the connection works
  const displayPhone = (phoneData as { display_phone_number?: string }).display_phone_number;
  if (phoneNumberId && displayPhone) {
    try {
      const testNumber = displayPhone.replace(/\D/g, "");
      await sendTextMessage(
        phoneNumberId,
        tokenData.access_token,
        testNumber,
        "✅ NeonPing connected! Your AI assistant is now live on WhatsApp. Customers who message this number will get instant AI-powered replies.\n\nReply to this message to test it.",
      );
    } catch { /* non-fatal, don't block the connect flow */ }
  }

  const phone = displayPhone ?? "";
  return new Response(
    `<!DOCTYPE html><html><body><script>if(window.opener){window.opener.postMessage({type:'WA_CONNECTED',phone:'${phone}'},'*');}window.close();</script><p>Connected! Closing...</p></body></html>`,
    { headers: { "Content-Type": "text/html" } },
  );
}
