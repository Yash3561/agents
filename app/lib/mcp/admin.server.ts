import { McpError } from "~/lib/mcp/client.server";

const API_VERSION = "2026-04";

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; locations?: unknown }>;
}

interface UserError {
  field: string[];
  message: string;
}

/**
 * Execute an Admin GraphQL query or mutation against a merchant's store.
 * Used by Memory Agent (metafields) and Personalization Agent (discounts, tags).
 *
 * @param shopDomain    e.g. "auranod.myshopify.com"
 * @param accessToken   Merchant's Shopify access token (from our Postgres Session table)
 * @param query         GraphQL query or mutation string
 * @param variables     Optional variables object
 */
export async function adminGraphql<T = unknown>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const url = `https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new McpError(`Admin GraphQL network error: ${msg}`, -32000);
  }

  if (!response.ok) {
    throw new McpError(
      `Admin GraphQL HTTP ${response.status} for ${shopDomain}`,
      response.status,
    );
  }

  const json = (await response.json()) as GraphQLResponse<T & { userErrors?: UserError[] }>;

  if (json.errors?.length) {
    throw new McpError(
      json.errors.map((e) => e.message).join("; "),
      -32000,
      json.errors,
    );
  }

  // Surface userErrors from mutations (discountCodeBasicCreate, etc.)
  const data = json.data as Record<string, { userErrors?: UserError[] }> | undefined;
  if (data) {
    for (const value of Object.values(data)) {
      if (value?.userErrors?.length) {
        const msg = value.userErrors.map((e) => `${e.field.join(".")}: ${e.message}`).join("; ");
        throw new McpError(`Admin GraphQL userErrors: ${msg}`, -32000, value.userErrors);
      }
    }
  }

  if (!json.data) {
    throw new McpError("Admin GraphQL returned no data", -32000);
  }

  return json.data;
}
