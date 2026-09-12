# NeonPing / “Shop All of Shopify” — Handoff

**Last audited:** 2026-09-12
**Repository:** `https://github.com/Yash3561/agents`
**Current branch:** `main` at `909ad363` (`feat: pivot to store-agnostic Global Concierge, add Exa research, fix silent memory bug`)
**Current verdict:** The product logic is implemented and the automated checks are green. The remaining launch blocker is real Meta WhatsApp delivery. Shopify store credentials are not used by the Global Catalog/Global Concierge logic, but the current monolith initializes Shopify’s SDK at server startup and therefore still needs non-empty Shopify initialization values unless that coupling is refactored.

## Read this first

This is the operational source of truth for the current codebase. It deliberately distinguishes:

- **Verified in this audit:** commands run against the checked-out repository today.
- **Previously live-verified:** real external calls recorded by the preceding implementation session, but not repeated during this audit.
- **Not verified:** a real-world path that still needs to be exercised.

The code is the source of truth for behavior. If this file and the code disagree, inspect the code and update this file rather than reviving the older architecture documents that were removed because they had drifted.

## Product and modes

The primary product is a WhatsApp shopping concierge that searches Shopify’s cross-merchant Global Catalog. A customer describes a need; the agent returns real listings, identifies each independent seller, and sends the seller’s own checkout URL. The product pitch is: **“Shop all of Shopify from one WhatsApp number.”**

There are two modes behind the same WhatsApp webhook:

| Mode | Switch | Product source | Purchase behavior |
| --- | --- | --- | --- |
| Global Concierge | `Merchant.isGlobalConcierge = true` | Shopify Global Catalog, plus Exa research | No local cart. Each result hands off to that seller’s checkout URL. |
| Per-merchant assistant | `false` (default) | One merchant’s Storefront MCP catalog, with cross-store fallback | Creates/updates that merchant’s Shopify cart and sends its checkout URL. |

The branch is in `app/routes/api.whatsapp.webhook.tsx`. Keep the modes separate: the per-merchant agent assumes a home store, local cart, discounts, and order history; the Global Concierge intentionally has none of those.

The Global Concierge pivot was an explicit product decision. Do not change the demo back to merchant-first or delete the per-merchant path without a new product decision.

## Verification ledger

### Verified in this audit

- `npm run test:unit`: **13 files, 100 tests passed**.
- `npm run build`: succeeds. The build emits the server bundle and static assets, including `public/.well-known/ucp-agent.json` through the normal Vite `public/` convention.
- `npm run typecheck`: succeeds.
- `git diff --check`: clean.
- `npm run demo:concierge-journey`: passed against live Global Catalog, Exa, local Postgres/Redis, and the real webhook action with Meta Graph intercepted. It verified one-turn clarification, budget enforcement after preference refinement, visible shopping-brief confirmation, Exa-backed comparison, explicit preference memory, deterministic contextual selection, Redis-session expiry recovery, one Exa freshness request reused by the agent, and a dynamic button follow-up.
- The source confirms the Global Concierge branch, seller/checkout URL mapping, memory write path, unsupported-message response, and `isGlobalConcierge` migration are present.
- `npm run demo:seed-whatsapp`: succeeds against the configured database and writes the test Merchant with `plan: "surge"` and `isGlobalConcierge: true`.
- A read-only Meta Graph API check for the configured phone ID/access token returned HTTP 200 and a display number.
- `npx tsx scripts/demo-webhook-test.ts 'find wireless headphones under $100'`: succeeds with HTTP 200 and captures a text response plus three seller-specific `cta_url` checkout messages. The harness still intercepts outbound Meta sends, so this is not a real inbound Meta delivery test.
- The app-owned UCP profile is now verified through the public tunnel: it returns the required shopping service and empty `payment_handlers`, and Shopify Global Catalog responds with HTTP 200 and products when that profile is used.

The build emits warnings about production source maps and future React Router flags. They are warnings, not build failures; source maps should be reviewed before a production deployment because the build warns that server source can become publicly visible.

### Previously live-verified, not repeated in this audit

The preceding implementation session recorded these real-network checks. They used real services where stated, but they should be rerun after credentials or deployment changes:

