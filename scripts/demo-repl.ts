/**
 * Interactive terminal chat against the REAL WhatsApp agent brain
 * (runWhatsAppAgent) — no Shopify OAuth, no WhatsApp/Meta API needed.
 *
 * Uses the live public Storefront MCP catalog on a real *.myshopify.com store
 * (no auth required for catalog reads — see app/lib/mcp/catalog.server.ts),
 * the real Azure LLM, and the real Exa web_search tool. Only things it can't
 * exercise: Admin-API-backed features that need a real access token (active
 * discounts, order lookup, customer-metafield memory) — those fail open and
 * are silently skipped, everything else runs for real.
 *
 * Usage:
 *   npx tsx scripts/demo-repl.ts [shopDomain]
 *   (defaults to DEMO_SHOP_DOMAIN in .env, or neonping-dev-a509ojgs.myshopify.com)
 *
 * Type messages like a WhatsApp customer would. Type "/reset" to clear the
 * session, "/trace" to print the last turn's tool-call trace, "/exit" to quit.
 */

import { config } from "dotenv";
import readline from "readline";
import { PrismaClient } from "@prisma/client";
import { runWhatsAppAgent } from "~/lib/agents/whatsapp.server";
import { getSession, setSession } from "~/lib/session.server";

config();

const shopDomain = process.argv[2] ?? process.env.DEMO_SHOP_DOMAIN ?? "neonping-dev-a509ojgs.myshopify.com";
const sessionId = `whatsapp_demo-repl-${Date.now()}`;
const customerPhone = "15550001111";

const prisma = new PrismaClient();

async function ensureMerchant() {
  return prisma.merchant.upsert({
    where: { shopDomain },
    create: { shopDomain, plan: "surge", personalizationEnabled: false },
    update: {},
  });
}

async function main() {
  console.log(`\n🧪 Demo REPL — talking to the real WhatsApp agent brain`);
  console.log(`   Store: ${shopDomain}  (live Storefront MCP, public, no keys needed)`);
  console.log(`   Session: ${sessionId}\n`);

  const merchant = await ensureMerchant();
  let lastTrace: string[] = [];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });

  // Process lines strictly sequentially via for-await — readline's "line" event
  // fires synchronously for every buffered line when stdin is piped (not a TTY),
  // and "close" fires right after, racing ahead of any async agent call still in
  // flight. Iterating the async iterator instead awaits each turn before the
  // next is read, so piped scripted conversations (used for testing) behave
  // identically to typing interactively.
  for await (const line of rl) {
    const msg = line.trim();
    if (!msg) continue;

    if (msg === "/exit") break;
    if (msg === "/reset") {
      await setSession(shopDomain, sessionId, { conversation_history: [], discount_negotiation: { offered_codes: [], level: 0 } });
      console.log("(session reset)\n");
      if (process.stdin.isTTY) rl.prompt();
      continue;
    }
    if (msg === "/trace") {
      console.log("(last tool trace):", lastTrace.join(" -> ") || "(none yet)", "\n");
      if (process.stdin.isTTY) rl.prompt();
      continue;
    }

    console.log(`you> ${msg}`);
    try {
      const session = await getSession(shopDomain, sessionId);
      const t0 = Date.now();
      const result = await runWhatsAppAgent({
        shopDomain,
        sessionId,
        customerPhone,
        agentMessage: msg,
        session,
        merchant,
        accessToken: "", // no Admin API in this harness — discount/order lookups fail open
      });
      const ms = Date.now() - t0;
      lastTrace = result.agent_trace;

      session.conversation_history.push({ role: "user", content: msg, timestamp: new Date().toISOString() } as never);
      session.conversation_history.push({ role: "assistant", content: result.text, timestamp: new Date().toISOString() } as never);
      if (result.cart_id) session.cart_id = result.cart_id;
      session.discount_negotiation = result.discount_negotiation;
      await setSession(shopDomain, sessionId, session);

      console.log(`bot> ${result.text}`);
      if (result.products?.length) {
        console.log(`  [${result.products.length} product(s)]: ${result.products.map((p) => `${p.title} ($${p.price_min})`).join(", ")}`);
      }
      if (result.checkout_url) console.log(`  [checkout]: ${result.checkout_url}`);
      if (result.escalate_to_human) console.log(`  [ESCALATED TO HUMAN]`);
      console.log(`  [tools: ${result.agent_trace.join(", ")}] [${ms}ms]\n`);
    } catch (err) {
      console.error("ERROR:", err instanceof Error ? err.stack : err);
    }
    // Piped (non-TTY) input closes the interface as soon as EOF is read, which
    // can race ahead of this still-awaiting loop body — re-showing the "you>"
    // cue only matters for a real interactive terminal anyway.
    if (process.stdin.isTTY) rl.prompt();
  }

  rl.close();
  // runWhatsAppAgent fires its memory write-back (updateWhatsAppMemory) as
  // "void promise.catch()" — intentionally not awaited, so the WhatsApp webhook
  // response returns to Meta fast. That's fine on a long-running server (the
  // event loop stays alive for other requests), but this short-lived script
  // would otherwise exit before that write lands. Give it a moment.
  await new Promise((r) => setTimeout(r, 1000));
  await prisma.$disconnect();
  console.log("\nbye");
}

main();
