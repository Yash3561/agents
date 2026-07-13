# NeonPing — Context & Continuation Guide

**Last updated**: 2026-06-29  
**Status**: ✅ Live on Azure Container Apps, merchant portal fully working, ready for feature work  
**Model default**: Sonnet 4.6

## Quick Start for New Sessions

### Continuation from Previous Session
1. **Production URL**: https://neonping.politeocean-a6f0ef16.southcentralus.azurecontainerapps.io
2. **Access merchant portal**: Go directly to `https://admin.shopify.com/store/neonping-dev/apps/d1ed7250a107b38802ff74de11f699f3` — NO tunnel needed, Azure is live
3. **If portal won't load**: Hit `https://neonping.politeocean-a6f0ef16.southcentralus.azurecontainerapps.io/auth?shop=neonping-dev-a509ojgs.myshopify.com` to force fresh OAuth
4. **Memory/context**: Read `/Users/krkaushikkumar/.claude/projects/-Users-krkaushikkumar-Desktop-neonping/memory/project_neonping.md` first

### GitHub Board
- Board: https://github.com/orgs/NeonPing/projects/1
- Repo: https://github.com/NeonPing/agentic-commerce (private)
- Keep this updated as you work (standing instruction from user)

---

## Current State (as of 2026-06-16)