- Shopify Global Catalog MCP at `https://catalog.shopify.com/api/ucp/mcp`, including real seller names, prices, ratings, product URLs, and seller checkout URLs.
- Exa search calls and an agent turn that combined web research with a catalog match.
- Per-merchant Storefront MCP catalog search, product-detail Q&A, cart creation, and a checkout URL that returned a live HTTP redirect.
- `search_other_stores` firing for a missing category and not firing when the home store had a relevant product.
- Direct Global Concierge scenarios: product search, first-time greeting, memory callback, jailbreak refusal, and off-topic refusal.
- The full webhook harness path with real HMAC calculation, Postgres, Redis, Azure LLM, Global Catalog, and Exa; only calls to `graph.facebook.com` were intercepted.

These records are evidence that the integrations worked during the earlier session, not evidence that Meta delivery or the old Azure deployment is live now.

### Not verified yet

- A real POST sent by Meta WhatsApp Cloud API to the deployed webhook.
- The real Meta GET verification handshake against the final public URL and verify token.
- A real inbound message answered on a phone, including the CTA checkout button opening correctly.
- Production deployment health, webhook delivery retries, Meta template/number eligibility, and production secrets.
- An actual Meta-approved media-card carousel send; the optional payload has been validated with Meta calls intercepted, but no template has been created or approved yet.
- Actual fulfillment/order support across multiple independent sellers.

The current sandbox could not inspect local Redis or Docker because access to the local Redis socket and Docker daemon was denied. Do not infer Redis health from that failed diagnostic.

## What is built

### Global Concierge

- `app/lib/agents/global-concierge.server.ts` contains a separate single-agent flow with two tools:
  - `search_global_catalog`: the default for every product request, including vague shopping needs.
  - `web_search`: Exa research for comparisons, reviews, buying guides, sizing, and trends.
- Explicit freshness language (`newest`, `latest`, `recent`, `just launched`, `trending`, `current`, or a recent year) deterministically triggers an Exa freshness preflight with publication-date filters, a 24-hour index-age preference, live crawling preference, and source-ranking instructions. The brief is passed to the agent as context; the agent must still call Global Catalog for the actual buyable listings.
- The prompt requires seller transparency, forbids invented product data, refuses unrelated topics and prompt-injection requests, and tells customers to contact the actual seller for order problems.
- `app/lib/mcp/global-catalog.server.ts` calls the real Shopify Global Catalog MCP endpoint. It requires a hosted UCP agent profile and maps seller, price, rating, URL, checkout URL, and image from the first returned variant. Listings without a seller domain or checkout URL are skipped rather than guessed.
- `public/.well-known/ucp-agent.json` is the production profile. For local testing before the app has a reachable public URL, `GLOBAL_CATALOG_AGENT_PROFILE_URL` can point to Shopify’s public sample profile.
- `sendCrossStoreOffer()` in `app/lib/whatsapp.server.ts` sends one `cta_url` message per product. The copy says “View & Buy”; it never claims that an item was added to NeonPing’s cart.
- The Global Concierge webhook sends one short intro followed by up to three seller cards. It intentionally does not send the agent’s product-by-product text as well, because that duplicated the same titles, prices, and sellers immediately above the cards.
- Product results are followed by “More options”, “Compare picks”, and “Refine search” quick replies. These are mapped back into the concierge as normal follow-up intents; seller checkout CTAs remain external one-tap handoffs.
- Follow-up buttons are dynamic: contextual selections such as “cheapest” do not get another button row, research turns get “More like this” and “Refine search”, and broad multi-result discovery gets up to three next actions.
- Result delivery is intent-aware rather than always three cards: singular selectors and explicit “show me one/two” requests are honored, “more options” can show up to five, and ordinary discovery uses up to three. Only the cards actually shown are remembered as the next-turn referent.
- If `WA_MEDIA_CAROUSEL_TEMPLATE_NAME` is configured and every result has an image, the webhook attempts a Meta-approved media-card carousel (up to 10 cards). It falls back to the current sequential CTA cards if the template is missing, ineligible, or rejected.
- Global Concierge remembers recent searches, explicit preference statements, a compact shopping brief, and the last five visible result records in phone-keyed Redis memory. If the 30-minute Redis conversation session expires, the agent can still answer contextual selectors such as “which one is cheapest?” and the webhook restores the durable transcript from Postgres.
- Explicit catalog price ceilings are enforced after Global Catalog returns results because semantic catalog ranking can include related products above a requested budget. Comparison turns can use Exa and still retain product cards plus the research summary.
- Explicit price ranges are enforced locally for both ceilings and floors (`under`, `between`, `over`, `at least`, and similar), and duplicate seller checkout listings are removed before they reach WhatsApp.
- Vague first turns such as “I need a gift” receive one focused clarification instead of an arbitrary product dump. Explicit refinements get a short visible brief confirmation, and comparison turns keep concise decision guidance instead of hiding the agent’s comparison behind generic handoff text.
- If a price includes a currency symbol, catalog filtering is currency-aware. Mixed-currency comparison cards are labeled as such and are not ranked by raw numeric amount; there is no foreign-exchange conversion in the MVP.
- `scripts/demo-concierge-journey.ts` is the repeatable agentic harness. It tests a full search/refinement/contextual-selection/memory-recovery/freshness/button journey and asserts that freshness uses Exa while purchase options still come from Global Catalog. It requires reachable local Postgres and Redis and only intercepts Meta Graph calls.
- The webhook sends the intent-selected number of sequential product offers (up to five) after the text response. It does not use the per-merchant carousel because the relevant CTA is an external URL and the existing carousel uses quick-reply buttons.
- `WA_DISABLE_RATE_LIMIT=true` can disable the 20-message/hour phone guardrail for a non-production Global Concierge demo. It is ignored when `NODE_ENV=production`; billing/plan limits and Meta limits still apply.

