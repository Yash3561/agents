# NeonPing — Definitive Implementation Plan
*Multi-agent. Azure-native. Channel-agnostic core. Last updated: 2026-06-14*

---

## What We Are Building

A B2B SaaS sold to Shopify merchants. Each merchant installs our app from the Shopify App Store.
Our widget embeds on THEIR store. Their customers shop ONLY that merchant's catalog.

One widget. One merchant. One store. Storefront-scoped only — no cross-merchant catalog.

---

## Technology Stack

| Layer | Choice | Reason |
|-------|--------|--------|
| App framework | React Router (Remix) v7 | Official Shopify app template |
| Orchestrator LLM | GPT-4o (Azure OpenAI) | Complex routing + confirmation gating |
| Specialist LLMs | GPT-4o-mini (Azure OpenAI) | 17× cheaper, more than capable for focused tasks |
| LLM Router | Azure AI Foundry Prompt Flow | Centralized rate limits, logging, A/B testing |
| Hosting | Azure Container Apps | Scales to zero, handles SSE streaming, auto-scales under load |
| Container Registry | Azure Container Registry (ACR) | Docker image storage for Container Apps |
| Database | Azure Database for PostgreSQL Flexible Server (Burstable B1ms) | Prisma-native, ~$15/mo at launch |
| Cache + Session State | Azure Cache for Redis (Basic C0) | Conversation state, MCP cache, query dedup |
| Blob Storage | Azure Blob Storage | Widget JS/CSS CDN bundle, GDPR exports |
| Billing | Shopify App Billing API | Merchant pays through Shopify — zero friction |

---

## Multi-Agent Architecture

Five agents. Each has one job. Each has a constrained tool list. None can exceed its scope.

```
CHANNEL (Shopify Widget → WhatsApp Month 4 → iMessage Month 6)
        │
        ▼
   CHANNEL ADAPTER  →  InboundMessage (standard format, channel-agnostic)
        │
        ▼
┌───────────────────────────────────────────────────────────────────┐
│                     ORCHESTRATOR AGENT                             │
│                     GPT-4o via Azure OpenAI                        │
│                                                                   │
│  Reads full conversation + customer memory                        │
│  Classifies intent → routes to specialist                         │
│  Gates complete_checkout (requires buyer_confirmed: true)         │
│  Max 3 specialist hops per turn                                   │
│  Assembles final response from specialist output                  │
└──────────────┬────────────────────┬──────────────────────────────┘
               │                    │
    ┌──────────▼──────┐   ┌─────────▼─────────────────┐
    │ SHOPPING AGENT  │   │      SUPPORT AGENT         │
    │ GPT-4o-mini     │   │      GPT-4o-mini            │
    │                 │   │                            │
    │ search_catalog  │   │ search_policies_and_faqs   │
    │ get_product     │   │ get_order                  │
    │ create_cart     │   │ get_customer_orders        │
    │ update_cart     │   │ READ-ONLY. No writes.      │
    │ create_checkout │   └────────────────────────────┘
    │ complete_chkout │
    └──────────┬──────┘
               │
    ┌──────────▼────────────────────────────────────┐
    │         PERSONALIZATION AGENT                  │
    │         GPT-4o-mini                            │
    │                                               │
    │  Read customer tags → VIP detection           │
    │  Create one-time discount codes               │
    │  Reorder suggestions from order history       │
    └──────────┬────────────────────────────────────┘
               │
    ┌──────────▼────────────────────────────────────┐
    │           MEMORY AGENT                         │
    │           No LLM — deterministic TypeScript    │
    │                                               │
    │  Pre-turn: fetch customer metafields           │
    │  Post-turn: extract preferences, write back   │
    │  namespace: "auranod_chat" ONLY               │
    └────────────────────────────────────────────────┘
               │
               ▼
        CHANNEL RENDERER  →  SSE cards (widget) / text+links (WhatsApp) / rich bubbles (iMessage)
```

---

## Shopify MCP Servers

Shopify hosts all of these. We are an MCP client calling them over JSON-RPC 2.0 over HTTP.
One shared HTTP client handles all servers.

