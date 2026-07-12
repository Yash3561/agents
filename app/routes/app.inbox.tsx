import type { HeadersFunction } from "react-router";
import { useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { inboxLoader, inboxAction } from "~/lib/inbox.server";
import { InboxView } from "~/components/inbox/InboxView";

export const loader = inboxLoader;
export const action = inboxAction;

export default function Inbox() {
  return (
    <s-page heading="Inbox">
      {/* ponytail: s-app-window is a Shopify web component; show() opens full-viewport overlay */}
      <s-app-window id="inbox-win" src="/app/inbox-full" />
      <InboxView variant="panel" />
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
