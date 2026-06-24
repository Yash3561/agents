# Security Policy

## Supported Versions

Only the current `main` branch of NeonPing is actively maintained and receives security updates.

| Version | Supported |
|---------|-----------|
| `main` (latest) | ✅ Yes |
| Older branches / tags | ❌ No |

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security vulnerabilities.**

Report security issues privately by emailing:

**kaushik@neonping.com**

Include as much detail as possible:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept (if available)
- Affected component(s) (e.g., `/api/chat`, widget, merchant portal)
- Any suggested mitigations you may have identified

### Response Timeline

| Milestone | Target |
|-----------|--------|
| Acknowledgement | Within 48 hours of receipt |
| Initial triage & severity assessment | Within 3 business days |
| Patch for **critical** vulnerabilities | Within 7 days of confirmed report |
| Patch for **high** vulnerabilities | Within 14 days |
| Patch for **medium/low** vulnerabilities | Next scheduled release |

We will keep you informed throughout the process and credit you in the changelog (unless you prefer to remain anonymous).

## Scope

### In Scope

The following are considered part of the NeonPing security surface:

- **NeonPing application** — merchant portal, onboarding wizard, settings UI
- **API endpoints** — `/api/chat`, `/api/widget-config`, `/api/webhooks/*`, and all other server routes
- **Storefront widget** — `neonping-widget.js` injected into merchant storefronts
- **Authentication & session handling** — OAuth flow, session tokens, Shopify embedded app auth
- **Data handling** — customer PII stored or transmitted by the app, metafield namespaces, Redis/Postgres data access
- **Rate limiting & billing logic** — bypass or manipulation of usage limits

### Out of Scope

The following are explicitly **not** in scope for NeonPing's security program:

- **Shopify platform** — vulnerabilities in Shopify's core infrastructure, Admin API, or Storefront API should be reported to [Shopify's bug bounty program](https://hackerone.com/shopify)
- **Third-party services** — Azure AI Foundry, Neon PostgreSQL, Upstash Redis, GitHub Actions — report these to the respective vendors
- **Social engineering attacks** against NeonPing team members
- **Physical security**
- **Denial of service** (DoS/DDoS) at the infrastructure level

## Disclosure Policy

NeonPing follows a **coordinated disclosure** model. We ask that you give us a reasonable amount of time to patch a reported issue before any public disclosure. We aim to resolve critical issues within 7 days and will work with you to agree on a disclosure timeline for other severities.

## Thank You

We appreciate the security research community's efforts to keep NeonPing and its merchants safe. Thank you for responsibly disclosing vulnerabilities.