```
SHOPIFY-HOSTED MCP SERVERS
────────────────────────────────────────────────────────────

1. Storefront Catalog MCP
   Endpoint : https://{store}.myshopify.com/api/mcp
   Tools    : search_catalog, lookup_catalog, get_product
   Auth     : None required
   Agent    : Shopping Agent only
   Use      : Product discovery scoped to this merchant's store

2. Policy & FAQs MCP
   Endpoint : https://{store}.myshopify.com/api/mcp
   Tools    : search_shop_policies_and_faqs
   Auth     : None required
   Agent    : Support Agent only
   Use      : Return policy, shipping policy, FAQs (Shopify pre-indexes)

3. Cart MCP
   Endpoint : Discovered from https://{store}.myshopify.com/.well-known/ucp
   Tools    : create_cart, get_cart, update_cart, cancel_cart
   Auth     : Anonymous (no credentials needed)
   Agent    : Shopping Agent only
   Use      : Build and iterate the customer's cart
   Rule     : update_cart is a FULL REPLACE — always send all line_items[]

4. Checkout MCP
   Endpoint : Discovered from https://{store}.myshopify.com/.well-known/ucp
   Tools    : create_checkout, update_checkout, complete_checkout, cancel_checkout
   Auth     : Token tier JWT (from UCP Dev Dashboard)
   Agent    : Shopping Agent only — complete_checkout gated by Orchestrator
   Use      : Convert cart to checkout, get payment link, complete purchase

5. Order MCP
   Endpoint : From UCP Dev Dashboard
   Tools    : get_order
   Auth     : Token tier JWT + read_global_api_orders scope
   Agent    : Support Agent only
   Use      : "Where's my order?" — fulfillment status, tracking, ETA

6. Customer Accounts MCP
   Endpoint : Discovered dynamically from storefront domain
   Tools    : get_customer_orders, get_account_details
   Auth     : OAuth 2.0 PKCE (customer must be logged in)
   Agent    : Support Agent + Personalization Agent
   Use      : Reorder flow, order history for logged-in customers

OUR CUSTOM MCP SERVER (we build — thin proxy)
────────────────────────────────────────────────────────────

7. Admin GraphQL MCP
   Wraps    : https://{store}.myshopify.com/admin/api/2026-04/graphql.json
   Tools    : admin_graphql(query, variables?)
   Auth     : Merchant's access token (Shopify OAuth, stored in our Postgres)
   Agents   : Personalization Agent (discounts, tags) + Memory Agent (metafields)
   Use      : Discount codes, customer metafields, customer tags, inventory
```

---

## UCP Authentication

| Tier | Credential | Unlocks |
|------|-----------|---------|
| **Token** | JWT Bearer from UCP Dev Dashboard | Cart + Checkout + `complete_checkout` + `get_order`. Highest rate limits. |
| **Signed** | HTTP Message Signatures (ECDSA P-256) | Cart + Checkout only |
| **Anonymous** | Nothing | Catalog + Cart only |

We use **Token tier**. Register agent in UCP Dev Dashboard → store JWT in Azure Key Vault → inject into MCP client at runtime.

UCP Agent Profile (Shopify fetches this to negotiate capabilities):
```json
// public/.well-known/ucp-agent.json
{
  "ucp": "2026-04-08",
  "name": "NeonPing Agent",
  "capabilities": [
    "dev.ucp.shopping.catalog",
    "dev.ucp.shopping.cart",
    "dev.ucp.shopping.checkout",
    "dev.ucp.shopping.order"
  ]
}
```

---

## Azure AI Foundry — LLM Router

Set up one Prompt Flow that routes by agent type. One Azure resource manages all models.

```
IncomingRequest
      │
      ├─ agent_type: "orchestrator"   → deployment: neonping-orchestrator  (GPT-4o)
      ├─ agent_type: "shopping"       → deployment: neonping-shopping      (GPT-4o-mini)
      ├─ agent_type: "support"        → deployment: neonping-support       (GPT-4o-mini)
      ├─ agent_type: "personalize"    → deployment: neonping-personalize   (GPT-4o-mini)
      └─ agent_type: "summary"        → deployment: neonping-summary       (GPT-4o-mini)
```

**AI Foundry deployments to create:**

| Deployment Name | Model | TPM Limit | Used by |
|----------------|-------|-----------|---------|
| neonping-orchestrator | gpt-4o | 100K | Orchestrator Agent |
| neonping-shopping | gpt-4o-mini | 500K | Shopping Agent |
| neonping-support | gpt-4o-mini | 200K | Support Agent |
| neonping-personalize | gpt-4o-mini | 100K | Personalization Agent |
| neonping-summary | gpt-4o-mini | 100K | Memory Agent (summarization only) |

Benefits: centralized rate limiting per merchant plan, built-in usage logging → Azure Monitor, A/B testing models without code changes, single cost line item.

---

## Agent Specifications

### Orchestrator Agent (GPT-4o)

Called once per turn. Only agent that sees full conversation history.

**Structured output (JSON, not free text):**
```typescript
{
  route: "shopping" | "support" | "personalization" | "direct",
  route_reason: string,
  context_for_specialist: string,
  buyer_confirmed: boolean,      // true only on explicit "yes / checkout / buy it / place order"
  direct_response?: string       // used for greetings, unclear messages
}
```

**Guardrails:**
- `buyer_confirmed: true` requires explicit confirmation word in history — never implied
- Max 3 specialist hops per turn → after 3 failures, return graceful fallback + direct store link
- Token budget enforced at AI Foundry: 2000 input + 500 output
- Timeout: 8 seconds → graceful error message

---

### Shopping Agent (GPT-4o-mini)

Called for: product search, add to cart, checkout.

**Tools:** `search_catalog`, `get_product`, `create_cart`, `get_cart`, `update_cart`, `create_checkout`, `complete_checkout`

