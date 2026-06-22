import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Reset merchant state so reinstalling triggers fresh onboarding and a clean usage slate.
  await db.merchant.updateMany({
    where: { shopDomain: shop },
    data: {
      onboardedAt: null,
      onboardingStep: 0,
      plan: "free",
      conversationCount: 0,
      conversationResetAt: new Date(),
    },
  });

  return new Response();
};
