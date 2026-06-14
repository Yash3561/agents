# NeonPing — Multi-Agent Architecture
*Azure-native. Channel-agnostic core. Shopify widget today. WhatsApp/iMessage tomorrow.*

---

## Stack Decision Summary

| Layer | Choice | Why |
|-------|--------|-----|
| Orchestrator LLM | GPT-4o (Azure OpenAI) | Complex routing logic needs best reasoning |
| Specialist LLMs | GPT-4o-mini (Azure OpenAI) | 17× cheaper than GPT-4o, more than capable for focused tasks |
| Hosting | Azure Container Apps | Scales to zero, pay per request — cheap at low volume, handles spikes |
| Database | Azure Database for PostgreSQL Flexible Server (Burstable B1ms) | Prisma-native, ~$15/mo at launch, no migration needed when we scale |
| LLM Router | Azure AI Foundry Prompt Flow | Routes by complexity, enables A/B testing models, centralized logging |
| Storage (blobs) | Azure Blob Storage | Widget JS bundle, product image caching |
| Cache | Azure Cache for Redis | Conversation state, MCP endpoint cache, repeat query results |

**Not using:** Azure Functions (cold start kills SSE streaming), Cosmos DB (overkill + more expensive than PostgreSQL at our scale), SQL Server (Prisma overhead).

---

## The 5 Agents

```
CHANNEL (widget / whatsapp / imessage)
        │
        ▼
   NORMALIZER  ──► InboundMessage (standard format)
        │
        ▼
 ┌─────────────────────────────────────────────────┐
 │              ORCHESTRATOR AGENT                  │
 │              GPT-4o via Azure OpenAI             │
 │                                                  │
 │  • Reads conversation history                    │
 │  • Classifies intent                             │
 │  • Gates checkout confirmation                   │
 │  • Assembles final response from specialists     │
 │  • Max 3 specialist hops per turn                │
 └──────────────┬────────────────┬──────────────────┘
                │                │
     ┌──────────▼──────┐ ┌───────▼──────────────┐
     │ SHOPPING AGENT  │ │   SUPPORT AGENT       │
     │ GPT-4o-mini     │ │   GPT-4o-mini         │
     │                 │ │                       │
     │ • search_catalog│ │ • search_policies_faq │
     │ • create_cart   │ │ • get_order           │
     │ • update_cart   │ │ • get_customer_orders │
     │ • create_checkout│ │                      │
     │ • complete_chkout│ │                      │
     └──────────┬──────┘ └───────────────────────┘
                │
     ┌──────────▼────────────────────────────────┐
     │         PERSONALIZATION AGENT              │
     │         GPT-4o-mini                        │
     │                                            │
     │  • Read customer tags (Admin GraphQL)       │
     │  • Create one-time discount codes           │
     │  • Detect VIP, repeat buyer, high-value     │
     │  • Suggest reorders from order history      │
     └──────────┬─────────────────────────────────┘
                │
     ┌──────────▼────────────────────────────────┐
     │           MEMORY AGENT                     │
     │           No LLM — deterministic logic     │
     │                                            │
     │  • Read customer metafields (preferences)  │
     │  • Write conversation summary after turn   │
     │  • Inject context into orchestrator prompt │
     └────────────────────────────────────────────┘
                │
                ▼
         RENDERER (per channel)
         → SSE product cards (widget)
         → Plain text + links (WhatsApp)
         → Rich bubbles (iMessage)
```

---

## Agent 1 — Orchestrator

**Model:** `gpt-4o` (Azure OpenAI deployment: `neonping-orchestrator`)

**Called:** Once per conversation turn. The only agent that sees the full history.

**Inputs it receives:**
```typescript
{
  conversation_history: Message[],   // last 20 turns max
  current_message: string,
  customer_memory: {                 // from Memory Agent (pre-fetched)
    preferences?: object,
    last_search?: string,
    conversation_summary?: string,
    abandoned_cart?: { items: [], value: number }
  },
  merchant_context: {
    shop_domain: string,
    plan: "free" | "starter" | "pro",
    brand_voice: string,
    widget_greeting: string
  },
  session: {
    cart_id?: string,
    checkout_id?: string,
    buyer_confirmed?: boolean       // set only after explicit "yes, checkout"
  }
}
```

**What it outputs (structured JSON, not free text):**
```typescript
{
  route: "shopping" | "support" | "personalization" | "direct",
  route_reason: string,          // logged for analytics
  context_for_specialist: string, // refined prompt for the specialist
  buyer_confirmed: boolean,       // gate for complete_checkout
  direct_response?: string        // if route = "direct" (e.g. greetings, unclear)
}
```