**System prompt (injected per merchant):**
```
You are a shopping assistant for {merchant_name}.
Find products, build carts, complete purchases.

RULES:
1. Only return products that MCP returns — never invent specs, prices, or availability
2. Show max 3 products per search
3. Always show cart total before calling create_checkout
4. Never call complete_checkout unless buyer_confirmed is true in your input
5. If complete_checkout returns requires_escalation → return continue_url immediately, do not retry
6. If search returns empty → suggest rephrasing or offer to browse categories
7. update_cart is a FULL REPLACE — always pass the complete line_items[] array

Customer context: {customer_memory}
Current cart: {cart_id}, total: {cart_total}
Merchant currency: {currency}
```

**Code-level guard (enforced regardless of LLM output):**
```typescript
if (toolName === "complete_checkout" && !input.buyer_confirmed) {
  throw new GuardrailError("checkout_not_confirmed");
}
```

---

### Support Agent (GPT-4o-mini)

Called for: policies, FAQs, shipping questions, order tracking.

**Tools:** `search_shop_policies_and_faqs`, `get_order`, `get_customer_orders`

**System prompt:**
```
You are a customer support assistant for {merchant_name}.
Answer questions about policies, shipping, and orders.

RULES:
1. Only use information from tool results — never invent policies or delivery estimates
2. If policy answer is ambiguous → end with: "For full details: {store_url}/policies"
3. If order not found → offer: "Please contact our support team at {support_email}"
4. You are READ-ONLY — you have zero tools that modify any data
5. If customer asks about products → tell the orchestrator to re-route to shopping
```

**Code-level guard:** Tool allowlist enforced — write-capable MCP tools are not available to this agent's tool registry.

---

### Personalization Agent (GPT-4o-mini)

Called for: discount inquiries, VIP signals, repeat customer reorders.

**Tools:** `admin_graphql` (read customer tags, create discount codes)

**Decision logic:**
```typescript
if (customer.tags.includes("VIP"))             → create 15% off code
if (customer.order_count >= 3)                 → create 10% loyalty code
if (cart.total >= merchant.vip_cart_threshold) → create free shipping code
if (memory.abandoned_cart exists)              → reference it in response
else                                           → return null, no fake offers
```

**Guardrails:**
- Discount codes: always `usageLimit: 1`, always `oncePerCustomer: true`
- Max discount: 20% (configurable per merchant, default 15%)
- One discount per conversation (tracked in Redis session)
- Never surface a discount unless the eligibility check passes
- If Admin MCP fails → skip silently (personalization is enhancement, not core)

---

### Memory Agent (No LLM)

Pure TypeScript. No model call. Fast. Free.

**Runs twice per turn:**
1. Before orchestrator — reads customer metafields, injects into orchestrator context
2. After turn completes — extracts signals, writes updated preferences back

**What it stores (Admin MCP → customer metafields):**
```
namespace: "auranod_chat"    (PUBLIC_READ — accessible from storefront)

keys:
  preferences    → { size: "M", color: "black", budget: "mid" }
  last_search    → "sleep supplements"
  summary        → "Bought wellness 3x. Prefers bundles. Price-sensitive."
  abandoned_cart → { items: [], total: 0, timestamp: ISO8601 }
```

**Summarization:** When conversation > 5 turns → one `neonping-summary` GPT-4o-mini call to compress history into a 2-sentence summary stored in metafields.

**Guardrails:**
- Only reads/writes `auranod_chat` namespace — cannot touch any other app's metafields
- Max 2KB total per customer (Shopify metafield limit)
- No PII stored: no email, no address, no payment data — behavioral signals only
- GDPR delete: wipe entire `auranod_chat` namespace on `customers/redact` webhook
- Only stores data for logged-in customers or returning session IDs (fingerprinted)

---

## Conversation State (Redis)

Session key: `session:{shop_domain}:{session_id}`
TTL: 30 minutes (resets on each message)

```typescript
interface ConversationSession {
  conversation_history: Message[]  // last 20 turns only (older turns in Postgres)
  cart_id?: string
  checkout_id?: string
  buyer_confirmed: boolean         // reset to false after each checkout attempt
  discount_applied: boolean        // one discount per conversation
  hop_count: number                // reset each turn, max 3
  agent_calls: string[]            // trace: ["shopping", "personalization"]
}
```

On session expire or conversation end → write summary row to Postgres `Conversation` table for merchant analytics.

**Also cached in Redis:**
- MCP endpoints per merchant: `mcp:{shop_domain}` — 60-min TTL (/.well-known/ucp response)
- Repeat product queries: `query:{shop_domain}:{query_hash}` — 5-min TTL

---

## All MCP Tool Payloads

### search_catalog (Storefront Catalog MCP)
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "id": 1,
  "params": {
    "name": "search_catalog",
    "arguments": {
      "meta": { "ucp-agent": { "profile": "https://neonping.azurecontainerapps.io/.well-known/ucp-agent" } },
      "catalog": {
        "query": "sleep supplements",
        "context": {
          "intent": "Customer looking for sleep improvement products",
          "address_country": "US",
          "currency": "USD"
        },
        "filters": { "price": { "max": 4000 } },
        "pagination": { "limit": 3 }
      }
    }
  }
}
```

### search_shop_policies_and_faqs (Policy MCP)
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "search_shop_policies_and_faqs",
    "arguments": {
      "query": "return policy for sale items",
      "context": "Customer viewing discounted wellness products"
    }
  }
}
```