### Per-merchant assistant

- `app/lib/agents/whatsapp.server.ts` retains the original store-specific flow.
- It supports live catalog search, product detail lookup, cart operations, checkout, discount negotiation, policy/FAQ search, order lookup where credentials permit, escalation, memory, and `search_other_stores` as a fallback.
- `app/lib/agents/shared-tools.server.ts` holds genuinely shared tools. Cart, discount, and order tools remain local where channel behavior differs intentionally.

### Webhook and guardrails

`app/routes/api.whatsapp.webhook.tsx` handles Meta verification and inbound messages. Common behavior includes:

- HMAC signature verification with `WHATSAPP_APP_SECRET`.
- Message deduplication in Redis (`wamsg:{id}`, 24-hour TTL).
- STOP/START opt-out handling before agent work.
- Per-phone rate limiting at 20 messages/hour.
- Plan usage gating via `checkAndIncrementUsage()`.
- Input cleanup and a 500-character cap.
- Jailbreak blocking, unsafe-output filtering, and PII redaction.
- PII-free phone hashes in guardrail logs.
- An explicit response for image, video, audio, document, sticker, location, and other unsupported inbound types. There is still no vision support.

### Persistence and data model

- `Merchant.isGlobalConcierge` was added by migration `prisma/migrations/20260912165038_add_is_global_concierge/` and defaults to `false`.
- Global Concierge uses `shopDomain` as a partition key for Redis sessions, memory, billing, and conversations. In this mode it may be a label such as `global-concierge-webhook-test`, not a real `.myshopify.com` domain.
- Customer memory uses the WhatsApp phone-keyed Redis path; identified per-merchant customers may also receive durable Shopify metafield memory.
- Global Concierge conversation/tool traces are awaited before the webhook finishes so short-lived processes do not lose the turn; LLM usage telemetry and channel memory remain best-effort so a Redis/telemetry problem does not prevent the WhatsApp response.

## Bug ledger and recurring patterns

These are the important bugs already found. Preserve the recognition pattern when touching similar code.

1. **AI SDK result-shape drift broke memory silently.**

   `whatsapp.server.ts` used to read `result.steps[].toolResults[].result`, an older AI SDK shape. The current SDK exposes tool output through `step.content[]` entries with `type: "tool-result"` and `output`. The old loop found nothing, so products were shown but `recent_products` was never written. The fix reads the authoritative `state.products` populated by `shared-tools.server.ts` instead of depending on internal SDK result structure. If new code walks `steps`, `toolResults`, or `.result`, treat it as suspect and check the installed AI SDK shape first.

