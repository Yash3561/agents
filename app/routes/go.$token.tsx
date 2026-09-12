import type { LoaderFunctionArgs } from "react-router";
import { redis } from "~/redis.server";

/**
 * Redirect target for Global Catalog carousel URL buttons.
 * Tokens are short-lived and map only to HTTPS seller checkout URLs stored in Redis.
 */
export async function loader({ params }: LoaderFunctionArgs) {
  const token = params.token ?? "";
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) {
    return new Response("Invalid checkout link", { status: 400 });
  }

  const destination = await redis.get(`wa:global:checkout:${token}`).catch(() => null);
  if (!destination) return new Response("Checkout link expired", { status: 404 });

  try {
    const url = new URL(destination);
    if (url.protocol !== "https:") throw new Error("non-HTTPS destination");
    return Response.redirect(url.toString(), 302);
  } catch {
    return new Response("Invalid checkout link", { status: 400 });
  }
}

export default function CheckoutRedirect() {
  return null;
}
