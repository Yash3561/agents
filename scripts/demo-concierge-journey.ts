/**
 * Repeatable Global Concierge journey harness.
 *
 * This exercises the real webhook, Azure model, Global Catalog, Exa, Redis,
 * and Prisma. Only outbound Meta Graph calls are intercepted. It intentionally
 * tests a sequence, because shopping quality is mostly about continuity:
 * search -> preference -> contextual choice -> Redis expiry recovery ->
 * freshness research -> dynamic button follow-up.
 *
 * Usage:
 *   node --import tsx scripts/demo-concierge-journey.ts
 */
import crypto from "crypto";
import { config } from "dotenv";
import { PrismaClient } from "@prisma/client";
import { action } from "../app/routes/api.whatsapp.webhook";
import { fetchWhatsAppMemory } from "../app/lib/agents/memory.server";
import { deleteSession, getSession } from "../app/lib/session.server";
import { redis } from "../app/redis.server";

config();

const SHOP_DOMAIN = "global-concierge-journey-harness";
const PHONE_NUMBER_ID = "journey-harness-phone-id";
const CUSTOMER_PHONE = "15559997777";
const SESSION_ID = `whatsapp_${CUSTOMER_PHONE}`;

type CapturedCall = { body: Record<string, unknown> };
const captured: CapturedCall[] = [];
let exaCalls = 0;
const realFetch = global.fetch;
global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const urlStr = typeof url === "string" ? url : url.toString();
  if (urlStr.includes("api.exa.ai/search")) exaCalls += 1;
  if (urlStr.includes("graph.facebook.com")) {
    captured.push({
      body: init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : {},
    });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.journey-harness" }] }), { status: 200 });
  }
  return realFetch(url as never, init);
}) as typeof fetch;

function encryptedToken(): string {
  const key = process.env.ENCRYPTION_KEY ?? "";
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(key, "hex"), iv);
  return `${iv.toString("hex")}:${Buffer.concat([
    cipher.update("journey-harness-token", "utf8"),
    cipher.final(),
  ]).toString("hex")}`;
}

function sign(body: string): string {
  return `sha256=${crypto.createHmac("sha256", process.env.WHATSAPP_APP_SECRET ?? "").update(body).digest("hex")}`;
}

function outboundSummary(body: Record<string, unknown>): string {
  const type = body.type as string | undefined;
  if (type === "text") {
    return `text: ${String((body.text as { body?: string } | undefined)?.body ?? "")}`;
  }
  if (type === "template") {
    const template = body.template as { name?: string; components?: unknown[] } | undefined;
    return `template: ${template?.name ?? "unknown"}`;
  }
  if (type === "interactive") {
    const interactive = body.interactive as { type?: string; body?: { text?: string }; action?: { buttons?: unknown[]; parameters?: { url?: string } } } | undefined;
    return `${interactive?.type ?? "interactive"}: ${interactive?.body?.text ?? ""}${interactive?.action?.parameters?.url ? ` -> ${interactive.action.parameters.url}` : ""}${interactive?.action?.buttons ? ` (${interactive.action.buttons.length} buttons)` : ""}`;
  }
  return type ?? "unknown";
}

