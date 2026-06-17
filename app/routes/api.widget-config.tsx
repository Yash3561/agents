/**
 * GET /api/widget-config?shop=...
 *
 * Lightweight, anonymous, cacheable lookup the widget calls at load time so
 * that changes made on the merchant's Settings page (app.settings.tsx) take
 * effect immediately on the storefront, without needing to also touch the
 * theme editor's block settings (which remain as the fallback/default).
 */
import type { LoaderFunctionArgs } from "react-router";
import prisma from "~/db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  if (!shop) {
    return new Response(JSON.stringify({}), { headers });
  }

  const merchant = await prisma.merchant.findUnique({ where: { shopDomain: shop } });
  if (!merchant) {
    return new Response(JSON.stringify({}), { headers });
  }

  return new Response(
    JSON.stringify({
      color: merchant.widgetColor,
      position: merchant.widgetPosition,
      greeting: merchant.widgetGreeting,
      excludedPages: merchant.excludedPages,
    }),
    { headers },
  );
}
