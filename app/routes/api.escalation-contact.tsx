/**
 * POST /api/escalation-contact
 *
 * Called by the storefront widget when a customer submits their email
 * after the chat is escalated to a human agent. Stores the email against
 * the conversation so the merchant can follow up.
 *
 * Body: { session_id: string, shop: string, email: string }
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "~/db.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// Preflight support
export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return new Response(JSON.stringify({ error: "method_not_allowed" }), {
    status: 405,
    headers: CORS_HEADERS,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  let body: { session_id?: string; shop?: string; email?: string };
  try {
    body = (await request.json()) as { session_id?: string; shop?: string; email?: string };
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  const { session_id, shop, email } = body;

  if (!session_id || !shop || !email) {
    return new Response(JSON.stringify({ error: "missing_fields" }), {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  // Simple email format validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return new Response(JSON.stringify({ error: "invalid_email" }), {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  const conversation = await prisma.conversation.findFirst({
    where: { sessionId: session_id, shopDomain: shop },
  });

  if (!conversation) {
    return new Response(JSON.stringify({ error: "conversation_not_found" }), {
      status: 404,
      headers: CORS_HEADERS,
    });
  }

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { customerEmail: email },
  });

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: CORS_HEADERS,
  });
}
