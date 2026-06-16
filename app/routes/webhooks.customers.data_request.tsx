import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * Mandatory GDPR webhook. Shopify sends this when a store owner requests a
 * customer's data export on a customer's behalf. We have no automated export
 * pipeline (no admin UI for it yet) — log the request so it can be fulfilled
 * manually within Shopify's 30-day window. Must always return 200.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`, JSON.stringify(payload));

  return new Response();
};
