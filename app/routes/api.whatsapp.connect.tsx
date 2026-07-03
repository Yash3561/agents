/**
 * GET /api/whatsapp/connect
 *
 * OAuth callback from Meta Embedded Signup. Meta redirects here with
 * ?code=...&waba_id=...&phone_number_id=... after the merchant completes the
 * WhatsApp Business signup flow.
 *
 * waba_id and phone_number_id come from the client-side postMessage listener
 * (sessionInfoVersion: "3") and are forwarded as query params. If they're
 * missing (race condition / browser quirk), we fall back to the Graph API.
 */

import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "~/db.server";
import { encryptToken } from "~/lib/whatsapp.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (!code) return redirect("/app/settings?whatsapp=error");

  let wabaId = url.searchParams.get("waba_id");
  let phoneNumberId = url.searchParams.get("phone_number_id");

  // Exchange code for access token
  const tokenRes = await fetch(
    `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${process.env.WHATSAPP_APP_ID}&client_secret=${process.env.WHATSAPP_APP_SECRET}&code=${code}`,
  );
  const tokenData = (await tokenRes.json()) as { access_token?: string; error?: unknown };
  if (!tokenData.access_token) {
    console.error("[wa-connect] token exchange failed:", tokenData.error);
    return redirect("/app/settings?whatsapp=error");
  }

  // Discover WABA if postMessage race caused missing params
  if (!wabaId) {
    const wabaRes = await fetch(
      `https://graph.facebook.com/v19.0/me/whatsapp_business_accounts?access_token=${tokenData.access_token}`,
    );
    const wabaData = (await wabaRes.json()) as { data?: Array<{ id: string }> };
    wabaId = wabaData.data?.[0]?.id ?? null;
  }

  // Discover first phone number if still missing
  if (!phoneNumberId && wabaId) {
    const phoneListRes = await fetch(
      `https://graph.facebook.com/v19.0/${wabaId}/phone_numbers?access_token=${tokenData.access_token}`,
    );
    const phoneListData = (await phoneListRes.json()) as { data?: Array<{ id: string }> };
    phoneNumberId = phoneListData.data?.[0]?.id ?? null;
  }

  // Get phone number display string
  const phoneData = phoneNumberId
    ? ((await (await fetch(
        `https://graph.facebook.com/v19.0/${phoneNumberId}?fields=display_phone_number&access_token=${tokenData.access_token}`,
      )).json()) as { display_phone_number?: string })
    : {};

  // Encrypt and store — access_token is the critical field; others are best-effort
  await prisma.merchant.update({
    where: { shopDomain: session.shop },
    data: {
      wabaId: wabaId ?? null,
      waPhoneNumberId: phoneNumberId ?? null,
      waAccessToken: encryptToken(tokenData.access_token),
      waPhone: (phoneData as { display_phone_number?: string }).display_phone_number ?? null,
      waConnectedAt: new Date(),
    },
  });

  return redirect("/app/settings?whatsapp=connected");
}
