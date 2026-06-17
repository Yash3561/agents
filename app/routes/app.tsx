import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  const navItems = [
    { href: "/app", label: "Home", icon: "📊" },
    { href: "/app/settings", label: "Settings", icon: "⚙️" },
    { href: "/app/ai-config", label: "AI Config", icon: "🤖" },
    { href: "/app/billing", label: "Billing", icon: "💳" },
  ];

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        {navItems.map((item) => (
          <s-link key={item.href} href={item.href}>
            <span style={{ marginRight: "6px" }}>{item.icon}</span>
            {item.label}
          </s-link>
        ))}
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