### create_cart (Cart MCP)
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "create_cart",
    "arguments": {
      "meta": { "ucp-agent": { "profile": "https://neonping.azurecontainerapps.io/.well-known/ucp-agent" } },
      "line_items": [{ "item": { "id": "gid://shopify/ProductVariant/xxx" }, "quantity": 1 }],
      "context": { "address_country": "US", "currency": "USD" }
    }
  }
}
```

### create_checkout (Checkout MCP)
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "create_checkout",
    "arguments": {
      "cart_id": "gid://shopify/Cart/xxx"
    }
  }
}
```
Returns: `checkout_id`, `continue_url` (direct to Shopify payment page), `status`

### complete_checkout (Checkout MCP — Token tier, buyer_confirmed gate)
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "complete_checkout",
    "arguments": {
      "checkout_id": "gid://shopify/Checkout/xxx"
    }
  }
}
```
On `requires_escalation`: always redirect to `continue_url`, never retry.

### admin_graphql — create discount (Admin MCP)
```graphql
mutation CreateVIPDiscount($input: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $input) {
    codeDiscountNode { id }
    userErrors { field message }
  }
}
```
```json
{
  "input": {
    "title": "VIP-{session_id}",
    "code": "VIP-{random_6_chars}",
    "startsAt": "{now}",
    "customerSelection": { "all": true },
    "customerGets": {
      "value": { "percentage": 0.15 },
      "items": { "all": true }
    },
    "appliesOncePerCustomer": true,
    "usageLimit": 1
  }
}
```

---

## Conversation Flows (with agent routing)

### Flow 1 — Product Discovery + Purchase
```
Customer: "I want something for better sleep under $40"

Orchestrator: route → shopping
Shopping Agent:
  → search_catalog { query: "sleep", filters: { price: { max: 4000 } } }
  → Returns 3 products with prices, images, variant_ids
  → Response: "Here are 3 sleep products under $40: ..."

[Widget renders product cards]

Customer: "Add the supplement to my cart"
Orchestrator: route → shopping, buyer_confirmed: false
Shopping Agent:
  → create_cart { line_items: [{ id: "variant_xxx", quantity: 1 }] }
  → Response: "Added! Cart total: $32. Ready to checkout?"

Customer: "yes checkout"
Orchestrator: route → shopping, buyer_confirmed: true  ← explicit "yes"
Shopping Agent:
  → create_checkout { cart_id: "xxx" }
  → Returns: continue_url

[Widget shows "Proceed to Payment" button → Shopify checkout]
```

### Flow 2 — Policy Question
```
Customer: "What's your return policy?"

Orchestrator: route → support
Support Agent:
  → search_shop_policies_and_faqs { query: "return policy" }
  → Returns: "30-day returns on full-price items. Sale items final sale."
  → Response: "You can return most items within 30 days..."
```

### Flow 3 — Order Tracking
```
Customer: "Where's my order #1234?"

Orchestrator: route → support
Support Agent:
  → get_order { order_id: "1234" }
  → Returns: fulfilled, UPS tracking, ETA June 16
  → Response: "Your order shipped June 12 via UPS. Estimated delivery June 16."
```

### Flow 4 — VIP Discount
```
Customer: "Do you have any discounts?"

Orchestrator: route → personalization
Personalization Agent:
  → admin_graphql { query: "customer tags" } → tags: ["VIP"]
  → admin_graphql { mutation: discountCodeBasicCreate } → code: "VIP-K3X9P2"
  → Response: "I've applied a 15% VIP discount. "

Orchestrator: route → shopping
Shopping Agent:
  → update_cart { discount_codes: ["VIP-K3X9P2"], line_items: [...all existing...] }
  → Response: "New total: $27.20. Ready to checkout?"
```

### Flow 5 — Memory-Powered Returning Customer
```
[Memory Agent pre-turn fetch]
customer_memory: { last_search: "sleep supplements", summary: "Bought Sleep Aid 3x." }

Customer: "What's new?"
Orchestrator injects memory into shopping context
Shopping Agent:
  → search_catalog { query: "sleep supplements", context: { intent: "repeat customer" } }
  → Response: "Welcome back! We have a new Sleep Bundle you might love based on your previous orders..."
```

### Flow 6 — Reorder (Logged-In Customer)
```
Customer: "Can I reorder what I bought last month?"

Orchestrator: route → support (for order history)
Support Agent:
  → get_customer_orders() [Customer Accounts MCP]
  → Returns: last order: Sleep Supplement × 1, May 15

Orchestrator: route → shopping
Shopping Agent:
  → create_cart { line_items: last_order.line_items }
  → Response: "Added Sleep Supplement to your cart. Total: $32. Checkout?"
