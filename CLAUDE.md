# NeonPing / "Shop All of Shopify" — Hackathon Handoff

**Last updated**: 2026-09-12 (this session)
**Status**: 🟢 Core product built and verified end-to-end in code. Blocked only on real Meta WhatsApp credentials for live delivery — everything upstream of that is real and tested, not mocked.
**Repo**: https://github.com/Yash3561/agents (pushed from this session — replaces the old `NeonPing/agentic-commerce` remote)
**Context**: Built for a hackathon. Organizers confirmed eligibility rules don't block reusing this pre-existing codebase — proceed without worrying about that.

## Read this first

This file exists because the session that did most of this work is ending and someone/something else needs to continue. Everything below is either **verified by a real test run this session** (stated explicitly) or **clearly marked as not yet verified**. Don't assume anything works that isn't marked verified — go verify it, the test scripts are already there.

---

## The product, in one paragraph

A WhatsApp number that acts as a **store-agnostic shopping concierge** — not tied to one merchant's Shopify store. A customer messages it, describes what they want, and the agent searches **Shopify's Global Catalog** (every Shopify merchant, one endpoint) for real products, then hands off to whichever actual seller carries it via that seller's own checkout link. Pitch: **"Shop all of Shopify from one WhatsApp number."** This needs zero Shopify Partner/OAuth setup for the demo — only a Meta WhatsApp Business test number.

There is also a second, older mode still in the codebase and still working: a **per-merchant** WhatsApp assistant tied to one Shopify store (the original NeonPing SaaS product). Both modes share most of the codebase; `Merchant.isGlobalConcierge` (boolean, Prisma) is the switch. The webhook branches cleanly on it — see `app/routes/api.whatsapp.webhook.tsx`.