2. **WhatsApp channel memory was not continuous for identified customers.**

   Agent-created cart/search state could be lost on the next turn when only durable customer memory was updated. The fix writes channel continuity to the phone-keyed WhatsApp memory for every customer and enriches Shopify metafield memory separately when a customer is identified. Keep these two scopes distinct.

3. **Unsupported inbound media caused silent dead air.**

   The webhook previously returned `200 OK` whenever it could not extract text or a supported button/list payload. Images, videos, voice notes, stickers, and locations therefore produced no reply. The fix detects the unsupported `msg.type` after merchant lookup and sends an honest capability message before rate/billing/agent work. Do not add a new inbound type by merely returning `200`; either parse it or acknowledge the limitation.

4. **One missing product image invalidated an entire Meta carousel.**

   Meta rejects the whole carousel if any card lacks its required media header. The old code attempted the carousel whenever products existed, even when one `image_url` was missing. The fix checks every card first and falls back directly to text. Any future batch API should validate the whole batch before sending; do not rely on partial acceptance.

5. **A forced “narrow it down” follow-up added noise.**

   Search results are intentionally capped at three. Sending a generic refinement prompt after every multi-product answer made the useful answer feel delayed and disconnected. The forced follow-up was removed; the agent’s answer can invite a relevant follow-up naturally.

6. **Product attributes were conflated.**

   A real customer asked about colors, and the agent treated color-coded resistance levels as color options. The prompt now requires `get_product` and a genuine Color option before answering a color question. Resistance level, color photos, and “color-coded” prose are not evidence of color variants.

7. **Loose search matches were presented as exact category matches.**

   Shopify catalog search can return related products, not only exact matches. The prompt now requires the title/type to support an exact-category claim; otherwise the response must call it a closest alternative or say the exact item was not found.

8. **An incomplete UCP profile looked valid locally but made Global Catalog return no products.**

   The first app-owned `/.well-known/ucp-agent.json` advertised capabilities but omitted the required `ucp.services` shopping-service metadata and `payment_handlers`. Shopify returned HTTP 422 (`profile_malformed`). `searchGlobalCatalog()` caught that discovery error and converted it to `[]`, so the agent misleadingly said it could not find products. The profile now includes the required fields and the same headphone query returns real listings. For this bug pattern, validate the hosted profile against the remote MCP endpoint and distinguish catalog-unavailable errors from a genuine zero-result search; never silently map both to the same customer message.

9. **Onboarding could be completed by bypassing the UI.**

   The client disabled the final button until WhatsApp was connected, but a direct POST could skip that check. The final onboarding action now re-reads `waConnectedAt` server-side before completing setup. UI gating is not authorization.

10. **Demo credential seeding assumed a Merchant row already existed.**

   `seed-wa-test.ts` used `update`, which failed in a fresh local database. It now uses `upsert`, sets the `surge` plan to avoid a ten-message free-plan cap interrupting a rehearsal, and sets `isGlobalConcierge=true` so a fresh seed cannot silently route the test number into the old per-merchant branch.

11. **Global Concierge product text duplicated the product cards.**

   The agent naturally listed product names, prices, and sellers in its text reply, after which the webhook sent the same data again in image/CTA messages. The webhook now replaces that text with one concise handoff sentence whenever product cards are present. Keep the product facts in the cards, where the seller checkout action is attached.

12. **A contextual product selection could become a text-only dead end.**

   The agent could identify “the cheapest one” from the last result context but returned no `products` array, so the webhook had no checkout CTA to send. The agent now maps supported selectors (cheapest, most expensive, first/second/third) back to the last real listing and emits its seller card.

13. **Semantic catalog ranking could violate an explicit budget.**

   A Global Catalog query containing “under $100” once returned a $219 related headphone. The concierge now parses explicit ceilings/ranges and filters returned prices before presenting anything. This is a final correctness guard, not a replacement for catalog search.

14. **Global Concierge persistence was fire-and-forget.**

   The conversation and tool trace were scheduled asynchronously, which could lose the turn if a short-lived process exited immediately after the webhook response. The Global Concierge Postgres upsert is now awaited; the Redis session remains the fast path, with Postgres restoration on a cache miss.