```

---

## Channel Adapter Contract

All agents work in this format. Channel adapters translate to/from it.

### Inbound (any channel → Orchestrator)
```typescript
interface InboundMessage {
  channel: "shopify_widget" | "whatsapp" | "imessage" | "web"
  shop_domain: string
  session_id: string
  customer_id?: string        // only if logged in via Customer Accounts MCP
  message: string
  context: {
    cart_id?: string
    checkout_id?: string
    current_page?: "product" | "collection" | "cart" | "home" | "other"
    page_product_id?: string  // pre-load if on a product page
    locale: string
    currency: string
  }
  capabilities: {
    rich_cards: boolean       // product image cards with buy buttons
    quick_replies: boolean    // tap-to-reply option chips
    images: boolean
    streaming: boolean        // SSE word-by-word (widget only)
  }
}
```

### Outbound (Orchestrator → any channel renderer)
```typescript
interface OutboundMessage {
  text: string               // always present — fallback for all channels
  products?: ProductCard[]
  cart_summary?: { items: CartItem[], total: string, currency: string }
  checkout_url?: string
  quick_replies?: string[]   // ["Add to cart", "See similar", "Checkout"]
  confidence: number         // <0.6 → escalate to human
  escalate_to_human?: boolean
}
```

### Channel Rendering Matrix

| Output | Shopify Widget (now) | WhatsApp (Month 4) | iMessage (Month 6) |
|--------|---------------------|--------------------|--------------------|
| Product | Image card + ATC button | JPEG + link text | Rich bubble |
| Cart | Slide-up drawer | Itemized text | Interactive bubble |
| Checkout | "Pay Now" → continue_url | Payment link in message | Apple Pay native sheet |
| Policy | Formatted block | Plain text + URL | Text + preview link |
| Quick replies | Tap chips | Numbered list | Tap chips |
| Streaming | SSE word-by-word | Not supported (send complete) | Not supported |

**Key rule:** Agents never know what channel they're on. Only adapters and renderers do. Adding WhatsApp = add adapter + renderer. All 5 agents unchanged.

---

## Guardrails — Complete Reference

### Checkout Safety
| Rule | Enforced at |
|------|-------------|
| `complete_checkout` blocked unless `buyer_confirmed: true` | Code guard in shopping agent runner |
| `buyer_confirmed` only set on explicit confirmation words | Orchestrator prompt + structured output |
| Cannot create checkout with empty cart | Shopping agent tool call validator |
| `requires_escalation` → always use `continue_url`, never retry | Shopping agent prompt + error handler |
| Cart total shown before `create_checkout` | Shopping agent prompt |

### Content Safety
| Rule | Enforced at |
|------|-------------|
| No invented product specs, prices, or availability | Shopping agent system prompt |
| No invented policies or shipping estimates | Support agent system prompt |
| No discount unless eligibility check passes | Personalization agent logic |
| Max 3 products per search | Shopping agent prompt |
| Max 1 discount per conversation | Redis session `discount_applied` flag |
| Max discount: 20% | Personalization agent config |

### Cost Controls
| Rule | Value |
|------|-------|
| Orchestrator token budget | 2000 in + 500 out (AI Foundry limit) |
| Specialist token budget | 3000 in + 600 out (AI Foundry limit) |
| Max hops per turn | 3 → fallback response |
| Max conversation turns | 50 → "Start a new chat" |
| Repeat query cache | 5-min TTL in Redis |
| MCP endpoint cache | 60-min TTL in Redis |
| Conversation history in memory | Last 20 turns only |
| Free tier enforcement | 50 conversations/mo — checked at api.chat.tsx entry |

### Quality
| Rule | Enforced at |
|------|-------------|
| Confidence < 0.6 → ask to rephrase | Orchestrator structured output |
| Empty search → suggest rephrasing | Shopping agent prompt |
| 3 failed hops → graceful fallback + store link | Orchestrator hop_count guard |
| Merchant brand voice always injected | System prompt builder per merchant |

### Compliance
| Rule | Enforced at |
|------|-------------|
| GDPR data deletion | Wipe `auranod_chat` metafields + Postgres conversation rows |
| GDPR data export | ZIP Postgres conversation records per customer email |
| PII masking in logs | Middleware strips email/phone/address before Azure Monitor |
| No PII in metafields | Memory agent stores behavioral signals only |
| Shopify App Store TOS | No "automated purchase" claims in listing copy |

---

## File Structure

```
auranod-chat/
│
├── app/
│   ├── shopify.server.ts
│   ├── db.server.ts                          ← Prisma singleton
│   ├── redis.server.ts                       ← Azure Redis client singleton
│   │
│   ├── lib/
│   │   ├── mcp/
│   │   │   ├── client.server.ts              ← JSON-RPC 2.0 HTTP client (shared base)
│   │   │   ├── discovery.server.ts           ← /.well-known/ucp → Redis 60-min cache
│   │   │   ├── catalog.server.ts             ← search_catalog, lookup_catalog, get_product
│   │   │   ├── policy.server.ts              ← search_shop_policies_and_faqs
│   │   │   ├── cart.server.ts                ← create/get/update/cancel_cart
│   │   │   ├── checkout.server.ts            ← create/update/complete/cancel_checkout
│   │   │   ├── order.server.ts               ← get_order
│   │   │   ├── customer-accounts.server.ts   ← get_customer_orders, get_account_details
│   │   │   └── admin.server.ts               ← Admin GraphQL proxy (our custom MCP)
│   │   │
│   │   ├── agents/
│   │   │   ├── orchestrator.server.ts        ← GPT-4o, routes turns, gates checkout
│   │   │   ├── shopping.server.ts            ← GPT-4o-mini, catalog+cart+checkout
│   │   │   ├── support.server.ts             ← GPT-4o-mini, policy+orders (read-only)
│   │   │   ├── personalization.server.ts     ← GPT-4o-mini, VIP+discounts
│   │   │   └── memory.server.ts              ← No LLM, metafield R/W + summarization
│   │   │
│   │   ├── adapters/
│   │   │   ├── types.ts                      ← InboundMessage, OutboundMessage interfaces
│   │   │   └── shopify-widget.server.ts      ← Normalize widget POST → InboundMessage
│   │   │
│   │   ├── renderers/
│   │   │   └── shopify-widget.ts             ← OutboundMessage → SSE product cards
│   │   │
│   │   ├── guardrails.server.ts              ← Code-level guards (checkout gate, hop count)
│   │   ├── session.server.ts                 ← Redis ConversationSession R/W
│   │   └── prompt.server.ts                  ← System prompt builder per merchant
│   │
│   └── routes/
│       ├── app.tsx                           ← Merchant dashboard layout
│       ├── app._index.tsx                    ← Stats, recent conversations
│       ├── app.settings.tsx                  ← Widget color, greeting, brand voice, VIP threshold
│       ├── app.billing.tsx                   ← Shopify App Billing plan management
│       ├── auth.$.tsx                        ← Shopify OAuth handler
│       ├── api.chat.tsx                      ← SSE streaming endpoint — entry point
│       ├── api.widget-config.tsx             ← Public config (HMAC-verified)
│       ├── webhooks.app.uninstalled.tsx
│       ├── webhooks.customers.data-request.tsx   ← GDPR export
│       ├── webhooks.customers.redact.tsx         ← GDPR delete
│       ├── webhooks.shop.redact.tsx              ← GDPR delete
│       └── webhooks.order.tsx                    ← UCP order lifecycle events
│
├── extensions/
│   └── chat-widget/
│       ├── shopify.extension.toml
│       ├── blocks/
│       │   └── chat-widget.liquid            ← App Block: chat bubble HTML + config vars
│       └── assets/
│           ├── chat.js                       ← SSE streaming, product cards, cart sync
│           └── chat.css                      ← Premium responsive styles
│
├── public/
│   └── .well-known/
│       └── ucp-agent.json                    ← UCP agent profile
│
├── prisma/schema.prisma
├── shopify.app.toml
├── Dockerfile                                ← Azure Container Apps deployment
└── .env
```

---

## Prisma Schema

```prisma
model Session {
  id          String    @id
  shop        String
  state       String
  isOnline    Boolean   @default(false)
  scope       String?
  expires     DateTime?
  accessToken String
  userId      BigInt?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
}

