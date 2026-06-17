import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError, useLocation } from "react-router";
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
  const location = useLocation();

  const navItems = [
    { href: "/app", label: "Home" },
    { href: "/app/conversations", label: "Conversations" },
    { href: "/app/settings", label: "Settings" },
    { href: "/app/ai-config", label: "Knowledge Base" },
    { href: "/app/billing", label: "Billing" },
  ];

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        {navItems.map((item) => {
          const isActive =
            item.href === "/app"
              ? location.pathname === "/app"
              : location.pathname.startsWith(item.href);
          return (
            <span
              key={item.href}
              style={isActive ? { fontWeight: 700, color: "#1a1a1a" } : {}}
            >
              <s-link href={item.href}>{item.label}</s-link>
            </span>
          );
        })}
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
