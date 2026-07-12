import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { data } = shopify;
  const orderId = data.selected[0]?.id;

  const [state, setState] = useState({ loading: true, summary: null, error: false });

  useEffect(() => {
    if (!orderId) {
      setState({ loading: false, summary: null, error: false });
      return;
    }
    fetch(`/api/admin-extension/order-summary?orderId=${encodeURIComponent(orderId)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json) => setState({ loading: false, summary: json.found ? json : null, error: false }))
      .catch(() => setState({ loading: false, summary: null, error: true }));
  }, [orderId]);

  if (state.loading) {
    return (
      <s-admin-block heading="NeonPing AI conversation">
        <s-spinner accessibilityLabel="Loading conversation" />
      </s-admin-block>
    );
  }

  if (state.error) {
    return (
      <s-admin-block heading="NeonPing AI conversation">
        <s-banner tone="critical">Couldn&apos;t load conversation data. Try refreshing the page.</s-banner>
      </s-admin-block>
    );
  }

  if (!state.summary) {
    return (
      <s-admin-block heading="NeonPing AI conversation">
        <s-text tone="neutral">This order wasn&apos;t placed through a NeonPing AI conversation.</s-text>
      </s-admin-block>
    );
  }

  const s = state.summary;
  return (
    <s-admin-block heading="NeonPing AI conversation">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base">
          <s-badge tone={s.resolved ? "success" : s.escalated ? "warning" : "info"}>
            {s.resolved ? "Resolved" : s.escalated ? "Needs reply" : "AI handling"}
          </s-badge>
          <s-text tone="neutral">{s.channel === "whatsapp" ? "WhatsApp" : "Storefront widget"}</s-text>
        </s-stack>
        {s.firstUserMessage ? (
          <s-text>&quot;{s.firstUserMessage}&quot;</s-text>
        ) : null}
        <s-text tone="neutral">{s.messageCount} messages{s.discountCode ? ` · discount ${s.discountCode} used` : ""}</s-text>
        <s-link href={s.inboxUrl} target="_blank">
          View full conversation in NeonPing
        </s-link>
      </s-stack>
    </s-admin-block>
  );
}
