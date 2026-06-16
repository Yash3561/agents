import { callMcpTool } from "~/lib/mcp/client.server";

const STOREFRONT_ENDPOINT = (shop: string) => `https://${shop}/api/mcp`;

const AGENT_PROFILE =
  process.env.SHOPIFY_APP_URL
    ? `${process.env.SHOPIFY_APP_URL}/.well-known/ucp-agent.json`
    : "https://neonping.azurecontainerapps.io/.well-known/ucp-agent.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Real Shopify response (confirmed via live call) is a bare array of QA pairs,
// not a { text } object.
export interface PolicyQA {
  question: string;
  answer: string;
}

export interface PolicyResult {
  text: string;
  source_url?: string;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

/**
 * Search the merchant's shop policies and FAQs.
 * Returns null when no relevant policy is found — callers must handle gracefully.
 */
export async function searchPoliciesAndFaqs(
  shopDomain: string,
  query: string,
  context?: string,
): Promise<PolicyResult | null> {
  const args: Record<string, unknown> = {
    query,
    ...(context ? { context } : {}),
  };

  const result = await callMcpTool<PolicyQA[]>(
    { endpoint: STOREFRONT_ENDPOINT(shopDomain), agentProfileUrl: AGENT_PROFILE },
    "search_shop_policies_and_faqs",
    args,
  );

  const entries = result.structuredContent;
  if (!Array.isArray(entries) || entries.length === 0) return null;

  return {
    text: entries.map((e) => `${e.question}\n${e.answer}`).join("\n\n"),
  };
}