15. **A cross-seller carousel cannot use each seller’s raw checkout URL as one approved template base.**

   Meta media-card carousel templates are marketing templates that must be approved before sending, and their URL button base is part of the approved template. Global Catalog results can point to unrelated seller domains. The optional carousel path therefore stores each HTTPS seller checkout URL behind a short-lived Redis token and sends the token through the approved `/go/{{1}}` URL; the redirect route validates HTTPS before handing off. Without an approved template, the runtime uses the no-approval sequential CTA fallback.

## Architecture decisions

- **Global-first demo, with both modes retained.** The new concierge is isolated because reusing `runWhatsAppAgent` would incorrectly expose one merchant’s cart, discounts, and order history to a store-agnostic customer.
- **No LangChain, LangGraph, or “deepagents.”** The existing Vercel AI SDK single-call/multi-tool loop keeps the normal turn within a roughly single-digit-second latency target. A future deep comparison should use bounded parallel tool calls plus synthesis, not add a sequential multi-agent framework without evidence that the latency tradeoff is acceptable.
- **No fake unified cart or cross-seller checkout.** Shopify’s current Global Catalog results belong to independent sellers and expose seller-owned checkout URLs. Separate seller handoffs are the truthful customer experience.
- **Azure remains the LLM provider.** The project already has Azure credits and `app/lib/llm.server.ts` abstracts the provider behind an OpenAI-compatible interface. Do not switch providers as cleanup.
- **Storefront MCP remains the per-merchant catalog source.** It provides live catalog data instead of a stale local product index. Global Catalog is used only by the concierge as primary search and by the merchant mode as an explicit fallback.
- **Redis is the fast state/guardrail path; Prisma is durable state.** Usage and session deduplication depend on Redis for correct behavior and have a degraded Prisma fallback. Avoid assuming that the fallback preserves per-session deduplication during a Redis outage.
- **Redis is the fast state/guardrail path; Prisma is durable state.** Usage and session deduplication depend on Redis for correct behavior and have a degraded Prisma fallback. Global Concierge also keeps compact phone-keyed preference/result memory in Redis and restores its transcript from Prisma after session expiry. Avoid assuming that the fallback preserves per-session deduplication during a Redis outage.

## Exact go-live runbook

### 1. Prepare the database and public profile

1. Confirm the production `DATABASE_URL` and `REDIS_URL` point to the intended services.
2. Run the migration path used by the deployment (`npm run setup`, or `prisma migrate deploy` in the container). Confirm the `Merchant.isGlobalConcierge` column exists.
3. Deploy the app at a stable public HTTPS URL. The quick MVP does not need Shopify OAuth or an installed Shopify store for its product logic, but the current monolith imports Shopify’s SDK at startup. A plain `npm run build && npm start` deployment therefore still needs non-empty `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, and `SHOPIFY_APP_URL` initialization values until that coupling is removed. Do not use a fake secret in a real production deployment; either provide the real Shopify app values or split/lazy-load the Shopify app module.
4. Confirm `https://<public-url>/.well-known/ucp-agent.json` returns the profile JSON without authentication or redirects if using the app’s own profile. Alternatively, keep `GLOBAL_CATALOG_AGENT_PROFILE_URL` pointed at Shopify’s public sample profile for the first MVP test. The Global Catalog request itself only needs `meta.ucp-agent.profile`; it does not need `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, or a Shopify Admin access token. [Shopify Global Catalog MCP documentation](https://shopify.dev/docs/agents/catalog/global-catalog)

5. A Meta submission is not required for this dev-only MVP if the carousel env vars are left unset: the app uses the working sequential seller CTA cards. If you choose to test the swipeable carousel itself, Meta’s Cloud API still treats it as a Marketing template, so create/approve the template in the developer WABA first (this is a template prerequisite, not a production launch step). Use the exact component shape in `sendGlobalCatalogCarouselTemplate()`: one BODY variable, and every card with an IMAGE header, one BODY text variable, and one dynamic URL button. Set the button URL base to `https://<stable-public-domain>/go/{{1}}`, then set `WA_MEDIA_CAROUSEL_TEMPLATE_NAME` and optionally `WA_MEDIA_CAROUSEL_TEMPLATE_LANGUAGE`. Review Meta’s [Media Card Carousel Templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/media-card-carousel-templates) documentation.

