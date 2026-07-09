/**
 * Real-model eval suite gate. Unlike tests/unit and tests/integration, these
 * tests call the actual Azure AI Foundry endpoint via app/lib/llm.server.ts —
 * no mocked generateText/streamText. That needs real credentials this repo's
 * sandbox (and most CI runs) won't have, so every eval `it` is skipped
 * (not failed) when they're absent — see README.md in this directory for
 * exactly which vars and how to run for real.
 */
export const hasCreds = Boolean(
  (process.env.AZURE_FOUNDRY_BASE_URL || process.env.AZURE_OPENAI_RESOURCE_NAME) &&
    process.env.AZURE_OPENAI_API_KEY,
);
