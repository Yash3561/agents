/**
 * LLM provider — Azure AI Foundry via OpenAI-compatible endpoint.
 *
 * We use the /openai/v1 surface on services.ai.azure.com rather than the
 * Foundry Agent Service thread API. Reason: Foundry Agents lock the system
 * prompt in the portal and strip runtime overrides — incompatible with our
 * per-merchant dynamic prompts. The /openai/v1 endpoint is fully stateless,
 * accepts dynamic system prompts per call, and works with @ai-sdk/openai-compatible.
 *
 * Migration to Azure OpenAI (openai.azure.com) if needed later:
 * swap createOpenAICompatible for createAzure — zero changes in agents/routes.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText, stepCountIs, type LanguageModelUsage } from "ai";
import prisma from "~/db.server";

// ---------------------------------------------------------------------------
// Provider — Azure AI Foundry /openai/v1 endpoint
// ---------------------------------------------------------------------------

const foundry = createOpenAICompatible({
  name: "azure-foundry",
  baseURL:
    process.env.AZURE_FOUNDRY_BASE_URL ??
    `https://${process.env.AZURE_OPENAI_RESOURCE_NAME ?? "neonping-resource"}.services.ai.azure.com/openai/v1`,
  apiKey: process.env.AZURE_OPENAI_API_KEY ?? "",
  supportsStructuredOutputs: true,
});

// All unified agent calls use gpt-4o-mini — differentiated by system prompt, not model.
const SPECIALIST_MODEL = process.env.AZURE_SPECIALIST_MODEL ?? "gpt-4o-mini";

export const deployments = {
  shopping: () => foundry(SPECIALIST_MODEL),
} as const;

// ---------------------------------------------------------------------------
// Token usage tracking — groundwork for a cost/usage dashboard. Fire-and-forget,
// day-granularity upsert-increment; never blocks or fails the calling agent.
// cachedInputTokens lets the dashboard verify the prompt-cache-alignment work
// (see prompt.server.ts) is actually landing provider-side cache hits.
// ---------------------------------------------------------------------------

export async function recordLlmUsage(
  shopDomain: string,
  agent: "unified" | "whatsapp" | "summary",
  usage: LanguageModelUsage,
): Promise<void> {
  try {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    await prisma.llmUsage.upsert({
      where: { shopDomain_date_agent: { shopDomain, date, agent } },
      create: {
        shopDomain,
        date,
        agent,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
        callCount: 1,
      },
      update: {
        inputTokens: { increment: usage.inputTokens ?? 0 },
        outputTokens: { increment: usage.outputTokens ?? 0 },
        cachedInputTokens: { increment: usage.inputTokenDetails?.cacheReadTokens ?? 0 },
        callCount: { increment: 1 },
      },
    });
  } catch {
    // Telemetry is best-effort — never let a usage-tracking failure affect the agent.
  }
}

// ---------------------------------------------------------------------------
// Tool-calling stream — Shopping / Support agents
// ---------------------------------------------------------------------------

export function runAgentStream(opts: {
  deployment: ReturnType<(typeof deployments)[keyof typeof deployments]>;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools?: Parameters<typeof streamText>[0]["tools"];
  maxOutputTokens?: number;
  maxSteps?: number;
  /** When provided, usage is recorded fire-and-forget once the stream completes. */
  shopDomain?: string;
  agentLabel?: "unified" | "whatsapp";
}) {
  const result = streamText({
    model: opts.deployment,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    maxOutputTokens: opts.maxOutputTokens ?? 600,
    stopWhen: stepCountIs(opts.maxSteps ?? 5),
    abortSignal: AbortSignal.timeout(25_000),
  });
  if (opts.shopDomain) {
    // result.usage is a PromiseLike (streamText's usage resolves once the stream ends),
    // not a full Promise — use the two-arg .then() form since .catch() isn't available.
    void result.usage.then(
      (usage) => recordLlmUsage(opts.shopDomain!, opts.agentLabel ?? "unified", usage),
      () => {},
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// One-shot text — Memory Agent summarization
// ---------------------------------------------------------------------------

export async function generateSummary(system: string, prompt: string, shopDomain?: string): Promise<string> {
  const result = await generateText({
    model: deployments.shopping(),
    system,
    prompt,
    maxOutputTokens: 200,
    abortSignal: AbortSignal.timeout(25_000),
  });
  if (shopDomain) void recordLlmUsage(shopDomain, "summary", result.usage).catch(() => {});
  return result.text.trim();
}
