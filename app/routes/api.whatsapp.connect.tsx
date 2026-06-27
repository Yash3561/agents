/**
 * GET /api/whatsapp/connect
 *
 * OAuth callback from Meta Embedded Signup. Meta redirects here with
 * ?code=...&waba_id=...&phone_number_id=... after the merchant completes the
 * WhatsApp Business signup flow.
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
  const wabaId = url.searchParams.get("waba_id");
  const phoneNumberId = url.searchParams.get("phone_number_id");

  if (!code || !wabaId || !phoneNumberId) {
    return redirect("/app/settings?whatsapp=error");
  }

  // Exchange code for access token
  const tokenRes = await fetch(
    `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${process.env.WHATSAPP_APP_ID}&client_secret=${process.env.WHATSAPP_APP_SECRET}&code=${code}`,
  );
  const tokenData = (await tokenRes.json()) as { access_token?: string; error?: unknown };
  if (!tokenData.access_token) {
    console.error("[wa-connect] token exchange failed:", tokenData.error);
    return redirect("/app/settings?whatsapp=error");
  }

  // Get phone number display string
  const phoneRes = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}?fields=display_phone_number&access_token=${tokenData.access_token}`,
  );
  const phoneData = (await phoneRes.json()) as { display_phone_number?: string };

  // Encrypt and store
  await prisma.merchant.update({
    where: { shopDomain: session.shop },
    data: {
      wabaId,
      waPhoneNumberId: phoneNumberId,
      waAccessToken: encryptToken(tokenData.access_token),
      waPhone: phoneData.display_phone_number ?? null,
      waConnectedAt: new Date(),
    },
  });

  return redirect("/app/settings?whatsapp=connected");
}
