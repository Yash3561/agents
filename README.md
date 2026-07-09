# NeonPing

AI-powered shopping assistant for Shopify. Engages customers on the web storefront via an embedded chat widget and on WhatsApp, helping them find products, manage their cart, and complete purchases.

Live on Azure Container Apps. Merchant portal is embedded in Shopify Admin.

---

## Features

### Web Chat Widget

- Sub-10KB bundle, injected as a Theme App Extension
- Proactive engagement: exit-intent (desktop) + 30-second time-on-page trigger (mobile)
- Real-time catalog search via Shopify UCP (Storefront MCP) — no stale synced data
- Interactive product cards (up to 3 per query) with add-to-cart buttons
- Discount and gift-card code application
- Abandoned-cart recovery: restores cart and personalised greeting
- Customer memory via Shopify metafields (`neonping_chat` namespace)
- Language auto-detect: replies in the customer's detected language

### WhatsApp Channel

- Inbound chat handled via Meta Webhooks (`/api/whatsapp/webhook`)
- Rich carousel replies for product searches (Meta Interactive Templates)
- Interactive cart view: itemised list with checkout CTA button
- Human handoff button when AI can't resolve the issue
- Language auto-detect

**Proactive outbound flows:**

| Trigger | Flow |
|---------|------|
| `checkouts/create` | Abandoned cart recovery message |
| `orders/fulfilled` | Order shipped with tracking URL |
| `orders/create` | Order confirmation + COD prepaid nudge (India) |

**Guardrails:**

| Guardrail | Implementation |
|-----------|---------------|
| Message dedup | Redis `wamsg:{id}`, 24hr TTL |
| Opt-out (STOP/START) | Redis `wa:optout:{phone}` |
| Per-phone rate limit | 20 msg/hr via Redis `wa:rl:{shop}:{phone}` |
| Billing gate | `checkAndIncrementUsage()` before every reply |
| Input sanitisation | Strip non-printable chars, 500-char cap |
| Jailbreak blocklist | 8 regex patterns + output safety filter + PII scrub |
| PII-free logging | SHA-256 phone hash, emails/phones redacted |

### Merchant Portal

- 4-step onboarding wizard
- Widget customisation: greeting, color, position, bot name, brand voice — with live preview
- Dashboard: AOV, cart-recovery rate, conversation volume
- Conversation history with search and transcript drill-down
- AI Config: custom FAQ/knowledge base, quick replies, chat playground
- Usage metering and plan limits

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React Router v7 + Polaris Web Components |
| Backend | Node.js / TypeScript |
| AI | Azure AI Foundry — `gpt-4o-mini` via `@ai-sdk/openai-compatible` |
| Database | Neon PostgreSQL (Prisma ORM) |
| Cache / rate-limit | Upstash Redis (`rediss://`) |
| Hosting | Azure Container Apps (consumption plan) |
| Storefront data | Shopify UCP / Storefront MCP (live, never stale) |

---

## Local Development

```bash
npm run dev -- --store neonping-dev-a509ojgs.myshopify.com
```

The tunnel URL changes on each restart. Use the `(p) Open app preview` shortcut from the dev terminal rather than navigating via the Shopify admin Apps list.

---

## Deployment

Azure Container Apps. Always build for `linux/amd64` (Mac M-series produces `arm64` by default).

```bash
# Increment the tag each deploy — Azure ignores :latest if the digest hasn't changed
docker build --platform linux/amd64 -t caab3198e06dacr.azurecr.io/neonping:v<N> .
az acr login --name caab3198e06dacr
docker push caab3198e06dacr.azurecr.io/neonping:v<N>
az containerapp update \
  --name neonping \
  --resource-group neonping-rg \
  --image caab3198e06dacr.azurecr.io/neonping:v<N>
```

Verify with `az containerapp revision list --name neonping --resource-group neonping-rg`.

Production URL: `https://neonping.politeocean-a6f0ef16.southcentralus.azurecontainerapps.io`

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `REDIS_URL` | Upstash Redis (`rediss://`) |
| `SHOPIFY_API_KEY` | App client ID |
| `SHOPIFY_API_SECRET` | App client secret |
| `SHOPIFY_APP_URL` | Public URL of this app (Azure URL in prod) |
| `ENCRYPTION_KEY` | 32-byte hex key for encrypting stored tokens |
| `WHATSAPP_VERIFY_TOKEN` | Meta webhook verify token |
| `WHATSAPP_APP_SECRET` | Meta app secret for HMAC signature verification |
| `AZURE_FOUNDRY_BASE_URL` | Azure AI Foundry `/openai/v1` base URL |
| `AZURE_OPENAI_API_KEY` | Azure AI Foundry API key |
| `AZURE_OPENAI_RESOURCE_NAME` | Azure AI Foundry resource name |
| `AZURE_ORCHESTRATOR_MODEL` | Model deployment name used for routing |
| `AZURE_SPECIALIST_MODEL` | Model deployment name used for shopping/support/etc. (e.g. `gpt-4o-mini`) |
| `RESEND_API_KEY` | Resend API key — escalation and usage-alert emails no-op without it |

---

## Key Files

| Path | Purpose |
|------|---------|
| `app/routes/api.chat.tsx` | Web chat entry point, rate-limit check, revenue tracking |
| `app/routes/api.whatsapp.webhook.tsx` | WhatsApp inbound webhook handler |
| `app/routes/webhooks.orders.*.tsx` | Proactive outbound order notification flows |
| `app/lib/agents/whatsapp.server.ts` | WhatsApp agent (tools + guardrails) |
| `app/lib/agents/whatsapp-formatter.server.ts` | Carousel copy formatter (Zod schema, char limits) |
| `app/lib/agents/memory.server.ts` | Customer memory via Shopify metafields |
| `app/lib/billing.server.ts` | Usage metering + plan limit enforcement |
| `app/lib/whatsapp.server.ts` | Meta API client (send messages, carousel templates) |
| `extensions/chat-widget/assets/neonping-widget.js` | Storefront widget (minified, verify size after changes) |
| `app/routes/app.settings.tsx` | Merchant widget config UI + live preview |
| `shopify.app.toml` | App config, webhook subscriptions |

---

## Notes

- Storefront MCP tier does not support Order MCP — order lookup requires Customer Account API credentials (not yet wired).
- WhatsApp carousel templates are blocked for US +1 numbers during Meta's marketing template pause; tracked in issue [#152](https://github.com/NeonPing/agentic-commerce/issues/152).

---

## Documentation map

- **This file** — public-facing overview: features, stack, deploy steps, key files.
- **[CLAUDE.md](./CLAUDE.md)** — the maintained source of truth for session continuity, current build state, and operational runbooks. Read this first in any new working session.
- **[SECURITY.md](./SECURITY.md)** — vulnerability disclosure policy.
- **GitHub Project board** — https://github.com/orgs/NeonPing/projects/1 — source of truth for what's open/closed/blocked.

There is intentionally no separate architecture/implementation-plan document: the codebase (`app/lib/prompt.server.ts` for agent prompts, `app/lib/agents/` for agent logic, `prisma/schema.prisma` for data model) is the source of truth for how the system actually works, and CLAUDE.md is the single maintained doc for everything else. A prior set of architecture docs (`AGENT_ARCHITECTURE.md`, `ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md`, `SESSION_STARTER.md`) described an early design (a 5-agent orchestrator pipeline, since replaced by the single unified agent in `unified.server.ts`) and had drifted into contradicting the real code — including wrong Shopify OAuth scopes and a nonexistent file path. They were removed rather than fixed in place to avoid re-accumulating the same drift.
