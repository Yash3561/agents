import { createAzure } from "@ai-sdk/azure";
import { generateObject, generateText, streamText, stepCountIs } from "ai";
import type { InferSchema } from "ai";
import { z } from "zod";

export const azure = createAzure({
  resourceName: process.env.AZURE_OPENAI_RESOURCE_NAME ?? "",
  apiKey: process.env.AZURE_OPENAI_API_KEY ?? "",
  apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? "2025-01-01-preview",
});

export const deployments = {
  orchestrator: () => azure(process.env.AZURE_DEPLOYMENT_ORCHESTRATOR ?? "neonping-orchestrator"),
  shopping:     () => azure(process.env.AZURE_DEPLOYMENT_SHOPPING     ?? "neonping-shopping"),
  support:      () => azure(process.env.AZURE_DEPLOYMENT_SUPPORT      ?? "neonping-support"),
  personalize:  () => azure(process.env.AZURE_DEPLOYMENT_PERSONALIZE  ?? "neonping-personalize"),
  summary:      () => azure(process.env.AZURE_DEPLOYMENT_SUMMARY      ?? "neonping-summary"),
} as const;

// ---------------------------------------------------------------------------
// Structured output — Orchestrator uses this with a Zod schema
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
    maxOutputTokens: opts.maxOutputTokens ?? 500,
  });
  return result.object as z.infer<SCHEMA>;
}

// ---------------------------------------------------------------------------
// Tool-calling stream — Shopping / Support use this
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
