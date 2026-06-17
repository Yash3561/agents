import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

interface AppSubscription {
  id: string;
  name: string;
  status: "ACTIVE" | "PENDING" | "DECLINED" | "EXPIRED" | "FROZEN" | "PAUSED";
  returnUrl: string;
  test: boolean;
  activatedOn?: string;
  cancelledOn?: string;
  trialDays?: number;
  trialEndsOn?: string;
  lineItems: Array<{
    id: string;
    plan: {
      pricingDetails: {
        interval: "EVERY_30_DAYS" | "ANNUAL";
        price: {
          amount: number;
          currencyCode: string;
        };
      };
    };
  }>;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (topic !== "app/subscriptions/update") {
    console.warn(`Unexpected webhook topic: ${topic}`);
    return new Response(JSON.stringify({ error: "unexpected_topic" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const subscription = payload as AppSubscription;

    console.log(`[billing] App subscription update: shop=${shop}, status=${subscription.status}, name=${subscription.name}`);

    // Determine plan from subscription name and status
    let plan = "free";

    if (subscription.status === "ACTIVE") {
      const subName = subscription.name.toLowerCase();
      if (subName === "starter" || subName === "growth" || subName === "pro") {
        plan = subName;
      } else {
        // Fallback: try to extract from price
        const price = subscription.lineItems?.[0]?.plan?.pricingDetails?.price?.amount;
        if (price === 29 || price === 29.0) {
          plan = "starter";
        } else if (price === 79 || price === 79.0) {
          plan = "growth";
        } else if (price === 199 || price === 199.0) {
          plan = "pro";
        }
      }
    } else if (subscription.status === "DECLINED" || subscription.status === "EXPIRED" || subscription.status === "PAUSED") {
      // Merchant declined, let subscription expire, or paused — downgrade to free
      plan = "free";
    } else if (subscription.status === "PENDING") {
      // Trial period — treat as the plan they're trialing, or as 'trial' if we can't determine
      const subName = subscription.name.toLowerCase();
      if (subName === "starter" || subName === "growth" || subName === "pro") {
        plan = subName;
      }
    } else if (subscription.status === "FROZEN") {
      // Frozen (e.g., due to payment failure) — downgrade to free
      plan = "free";
    }

    // Update the merchant's plan
    await db.merchant.update({
      where: { shopDomain: shop },
      data: { plan },
    });

    console.log(`[billing] Updated merchant ${shop} to plan: ${plan}`);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error(`[billing] Error processing app/subscriptions/update webhook:`, error);
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