model Merchant {
  id                   String         @id @default(cuid())
  shopDomain           String         @unique
  plan                 String         @default("free")
  conversationCount    Int            @default(0)
  conversationResetAt  DateTime       @default(now())
  mcpEndpointCache     String?
  widgetColor          String         @default("#1a1a1a")
  widgetPosition       String         @default("bottom-right")
  widgetGreeting       String         @default("Hi! How can I help you today?")
  brandVoice           String         @default("friendly and helpful")
  maxDiscountPct       Int            @default(15)
  vipCartThreshold     Int            @default(10000)    // cents
  supportEmail         String?
  whatsappNumber       String?        // Month 4
  createdAt            DateTime       @default(now())
  updatedAt            DateTime       @updatedAt
  conversations        Conversation[]
}

model Conversation {
  id              String   @id @default(cuid())
  shopDomain      String
  visitorSession  String
  channel         String   @default("shopify_widget")
  messages        Json
  cartId          String?
  checkoutId      String?
  cartValue       Float?
  converted       Boolean  @default(false)
  discountUsed    String?
  agentTrace      Json?    // which agents were called, in order
  createdAt       DateTime @default(now())
  merchant        Merchant @relation(fields: [shopDomain], references: [shopDomain])
}
```

---

## shopify.app.toml

```toml
name = "NeonPing"
client_id = ""
application_url = "https://neonping.azurecontainerapps.io"

[access_scopes]
scopes = "read_products,read_inventory,read_orders,read_customers,write_customers,read_content,write_metaobjects,write_discounts"