**Guardrails:**
- `buyer_confirmed` can only be set to `true` if the conversation history contains an explicit "yes", "checkout", "proceed", "buy it", "place order" — not implied
- Max 3 hops: if specialist fails twice → orchestrator generates "I'm having trouble with that, here's a direct link" response
- Token budget per turn: 2000 input + 500 output (enforced at Azure AI Foundry level)
- Timeout: 8 seconds → fallback to graceful error message

---

## Agent 2 — Shopping Agent

**Model:** `gpt-4o-mini` (Azure OpenAI deployment: `neonping-shopping`)

**Called:** Every time customer wants products, cart actions, or checkout.

**MCP tools it can call:**
```
Storefront Catalog MCP:
  search_catalog       → find products by query + filters
  get_product          → full variant details when narrowing down

Cart MCP:
  create_cart          → new cart with initial items
  get_cart             → current cart state
  update_cart          → ALWAYS pass full line_items[] (full replace)

Checkout MCP:
  create_checkout      → converts cart to checkout, returns continue_url
  complete_checkout    → ONLY if orchestrator passes buyer_confirmed: true
```

**System prompt structure:**
```
You are a shopping assistant for {merchant_name}.
Your job: help customers find products, add them to cart, and complete purchase.

RULES:
1. Only return products that exist in search results — never invent specs/prices
2. Show max 3 products per search (not overwhelming)
3. Always show cart total before creating checkout
4. Never call complete_checkout unless buyer_confirmed is true in your input
5. If checkout returns requires_escalation → return continue_url immediately
6. If search returns empty → suggest rephrasing, offer categories
7. Currency: always show {currency} format from MCP response

Customer context: {customer_memory}
Cart state: {cart_id}, {cart_total}
```

**Guardrails:**
- `complete_checkout` call blocked at code level if `buyer_confirmed !== true`
- Product card maximum: 3 per turn
- Empty cart protection: cannot call `create_checkout` on empty cart
- Price display: always from MCP response, never computed or assumed
- If MCP call fails: retry once, then return "I'm having trouble loading products right now"

---

## Agent 3 — Support Agent

**Model:** `gpt-4o-mini` (Azure OpenAI deployment: `neonping-support`)

**Called:** Policies, FAQs, shipping questions, order tracking.

**MCP tools it can call:**
```
Policy & FAQs MCP:
  search_shop_policies_and_faqs   → return policy, shipping, FAQ

Order MCP:
  get_order(order_id)             → fulfillment status, tracking

Customer Accounts MCP (logged-in only):
  get_customer_orders()           → order history
```

**System prompt structure:**
```
You are a customer support assistant for {merchant_name}.
Answer questions about policies, shipping, and orders.

RULES:
1. Only use information from the policy/FAQ results — never invent policies
2. If policy answer is ambiguous → end with "For full details: {policy_url}"
3. If order not found → offer "Contact our support team"
4. Never modify any cart or order data — you are READ-ONLY
5. If customer asks about products → tell orchestrator to re-route to shopping
```

**Guardrails:**
- Zero write permissions — no MCP tools that modify state
- If policy tool returns empty → do not guess, return store contact info
- Order tracking: only return what `get_order` returns — no estimated dates beyond what MCP provides
- PII: mask email/address in any logs (handled at logging middleware level)

---

## Agent 4 — Personalization Agent

**Model:** `gpt-4o-mini` (Azure OpenAI deployment: `neonping-personalization`)

**Called:** When orchestrator detects opportunity — discount inquiry, VIP signal, or high cart value.

**Admin MCP tools it can call:**
```
admin_graphql(query)    → read customer tags, order count, order history
admin_graphql(mutation) → create one-time discount code (usageLimit: 1)
```

**Decision logic:**
```
IF customer.tags includes "VIP"        → create 15% off code
IF customer.order_count >= 3           → create 10% loyalty code
IF cart.total >= merchant.vip_threshold → create free shipping code
IF memory.abandoned_cart exists        → reference it ("still looking at X?")
ELSE                                   → return null (no discount, no fake offers)
```

**Guardrails:**
- Maximum discount: 20% (configurable per merchant in dashboard, default 15%)
- One discount per conversation — tracked in session state
- Discount codes: always `usageLimit: 1`, always `oncePerCustomer: true`
- Never surface a discount unless customer is actually eligible
- If Admin MCP fails: skip silently — personalization is enhancement, not core

---

## Agent 5 — Memory Agent (No LLM)

**No model call.** Pure TypeScript logic. Fast, free, deterministic.

