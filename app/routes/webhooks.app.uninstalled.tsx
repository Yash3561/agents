import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { redis } from "../redis.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session } = await authenticate.webhook(request);

  try {
    if (session) {
      await db.session.deleteMany({ where: { shop } });
    }

    await db.merchant.updateMany({
      where: { shopDomain: shop },
      data: {
        onboardedAt: null,
        onboardingStep: 0,
        plan: "free",
        conversationCount: 0,
        conversationResetAt: new Date(),
        whatsappNumber: null,
        wabaId: null,
        waPhoneNumberId: null,
        waAccessToken: null,
        waPhone: null,
        waConnectedAt: null,
      },
    });

    const keys = await redis.keys(`*${shop}*`).catch(() => []);
    if (keys.length) await redis.del(...keys).catch(() => null);

    return new Response(null, { status: 200 });
  } catch (err) {
    console.error(`[app/uninstalled] Error processing webhook for ${shop}:`, err);
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