[customer_authentication]
redirect_uris = ["https://neonping.azurecontainerapps.io/app/customer-auth/callback"]

[webhooks]
api_version = "2026-04"

[[webhooks.subscriptions]]
topics = ["app/uninstalled"]
uri = "/webhooks/app/uninstalled"

[[webhooks.subscriptions]]
compliance_topics = ["customers/data_request"]
uri = "/webhooks/customers/data_request"

[[webhooks.subscriptions]]
compliance_topics = ["customers/redact"]
uri = "/webhooks/customers/redact"

[[webhooks.subscriptions]]
compliance_topics = ["shop/redact"]
uri = "/webhooks/shop/redact"
```

---

## Webhooks

### UCP Order Webhooks (NOT self-serve — contact Shopify Partner Manager)
- Topics: `orders/create`, `orders/updated`, `orders/delete`
- Endpoint: `https://neonping.azurecontainerapps.io/webhooks/order`
- Payload: Full current order state (treat latest payload as source of truth)
- Deduplicate: `X-Shopify-Webhook-Id` header → check Redis before processing

---

## Environment Variables

```bash
# Shopify App
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SHOPIFY_APP_URL=https://neonping.azurecontainerapps.io

# Azure OpenAI (via AI Foundry)
AZURE_OPENAI_ENDPOINT=https://{your-foundry}.openai.azure.com
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_API_VERSION=2025-01-01-preview

# Deployment names (AI Foundry)
AZURE_DEPLOYMENT_ORCHESTRATOR=neonping-orchestrator
AZURE_DEPLOYMENT_SHOPPING=neonping-shopping
AZURE_DEPLOYMENT_SUPPORT=neonping-support
AZURE_DEPLOYMENT_PERSONALIZE=neonping-personalize
AZURE_DEPLOYMENT_SUMMARY=neonping-summary

# Database
DATABASE_URL=postgresql://user:pass@psql-neonping.postgres.database.azure.com:5432/auranod

# Redis
REDIS_URL=rediss://:password@redis-neonping.redis.cache.windows.net:6380

# UCP
UCP_JWT=                     # UCP Dev Dashboard → Token tier JWT

# Azure Blob (widget CDN + GDPR exports)
AZURE_STORAGE_CONNECTION_STRING=
AZURE_STORAGE_CONTAINER_WIDGET=widget-assets
AZURE_STORAGE_CONTAINER_GDPR=conversation-exports
```

---

## Azure Infrastructure

```
Resource Group: rg-neonping-prod
│
├── Container Apps Environment: cae-neonping
│   └── Container App: ca-neonping
│       Min replicas : 0 (scale to zero when idle)
│       Max replicas : 10
│       CPU/Memory   : 0.5 vCPU, 1Gi per replica
│       Scale rule   : HTTP — 100 concurrent requests per replica
│
├── Azure Container Registry: acrneonping
│
├── Azure Database for PostgreSQL Flexible Server: psql-neonping
│   Tier    : Burstable B1ms (1 vCPU, 2GB RAM, 32GB SSD)
│   Cost    : ~$15/mo
│   Backups : 7-day retention (included)
│   Upgrade : B2ms → D2s_v3 at >100 merchants
│
├── Azure Cache for Redis: redis-neonping
│   Tier    : Basic C0 (250MB)
│   Cost    : ~$16/mo
│   Use     : Conversation state + MCP cache + query dedup
│   Upgrade : Standard C1 (1GB + replica) when we need HA
│
├── Azure Blob Storage: stneonping
│   Container: widget-assets (public, CDN-enabled)
│   Container: conversation-exports (private, GDPR)
│   Cost    : ~$1/mo
│
└── Azure AI Foundry Hub: aifh-neonping
    └── AI Foundry Project: aifp-neonping
        5 deployments (listed above)
        Prompt Flow: neonping-llm-router

Total infra cost: ~$32-65/mo
Break-even: 2 paying merchants on Starter plan ($29 × 2 = $58)
```

---

## Cost Per Conversation

| Agent | Model | Avg tokens | Cost |
|-------|-------|-----------|------|
| Orchestrator | GPT-4o | 1,500 in + 400 out | ~$0.0078 |
| Shopping | GPT-4o-mini | 2,000 in + 500 out | ~$0.0006 |
| Support | GPT-4o-mini | 1,000 in + 300 out | ~$0.0003 |
| Personalization | GPT-4o-mini | 500 in + 200 out | ~$0.0002 (30% of turns) |
| Memory summary | GPT-4o-mini | 800 in + 200 out | ~$0.0001 (20% of turns) |
| **Average total** | | | **~$0.009/conversation** |

With Azure OpenAI prompt caching (50% off cached input): **~$0.005/conversation**

| Plan | Price | Convos/mo | LLM Cost | Infra Share | Net |
|------|-------|-----------|----------|-------------|-----|
| Free | $0 | 50 | $0.25 | subsidized | — |
| Starter | $29 | 500 | $2.50 | $5 | $21.50 (74%) |
| Pro | $79 | 2,000 | $10 | $10 | $59 (75%) |
| Agency | $199 | 10,000 | $50 | $20 | $129 (65%) |

