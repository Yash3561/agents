# LLM prompt evals

Real-model tests for the shopping/WhatsApp agent system prompts
(`app/lib/prompt.server.ts`, `buildWhatsAppPrompt` in
`app/lib/agents/whatsapp.server.ts`). These call the real
`runUnifiedAgent` / `runWhatsAppAgent` entry points with the real prompt
text and real tool schemas, against a real Azure AI Foundry model — the
only thing mocked is the Shopify MCP network boundary (catalog/cart/
discounts/policy/order/memory), the same way `tests/unit/*.test.ts`
mocks it, except `ai` and `~/lib/llm.server` are left real here.

This is why they live outside `tests/unit` and `tests/integration`: they
are nondeterministic, cost real tokens, and need real credentials — they
must never run as part of `npm test`, `test:unit`, or CI's `pr-gate.yml`.

## Running for real

```bash
AZURE_FOUNDRY_BASE_URL=https://<resource>.services.ai.azure.com/openai/v1 \
AZURE_OPENAI_API_KEY=<key> \
AZURE_SPECIALIST_MODEL=gpt-4o-mini \
npm run eval
```

(`AZURE_OPENAI_RESOURCE_NAME` works instead of `AZURE_FOUNDRY_BASE_URL`,
same as `app/lib/llm.server.ts`.) Without credentials, every case is
skipped (reported as "skipped", not failed) — `npm run eval` exits 0.

## When to run this

Run it by hand after editing `prompt.server.ts` or `buildWhatsAppPrompt`,
before merging. It is deliberately NOT wired into `pr-gate.yml`: a flaky,
paid, real-network suite blocking every PR (including PRs that don't
touch a prompt) is the wrong trade. If prompt edits become frequent
enough that this is forgotten in practice, promote it to a scheduled
(e.g. nightly/weekly) GitHub Actions workflow with Azure creds in repo
secrets rather than a `pull_request`-triggered gate.

## Adding a case

Follow the existing files: mock the MCP layer exactly like
`tests/unit/unified-agent-fixes.test.ts` / `whatsapp-cart-assist.test.ts`
already do, but do NOT mock `ai` or `~/lib/llm.server` — that's what
makes it a real-model eval instead of a mocked orchestration test.
Assertions on model text should stay loose (substrings, length bounds,
sentence counts) — real model output varies run to run.
