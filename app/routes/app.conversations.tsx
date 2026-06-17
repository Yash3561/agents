import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const days = url.searchParams.get("days") || "30";
  const status = url.searchParams.get("status") || "all";

  const since =
    days === "all" ? undefined : new Date(Date.now() - Number(days) * 86400000);

  const where: {
    shopDomain: string;
    startedAt?: { gte: Date };
    escalated?: boolean;
    orderId?: { not: null };
  } = { shopDomain: session.shop };
  if (since) where.startedAt = { gte: since };
  if (status === "escalated") where.escalated = true;
  if (status === "converted") where.orderId = { not: null };

  const conversations = await db.conversation.findMany({
    where,
    orderBy: { lastMessageAt: "desc" },
    take: 50,
    select: {
      id: true,
      sessionId: true,
      customerId: true,
      messageCount: true,
      cartValue: true,
      orderRevenueCents: true,
      escalated: true,
      orderId: true,
      discountCode: true,
      startedAt: true,
      lastMessageAt: true,
    },
  });

  return { conversations, days, status };
}

export default function ConversationsList() {
  const { conversations, days, status } = useLoaderData<typeof loader>();

  const dayOptions = [
    { value: "7", label: "Last 7 days" },
    { value: "30", label: "Last 30 days" },
    { value: "90", label: "Last 90 days" },
    { value: "all", label: "All time" },
  ];

  const statusOptions = [
    { value: "all", label: "All" },
    { value: "escalated", label: "Escalated" },
    { value: "converted", label: "Converted" },
  ];

  const activeLinkStyle: React.CSSProperties = {
    display: "inline-block",
    padding: "4px 12px",
    background: "#1a1a1a",
    color: "#fff",
    borderRadius: "4px",
    textDecoration: "none",
    fontSize: "13px",
    marginRight: "6px",
  };

  const inactiveLinkStyle: React.CSSProperties = {
    display: "inline-block",
    padding: "4px 12px",
    background: "#f0f0f0",
    color: "#333",
    borderRadius: "4px",
    textDecoration: "none",
    fontSize: "13px",
    marginRight: "6px",
  };

  return (
    <s-page heading="Conversations">
      <s-section>
        <div style={{ marginBottom: "12px" }}>
          <span style={{ fontSize: "13px", marginRight: "8px", fontWeight: 600 }}>
            Date range:
          </span>
          {dayOptions.map((opt) => {
            const params = new URLSearchParams({ days: opt.value, status });
            return (
              <a
                key={opt.value}
                href={`/app/conversations?${params.toString()}`}
                style={days === opt.value ? activeLinkStyle : inactiveLinkStyle}
              >
                {opt.label}
              </a>
            );
          })}
        </div>

        <div style={{ marginBottom: "16px" }}>
          <span style={{ fontSize: "13px", marginRight: "8px", fontWeight: 600 }}>
            Status:
          </span>
          {statusOptions.map((opt) => {
            const params = new URLSearchParams({ days, status: opt.value });
            return (
              <a
                key={opt.value}
                href={`/app/conversations?${params.toString()}`}
                style={status === opt.value ? activeLinkStyle : inactiveLinkStyle}
              >
                {opt.label}
              </a>
            );
          })}
        </div>

        {conversations.length === 0 ? (
          <p>No conversations found.</p>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header>Started</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Messages</s-table-header>
              <s-table-header>Cart</s-table-header>
              <s-table-header>Revenue</s-table-header>
              <s-table-header>Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {conversations.map((c) => (
                <s-table-row key={c.id}>
                  <s-table-cell>
                    <s-link href={`/app/conversations/${c.id}`}>
                      {new Date(c.startedAt).toLocaleDateString()}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>
                    {c.customerId ? "Customer" : "Anonymous"}
                  </s-table-cell>
                  <s-table-cell>{c.messageCount}</s-table-cell>
                  <s-table-cell>
                    {c.cartValue != null ? `$${c.cartValue.toFixed(2)}` : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    {c.orderRevenueCents != null
                      ? `$${(c.orderRevenueCents / 100).toFixed(2)}`
                      : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    {c.escalated ? (
                      <s-badge tone="critical">Escalated</s-badge>
                    ) : null}
                    {c.orderId ? (
                      <s-badge tone="success">Converted</s-badge>
                    ) : null}
                    {c.discountCode ? (
                      <s-badge tone="info">Discount</s-badge>
                    ) : null}
                    {!c.escalated && !c.orderId && !c.discountCode ? (
                      <span style={{ color: "#888" }}>—</span>
                    ) : null}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