---

## Pricing Plans

| Plan | Price | Conversations/mo | Features |
|------|-------|-----------------|---------|
| Free | $0 | 50 | Catalog search, product cards, policy Q&A |
| Starter | $29 | 500 | + Cart + Checkout, customer memory |
| Pro | $79 | Unlimited | + VIP discounts, order tracking, Customer Accounts MCP |
| Agency | $199 | Unlimited × 5 stores | + White-label, priority support |

---

## Build Phases

### Phase 1 — MCP Layer + Agents (Days 1–7)
- [ ] `shopify app init` — run interactively in terminal, select org
- [ ] `lib/mcp/client.server.ts` — shared JSON-RPC 2.0 HTTP client
- [ ] `lib/mcp/discovery.server.ts` — /.well-known/ucp with Redis 60-min cache
- [ ] `lib/mcp/catalog.server.ts` — search_catalog, get_product
- [ ] `lib/mcp/policy.server.ts` — search_shop_policies_and_faqs
- [ ] `lib/mcp/cart.server.ts` — full cart flow
- [ ] `lib/mcp/checkout.server.ts` — full checkout flow
- [ ] `lib/mcp/order.server.ts` — get_order
- [ ] `lib/mcp/admin.server.ts` — Admin GraphQL proxy
- [ ] `lib/agents/memory.server.ts` — metafield R/W, no LLM (build first — no dependencies)
- [ ] `lib/agents/shopping.server.ts` — GPT-4o-mini + catalog + cart + checkout
- [ ] `lib/agents/support.server.ts` — GPT-4o-mini + policy + orders
- [ ] `lib/agents/personalization.server.ts` — GPT-4o-mini + Admin MCP discounts
- [ ] `lib/agents/orchestrator.server.ts` — GPT-4o + routing + checkout gate
- [ ] `lib/guardrails.server.ts` — code-level guards
- [ ] `lib/session.server.ts` — Redis conversation state
- [ ] `routes/api.chat.tsx` — SSE endpoint wiring all agents
- [ ] `public/.well-known/ucp-agent.json`
- [ ] **Milestone:** `curl /api/chat` → search → cart → checkout link end-to-end

### Phase 2 — Widget (Days 7–11)
- [ ] Theme App Extension scaffold
- [ ] `chat-widget.liquid` — App Block entry point
- [ ] `chat.js` — SSE streaming, product card renderer, cart sync
- [ ] `chat.css` — premium design, mobile-first, animated
- [ ] `lib/adapters/shopify-widget.server.ts` — normalize POST → InboundMessage
- [ ] `lib/renderers/shopify-widget.ts` — OutboundMessage → SSE cards
- [ ] `routes/api.widget-config.tsx`
- [ ] **Milestone:** Full flow in browser on auranod.myshopify.com

### Phase 3 — Memory + Personalization (Days 11–14)
- [ ] Memory agent: metafield preferences R/W + summarization
- [ ] Customer Accounts MCP: reorder flow
- [ ] VIP discount flow: tag check → discount create → cart apply
- [ ] Order tracking flow end-to-end
- [ ] UCP order webhooks (contact Shopify Partner Manager)
- [ ] **Milestone:** Returning customer sees personalized greeting + abandoned cart nudge

### Phase 4 — Dashboard + Billing (Days 14–19)
- [ ] Dashboard: conversation stats, conversion rate, revenue attributed
- [ ] Settings: widget color, greeting, brand voice, VIP threshold, max discount %
- [ ] Shopify App Billing API: plan management, upgrade/downgrade
- [ ] Plan enforcement at api.chat.tsx entry
- [ ] **Milestone:** Merchant can configure widget and upgrade plan without us

### Phase 5 — App Store Submission (Days 19–27)
- [ ] GDPR webhook handlers (data_request, customers/redact, shop/redact)
- [ ] Privacy policy page
- [ ] Dockerfile + Azure Container Apps deployment pipeline
- [ ] 60-second demo video on auranod.myshopify.com
- [ ] App Store listing copy + screenshots
- [ ] Submit for Shopify review (~5 business days)

### Phase 6 — WhatsApp (Month 4)
- [ ] `lib/adapters/whatsapp.server.ts`
- [ ] `lib/renderers/whatsapp.ts`
- [ ] `routes/webhooks.whatsapp.tsx`
- [ ] Merchant onboarding: connect WhatsApp Business number
- [ ] **No agent changes required**

---

## Next Step

Run this in your terminal, select your Shopify Partner org when prompted:

```bash
cd /Users/krkaushikkumar/Desktop && rm -rf neonping && shopify app init --name neonping --template reactRouter --flavor typescript --package-manager npm
```

Come back and say "done" — we'll start with the MCP client and Memory Agent.

---

*Agent architecture details: AGENT_ARCHITECTURE.md*
*Company roadmap: /Users/krkaushikkumar/Desktop/shopify/AI_CHAT_WIDGET_PLAN.md*