**Why the pivot to global-first**: the user explicitly chose this over keeping the per-merchant-first design when asked directly (see git history / this session's conversation). Don't revert it without asking.

---

## What's built and verified this session (chronological, so you can see the reasoning)

1. **Local dev environment** — no Azure needed for any of this.
   - `docker-compose.dev.yml`: local Postgres only, on port **5433** (5432 was taken by another local Postgres). `DATABASE_URL` in `.env` already points here.
   - Redis: **do not add a Docker Redis container** — a native `redis-server` already runs on this Mac at `127.0.0.1:6379` and macOS routes `localhost` there ahead of any Docker port mapping to the same port. This was a real, confusing bug this session (a Docker Redis container existed but was never actually being read from/written to — all traffic silently went to the native instance instead). Confirmed via `redis-cli -h 127.0.0.1 -p 6379 keys '*'` showing real session/memory keys. If Redis stops working, check `redis-cli -h 127.0.0.1 -p 6379 ping` before assuming anything is broken.
   - `pnpm install`, not `npm` — the repo has `pnpm-workspace.yaml`; `package-lock.json` is stale/vestigial.
   - `.env` is filled in with real values for: `DATABASE_URL`, Azure LLM (`AZURE_FOUNDRY_BASE_URL`/`AZURE_OPENAI_API_KEY`/`AZURE_SPECIALIST_MODEL`=`model-router`), `EXA_API_KEY`, `ENCRYPTION_KEY`, `SESSION_SECRET`, and a **local-only placeholder** `WHATSAPP_APP_SECRET`/`WHATSAPP_VERIFY_TOKEN` (used only for `scripts/demo-webhook-test.ts`'s signature verification — **replace with the real Meta values** once you have them, don't assume these are real secrets).
   - **Still empty, needed to go live**: `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET`/`SHOPIFY_APP_URL` (only needed if you ever re-enable the per-merchant mode's Shopify OAuth — NOT needed for the Global Concierge demo), and the **real** `WHATSAPP_APP_ID`/`WHATSAPP_APP_SECRET`/`WA_TEST_PHONE_NUMBER_ID`/`WA_TEST_ACCESS_TOKEN`/`WA_TEST_PHONE_DISPLAY`/`WHATSAPP_VERIFY_TOKEN` from Meta's App Dashboard.

2. **Exa web-search tool** (`app/lib/exa.server.ts`, wired into `app/lib/agents/shared-tools.server.ts` as `web_search`) — for shopping research the catalog can't answer (comparisons, reviews, buying guides). Verified live: real Exa API calls returning real results, and the agent correctly cross-checking web research against the catalog in the same turn (e.g. "is red light therapy backed by science?" → real research + a real matching store product named).

3. **A confirmed, fixed bug**: `recent_products` customer memory was **silently never being written**, because `whatsapp.server.ts` parsed the AI SDK's OLD tool-result shape (`step.toolResults[].result`), which no longer exists — the SDK now nests it as `step.content[]` with `type: "tool-result"` / `.output`. Fixed by reading from `shared-tools.server.ts`'s already-correct `state.products` instead of re-deriving it. **If you see other code walking `result.steps[].toolResults` or `.result` anywhere, it has the same bug — grep for it.**

4. **Global Catalog integration** (`app/lib/mcp/global-catalog.server.ts`) — calls Shopify's real, public `https://catalog.shopify.com/api/ucp/mcp` endpoint. Requires a hosted **UCP agent profile** (a small JSON file, no Partner account or approval needed) referenced via `meta["ucp-agent"].profile` — this plumbing already existed in the codebase (`client.server.ts`'s `agentProfileUrl` param, built for Cart/Checkout/Order MCP, unused for catalog until now). The profile file is `public/.well-known/ucp-agent.json` (served automatically at `<app_url>/.well-known/ucp-agent.json` by Vite's static `public/` convention — confirmed it lands in the build output). For local testing before you have a real reachable `SHOPIFY_APP_URL`, set `GLOBAL_CATALOG_AGENT_PROFILE_URL` in `.env` to Shopify's own public sample profile (already set — see `.env`): `https://shopify.dev/ucp/agent-profiles/2026-08-25/valid-with-capabilities.json`.
   - **Confirmed field shapes via live calls** (docs summaries were unreliable/incomplete — always verify against a real response): seller info, price, rating, and checkout URL live on each **variant**, not the product: `product.variants[0].seller.{name,domain,url}`, `.price.{amount,currency}`, `.checkout_url`, `.rating.{value,count}`, `.url` (product page). `product.media[0].url` for image.
   - **Confirmed real limitation (Shopify's own docs, not something I invented)**: there is **no unified cross-merchant checkout**. Shopify's own guidance: group results by `seller.domain` and create a separate checkout URL per seller. A developer asked Shopify directly whether unified multi-merchant checkout is possible — [unanswered as of this research](https://community.shopify.dev/t/multi-merchant-cart-checkout-in-ucp/36542). So: every cross-store result gets its own "View & Buy" button to that seller's own checkout — this is correct, not a shortcut.

5. **`search_other_stores` tool** (per-merchant mode only) — cross-merchant fallback for when a specific store's own catalog has nothing. Careful prompt guardrails: never fires as a first resort, never for something the store already carries, always transparent about which other store a result is from. Verified live: correctly triggered for "electric guitars" (this demo store doesn't sell them) with real cross-store results; correctly did NOT trigger for "resistance bands" (the store does carry them).

6. **The Global Concierge pivot** (this is the main deliverable):
   - `prisma/schema.prisma`: added `Merchant.isGlobalConcierge Boolean @default(false)`, migrated (`prisma/migrations/20260912165038_add_is_global_concierge/`).
   - `app/lib/agents/global-concierge.server.ts`: a new, separate agent (not reusing `runWhatsAppAgent`, which is deeply coupled to one store's cart/discounts/order-history). Tools: `search_global_catalog` (primary, not a fallback), `web_search` (Exa). System prompt is honest by design — always names the real seller, never implies it's this bot's own inventory, tells customers to contact the actual seller for order issues (no unified order tracking is possible across independent stores).
   - `app/lib/whatsapp.server.ts`: new `sendCrossStoreOffer()` function — deliberately different copy from `sendCheckoutMessage` ("Added to your cart!" would be a lie here since nothing was added to any cart of ours). One `cta_url` card per product (WhatsApp's cta_url type supports exactly one button; the existing `sendCarousel` only supports `quick_reply` buttons, not URLs, so cross-store results are sent as sequential single cards, not a carousel).
   - `app/routes/api.whatsapp.webhook.tsx`: cleanly branched — `if (merchant.isGlobalConcierge) { ...self-contained handling...; return; }` placed right after the merchant/billing gates and before the per-merchant button/list-reply logic, so the original per-merchant path is completely untouched.
   - **Also fixed in this file**: unsupported inbound message types (image, video, voice note, sticker, location) used to silently return `200 OK` with **no reply at all** — a real customer sending a photo ("does this come in this color?") saw dead silence. Now sends an honest "I can't view images yet, but tell me what you're looking for" instead. This applies to both modes.

7. **Test infrastructure built this session** (all still here, all reusable):
   - `scripts/demo-repl.ts` — interactive/pipeable terminal chat against the real per-merchant `runWhatsAppAgent` brain, no Shopify/WhatsApp credentials needed (uses the public, unauthenticated per-store Storefront MCP). `npx tsx scripts/demo-repl.ts [shopDomain]`.
   - `scripts/demo-webhook-test.ts` — **the most important one**: calls the REAL `api.whatsapp.webhook.tsx` `action()` function with a real HMAC-signed Meta-shaped payload, intercepting only outbound `graph.facebook.com` calls (logs what would be sent instead of sending it) — everything else (Global Catalog, Azure LLM, Exa, Redis, Postgres) is 100% real. This is how the Global Concierge was verified end-to-end without real Meta credentials. `npx tsx scripts/demo-webhook-test.ts "your message here"`. Currently seeds a test merchant with `isGlobalConcierge: true` — change that or add a CLI flag if you need to test the per-merchant path this way too.
   - `scripts/demo-trigger-cart-recovery.ts` — fires the per-merchant abandoned-cart-recovery WhatsApp message immediately instead of waiting for QStash's real 30-minute delay (QSTASH_TOKEN is intentionally left unset for local dev).
   - `scripts/seed-wa-test.ts` — seeds/updates a Merchant row with WhatsApp test credentials directly (bypasses Meta's embedded-signup OAuth popup). Hardened this session: `upsert` not `update` (works standalone), forces `plan: "surge"` (10k msgs/mo — the default `free` plan's 10/mo cap was a real risk of interrupting a demo mid-rehearsal).
   - `npm run demo:seed-whatsapp` / `npm run demo:trigger-cart-recovery` — convenience aliases for the above two.

8. **Verified test scenarios (this session, via the scripts above)** — all passed:
   - Global Concierge: cross-store product search with real sellers/prices/checkout links, correct greeting (first-time and memory-callback "last time you were looking at X"), jailbreak refusal, off-topic refusal.
   - Per-merchant: catalog search, product Q&A (including the "light modes vs. color options" nuance the prompt specifically guards against), Exa cross-check, cart→real checkout URL (confirmed live with a 302 redirect), escalation, gift-intent + budget filtering, cross-session memory recall, `search_other_stores` firing correctly (and not over-firing).
   - Full regression: **100/100 unit tests pass**, production build succeeds, after every change in this session.

---

## What is NOT yet verified — do this next

**Nothing has been sent through the real Meta WhatsApp Cloud API.** Every test above intercepted the `graph.facebook.com` calls. To close the loop:

1. Get real values for `WHATSAPP_APP_ID`, `WHATSAPP_APP_SECRET`, `WA_TEST_PHONE_NUMBER_ID`, `WA_TEST_ACCESS_TOKEN`, `WA_TEST_PHONE_DISPLAY` from Meta App Dashboard → WhatsApp → API Setup. Put them in `.env`, replacing the local-only placeholders.
2. Pick a real `WHATSAPP_VERIFY_TOKEN` (any string), put it in `.env` and in Meta's webhook config.
3. Run `npm run dev` (`shopify app dev`) — starts a public tunnel and, because `automatically_update_urls_on_dev = true` is set in `shopify.app.toml`, updates `application_url`/`redirect_urls` automatically. This step **does** need real `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET` even for Global Concierge mode, only because the tunnel/dev-server infrastructure comes from the Shopify CLI — the Global Concierge's own product logic doesn't call any Shopify-store-specific API.
4. Run `npm run demo:seed-whatsapp` to wire the WhatsApp test number to a Merchant row — **make sure `isGlobalConcierge: true` is set on it** if you want the new concierge mode (the seed script doesn't currently set this flag by default — check/patch `scripts/seed-wa-test.ts` before running, or set it manually via Prisma Studio / a one-off script).
5. Point Meta's webhook config at `<tunnel-url>/api/whatsapp/webhook`, subscribe to the `messages` field.
6. Message the test number from a real phone. Compare against what `demo-webhook-test.ts` predicted — if it differs, the gap is specifically in the real Meta delivery layer, not the agent/catalog/LLM logic (that part is already proven).

---

## Architecture decisions — don't relitigate these without a reason

- **Global-first, not merchant-first** — explicit user choice this session. The per-merchant mode still exists and works; it's just not the primary demo path anymore.
- **No LangChain / LangGraph / "deepagents"** — considered and explicitly rejected this session. Reasoning: WhatsApp's latency budget (customers expect single-digit-second replies; every test this session landed in 3-9s with ONE LLM call) doesn't tolerate a multi-agent handoff architecture's sequential round-trips. The existing single-call, multi-tool pattern (Vercel `ai` SDK, already working) already achieves the composition a "team of agents" would provide, without the latency cost. If a genuinely slow, opt-in "deep compare across all of Shopify" feature is ever wanted, build it as parallel tool calls + a synthesis step in the same SDK — not a new framework dependency.
- **No unified cross-merchant checkout** — not a shortcut, it's Shopify's own current platform limitation (see point 4 above). Don't try to build a fake unified cart; it would misrepresent what's actually happening to the customer.
- **Azure kept intentionally for the LLM** (user has existing Azure credits) — do not swap to another provider without being asked. `app/lib/llm.server.ts` is the one file this would touch if it ever changes; it's already abstracted behind `@ai-sdk/openai-compatible` so the swap would be small.
- **Keep both modes in the codebase** — don't delete the per-merchant path (`runWhatsAppAgent`, the onboarding wizard, billing pages, etc.) even though the demo doesn't use them. They're tested and working; ripping them out for "cleanliness" was explicitly decided against earlier this session (high effort, zero demo benefit, since the demo never shows the Shopify admin UI at all — judges see WhatsApp on a phone).

---

## Known gaps / things to be honest about in the demo

- No vision support — a customer sending a photo gets an honest "I can't view that yet" instead of silence (fixed this session), but still can't actually answer "does this come in this color" from a picture.
- No order tracking across sellers — by design, not a bug; each seller is a fully independent store.
- The Global Concierge's memory/session state lives in the shared Redis instance, keyed by a shopDomain-shaped partition string that need not be a real Shopify store (see `Merchant.isGlobalConcierge` comment in `schema.prisma`) — this is intentional, not a bug, but worth understanding before touching billing/usage code that assumes `shopDomain` is always a real `.myshopify.com` domain.
- `demo-webhook-test.ts` currently hardcodes a concierge-mode test merchant — if you need to test the per-merchant path via the same script, either parameterize it or use `demo-repl.ts` instead (which already targets per-merchant mode against a real public demo store, `neonping-dev-a509ojgs.myshopify.com`).

---

## Contact & original project context

- Legal/privacy contact from the original NeonPing project: kaushik@neonping.com
- The original Azure-hosted deployment (`neonping.politeocean-a6f0ef16.southcentralus.azurecontainerapps.io`) is stale/likely dead — this session moved entirely to local dev. Don't assume it's reachable.
- Original dev store referenced throughout: `neonping-dev-a509ojgs.myshopify.com` — real, live, public Storefront MCP, used for all per-merchant-mode testing this session.
