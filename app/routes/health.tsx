/**
 * GET /health
 *
 * Health check endpoint polled by the CI pipeline to confirm the container
 * is up after an Azure Container Apps deploy. No auth required.
 */
import type { LoaderFunctionArgs } from "react-router";

export async function loader({ request: _request }: LoaderFunctionArgs) {
  const body = JSON.stringify({
    status: "ok",
    version: process.env.BUILD_VERSION ?? "dev",
    timestamp: new Date().toISOString(),
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