**Reads/writes:** Customer metafields via Admin MCP
```
namespace: "auranod_chat"
access: PUBLIC_READ (readable from storefront)

keys:
  preferences    → { size: "M", color: "black", budget: "mid" }
  last_search    → "sleep supplements"
  summary        → "Repeat buyer. Bought wellness products 3x. Prefers bundles."
  abandoned_cart → { items: [], total: 0, timestamp: ISO8601 }
```

**When it runs:**
1. **Before orchestrator** — fetches customer memory, injects into context
2. **After each turn** — extracts new preferences from conversation, updates metafields

**What it extracts (hardcoded logic, no LLM):**
```typescript
// After a shopping turn, extract:
if (searchQuery) memory.last_search = searchQuery
if (addedToCart) memory.preferences = mergePreferences(cart.items)
if (conversationLength > 5) memory.summary = await summarize(history) // one GPT-4o-mini call
if (cartAbandoned) memory.abandoned_cart = { items, total, timestamp: now() }
```

**Guardrails:**
- Only reads/writes `auranod_chat` namespace — cannot access `app--`, Shopify native, or other app namespaces
- Max 2KB total per customer (Shopify metafield limit)
- GDPR delete: wipes entire `auranod_chat` namespace on customer data request
- Only stores logged-in customers (Customer Accounts MCP) or returning session IDs
- No PII stored: no email, no address, no payment data — only behavioral signals

---

## Azure AI Foundry — LLM Router

This is the key piece that makes multi-model routing clean. In AI Foundry, you set up a **Prompt Flow** that:

```
Request → Model Router → GPT-4o (orchestrator)
                      └→ GPT-4o-mini (specialists)

Router logic:
  agent_type == "orchestrator" → endpoint: neonping-orchestrator (gpt-4o)
  agent_type == "shopping"     → endpoint: neonping-shopping (gpt-4o-mini)
  agent_type == "support"      → endpoint: neonping-support (gpt-4o-mini)
  agent_type == "personalize"  → endpoint: neonping-personalization (gpt-4o-mini)
```

**Benefits:**
- Centralized rate limit management (per model, per merchant plan)
- Built-in usage logging → Azure Monitor → merchant analytics dashboard
- A/B testing: route 10% of orchestrator calls to gpt-4o-mini to compare quality
- Fallback: if GPT-4o is rate-limited → fallback to GPT-4o with lower token budget
- One Azure resource to manage, one cost line item

**AI Foundry deployments to create:**
```
Deployment Name           Model         TPM Limit
neonping-orchestrator      gpt-4o        100K
neonping-shopping          gpt-4o-mini   500K
neonping-support           gpt-4o-mini   200K
neonping-personalization   gpt-4o-mini   100K
auranod-summary           gpt-4o-mini   100K  (memory agent's summarization)
```

---

## Azure Infrastructure

### Resource Group Layout
```
Resource Group: rg-neonping-prod
│
├── Container Apps Environment: cae-neonping
│   └── Container App: ca-neonping
│       • Image: auranod-chat:latest (from ACR)
│       • Min replicas: 0 (scale to zero)
│       • Max replicas: 10
│       • CPU: 0.5 vCPU, Memory: 1Gi per replica
│       • HTTP scaling rule: 100 concurrent requests per replica
│
├── Azure Container Registry: acrneonping
│   └── Repo: auranod-chat (Docker images)
│
├── Azure Database for PostgreSQL Flexible Server: psql-neonping
│   • Tier: Burstable B1ms (1 vCPU, 2GB RAM)
│   • Storage: 32GB (auto-grow enabled)
│   • Cost: ~$15/mo
│   • Backup: 7-day retention (free)
│   • Upgrade path: B2ms → D2s_v3 when we need it
│
├── Azure Cache for Redis: redis-neonping
│   • Tier: Basic C0 (250MB, no replica)
│   • Cost: ~$16/mo
│   • Use: conversation state, MCP endpoint cache (1hr TTL), repeat query cache (5min TTL)
│   • Upgrade to Standard C1 when we need persistence + replica
│
├── Azure Blob Storage: stneonping
│   • Container: widget-assets (widget JS/CSS bundles — public CDN)
│   • Container: conversation-exports (GDPR data exports — private)
│   • Cost: pennies/mo at our scale
│
└── Azure AI Foundry Hub: aifh-neonping
    └── AI Foundry Project: aifp-neonping
        └── Deployments: (5 listed above)
        └── Prompt Flow: neonping-llm-router
```

