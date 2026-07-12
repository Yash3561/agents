import type { ActionFunctionArgs } from "react-router";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { redis } from "~/redis.server";

interface AppSubscription {
  id: string;
  name: string;
  status: "ACTIVE" | "PENDING" | "DECLINED" | "EXPIRED" | "FROZEN" | "PAUSED" | "CANCELLED";
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

  // authenticate.webhook() normalizes the topic to UPPER_SNAKE_CASE via topicForStorage()
  // e.g., "app_subscriptions/update" → "APP_SUBSCRIPTIONS_UPDATE"
  if (topic !== "APP_SUBSCRIPTIONS_UPDATE") {
    console.warn(`Unexpected webhook topic: ${topic}`);
    return new Response(JSON.stringify({ error: "unexpected_topic" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const subscription = payload as AppSubscription;

    // Determine plan from subscription name and status
    let plan = "free";

    if (subscription.status === "ACTIVE") {
      // ponytail: includes() handles both legacy "Spark" and current "NeonPing Spark" names
      const subName = subscription.name?.toLowerCase() ?? "";
      if (subName.includes("spark")) {
        plan = "spark";
      } else if (subName.includes("pulse")) {
        plan = "pulse";
      } else if (subName.includes("surge")) {
        plan = "surge";
      } else {
        // Fallback: try to extract from price
        const price = Number(subscription.lineItems?.[0]?.plan?.pricingDetails?.price?.amount);
        if (price === 29) {
          plan = "spark";
        } else if (price === 79) {
          plan = "pulse";
        } else if (price === 199) {
          plan = "surge";
        }
      }
    } else if (
      subscription.status === "CANCELLED" ||
      subscription.status === "DECLINED" ||
      subscription.status === "EXPIRED" ||
      subscription.status === "PAUSED"
    ) {
      // Merchant cancelled, declined, let subscription expire, or paused: downgrade to free.
      plan = "free";
    } else if (subscription.status === "PENDING") {
      // Trial period — treat as the plan they're trialing
      const subName = subscription.name?.toLowerCase() ?? "";
      if (subName.includes("spark")) {
        plan = "spark";
      } else if (subName.includes("pulse")) {
        plan = "pulse";
      } else if (subName.includes("surge")) {
        plan = "surge";
      }
    } else if (subscription.status === "FROZEN") {
      // Frozen (e.g., due to payment failure) — downgrade to free
      plan = "free";
    }

    // Update the merchant's plan.
    // On every ACTIVE transition (upgrade, downgrade, or renewal), reset the
    // conversation counter to 0 and stamp conversationResetAt to now. A plan
    // change = a new billing cycle, so merchants get a fresh start immediately.
    // This prevents a downgraded merchant from being over-limit on day 1, and
    // gives upgraded merchants the full quota they just paid for.
    const now = new Date();
    const updateData: Prisma.MerchantUpdateInput = { plan };
    const createData: Prisma.MerchantCreateInput = { shopDomain: shop, plan };
    if (subscription.status === "ACTIVE") {
      updateData.conversationCount = 0;
      updateData.conversationResetAt = now;
      createData.conversationCount = 0;
      createData.conversationResetAt = now;
      // Mark the trial as used the first time a subscription goes active, whether
      // or not this activation itself was trialing — prevents cancel/resubscribe
      // loops from getting a fresh trialDays every time (app.billing.tsx / app.onboarding.tsx
      // check this before setting trialDays on a new appSubscriptionCreate).
      const merchant = await db.merchant.findUnique({ where: { shopDomain: shop }, select: { trialUsedAt: true } });
      if (!merchant?.trialUsedAt) {
        updateData.trialUsedAt = now;
        createData.trialUsedAt = now;
      }
      // Also clear the Redis fast-path counter so it stays in sync with Prisma.
      await redis.set(`usage:${shop}`, "0").catch(() => null);
    }
    await db.merchant.upsert({
      where: { shopDomain: shop },
      update: updateData,
      create: createData,
    });

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
