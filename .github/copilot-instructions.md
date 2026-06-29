# NeonPing — Copilot Instructions

## Stack
React Router v7, Node/TypeScript, Shopify Embedded App, Neon PostgreSQL (Prisma ORM),
Upstash Redis (ioredis), Azure Container Apps. AI via Azure AI Foundry (gpt-4o-mini).

## Critical rules
- UI components are Shopify web components with `s-` prefix: `s-page`, `s-section`,
  `s-badge`, `s-button`, `s-table`, `s-banner`. **Never** import from `@shopify/polaris`.
- Run `npx tsc --noEmit` before declaring TypeScript work done. No output = clean.
- Widget bundle must stay under 10KB after any change to
  `extensions/chat-widget/assets/neonping-widget.js`. Verify with `wc -c`.
- Never commit `.env`. Never hardcode secrets or API keys.
- All money values: `cartValue` stored in dollars, `orderRevenueCents` in cents. Be explicit.

## Key file locations
- AI agents: `app/lib/agents/` (orchestrator, shopping, support, personalization, memory, whatsapp)
- Billing/limits: `app/lib/billing.server.ts` — `checkAndIncrementUsage()`
- MCP tools: `app/lib/mcp/` (catalog, cart, admin, discounts)
- WhatsApp: `app/routes/api.whatsapp.webhook.tsx` + `app/lib/whatsapp.server.ts`
- Merchant UI routes: `app/routes/app.*.tsx`
- Widget (minified, manual build): `extensions/chat-widget/assets/neonping-widget.js` — do NOT touch

## Do not touch without human review
- Any file matching `app/routes/auth*` or `shopify.server.ts`
- `shopify.app.toml`
- `Dockerfile`
- `app/lib/billing.server.ts` (billing path — requires human verification against live store)
- `.github/` directory itself

## Test command
```
npx tsc --noEmit
npm run lint
```
No unit test suite yet — TypeScript clean + lint passing is the acceptance gate.

## Deployment (for context only — do not attempt in PR)
Docker build → push to Azure Container Registry → `az containerapp update`.
Always use `--platform linux/amd64` and a versioned tag.