### Why These Tiers
| Resource | Tier | Cost/mo | Upgrade Trigger |
|----------|------|---------|-----------------|
| Container Apps | Pay-per-use | $0-30 | Always (auto-scales) |
| PostgreSQL | Burstable B1ms | ~$15 | >100 merchants |
| Redis | Basic C0 | ~$16 | Need persistence/HA |
| Blob Storage | LRS | ~$1 | Never (auto-scales) |
| AI Foundry | Pay-per-token | Variable | — |
| **Total infra** | | **~$32-65/mo** | |

You break even on infra at **2 paying merchants** on Starter ($29 × 2 = $58). From merchant 3 onward, every new install is profit.

---

## Cost Per Conversation (Azure OpenAI Pricing)

GPT-4o: $2.50/1M input, $10/1M output
GPT-4o-mini: $0.15/1M input, $0.60/1M output

| Agent | Model | Avg tokens | Cost |
|-------|-------|-----------|------|
| Orchestrator | GPT-4o | 1,500 in + 400 out | $0.00375 + $0.004 = $0.0078 |
| Shopping | GPT-4o-mini | 2,000 in + 500 out | $0.0003 + $0.0003 = $0.0006 |
| Support | GPT-4o-mini | 1,000 in + 300 out | $0.00015 + $0.00018 = $0.0003 |
| Personalization | GPT-4o-mini | 500 in + 200 out | — called ~30% of turns only |
| Memory summary | GPT-4o-mini | 800 in + 200 out | — called ~20% of turns only |
| **Avg total** | | | **~$0.009/conversation** |

With prompt caching on Azure OpenAI (cached input = 50% off): **~$0.005/conversation**

**Margin table:**
| Plan | Price | Convos | LLM Cost | Infra Share | Net Margin |
|------|-------|--------|----------|-------------|------------|
| Free | $0 | 50 | $0.25 | subsidized | — |
| Starter | $29 | 500 | $2.50 | $5 | $21.50 (74%) |
| Pro | $79 | 2,000 | $10 | $10 | $59 (75%) |
| Agency | $199 | 10,000 | $50 | $20 | $129 (65%) |

---

## Channel Adapter Contract

The core agents never know what channel they're on. Only the adapters and renderers do.

### Inbound Standard Format
```typescript
interface InboundMessage {
  channel: "shopify_widget" | "whatsapp" | "imessage" | "web"
  shop_domain: string
  session_id: string
  customer_id?: string          // only if logged in via Customer Accounts MCP
  message: string
  context: {
    cart_id?: string
    checkout_id?: string
    current_page?: "product" | "collection" | "cart" | "home" | "other"
    locale: string              // "en-US"
    currency: string            // "USD"
    page_product_id?: string    // if on a product page → pre-load that product
  }
  capabilities: {
    rich_cards: boolean         // product image cards with buttons
    quick_replies: boolean      // tap-to-reply buttons
    images: boolean             // inline images
    streaming: boolean          // SSE streaming (widget only)
  }
}
```

### Outbound Standard Format
```typescript
interface OutboundMessage {
  text: string                  // ALWAYS present — fallback for every channel
  products?: ProductCard[]
  cart_summary?: {
    items: CartItem[]
    total: string               // formatted: "$47.00"
    currency: string
  }
  checkout_url?: string
  quick_replies?: string[]      // ["Add to cart", "See similar", "Checkout"]
  confidence: number            // 0-1. Below 0.6 → escalate to human
  escalate_to_human?: boolean   // support can set this
}
```

### Per-Channel Rendering

| Output type | Shopify Widget | WhatsApp (Month 4) | iMessage (Month 6) |
|------------|----------------|--------------------|--------------------|
| Product | Image card + ATC button | JPEG + link text | Rich bubble + Apple Pay |
| Cart | Slide-up summary drawer | Itemized text message | Interactive bubble |
| Checkout | "Proceed to Payment" → `continue_url` | Payment link in message | Apple Pay native sheet |
| Policy | Formatted text block | Plain text + link | Text + preview link |
| Quick replies | Tap buttons below response | Numbered list options | Tap chips |
| Streaming | SSE word-by-word | Not supported (send complete) | Not supported |

---

## Expanding to Other Channels

### Month 4 — WhatsApp

**What to add:**
```
app/adapters/whatsapp.server.ts     ← normalize WhatsApp message → InboundMessage
app/renderers/whatsapp.ts           ← OutboundMessage → WhatsApp message template
app/routes/webhooks.whatsapp.tsx    ← receive inbound WhatsApp webhooks
```

**What stays identical:** All 5 agents, all MCP tools, all guardrails, Postgres, Redis.

**Integration:** Twilio WhatsApp Business API or direct Meta WhatsApp Cloud API. Merchant connects their WhatsApp number in our dashboard → we store the phone number + WA credentials per merchant.

