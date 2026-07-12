import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { data } = shopify;
  const customerId = data.selected[0]?.id;

  const [state, setState] = useState({ loading: true, conversations: [], error: false });

  useEffect(() => {
    if (!customerId) {
      setState({ loading: false, conversations: [], error: false });
      return;
    }
    fetch(`/api/admin-extension/customer-summary?customerId=${encodeURIComponent(customerId)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json) => setState({ loading: false, conversations: json.conversations ?? [], error: false }))
      .catch(() => setState({ loading: false, conversations: [], error: true }));
  }, [customerId]);

  if (state.loading) {
    return (
      <s-admin-block heading="NeonPing AI conversations">
        <s-spinner accessibilityLabel="Loading conversations" />
      </s-admin-block>
    );
  }

  if (state.error) {
    return (
      <s-admin-block heading="NeonPing AI conversations">
        <s-banner tone="critical">Couldn&apos;t load conversation data. Try refreshing the page.</s-banner>
      </s-admin-block>
    );
  }

  if (!state.conversations.length) {
    return (
      <s-admin-block heading="NeonPing AI conversations">
        <s-text tone="neutral">No NeonPing AI conversations with this customer yet.</s-text>
      </s-admin-block>
    );
  }

  return (
    <s-admin-block heading="NeonPing AI conversations">
      <s-stack direction="block" gap="base">
        {state.conversations.map((c) => (
          <s-stack key={c.id} direction="block" gap="tight">
            <s-stack direction="inline" gap="base">
              <s-badge tone={c.resolved ? "success" : c.escalated ? "warning" : "info"}>
                {c.resolved ? "Resolved" : c.escalated ? "Needs reply" : "AI handling"}
              </s-badge>
              <s-text tone="neutral">{c.channel === "whatsapp" ? "WhatsApp" : "Storefront widget"}</s-text>
            </s-stack>
            {c.firstUserMessage ? <s-text>&quot;{c.firstUserMessage}&quot;</s-text> : null}
            <s-link href={c.inboxUrl} target="_blank">
              View in NeonPing
            </s-link>
            <s-divider />
          </s-stack>
        ))}
      </s-stack>
    </s-admin-block>
  );
}
