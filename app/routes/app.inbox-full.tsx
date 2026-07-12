import type { HeadersFunction } from "react-router";
import { useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { inboxLoader, inboxAction } from "~/lib/inbox.server";
import { InboxView } from "~/components/inbox/InboxView";

// Full-screen inbox overlay — rendered inside <s-app-window> via /app/inbox-full.
// No <s-page> wrapper; <ui-title-bar> registers the admin chrome heading.

export const loader = inboxLoader;
export const action = inboxAction;

export default function InboxFull() {
  return (
    <>
      <ui-title-bar title="Inbox" />
      <InboxView variant="full" />
    </>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
