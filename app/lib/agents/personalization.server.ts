import { adminGraphql } from "~/lib/mcp/admin.server";
import {
  assertDiscountNotApplied,
  assertDiscountWithinLimit,
  GuardrailError,
} from "~/lib/guardrails.server";
import type { ConversationSession } from "~/lib/session.server";
import type { CustomerMemory } from "~/lib/agents/memory.server";
import type { Merchant } from "@prisma/client";

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export interface PersonalizationAgentOutput {
  text: string | null;         // null = no discount offered (caller skips this turn)
  discountCode?: string;
  discountPct?: number;
  toolsCalled: string[];
}

// ---------------------------------------------------------------------------
// Agent (deterministic logic — no LLM needed here)
// ---------------------------------------------------------------------------

export async function runPersonalizationAgent(opts: {
  shopDomain: string;
  accessToken: string;
  customerId?: string;
  session: ConversationSession;
  merchant: Merchant;
  memory: CustomerMemory;
  cartTotalCents?: number;
}): Promise<PersonalizationAgentOutput> {
  const { shopDomain, accessToken, customerId, session, merchant, memory, cartTotalCents } = opts;

  const toolsCalled: string[] = [];

  // Guard: one discount per conversation
  try {
    assertDiscountNotApplied(session);
  } catch (err) {
    if (err instanceof GuardrailError) return { text: null, toolsCalled };
    throw err;
  }

  // No customer ID = no personalization possible
  if (!customerId) return { text: null, toolsCalled };

  try {
    // Fetch customer tags and order count
    toolsCalled.push("admin_graphql:customer_tags");
    const data = await adminGraphql<{
      customer: { tags: string[]; numberOfOrders: number };
    }>(
      shopDomain,
      accessToken,
      `query GetCustomerSignals($id: ID!) {
        customer(id: $id) {
          tags
          numberOfOrders
        }
      }`,
      { id: customerId },
    );

    const { tags, numberOfOrders } = data.customer;

    // Determine eligibility — first match wins
    let discountPct: number | null = null;
    let reason: string = "";

    if (tags.includes("VIP")) {
      discountPct = Math.min(15, merchant.maxDiscountPct);
      reason = "VIP";
    } else if (numberOfOrders >= 3) {
      discountPct = Math.min(10, merchant.maxDiscountPct);
      reason = "loyalty";
    } else if (cartTotalCents && cartTotalCents >= merchant.vipCartThreshold) {
      discountPct = 0; // free shipping — handled as a separate code type
      reason = "free_shipping";
    } else if (memory.abandoned_cart) {
      // Reference abandoned cart but don't create a discount code
      return {
        text: `Still thinking about what you had in your cart? I can add those items back for you.`,
        toolsCalled,
      };
    } else {
      // Not eligible — return null silently
      return { text: null, toolsCalled };
    }

    if (discountPct !== null && discountPct > 0) {
      // Guard: check merchant limit
      try {
        assertDiscountWithinLimit(discountPct, merchant);
      } catch {
        return { text: null, toolsCalled };
      }

      // Create one-time discount code
      toolsCalled.push("admin_graphql:create_discount");
      const code = generateCode(reason);
      await createDiscountCode(shopDomain, accessToken, code, discountPct, session);

      return {
        text: `As a thank-you, I've created a ${discountPct}% discount code for you: **${code}**. It's valid for this order only.`,
        discountCode: code,
        discountPct,
        toolsCalled,
      };
    }

    if (reason === "free_shipping") {
      const code = generateCode("SHIP");
      await createFreeShippingCode(shopDomain, accessToken, code, session);
      return {
        text: `Great news — you qualify for free shipping! Use code **${code}** at checkout.`,
        discountCode: code,
        discountPct: 0,
        toolsCalled,
      };
    }

    return { text: null, toolsCalled };
  } catch {
    // Admin MCP failure → skip silently (personalization is enhancement, not core)
    return { text: null, toolsCalled };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateCode(prefix: string): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rand = Array.from({ length: 6 }, () =>
    chars[Math.floor(Math.random() * chars.length)],
  ).join("");
  return `${prefix.toUpperCase()}-${rand}`;
}

async function createDiscountCode(
  shopDomain: string,
  accessToken: string,
  code: string,
  pct: number,
  session: ConversationSession,
): Promise<void> {
  await adminGraphql(
    shopDomain,
    accessToken,
    `mutation CreateDiscount($input: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $input) {
        codeDiscountNode { id }
        userErrors { field message }
      }
    }`,
    {
      input: {
        title: `NeonPing-${session.cart_id ?? "session"}-${code}`,
        code,
        startsAt: new Date().toISOString(),
        customerSelection: { all: true },
        customerGets: {
          value: { percentage: pct / 100 },
          items: { all: true },
        },
        appliesOncePerCustomer: true,
        usageLimit: 1,
      },
    },
  );
}

async function createFreeShippingCode(
  shopDomain: string,
  accessToken: string,
  code: string,
  session: ConversationSession,
): Promise<void> {
  await adminGraphql(
    shopDomain,
    accessToken,
    `mutation CreateShippingDiscount($input: DiscountCodeFreeShippingInput!) {
      discountCodeFreeShippingCreate(freeShippingCodeDiscount: $input) {
        codeDiscountNode { id }
        userErrors { field message }
      }
    }`,
    {
      input: {
        title: `NeonPing-SHIP-${session.cart_id ?? "session"}-${code}`,
        code,
        startsAt: new Date().toISOString(),
        customerSelection: { all: true },
        appliesOncePerCustomer: true,
        usageLimit: 1,
      },
    },
  );
}
