/**
 * Exercises the REAL api.whatsapp.webhook.tsx `action()` end-to-end — signature
 * verification, dedup, opt-out, the Global Concierge branch, the real agent,
 * real Global Catalog search, real Azure LLM — with ONLY the outbound Meta
 * Graph API calls intercepted (captured and logged instead of actually sent,
 * since we don't have real WhatsApp credentials yet). Everything else is real.
 *
 * Usage: npx tsx scripts/demo-webhook-test.ts "do you have electric guitars?"
 * Button tap: npx tsx scripts/demo-webhook-test.ts "button:global_more"
 */
import crypto from "crypto";
import { config } from "dotenv";
import { PrismaClient } from "@prisma/client";

config();

const TEST_PHONE_NUMBER_ID = "test-concierge-phone-id";
const TEST_SHOP_DOMAIN = "global-concierge-webhook-test";
const TEST_CUSTOMER_PHONE = "15559998888";

// Intercept only graph.facebook.com (Meta) calls — everything else (Global
// Catalog, Azure LLM, Exa) hits the real network exactly like production.
const realFetch = global.fetch;
const captured: Array<{ url: string; body: unknown }> = [];
global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const urlStr = typeof url === "string" ? url : url.toString();
  if (urlStr.includes("graph.facebook.com")) {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    captured.push({ url: urlStr, body });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.test" }] }), { status: 200 });
  }
  return realFetch(url as never, init);
}) as typeof fetch;

async function main() {
  const prisma = new PrismaClient();
  const encKey = process.env.ENCRYPTION_KEY ?? "";
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(encKey, "hex"), iv);
  const encToken = iv.toString("hex") + ":" + Buffer.concat([cipher.update("dummy-wa-token", "utf8"), cipher.final()]).toString("hex");

  await prisma.merchant.upsert({
    where: { shopDomain: TEST_SHOP_DOMAIN },
    create: {
      shopDomain: TEST_SHOP_DOMAIN,
      plan: "surge",
      isGlobalConcierge: true,
      waPhoneNumberId: TEST_PHONE_NUMBER_ID,
      waAccessToken: encToken,
      waPhone: "15550000000",
      waConnectedAt: new Date(),
    },
    update: { isGlobalConcierge: true, waPhoneNumberId: TEST_PHONE_NUMBER_ID, waAccessToken: encToken },
  });

  const messageText = process.argv[2] ?? "do you have electric guitars?";
  const buttonId = messageText.startsWith("button:") ? messageText.slice("button:".length) : undefined;
  const messageId = `wamid.demo-${Date.now()}`;
  const metaPayload = {
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: TEST_PHONE_NUMBER_ID },
          messages: [buttonId
            ? {
                from: TEST_CUSTOMER_PHONE,
                id: messageId,
                type: "interactive",
                interactive: { type: "button_reply", button_reply: { id: buttonId, title: buttonId } },
              }
            : { from: TEST_CUSTOMER_PHONE, id: messageId, text: { body: messageText } }],
          contacts: [{ profile: {} }],
        },
      }],
    }],
  };
  const rawBody = JSON.stringify(metaPayload);
  const signature = "sha256=" + crypto.createHmac("sha256", process.env.WHATSAPP_APP_SECRET ?? "").update(rawBody).digest("hex");

  const { action } = await import("../app/routes/api.whatsapp.webhook");
  const request = new Request("http://localhost/api/whatsapp/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hub-signature-256": signature },
    body: rawBody,
  });

  console.log(`\n📩 Simulated inbound WhatsApp ${buttonId ? "button tap" : "message"}: "${buttonId ?? messageText}"\n`);
  const response = await action({ request, params: {}, context: {} } as never);
  console.log(`Webhook response: ${response.status} ${await response.text()}\n`);

  console.log(`--- Captured outbound Meta API calls (${captured.length}) ---`);
  for (const c of captured) {
    const interactive = (c.body as { interactive?: { type?: string; body?: { text?: string }; action?: { parameters?: { url?: string } } } })?.interactive;
    const text = (c.body as { text?: { body?: string } })?.text?.body;
    if (text) {
      console.log(`[text] "${text}"`);
    } else if (interactive) {
      console.log(`[${interactive.type}] "${interactive.body?.text}"${interactive.action?.parameters?.url ? ` -> ${interactive.action.parameters.url}` : ""}`);
    } else {
      console.log(JSON.stringify(c.body));
    }
  }

  await prisma.$disconnect();
  process.exit(0);
}

main();