### 2. Configure Meta

From Meta App Dashboard → WhatsApp → API Setup, obtain:

- `WHATSAPP_APP_ID`
- `WHATSAPP_APP_SECRET`
- `WA_TEST_PHONE_NUMBER_ID`
- `WA_TEST_ACCESS_TOKEN`
- `WA_TEST_PHONE_DISPLAY`

Choose a real random `WHATSAPP_VERIFY_TOKEN`. Put it both in the runtime environment and in Meta’s webhook configuration. Replace the local placeholder `WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN`; the placeholder is only for the signed local harness and is not live Meta authentication.

### 3. Seed the correct Merchant row

`npm run demo:seed-whatsapp` requires these variables, including `WA_TEST_SHOP_DOMAIN`:

```text
WA_TEST_PHONE_NUMBER_ID
WA_TEST_ACCESS_TOKEN
WA_TEST_PHONE_DISPLAY
WA_TEST_SHOP_DOMAIN
```

The script upserts the credentials, sets `plan: "surge"`, and sets `isGlobalConcierge = true`. Verify all of these values before messaging:

```text
waPhoneNumberId matches Meta’s phone number ID
waAccessToken is the encrypted token written by the seed script
isGlobalConcierge = true
plan is not free for a live demo
```

Do not accidentally seed the test number against the old per-merchant branch.

### 4. Register and test the webhook

1. Point Meta’s webhook URL to `https://<public-url>/api/whatsapp/webhook`.
2. Subscribe to the `messages` field.
3. Complete Meta’s GET verification handshake and confirm HTTP 200 with the challenge.
4. Send a real text message from an allowed phone to the test number.
5. Confirm the message reaches the Global Concierge branch, receives a text reply, and receives seller-owned `View & Buy` CTA messages.
6. Open a CTA and confirm it lands on the seller checkout URL.
7. Test one unsupported image message and confirm the honest no-vision response.
8. Compare the live behavior with the local harness output. If the harness works and Meta does not, investigate only the Meta/public URL/credentials layer first.