async function sendTurn(prisma: PrismaClient, input: string, label: string) {
  const before = captured.length;
  const buttonId = input.startsWith("button:") ? input.slice("button:".length) : undefined;
  const messageId = `wamid.journey-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: PHONE_NUMBER_ID },
      messages: [buttonId
        ? {
            from: CUSTOMER_PHONE,
            id: messageId,
            type: "interactive",
            interactive: { type: "button_reply", button_reply: { id: buttonId, title: buttonId } },
          }
        : { from: CUSTOMER_PHONE, id: messageId, text: { body: input } }],
      contacts: [{ profile: {} }],
    } }] }],
  };
  const raw = JSON.stringify(payload);
  const response = await action({
    request: new Request("http://localhost/api/whatsapp/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hub-signature-256": sign(raw) },
      body: raw,
    }),
    params: {},
    context: {},
  } as never);
  if (response.status !== 200) throw new Error(`${label}: webhook returned ${response.status}`);

  const session = await getSession(SHOP_DOMAIN, SESSION_ID);
  const memory = await fetchWhatsAppMemory(SHOP_DOMAIN, CUSTOMER_PHONE);
  const conversation = await prisma.conversation.findUnique({
    where: { shopDomain_sessionId: { shopDomain: SHOP_DOMAIN, sessionId: SESSION_ID } },
    select: { agentTrace: true },
  });
  const messages = captured.slice(before).map((call) => outboundSummary(call.body));
  console.log(`\n[${label}] ${input}`);
  console.log(`  outbound: ${messages.join(" | ") || "none"}`);
  console.log(`  trace: ${Array.isArray(conversation?.agentTrace) ? (conversation.agentTrace as string[]).join(", ") : "none"}`);
  console.log(`  memory: searches=${memory.recent_searches?.length ?? 0}, preferences=${memory.preferences?.length ?? 0}, last_results=${memory.last_results?.length ?? 0}`);
  return { session, memory, trace: Array.isArray(conversation?.agentTrace) ? conversation.agentTrace as string[] : [], messages };
}

function assertThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Harness assertion failed: ${message}`);
}

async function main() {
  const prisma = new PrismaClient();
  try {
    await prisma.merchant.upsert({
      where: { shopDomain: SHOP_DOMAIN },
      create: {
        shopDomain: SHOP_DOMAIN,
        plan: "surge",
        isGlobalConcierge: true,
        waPhoneNumberId: PHONE_NUMBER_ID,
        waAccessToken: encryptedToken(),
        waPhone: "15550000001",
        waConnectedAt: new Date(),
      },
      update: {
        plan: "surge",
        isGlobalConcierge: true,
        waPhoneNumberId: PHONE_NUMBER_ID,
        waAccessToken: encryptedToken(),
      },
    });
    await deleteSession(SHOP_DOMAIN, SESSION_ID);
    await redis.del(`wamem:${SHOP_DOMAIN}:${CUSTOMER_PHONE}`, `wa:rl:${SHOP_DOMAIN}:${CUSTOMER_PHONE}`);
    await prisma.conversation.deleteMany({ where: { shopDomain: SHOP_DOMAIN, sessionId: CUSTOMER_PHONE } });

    const first = await sendTurn(prisma, "Find wireless headphones under $100", "budget search");
    assertThat(first.memory.last_results?.length, "the first search should remember real result cards");
    assertThat(first.memory.last_results?.every((product) => Number.parseFloat(product.price) <= 100), "budget search must not present an item over $100");

    const preference = await sendTurn(prisma, "I prefer over-ear and black", "preference refinement");
    assertThat((preference.memory.preferences?.length ?? 0) > 0, "explicit preferences should be remembered");

    const cheapest = await sendTurn(prisma, "Which one is cheapest?", "contextual selection");
    assertThat(cheapest.messages.some((message) => message.includes("cta_url") || message.includes("template")), "contextual selection should retain a seller handoff");

    await deleteSession(SHOP_DOMAIN, SESSION_ID);
    const recovered = await sendTurn(prisma, "Which one is cheapest?", "Redis expiry recovery");
    assertThat(recovered.messages.some((message) => message.includes("cta_url") || message.includes("template")), "durable memory should recover the last product referent");

    const exaBefore = exaCalls;
    const freshness = await sendTurn(prisma, "Find the newest wireless headphones under $150 with current reviews", "freshness + research");
    assertThat(freshness.trace.includes("web_search"), "freshness requests must call Exa deterministically");
    assertThat(freshness.trace.includes("exa_freshness"), "freshness trace should be visible for debugging");
    assertThat(freshness.trace.includes("search_global_catalog"), "freshness research must still end in real Global Catalog listings");
    assertThat(exaCalls - exaBefore === 1, "one freshness turn should reuse its Exa brief instead of making duplicate searches");

    const more = await sendTurn(prisma, "button:global_more", "dynamic more button");
    assertThat(more.messages.length > 0, "dynamic button tap should produce a response");

    console.log("\n✅ Global Concierge journey passed: catalog truth, price guard, preference memory, contextual CTA, Redis expiry recovery, Exa freshness, and dynamic follow-up.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
