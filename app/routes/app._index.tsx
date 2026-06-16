import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  await prisma.merchant.upsert({
    where: { shopDomain: shop },
    update: {},
    create: { shopDomain: shop },
  });

  const url = new URL(request.url);
  const filter = url.searchParams.get("filter");
  const listWhere =
    filter === "escalated"
      ? { shopDomain: shop, escalated: true }
      : { shopDomain: shop };

  const [
    totalConversations,
    escalatedCount,
    conversionsCount,
    discountsUsedCount,
    revenueAgg,
    conversations,
  ] = await Promise.all([
    prisma.conversation.count({ where: { shopDomain: shop } }),
    prisma.conversation.count({ where: { shopDomain: shop, escalated: true } }),
    prisma.conversation.count({ where: { shopDomain: shop, orderId: { not: null } } }),
    prisma.conversation.count({ where: { shopDomain: shop, discountCode: { not: null } } }),
    prisma.conversation.aggregate({
      where: { shopDomain: shop, orderId: { not: null } },
      _sum: { orderRevenueCents: true },
    }),
    prisma.conversation.findMany({
      where: listWhere,
      orderBy: { lastMessageAt: "desc" },
      take: 30,
    }),
  ]);

  return {
    filter,
    stats: {
      totalConversations,
      escalatedCount,
      conversionsCount,
      discountsUsedCount,
      revenueCents: revenueAgg._sum.orderRevenueCents ?? 0,
    },
    conversations,
  };
};

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-text tone="neutral">{label}</s-text>
      <s-heading>{value}</s-heading>
    </s-box>
  );
}

export default function Index() {
  const { stats, conversations, filter } = useLoaderData<typeof loader>();

  const escalationRatePct = stats.totalConversations
    ? Math.round((stats.escalatedCount / stats.totalConversations) * 100)
    : 0;
  const resolutionRatePct = 100 - escalationRatePct;
  const conversionRatePct = stats.totalConversations
    ? Math.round((stats.conversionsCount / stats.totalConversations) * 100)
    : 0;
  const revenue = (stats.revenueCents / 100).toFixed(2);

  return (
    <s-page heading="NeonPing Dashboard">
      <s-section heading="Performance">
        <s-grid gridTemplateColumns="1fr 1fr 1fr 1fr 1fr" gap="base">
          <Metric label="Conversations" value={String(stats.totalConversations)} />
          <Metric label="Resolution rate" value={`${resolutionRatePct}%`} />
          <Metric label="Revenue attributed" value={`$${revenue}`} />
          <Metric label="Conversion rate" value={`${conversionRatePct}%`} />
          <Metric label="Discounts used" value={String(stats.discountsUsedCount)} />
        </s-grid>
      </s-section>

      <s-section heading="Conversations">
        <s-stack direction="inline" gap="base">
          <s-link href="/app">{filter === "escalated" ? "All" : "All (showing)"}</s-link>
          <s-link href="/app?filter=escalated">
            {filter === "escalated" ? "Escalated (showing)" : "Escalated"}
          </s-link>
        </s-stack>

        {conversations.length === 0 ? (
          <s-paragraph>No conversations yet.</s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Started</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Messages</s-table-header>
              <s-table-header>Revenue</s-table-header>
              <s-table-header>Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {conversations.map((c) => (
                <s-table-row key={c.id}>
                  <s-table-cell>{new Date(c.startedAt).toLocaleString()}</s-table-cell>
                  <s-table-cell>{c.customerId ? "Customer" : "Anonymous"}</s-table-cell>
                  <s-table-cell>{c.messageCount}</s-table-cell>
                  <s-table-cell>
                    {c.orderRevenueCents
                      ? `$${(c.orderRevenueCents / 100).toFixed(2)}`
                      : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    {c.escalated ? <s-badge tone="critical">Escalated</s-badge> : null}
                    {c.discountCode ? <s-badge tone="success">Discount</s-badge> : null}
                    {!c.escalated && !c.discountCode ? (
                      <s-text tone="neutral">—</s-text>
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

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