**Key difference:** No streaming (WhatsApp doesn't support SSE). Send complete message only. Rich cards become image + text + link.

### Month 6 — iMessage (Apple Business Chat)

**What to add:**
```
app/adapters/imessage.server.ts
app/renderers/imessage.ts
app/routes/webhooks.imessage.tsx
```

**Apple Pay integration:** When checkout is ready, renderer sends an Apple Pay request bubble. Customer taps → Apple Pay sheet → payment processed by Shopify Payments. Our `complete_checkout` is replaced by Apple Pay's native flow.

**Requirement:** Apple Business Register account for merchant. We handle the setup in our onboarding.

### Month 8 — Non-Shopify Web Chat

**What to add:**
```
app/adapters/web-generic.server.ts
app/renderers/web.ts
lib/mcp/external-catalog.server.ts   ← custom catalog adapter (not Storefront MCP)
```

**Key difference:** Non-Shopify merchants don't have Storefront Catalog MCP. We need a generic product search adapter (their API or a crawled index). The shopping agent gets a new tool: `search_external_catalog(endpoint, query, filters)`.

---

## Guardrails — Complete List

### Checkout Safety
```
1. complete_checkout requires buyer_confirmed: true (set only on explicit "yes, checkout")
2. Checkout not created on empty cart
3. If complete_checkout returns requires_escalation → always use continue_url
4. Never retry complete_checkout after failure — hand off to continue_url
5. Cart total always shown before checkout_create is called
```

### Content Safety
```
6. Products: only what MCP returns — no invented specs, prices, availability
7. Policies: only what policy MCP returns — no invented rules or dates
8. Orders: only what order MCP returns — no estimated dates beyond MCP data
9. Discounts: only created if customer is actually eligible (tag/order count check)
10. Max discount: 20% (configurable), one per conversation
```

### Cost Controls
```
11. Orchestrator token budget: 2000 in + 500 out per turn (Azure AI Foundry limit)
12. Specialist token budget: 3000 in + 600 out per turn
13. Max conversation turns: 50 (then "Start a new chat")
14. Repeat query cache: 5-min TTL in Redis (same merchant + same query → cached)
15. MCP endpoint cache: 60-min TTL (/.well-known/ucp not re-fetched every turn)
16. Free tier: 50 conversations/mo — enforced at api.chat.tsx entry, checked against Postgres counter
```

### Quality
```
17. Confidence < 0.6 → "I'm not sure about that — can you rephrase?"
18. Empty search results → suggest rephrasing, offer to browse categories
19. 3 failed agent hops → graceful fallback response with direct link to store
20. Max 3 products per search result (not overwhelming)
21. Always show merchant brand voice (configured in dashboard, injected into system prompt)
```

### Compliance
```
22. GDPR data deletion: wipe auranod_chat metafields + Postgres conversation records
23. GDPR data export: ZIP conversation records from Postgres per customer email
24. PII masking: middleware strips email/address from all Azure Monitor logs
25. No conversation transcripts stored in metafields — only behavioral summaries
26. Shopify App Store TOS: no "automated purchase" claims in listing copy
```

---

## Conversation State (Redis)

Session key: `session:{shop_domain}:{session_id}`
TTL: 30 minutes (resets on each message)

```typescript
interface ConversationSession {
  conversation_history: Message[]   // last 20 turns only
  cart_id?: string
  checkout_id?: string
  buyer_confirmed: boolean          // reset to false after each checkout attempt
  discount_applied: boolean         // one discount per convo
  hop_count: number                 // reset each turn
  agent_calls: string[]             // ["shopping", "support"] — current turn trace
}
```

After session expires or conversation ends → write summary to Postgres (`Conversation` table) for analytics.

---

## Build Order (Phase 1 priority)

Build the agents in this order — each is testable before the next:

```
Week 1:
  1. Memory Agent (no LLM — just Admin MCP metafield R/W)
  2. Shopping Agent (GPT-4o-mini + Storefront Catalog + Cart)
  3. Support Agent (GPT-4o-mini + Policy MCP)

Week 2:
  4. Personalization Agent (GPT-4o-mini + Admin MCP discounts)
  5. Orchestrator (GPT-4o + routes to all agents)
  6. api.chat.tsx (SSE endpoint that wires all agents)

Week 3:
  7. Shopify Widget (Theme App Extension)
  8. Shopify Widget adapter + renderer
  9. End-to-end test on auranod.myshopify.com
```

---

*Full MCP tool specs: IMPLEMENTATION_PLAN.md*
*Company roadmap: /Users/krkaushikkumar/Desktop/shopify/AI_CHAT_WIDGET_PLAN.md*
