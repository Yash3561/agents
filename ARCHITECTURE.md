# NeonPing — System Architecture & Design

**Last updated**: 2026-06-17  
**Status**: Production-ready, live on Azure Container Apps  
**Audiences**: Developers, AI code assistants, future maintainers, Shopify auditors

---

## Table of Contents
1. [System Overview](#system-overview)
2. [High-Level Architecture](#high-level-architecture)
3. [Component Details](#component-details)
4. [Data Flow Diagrams](#data-flow-diagrams)
5. [Integration Points](#integration-points)
6. [Database Schema](#database-schema)
7. [Deployment Architecture](#deployment-architecture)
8. [Security Model](#security-model)

---

## System Overview

NeonPing is a **B2B SaaS AI chat widget** for Shopify storefronts. Merchants install it on their storefront as a theme app extension; customers interact with it via a minified JS widget. The backend uses multi-agent AI (gpt-4o-mini on Azure AI Foundry) to understand customer intent, search the merchant's live Shopify catalog (via Storefront MCP), manage carts, and handle abandoned-cart recovery.

**Key differentiator**: All catalog data is **always fresh** — we never sync/cache it. Every search hits Shopify's live Storefront MCP endpoint.

---

## High-Level Architecture

```mermaid
graph TB
    subgraph Storefront["Storefront (Customer-Facing)"]
        Theme["Shopify Theme<br/>(Merchant's Store)"]
        Widget["NeonPing Widget<br/>(~7KB JS Bundle)"]
        Theme -->|injects| Widget
    end

    subgraph MerchantPortal["Merchant Portal<br/>(Admin-Embedded)"]
        Onboarding["Onboarding Wizard"]
        Settings["Settings<br/>(Widget Config)"]
        Dashboard["Dashboard<br/>(KPIs, Stats)"]
    end

    subgraph Backend["Backend API<br/>(Node.js/TypeScript)"]
        ChatAPI["POST /api/chat<br/>(Message Entry)"]
        WebhookAPI["Webhooks<br/>(orders/paid, etc.)"]
        ConfigAPI["GET /api/widget-config<br/>(Settings Sync)"]
        AuthAPI["OAuth Routes<br/>(Embedded Auth)"]
        GreetingAPI["GET /api/greeting<br/>(Personalized)"]
    end

    subgraph Agents["Multi-Agent Orchestrator<br/>(Azure AI Foundry)"]
        Orchestrator["Orchestrator<br/>(gpt-4o-mini)"]
        Shopping["Shopping Agent<br/>(gpt-4o-mini)"]
        Support["Support Agent<br/>(gpt-4o-mini)"]
        Personalization["Personalization Agent<br/>(gpt-4o-mini)"]
        Memory["Memory Agent<br/>(gpt-4o-mini)"]
    end

    subgraph MCP["Shopify Integrations<br/>(Storefront MCP / UCP)"]
        CatalogMCP["search_catalog<br/>(Real-time search)"]
        CartMCP["get_cart / update_cart<br/>(Cart operations)"]
        PolicyMCP["search_shop_policies<br/>(FAQs, policies)"]
    end

    subgraph Database["Data Layer"]
        Postgres["Neon PostgreSQL<br/>(Conversations, Merchants,<br/>Webhooks, Sessions)"]
        Redis["Upstash Redis<br/>(Usage limits,<br/>Rate limiting,<br/>Temporary state)"]
    end

    Widget -->|Stream chat messages| ChatAPI
    ChatAPI -->|Route request| Orchestrator
    Orchestrator -->|Delegate to agent| Shopping
    Orchestrator -->|Delegate to agent| Support
    Orchestrator -->|Delegate to agent| Personalization
    Orchestrator -->|Delegate to agent| Memory
    Shopping -->|Live search| CatalogMCP
    Shopping -->|Cart ops| CartMCP
    Support -->|Policies| PolicyMCP
    ChatAPI -->|Persist conversation| Postgres
    ChatAPI -->|Check/increment usage| Redis
    WebhookAPI -->|orders/paid| Postgres
    WebhookAPI -->|abandoned_checkout| Postgres
    MerchantPortal -->|Configure widget| ConfigAPI
    ConfigAPI -->|Read/write config| Postgres
    MerchantPortal -->|OAuth login| AuthAPI
    GreetingAPI -->|Personalized greeting| Memory
    GreetingAPI -->|Fetch from DB| Postgres
```

---

## Component Details

### 1. **Storefront Widget** (`extensions/chat-widget/assets/neonping-widget.js`)

**Purpose**: Customer-facing chat launcher + message interface  
**Bundle size**: 7.07 KB / 10 KB cap  
**Triggers**:
- Exit-intent (desktop, mouse leaves viewport)
- 30s time-on-page (mobile)
- Manual launcher click

**Architecture**:
```mermaid
graph LR
    A["Widget Init"] -->|Check suppression flag| B["sessionStorage<br/>(proactive_*)"]
    A -->|Fetch config| C["GET /api/widget-config"]
    C -->|Color, greeting, position| A
    A -->|Render launcher| D["DOM: Launcher Button"]
    A -->|Render panel| E["DOM: Chat Panel"]
    D -->|Click| F["Open Panel"]
    E -->|User types| G["Construct message"]
    G -->|Stream to backend| H["POST /api/chat"]
    H -->|SSE stream back| I["Render bot response"]
    I -->|Extract meta| J["Render products/<br/>quick replies"]
    J -->|Add to cart| K["Update cart via<br/>message input"]
```

**Key features**:
- Live config fetching (color, position, greeting)
- Proactive engagement with suppression flag (prevents double-fire)
- Server-sent events (SSE) for streaming responses
- Product card rendering from bot `meta` response
- Quick-reply buttons

---

### 2. **Backend API Routes** (`app/routes/api.*.tsx`)

#### `api.chat.tsx` (Message Processing)
```
POST /api/chat
├─ Input: { session_id, shop, message, customer_id?, cart_total_cents? }
├─ Check rate limit (Redis, plan-based)
├─ Build context (customer, cart, merchant config)
├─ Call Orchestrator agent
├─ Persist conversation to Postgres
├─ Stream SSE response back to widget
└─ Output: SSE stream with { event, data } pairs
    ├─ event: "message" → bot text response
    ├─ event: "meta" → { products, discount_code, checkout_url, quick_replies }
    └─ event: "error" → error message
```

#### `api.widget-config.tsx` (Settings Sync)
```
GET /api/widget-config?shop=...
├─ Fetch merchant settings from Postgres
├─ Return { color, position, greeting }
└─ Widget uses this to apply saved customization
```

#### `api/greeting.tsx` (Personalized Opening)
```
GET /api/greeting?shop=...&customer_id=...
├─ Fetch customer memory (recent_products)
├─ Call Memory agent to personalize
└─ Return custom greeting mentioning recent products
```

---

### 3. **Merchant Portal** (Admin-Embedded App)

#### Onboarding (`app/routes/app.onboarding.tsx`)
4-step wizard:
1. Widget appearance (color, position, greeting)
2. AI behavior (brand voice, discount limits, VIP threshold)
3. Support configuration (support email)
4. Verify installation (deep link to theme editor, App Embeds section)

#### Settings (`app/routes/app.settings.tsx`)
- Edit widget appearance with **live preview**
- Edit AI behavior settings
- Settings saved to Postgres
- Widget fetches via `/api/widget-config`

#### Dashboard (`app/routes/app._index.tsx`)
- Total conversations count
- Conversion rate (carts created via chat / total conversations)
- AOV (average order value from chat-attributed orders)
- Cart recovery rate (abandoned carts recovered)

---

### 4. **Multi-Agent Orchestrator** (`app/lib/agents/orchestrator.server.ts`)

**Flow**:
```mermaid
graph TD
    A["Incoming message"] -->|Structured output| B["Parse intent"]
    B --> C{Route to agent?}
    C -->|Shopping| D["Shopping Agent<br/>(search, add to cart,<br/>discount codes)"]
    C -->|Support| E["Support Agent<br/>(FAQs, policies,<br/>help)"]
    C -->|Greeting| F["Personalization Agent<br/>(opening message,<br/>customer context)"]
    C -->|Memory| G["Memory Agent<br/>(customer history,<br/>preferences)"]
    D -->|Call MCP tools| H["Shopify Storefront MCP"]
    E -->|Search policies| H
    G -->|Upsert customer memory| I["Neon Postgres<br/>(metafields)"]
    H -->|Return products| J["Format response"]
    I -->|Return recent_products| J
    J -->|SSE stream| K["Widget"]
```

**Agent tools**:
```mermaid
graph LR
    Shopping["Shopping Agent"]
    Orch["Orchestrator"]
    
    Shopping -->|search_catalog| A["search<br/>intent<br/>maxPriceCents<br/>filters"]
    Shopping -->|get_cart| B["Fetch current<br/>cart state"]
    Shopping -->|update_cart| C["add/update/remove<br/>items, apply codes"]
    Shopping -->|search_policies| D["Search FAQs<br/>Shipping, Returns"]
    
    Orch -->|Guardrail: 2000 char cap| E["Truncate responses"]
```

---

### 5. **Shopify Integrations** (`app/lib/mcp/`)

#### Storefront MCP (UCP - Universal Commerce Protocol)

**Why Storefront MCP, not Admin API?**
- ✅ Always-fresh data (no sync lag, no hallucination risk)
- ✅ Public endpoint, customer-facing, reflects real storefront
- ✅ Faster (real-time vs. admin API rate limits)
- ❌ Limited to read-only catalog + cart operations (can't list customers, create orders, etc.)

**Tools available**:
```
✅ search_catalog (with intent + maxPriceCents for ranking)
✅ get_cart
✅ update_cart (add/remove/update items, discount codes, gift card codes)
✅ search_shop_policies_and_faqs
✅ get_product_details

❌ list_products (use search_catalog instead)
❌ create_checkout (Shopify hosted checkout is confirmation gate)
❌ get_order (requires Dev Dashboard credentials)
❌ get_customer_orders (Storefront API, not available on this tier)
```

**Search context fields**:
```mermaid
graph LR
    A["search_catalog"]
    B["query: string"]
    C["intent: 'budget'|'gift'|'urgent'"]
    D["maxPriceCents: number"]
    E["filters: categories, price.min/max"]
    
    A --> B
    A --> C
    A --> D
    A --> E
    
    B -->|Keyword matching| F["Shopify's ranking engine"]
    C -->|Budget context| F
    D -->|Price ceiling| F
    E -->|Category/price range| F
```

#### Webhooks (Real-Time Events)

```mermaid
graph LR
    Shopify["Shopify"]
    OrderPaid["orders/paid"]
    AbandonedCheckout["orders/abandoned_checkout"]
    DataRequest["customers/data_request"]
    Redact["customers/redact"]
    ShopRedact["shop/redact"]
    
    Shopify -->|POST /webhooks| OrderPaid
    Shopify -->|POST /webhooks| AbandonedCheckout
    Shopify -->|POST /webhooks| DataRequest
    Shopify -->|POST /webhooks| Redact
    Shopify -->|POST /webhooks| ShopRedact
    
    OrderPaid -->|Persist conversation<br/>mark as paid| DB1["Postgres"]
    AbandonedCheckout -->|Trigger cart recovery<br/>email/notification| DB2["Postgres"]
    DataRequest -->|Export customer data<br/>GDPR| DB3["Postgres"]
    Redact -->|Delete customer PII<br/>GDPR| DB4["Postgres"]
    ShopRedact -->|Delete all shop data<br/>GDPR| DB5["Postgres"]
```

---

## Data Flow Diagrams

### Customer Message Flow (End-to-End)

```mermaid
sequenceDiagram
    participant Customer as Customer<br/>(Browser)
    participant Widget as Widget<br/>(JS)
    participant API as Backend API<br/>(Node.js)
    participant Orch as Orchestrator<br/>(Azure AI)
    participant MCP as Shopify MCP<br/>(Storefront)
    participant DB as Postgres<br/>(Neon)
    participant Cache as Redis<br/>(Upstash)

    Customer->>Widget: Types message
    Widget->>API: POST /api/chat<br/>{message, session_id, shop}
    API->>Cache: Check usage limit
    Cache-->>API: OK / 402 Over limit
    API->>Orch: Send message<br/>(with merchant config, customer context)
    Orch->>Orch: Route to Shopping/Support/Memory agent
    Orch->>MCP: search_catalog<br/>(intent, maxPrice, query)
    MCP-->>Orch: [Product, Product, Product]
    Orch->>DB: Upsert recent_products memory
    Orch->>Orch: Format response with product cards
    API->>DB: INSERT Conversation record
    API->>Cache: Increment usage counter (sync every 10 calls)
    API-->>Widget: SSE stream<br/>event: "message"<br/>data: "Here are some options..."
    Widget->>Customer: Render bot message + product cards
    Customer->>Widget: Click "Add to Cart"
    Widget->>API: POST /api/chat<br/>message: Add 1 "Product" to cart
    API->>Orch: Process add-to-cart intent
    Orch->>MCP: update_cart<br/>(add_items: [{product_variant_id, qty}])
    MCP-->>Orch: Cart updated
    Orch-->>API: Confirmed
    API-->>Widget: event: "meta"<br/>data: {checkout_url, ...}
    Widget->>Customer: Confirm added, show checkout link
```

### Order Attribution & Revenue Tracking

```mermaid
graph LR
    A["Customer completes purchase<br/>(via Shopify checkout)"]
    B["orders/paid webhook"]
    C["Shopify → Backend"]
    D["Fetch conversation<br/>by session_id"]
    E["Neon Postgres"]
    F["Mark conversation<br/>as paid = true"]
    G["Update Merchant stats<br/>(revenue, AOV, count)"]
    H["Dashboard displays<br/>conversion rate"]
    
    A --> B
    B --> C
    C --> D
    E --> D
    D --> F
    F --> G
    G --> H
```

---

## Integration Points

### 1. **Shopify Partner Dashboard** (OAuth, Configuration)
- App registered with Client ID: `d1ed7250a107b38802ff74de11f699f3`
- Scopes: `write_products`, `read_customers`, `write_discounts`, `read_orders`
- Redirect URL: Azure Container App URL
- Webhooks: Configured via `shopify.app.toml` (compliance_topics for GDPR)

### 2. **Azure AI Foundry** (LLM Calls)
- Endpoint: `/openai/v1` (compatible with OpenAI SDK)
- Model: `gpt-4o-mini` (all agents use this)
- Auth: Environment variable `AZURE_OPENAI_API_KEY`
- Streaming: Supported via `vercel/ai` SDK's `generateObject` + streaming

### 3. **Neon PostgreSQL** (Persistent Data)
- URL: `DATABASE_URL` env var
- ORM: Prisma
- Tables: `Merchant`, `Conversation`, `CustomerMemory`, `WebhookLog`
- Backup: Automatic Neon backups

### 4. **Upstash Redis** (Caching & Rate Limiting)
- URL: `REDIS_URL` env var (rediss:// for TLS)
- Keys: `usage:{shop}:{month}`, `neonping_proactive_{shop}`, `neonping_sid_{shop}`
- Strategy: Source-of-truth for live limit checks; Postgres for durability

### 5. **Shopify Storefront MCP** (Live Catalog)
- Endpoint: `https://{shop}/api/mcp` (JSON-RPC 2.0)
- Auth: Customer access token (from storefront, public)
- No caching, always fresh

---

## Database Schema

```mermaid
erDiagram
    MERCHANT ||--o{ CONVERSATION : has
    MERCHANT ||--o{ CUSTOMER_MEMORY : has
    CONVERSATION ||--o{ MESSAGE : contains
    CUSTOMER_MEMORY ||--o{ RECENT_PRODUCTS : stores

    MERCHANT {
        string shopDomain PK
        string widgetGreeting
        string widgetColor
        string widgetPosition
        string brandVoice
        int maxDiscountPct
        int vipCartThreshold
        string plan "free|trial|starter|growth|pro"
        timestamp createdAt
        timestamp updatedAt
    }

    CONVERSATION {
        string id PK
        string shopDomain FK
        string sessionId
        string customerId "nullable"
        text messages "array of {role, content}"
        int cartCreatedCount
        int cartRecoveredCount
        boolean paid "false until orders/paid webhook"
        int totalSpentCents
        timestamp createdAt
        timestamp updatedAt
    }

    CUSTOMER_MEMORY {
        string id PK
        string shopDomain FK
        string customerId
        string[] recentProducts "up to 5 product titles"
        timestamp lastUpdated
    }

    MESSAGE {
        string conversationId FK
        string role "user|bot"
        text content
        json metadata "tools, sources, etc."
        timestamp createdAt
    }
```

---

## Deployment Architecture

```mermaid
graph TB
    subgraph Dev["Development"]
        DevLocalCode["Local Code<br/>(/Users/.../neonping)"]
        DevNpm["npm run dev<br/>--store neonping-dev"]
        DevTunnel["Shopify CLI Tunnel<br/>(changes each restart)"]
        DevStore["Dev Store<br/>(neonping-dev.myshopify.com)"]
        
        DevLocalCode --> DevNpm
        DevNpm --> DevTunnel
        DevTunnel --> DevStore
    end

    subgraph Prod["Production"]
        GitHub["GitHub Repo<br/>(private, NeonPing org)"]
        Dockerfile["Dockerfile<br/>(node:20-alpine)"]
        ACR["Azure Container Registry<br/>(caab3198e06dacr.azurecr.io)"]
        ACA["Azure Container Apps<br/>(neonping-politeocean)"]
        ProdStore["Prod Store<br/>(deployed merchants)"]
        
        GitHub -->|docker build<br/>--platform linux/amd64| Dockerfile
        Dockerfile -->|docker push| ACR
        ACR -->|az containerapp update| ACA
        ACA -->|public HTTPS| ProdStore
    end

    DevStore -.->|Once verified| GitHub
```

**Build process**:
```bash
docker build --platform linux/amd64 \
  -t caab3198e06dacr.azurecr.io/neonping:v4 .
docker push caab3198e06dacr.azurecr.io/neonping:v4
az containerapp update \
  --name neonping \
  --resource-group neonping-rg \
  --image caab3198e06dacr.azurecr.io/neonping:v4
```

**Environment variables** (set on Azure Container App):
```
DATABASE_URL=postgresql://...
REDIS_URL=rediss://...
SHOPIFY_API_KEY=...
SHOPIFY_API_SECRET=...
SHOPIFY_APP_URL=https://neonping.politeocean-a6f0ef16.southcentralus.azurecontainerapps.io
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_ENDPOINT=...
```

---

## Security Model

```mermaid
graph LR
    A["Customer"] -->|Public storefront| B["Widget<br/>(no auth)"]
    B -->|POST /api/chat| C["Rate limit check<br/>(plan-based)"]
    C -->|session_id only| D["Backend"]
    
    E["Merchant"] -->|OAuth via Shopify| F["Admin Embedded App"]
    F -->|authenticate.admin| G["Verify Shopify session"]
    G -->|shop domain| H["Backend"]
    
    D -->|PII boundary:| I["Don't query<br/>customer emails<br/>without<br/>authorization"]
    H -->|PII boundary:| I
    
    J["Webhooks"] -->|HMAC-SHA256<br/>verified| K["Backend"]
    K -->|Only process<br/>valid signatures| L["Persist to DB"]
    
    M["Customer data"] -->|Encrypted<br/>in transit| N["HTTPS/TLS"]
    M -->|Encrypted<br/>at rest| O["Neon + AWS"]
    
    P["Metafields"] -->|namespace:<br/>neonping_chat| Q["Shopify<br/>isolation"]
```

**Key principles**:
- ✅ No customer email harvesting without explicit authorization
- ✅ Webhook HMAC verification (Shopify-signed)
- ✅ GDPR webhooks: customers/data_request, customers/redact, shop/redact
- ✅ Session isolation (session_id is opaque UUID, not predictable)
- ✅ Rate limiting (Redis-based, plan-enforced)
- ✅ Message cap (2000 chars guardrail)
- ✅ Widget size cap (10 KB, verified on every change)

---

## Handoff Checklist for New Developers/AI Assistants

Before starting work, confirm you understand:

- [ ] **Widget is always live**; widget JS is minified and <10KB
- [ ] **No catalog caching**; every `search_catalog` hits Shopify's live MCP
- [ ] **Storefront MCP only**; no Admin API for catalog (intentional, for freshness)
- [ ] **Multi-agent orchestrator** routes messages to Shopping/Support/Personalization/Memory agents
- [ ] **Database tables**: Merchant, Conversation, CustomerMemory, WebhookLog (via Prisma)
- [ ] **Redis is source of truth** for usage limits; Postgres is durable backup
- [ ] **Webhooks are GDPR-mandated**; use `compliance_topics` in TOML, not `topics`
- [ ] **Rate limiting is plan-based** (free/trial/starter:500, growth:2000, pro:unlimited)
- [ ] **Embedded app runs on Azure**, not a dev tunnel; static URL for Shopify OAuth
- [ ] **Session isolation**: session_id is UUID, not customer_id; no customer email in widget
- [ ] **GitHub kanban is source of truth** for what's done/open/blocked

---

## References

- **CLAUDE.md**: Quick start, what's built, what's pending
- **SESSION_STARTER.md**: New session action items
- **Memory file**: `/Users/krkaushikkumar/.claude/projects/-Users-krkaushikkumar-Desktop-neonping/memory/project_neonping.md`
- **GitHub board**: https://github.com/orgs/NeonPing/projects/1
- **Shopify docs**: https://shopify.dev (Storefront MCP, Admin API, Webhooks)

---

Good luck! 🚀
