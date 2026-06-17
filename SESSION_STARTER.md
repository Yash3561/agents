# NeonPing — New Session Starter

**Current date**: 2026-06-17  
**Status**: ✅ Live on Azure, merchant portal verified working end-to-end, ready for next features  
**Production URL**: https://neonping.politeocean-a6f0ef16.southcentralus.azurecontainerapps.io

---

## Start Here (Every New Session)

1. **Read CLAUDE.md** — full context, architecture, what's built, what's pending
2. **Read memory file** — `/Users/krkaushikkumar/.claude/projects/-Users-krkaushikkumar-Desktop-neonping/memory/project_neonping.md`
3. **Check GitHub board** — https://github.com/orgs/NeonPing/projects/1 (source of truth for what's done/open)

---

## Immediate Action Items (Pick One)

### Option A: Live Verification (Test & Report)
**Time estimate**: 1-2 hours  
**Outcome**: Mark features as fully verified or surface real bugs

```
These are all code-complete but NOT YET live-verified:
- #51: Settings widget preview (color/position/greeting should update live while editing)
- #49: recent_products memory (customer should see bot mention products they browsed)
- Mobile proactive trigger (30s time-on-page should fire on mobile)
- Exit-intent fire-time fix (two different triggers shouldn't both fire)

Need real Shopify admin embedded session to test.
```

**How to test:**
```
NO tunnel needed — Azure is live and working.
Go to: https://admin.shopify.com/store/neonping-dev/apps/d1ed7250a107b38802ff74de11f699f3
If it won't load, hit the auth URL first:
https://neonping.politeocean-a6f0ef16.southcentralus.azurecontainerapps.io/auth?shop=neonping-dev.myshopify.com
```

**Then**: Update GitHub issues (#51, #49, #46) with live verification notes (either close with "verified" or note what broke)

---

### Option B: Next Feature — Shopify Billing API (#27)
**Time estimate**: 2-3 hours  
**Blocks**: Real plan assignment (currently all merchants default to `plan: "free"`)  
**Why**: #28 (usage metering) has the limit enforcement working but can't actually upgrade merchants to paid plans

**What to build:**
- Call `POST /api/graphql.json` with `billingCycleDiscount` query (Shopify's API for offering plans)
- Create webhook for `app/subscriptions/update` to capture when merchant chooses a plan
- Store the chosen plan (`starter`/`growth`/`pro`) in the `Merchant` table
- Verify limits are enforced against the real plan (not just the hardcoded `"free"` default)

**Reference**: Shopify Billing API docs (search "Recurring Application Charges")

---

### Option C: Email Provider Setup (#50)
**Time estimate**: 1 hour  
**Blocks**: #28 usage warning emails  
**Decision needed**: Pick an email provider

```
Options:
- Resend (easiest, $0.10/email)
- SendGrid (free tier 100/day)
- AWS SES (pay-per-use, ~$0.10/email)
- Mailgun (free tier, slightly more setup)
```

**If you pick one**: Wire it into `billingWarning()` in `billing.server.ts`, test, close #50

---

### Option D: App Store Listing (#37)
**Time estimate**: 1-2 hours  
**Outcome**: Copy + images ready for Shopify App Store  
**Unique selling point**: "Never syncs catalog = no stale data, no hallucinations" (from competitive research)

**What to create:**
- App name & tagline (30 chars)
- Long description (~500 chars)
- 3-5 screenshots showing: widget in action, settings UI, dashboard
- Icon (600x600 PNG)
- Category tags

---

## Dev Environment

```bash
cd /Users/krkaushikkumar/Desktop/neonping

# Start dev (tunnel URL will change each time)
npm run dev -- --store neonping-dev.myshopify.com

# Install deps if needed
npm install

# Type check
npx tsc --noEmit

# Widget size check (must be <10KB)
wc -c extensions/chat-widget/assets/neonping-widget.js
```

---

## Git Workflow

```bash
# Always create new commits (never amend published ones)
git add <specific files>
git commit -m "feat/fix: description

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"

# Don't push unless explicitly asked — just commit locally
git status
```

---

## Files You'll Touch Most Often

| Path | Purpose |
|------|---------|
| `app/routes/app.settings.tsx` | Merchant widget settings UI |
| `app/routes/app._index.tsx` | Merchant dashboard |
| `extensions/chat-widget/assets/neonping-widget.js` | Storefront widget (minified) |
| `app/lib/agents/` | AI agents (Orchestrator, Shopping, etc.) |
| `app/lib/mcp/` | Shopify MCP integration (catalog, cart) |
| `app/lib/billing.server.ts` | Usage metering + plan limits |
| `shopify.app.toml` | App config, webhooks |
| `.env.local` | Local dev secrets |

---

## Common Gotchas

**"shopify app dev" won't start?**
→ Check `shopify.app.toml` for `compliance_topics` (not `topics`) on GDPR webhooks

**Embedded app login fails?**
→ Use `(p) Open app preview` from terminal, not Apps list; try incognito; restart dev if tunnel changed

**Widget not reflecting saved settings?**
→ Check `/api/widget-config` endpoint returns the values; widget caches in localStorage

**Rate limiting broken?**
→ Verify Redis is reachable; confirm `checkAndIncrementUsage()` called from `api.chat.tsx`

---

## Kanban Rule (Non-Negotiable)

**Every task you complete must be tracked on GitHub.** Either:
- **Close it** with a comment explaining what was verified/built
- **Leave it open** with honest notes if it's partial (don't pretend it's done)
- **File retroactively** if you did untracked work

Examples:
```
✅ Closed: "Live-verified on neonping-dev store, color/position/greeting all update live as expected"
⏳ Left open: "Code is tsc-clean but couldn't test in Shopify admin due to login issue — left for next session"
🔄 Updated: "Added to this issue: switched from Resend to SendGrid due to cost"
```

---

## Quick Decision Tree

```
"What should I work on?"
├─ Unsure? → Ask the user or read the GitHub board
├─ Feature code + can test live? → Verify #51, #49, or mobile trigger
├─ Want new capability? → Try #27 Billing API (highest impact)
├─ Blocked by decisions? → Pick email provider (#50) or ask user
└─ Want to move toward launch? → #37 App Store listing copy/images
```

---

## Persistent References

- **Memory file**: `/Users/krkaushikkumar/.claude/projects/-Users-krkaushikkumar-Desktop-neonping/memory/project_neonping.md`
  - What's built, what's blocked, why past decisions were made
- **CLAUDE.md**: Root directory, full context
- **Plan file**: `~/.claude/plans/keen-hopping-mccarthy.md` (may be outdated, check with user if referenced)
- **GitHub board**: https://github.com/orgs/NeonPing/projects/1 (source of truth)

---

Good luck! 🚀