### ✅ Built & Verified (Live or Code-Reviewed)
- **Merchant portal on Azure**: Fully working — no tunnel needed. Auth redirect bug fixed (`app._index.tsx` now passes Shopify query params when redirecting to onboarding). Docker image must be built with `--platform linux/amd64`. Current live image tag: `v20260624-18`.
- **Core MCP/agents**: Orchestrator → Shopping/Support/Personalization/Memory agents (all gpt-4o-mini on Azure AI Foundry)
- **Storefront widget**: Fully functional, <10KB bundle, live proactive engagement (exit-intent desktop + 30s time-on-page mobile), with suppression flag fix
- **Revenue attribution**: Conversation persistence, orders/paid webhook tracking
- **Personalized greeting**: Customer-aware, pulls recent_products memory
- **Abandoned-cart recovery**: Triggered via `orders/abandoned_checkout` webhook
- **Interactive product cards**: Real Shopify catalog search via UCP (hard-capped at 3 results per query)
- **Smart shopping**: `intent` (budget/context) + `maxPriceCents` populated, discount/gift-card codes wired through
- **Rate limiting**: Plan-based (free/trial/starter 500/mo, growth 2000/mo, pro unlimited), Redis fast-path + Prisma backup, fails open
- **Widget Settings UI**: Merchant can customize greeting/color/position, **live preview added** (#51, tsc-clean)
- **Merchant Dashboard**: AOV + cart-recovery-rate KPIs computed and displayed
- **Onboarding wizard**: 3-step setup flow (brand identity → WhatsApp connect → plan)
- **GDPR webhooks**: `customers/data_request`, `customers/redact`, `shop/redact` — compliance_topics TOML field used correctly (bug fixed in e087e1a)
- **Webhook failure rate fixed**: Was 97.7% failure. Root causes fixed in 6deb7e6: wrong topic string in `subscriptions_update` handler (checked "app/subscriptions/update" but Shopify lib normalizes to "APP_SUBSCRIPTIONS_UPDATE"), invalid api_version "2026-07" in TOML (changed to "2026-04"), missing try/catch in 4 handlers. All 7 endpoints now return 200 OK.
- **Privacy/ToS pages**: Draft content with legal disclaimer, contactable via kaushik@neonping.com
- **Billing core**: `checkAndIncrementUsage()` with live Redis limit checks (stale-count bug found and fixed)

### 🔄 Open/Pending

**#49 — recent_products memory**: Code correct (verified by review), extracting real `merchandise.title` from cart lines. **Not live-verified** (blocked by PII permission boundary when trying to pull real customer data). Left intentionally open rather than closed — code is good, just needs either live testing with user authorization or explicit user sign-off to trust code review only.

**#50 — 80% usage-warning email**: Not built — no email service exists in codebase. Blocked on provider choice (e.g., Resend). Part of #28 spec, split out as separate issue.

**#77 — Shopify Billing API (end-to-end wiring)**: Not started. #27 (closed) scaffolded the infrastructure; #77 wires real Shopify `appSubscriptionCreate`, plan write-back, and UI subscribe buttons. Blocks real plan assignment (all merchants default to `plan: "free"` today). Copilot agent spec added — ready to assign.

**#31, #34, #37, #39, #42**: Not started (Sentry, E2E tests, App Store listing, security review, Order MCP).

### ⚠️ Known Intentional Limits
- `search_catalog` hard-capped at 3 results (tied to widget UI showing max 3 cards, not a Shopify limit)
- No vector search or recommendation engine (retrieval + reasoning over Shopify's native ranking)
- Proactive engagement desktop-only (exit-intent needs mouse events)
- Order MCP unavailable on Storefront MCP tier (requires Dev Dashboard credentials)

---

## Stack & Architecture

```
Frontend: React Router v7 + Polaris web components (s-page/s-section/etc., NOT @shopify/polaris)
         ⚠️  Component names use s- prefix: s-page, s-section, s-badge, s-button, s-table, s-banner
             DO NOT use @shopify/polaris React components — they are NOT installed
Backend: Node.js/TypeScript, Shopify Embedded App + Theme App Extension
AI: Azure AI Foundry /openai/v1 (gpt-4o-mini for all agents, @ai-sdk/openai-compatible)
DB: Neon PostgreSQL (Prisma ORM)
Cache: Upstash Redis (rediss://)
Hosting: Azure Container Apps (consumption-based, ~$5/mo for ACR registry)
Dev store: neonping-dev-a509ojgs.myshopify.com
Customer data namespace: neonping_chat (metafields)
```

### Key Technical Decisions (Don't Change Without Asking)
- **Storefront MCP only** (not Admin API) — live, always-fresh catalog queries, no hallucination from stale synced data
- **Intent + maxPriceCents** populated in every catalog search (UCP context fields for better ranking)
- **Redis as source of truth** for usage limits (Prisma is durable backup, Redis errors fail open)
- **No complete_checkout tool** — Shopify's hosted checkout is the real confirmation gate, buyer_confirmed code removed
- **2000-char message cap** on `/api/chat` (guardrail)
- **Widget bundle <10KB** (Shopify size limit) — every change verified via `wc -c`

---

## How to Deploy/Update

### Standard Deploy (for code changes)
```bash
# ALWAYS use --platform linux/amd64 (Mac M-series builds arm64 by default, Azure runs amd64)
# ALWAYS use a versioned tag — Azure ignores :latest if the digest hasn't changed
docker build --platform linux/amd64 -t caab3198e06dacr.azurecr.io/neonping:v4 .
az acr login --name caab3198e06dacr
docker push caab3198e06dacr.azurecr.io/neonping:v4
az containerapp update --name neonping --resource-group neonping-rg --image caab3198e06dacr.azurecr.io/neonping:v4
```
Increment the version tag (v4 → v5 → etc.) each time. Check `az containerapp revision list` to confirm new revision is Healthy.

`.env` is already in `.dockerignore` — secrets come from Azure env vars only. ✅

### If Azure URL Changes
1. Update `shopify.app.toml`:
   ```toml
   application_url = "https://neonping.politeocean-a6f0ef16.southcentralus.azurecontainerapps.io"
   redirect_urls = ["https://neonping.politeocean-a6f0ef16.southcentralus.azurecontainerapps.io/auth/callback"]
   ```
2. Run: `shopify app deploy`
3. Verify webhooks registered and reachable

### Environment Variables (Already Set on Azure)
All required vars should already be configured on the Azure Container App. If deploying fresh:
- `DATABASE_URL` (Neon)
- `REDIS_URL` (Upstash)
- `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`
- `SHOPIFY_APP_URL`
- Azure AI Foundry credentials

### Cost Snapshot
- **Azure Container Apps**: Perpetual free allowance (~180k vCPU-sec/month) — this app won't exceed it
- **Azure Container Registry**: ~$5/month (smallest tier)
- **Neon DB + Upstash Redis**: Within free tier
- **Total**: ~$5/month, $300 credit covers 5+ years

---

## Running Dev

```bash
cd /Users/krkaushikkumar/Desktop/neonping
npm run dev -- --store neonping-dev-a509ojgs.myshopify.com
```

### Type-check (no build needed)
```bash
npx tsc --noEmit
```
Run this before deploying. No output = clean.

**Note**: Tunnel URL changes on each restart. If embedded app login fails:
1. Use `(p) Open app preview` from the dev terminal instead of navigating via Apps list manually
2. Try incognito window
3. Restart dev session if it's been running a while

---

## Permission Boundary

**Don't query real customer PII (emails, customer lists) via Admin GraphQL for debugging without explicit user authorization**, even if it would make testing easier. The permission system will (correctly) block this. Ask the user first, or find a PII-free verification path.

---

## Persistent Memory & Planning

- **Session memory**: `/Users/krkaushikkumar/.claude/projects/-Users-krkaushikkumar-Desktop-neonping/memory/project_neonping.md`
  - What's built, what's open, what's blocked
  - Known recurring issues (e.g., "accounts.shopify.com" login troubleshooting checklist)
  - Why various decisions were made
  - **Read this first in any new session**

- **Working plan**: `~/.claude/plans/keen-hopping-mccarthy.md`
  - Current feature reasoning and research
  - May be outdated if work has progressed — check with user if in doubt

- **GitHub Project Board**: https://github.com/orgs/NeonPing/projects/1
  - Source of truth for what's closed, what's open, what's next
  - Keep this in sync as you work

---

## What's Next? (Candidates)

**Ask the user or do a fresh pass.** Don't assume any of these is already decided. Options include:
- **Live-verify #51** (Settings widget preview) — needs real embedded admin session; code is tsc-clean
- **Live-verify #49** (recent_products memory) — same; code is reviewed; either way, update GitHub issue status
- **#27 (Shopify Billing API)** — unblocks plan assignment for #28
- **#50 (usage warning email)** — blocked on provider choice
- **Mobile proactive trigger verification** — code is in the widget, needs real browser testing
- **Security review prep (#39)** — code audit, dead-code cleanup already done, could formalize
- **E2E tests (#34)** — infrastructure
- **App Store listing (#37)** — copy + images, positioning on "never syncs = no stale data" advantage

---

## Files You'll Touch Often

- `app/routes/app.settings.tsx` — merchant config UI (live preview component here)
- `extensions/chat-widget/assets/neonping-widget.js` — storefront widget (minified, always verify size)
- `app/lib/agents/` — orchestrator, shopping/support/personalization/memory agents
- `app/lib/mcp/` — catalog.server.ts, cart.server.ts (Shopify UCP integration)
- `app/lib/billing.server.ts` — usage metering + plan limits
- `app/routes/api.chat.tsx` — message entry point, rate-limit check, revenue tracking
- `shopify.app.toml` — app config, webhook subscriptions (compliance_topics for GDPR)
- `.env.local` — local dev secrets (DATABASE_URL, REDIS_URL, Azure AI keys)

---

## Quick Diagnostic Checklist

**"shopify app dev" won't start?**
- Check `shopify.app.toml` for `compliance_topics` field (not `topics`) on GDPR webhooks

**Merchant portal shows blank page or "refused to connect"?**
- The app runs on Azure — no tunnel needed
- If the iframe is loading a dead Cloudflare URL: the partner dashboard cached the tunnel. Go to `partners.shopify.com` → Apps → NeonPing → Configuration and verify App URL is the Azure URL. Then uninstall/reinstall the app on the dev store.
- If `accounts.shopify.com refused to connect` in iframe: OAuth is trying to load inside the iframe. Hit the auth URL directly (`https://[azure-url]/auth?shop=neonping-dev-a509ojgs.myshopify.com`) to trigger a top-level OAuth flow.
- **Root cause of auth redirect loop** (already fixed in code): `app._index.tsx` was stripping Shopify query params (`host`, `embedded`, `id_token`) when redirecting to `/app/onboarding`. Fixed by using `url.searchParams.toString()` in the redirect. Don't revert this.

**Docker build fails or Azure container crashes with "exec format error"?**
- You're on Apple Silicon (arm64). Always build with `--platform linux/amd64`.
- Always use a versioned tag (`:v4`, `:v5`) not `:latest` — Azure won't pull a new image if the tag hasn't changed.

**Widget not showing live config changes?**
- Verify `api/widget-config` endpoint returns the saved values
- Check localStorage — widget pulls config on init, may be cached

**Rate limiting not working?**
- Confirm REDIS_URL is set and reachable
- Check `checkAndIncrementUsage()` is being called from `api.chat.tsx`
- Verify plan value in database (should default to "free")

---

## Contact & Reporting

- **Issues/bugs**: GitHub issues in the board
- **Legal/privacy**: kaushik@neonping.com
- **Session continuity**: This file + memory file + git history

---

## Session Notes

- User switched to **Sonnet 4.6** as default model (2026-06-17)
- **App is live on Azure, merchant portal verified working** — no tunnel needed, access via Shopify admin directly
- **Kanban must stay updated** — non-negotiable standing instruction
- **Code review is valid verification** for features blocked by PII boundaries (e.g., #49) if user explicitly approves
- **Next priority**: #27 Shopify Billing API, then live-verify #51/#49/mobile trigger

---

Good luck! 🚀
