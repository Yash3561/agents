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
import { generateObject, generateText, streamText, stepCountIs } from "ai";
import { z } from "zod";

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

// All 5 roles use gpt-4o-mini — differentiated by system prompt, not model.
// Upgrade orchestrator to gpt-4o when routing quality issues are observed.
const ORCHESTRATOR_MODEL = process.env.AZURE_ORCHESTRATOR_MODEL ?? "gpt-4o-mini";
const SPECIALIST_MODEL   = process.env.AZURE_SPECIALIST_MODEL   ?? "gpt-4o-mini";

export const deployments = {
  orchestrator: () => foundry(ORCHESTRATOR_MODEL),
  shopping:     () => foundry(SPECIALIST_MODEL),
  support:      () => foundry(SPECIALIST_MODEL),
  personalize:  () => foundry(SPECIALIST_MODEL),
  summary:      () => foundry(SPECIALIST_MODEL),
} as const;

// ---------------------------------------------------------------------------
// Structured output — Orchestrator routing decision
// ---------------------------------------------------------------------------

export async function generateStructured<SCHEMA extends z.ZodTypeAny>(opts: {
  deployment: ReturnType<(typeof deployments)[keyof typeof deployments]>;
  system: string;
  prompt: string;
  schema: SCHEMA;
  maxOutputTokens?: number;
}): Promise<z.infer<SCHEMA>> {
  const result = await generateObject({
    model: opts.deployment,
    system: opts.system,
    prompt: opts.prompt,
    schema: opts.schema,
    maxOutputTokens: opts.maxOutputTokens ?? 200,
  });
  return result.object as z.infer<SCHEMA>;
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
}) {
  return streamText({
    model: opts.deployment,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    maxOutputTokens: opts.maxOutputTokens ?? 600,
    stopWhen: stepCountIs(opts.maxSteps ?? 5),
  });
}

// ---------------------------------------------------------------------------
// One-shot text — Memory Agent summarization
// ---------------------------------------------------------------------------

export async function generateSummary(system: string, prompt: string): Promise<string> {
  const result = await generateText({
    model: deployments.summary(),
    system,
    prompt,
    maxOutputTokens: 200,
  });
  return result.text.trim();
}