The existing `npm run dev` command invokes `shopify app dev`, which is useful for the embedded Shopify app but is not required for the Global Concierge MVP. A separate public tunnel can expose the plain Node server instead, but the current bundle still needs the Shopify SDK’s startup configuration described above. Shopify’s CLI documentation also supports bringing your own tunnel with `--tunnel-url`. [Shopify app dev documentation](https://shopify.dev/docs/api/shopify-cli/app/app-dev) [Shopify networking options](https://shopify.dev/docs/apps/build/cli-for-apps/networking-options)

## Reusable commands

```bash
# Local Postgres (the compose file maps host 5433 → container 5432)
docker compose -f docker-compose.dev.yml up -d

# Generate client and apply local migrations
npm run setup

# Automated checks
npm run test:unit
npm run typecheck
npm run build

# Real per-merchant terminal chat; uses live Storefront MCP where configured
npx tsx scripts/demo-repl.ts neonping-dev-a509ojgs.myshopify.com

# Real webhook action with only graph.facebook.com intercepted
npx tsx scripts/demo-webhook-test.ts "show me electric guitars"

# Full Global Concierge journey: memory, contextual selectors, Exa freshness, and buttons
npm run demo:concierge-journey

# Seed Meta test credentials
npm run demo:seed-whatsapp

# Trigger per-merchant cart recovery immediately
npm run demo:trigger-cart-recovery
```

Redis is not defined as a service in `docker-compose.dev.yml`. The original development machine had a native Redis server on `127.0.0.1:6379`; if local state appears broken, check the configured `REDIS_URL` and `redis-cli ... ping` before adding another container on the same port.

The real-model eval suite is separate from the normal test gate. Run `npm run eval` manually after prompt changes; it skips when Azure credentials are absent and is intentionally not part of CI because it costs real tokens and is nondeterministic.

## Known gaps and honest demo boundaries

- **No vision support.** Images and videos receive an explicit limitation message; the agent cannot inspect a photo to answer a color or product question.
- **No cross-seller order tracking.** Global Concierge has no order history, refund authority, return authority, or account access across independent sellers. Customers must contact the seller they bought from.
- **No unified cross-seller cart or checkout.** Results are separate seller-owned handoffs, potentially one checkout per seller.
- **Global Catalog uses the first returned variant.** Cross-seller variant selection is not implemented in the concierge card flow; listings without a usable checkout URL are dropped.
- **The seed script now defaults `isGlobalConcierge` to true.** If an older database row is reused or manually changed, still verify the flag before testing.
- **Real Meta delivery is still outstanding.** Local harness tests intercept outbound Graph API calls, so they do not prove Meta credentials, webhook registration, number eligibility, or delivery.
- **Shopify credentials are not part of the direct Global Catalog → agent → Meta webhook path.** However, the current monolith initializes Shopify’s SDK globally at startup, so the server currently needs non-empty Shopify initialization values even when only the Global Concierge route is used. Remove that startup coupling before claiming a credential-free deployment.
- **Global Concierge state uses a synthetic partition key.** Code that assumes every `shopDomain` is a real Shopify domain can break this mode. Review billing, admin API, and GDPR code before reusing it for concierge records.
- **The old Azure URL is not a trusted production target.** Treat `https://neonping.politeocean-a6f0ef16.southcentralus.azurecontainerapps.io` as stale until independently checked.

## Key files

| File | Responsibility |
| --- | --- |
| `app/routes/api.whatsapp.webhook.tsx` | Meta GET/POST webhook, guardrails, mode branch, message sending |
| `app/lib/agents/global-concierge.server.ts` | Store-agnostic agent and prompt |
| `app/lib/agents/whatsapp.server.ts` | Per-merchant WhatsApp agent |
| `app/lib/agents/shared-tools.server.ts` | Shared catalog, policy, order, web-search, escalation tools |
| `app/lib/mcp/global-catalog.server.ts` | Shopify Global Catalog MCP adapter |
| `app/lib/mcp/client.server.ts` | Shared MCP JSON-RPC client and UCP profile injection |
| `app/lib/whatsapp.server.ts` | Meta Graph API message builders, including cross-store CTA |
| `app/lib/agents/memory.server.ts` | Redis/Shopify customer memory and abandoned-cart state |
| `app/lib/billing.server.ts` / `app/lib/plans.ts` | Usage gating and plan limits |
| `prisma/schema.prisma` | Merchant, conversation, session, and usage data model |
| `public/.well-known/ucp-agent.json` | Hosted UCP agent profile |
| `scripts/demo-webhook-test.ts` | End-to-end webhook harness with Meta calls intercepted |
| `scripts/seed-wa-test.ts` | Direct WhatsApp credential seeding via Merchant upsert |

## Environment notes

Never paste secret values into this document. The local `.env` contains machine-specific credentials and placeholders; `.env.example` is the safe variable-name reference. Important production variables are:

```text
DATABASE_URL
REDIS_URL
AZURE_FOUNDRY_BASE_URL or AZURE_OPENAI_RESOURCE_NAME
AZURE_OPENAI_API_KEY
AZURE_SPECIALIST_MODEL
EXA_API_KEY
ENCRYPTION_KEY
SESSION_SECRET
SHOPIFY_APP_URL                      # runtime initialization currently required; also used for own UCP profile/OAuth
SHOPIFY_API_KEY / SHOPIFY_API_SECRET # runtime initialization currently required; used for Shopify CLI/embedded app/OAuth
WHATSAPP_APP_ID
WHATSAPP_APP_SECRET
WHATSAPP_VERIFY_TOKEN
WA_TEST_PHONE_NUMBER_ID
WA_TEST_ACCESS_TOKEN
WA_TEST_PHONE_DISPLAY
WA_TEST_SHOP_DOMAIN
GLOBAL_CATALOG_AGENT_PROFILE_URL     # optional override; preferred for local testing
QSTASH_TOKEN                          # per-merchant delayed outbound jobs
RESEND_API_KEY                        # optional escalation/usage-alert email
```

The legal/privacy contact from the original project is `kaushik@neonping.com`. The old per-merchant dev store used in recorded tests is `neonping-dev-a509ojgs.myshopify.com`.
