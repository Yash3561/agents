import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { Prisma } from "@prisma/client";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getUsage } from "../lib/billing.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const merchant = await prisma.merchant.upsert({
    where: { shopDomain: shop },
    update: {},
    create: { shopDomain: shop },
  });

  const url = new URL(request.url);

  if (!merchant.onboardedAt) {
    throw redirect(`/app/onboarding?${url.searchParams.toString()}`);
  }

  const days = url.searchParams.get("days") || "30";
  const since = days === "all" ? undefined : new Date(Date.now() - Number(days) * 86400000);
  const dateFilter = since ? { startedAt: { gte: since } } : {};

  const filter = url.searchParams.get("filter");
  const listWhere =
    filter === "escalated"
      ? { shopDomain: shop, escalated: true, ...dateFilter }
      : { shopDomain: shop, ...dateFilter };

  const [
    totalConversations,
    escalatedCount,
    conversionsCount,
    discountsUsedCount,
    revenueAgg,
    cartsCreatedCount,
    cartsRecoveredCount,
    conversations,
    recentEscalations,
    usage,
  ] = await Promise.all([
    prisma.conversation.count({ where: { shopDomain: shop, ...dateFilter } }),
    prisma.conversation.count({ where: { shopDomain: shop, escalated: true, ...dateFilter } }),
    prisma.conversation.count({ where: { shopDomain: shop, orderId: { not: null }, ...dateFilter } }),
    prisma.conversation.count({ where: { shopDomain: shop, discountCode: { not: null }, ...dateFilter } }),
    prisma.conversation.aggregate({
      where: { shopDomain: shop, orderId: { not: null }, ...dateFilter },
      _sum: { orderRevenueCents: true },
    }),
    prisma.conversation.count({ where: { shopDomain: shop, cartId: { not: null }, ...dateFilter } }),
    prisma.conversation.count({
      where: { shopDomain: shop, cartId: { not: null }, orderId: { not: null }, ...dateFilter },
    }),
    prisma.conversation.findMany({
      where: listWhere,
      orderBy: { lastMessageAt: "desc" },
      take: 30,
    }),
    prisma.conversation.findMany({
      where: {
        shopDomain: shop,
        escalated: true,
        lastMessageAt: { gte: new Date(Date.now() - 48 * 3600000) },
      },
      orderBy: { lastMessageAt: "desc" },
      take: 5,
      select: { id: true, sessionId: true, lastMessageAt: true, customerId: true },
    }),
    getUsage(shop),
  ]);

  // Agent routing breakdown from agentTrace JSON — agentTrace column exists in schema
  const rawRouting = await prisma.$queryRaw<Array<{ route: string; count: bigint }>>`
    SELECT agentTrace::json->0->>'route' as route, COUNT(*) as count
    FROM "Conversation" WHERE "shopDomain" = ${shop}
    ${since ? Prisma.sql`AND "startedAt" >= ${since}` : Prisma.sql``}
    AND "agentTrace" IS NOT NULL GROUP BY 1
  `;
  const routingData = rawRouting.map((r) => ({
    route: String(r.route || "unknown"),
    count: Number(r.count),
  }));

  return {
    days,
    filter,
    stats: {
      totalConversations,
      escalatedCount,
      conversionsCount,
      discountsUsedCount,
      revenueCents: revenueAgg._sum.orderRevenueCents ?? 0,
      cartsCreatedCount,
      cartsRecoveredCount,
    },
    conversations,
    recentEscalations,
    usage,
    routingData,
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
  const { stats, conversations, filter, days, recentEscalations, usage, routingData } =
    useLoaderData<typeof loader>();

  const escalationRatePct = stats.totalConversations
    ? Math.round((stats.escalatedCount / stats.totalConversations) * 100)
    : 0;
  const resolutionRatePct = 100 - escalationRatePct;
  const conversionRatePct = stats.totalConversations
    ? Math.round((stats.conversionsCount / stats.totalConversations) * 100)
    : 0;
  const revenue = (stats.revenueCents / 100).toFixed(2);
  const aov = stats.conversionsCount
    ? (stats.revenueCents / stats.conversionsCount / 100).toFixed(2)
    : "0.00";
  const cartRecoveryRatePct = stats.cartsCreatedCount
    ? Math.round((stats.cartsRecoveredCount / stats.cartsCreatedCount) * 100)
    : 0;

  return (
    <s-page heading="NeonPing Dashboard">
      {usage.used >= usage.limit && (
        <s-banner tone="critical">
          {"You've reached your "}
          {usage.limit}
          {" conversation limit this month. "}
          <a href="/app/billing">Upgrade your plan</a>
          {" to continue."}
        </s-banner>
      )}
      {usage.used >= usage.limit * 0.8 && usage.used < usage.limit && (
        <s-banner tone="warning">
          {"You've used "}
          {Math.round((usage.used / usage.limit) * 100)}
          {"% of your "}
          {usage.limit}
          {" monthly conversations. "}
          <a href="/app/billing">Upgrade soon</a>
          {"."}
        </s-banner>
      )}

      <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
        {(["7", "30", "90", "all"] as const).map((d) => (
          <a
            key={d}
            href={`?days=${d}`}
            style={{
              padding: "6px 12px",
              background: days === d ? "#1a1a1a" : "#f0f0f0",
              color: days === d ? "#fff" : "#333",
              borderRadius: "4px",
              textDecoration: "none",
              fontSize: "14px",
            }}
          >
            {d === "all" ? "All time" : `${d} days`}
          </a>
        ))}
      </div>

      {recentEscalations.length > 0 && (
        <s-section heading={`Needs attention (${recentEscalations.length})`}>
          {recentEscalations.map((e) => (
            <div
              key={e.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "8px 0",
                borderBottom: "1px solid #e5e5e5",
              }}
            >
              <span style={{ fontFamily: "monospace", fontSize: "13px" }}>
                {e.sessionId.slice(0, 8)}...
              </span>
              <span style={{ fontSize: "12px", color: "#666" }}>
                {new Date(e.lastMessageAt).toLocaleDateString()}
              </span>
              <a
                href={`/app/conversations/${e.id}`}
                style={{ fontSize: "13px", color: "#1a1a1a" }}
              >
                View →
              </a>
            </div>
          ))}
        </s-section>
      )}

      <s-section heading="Performance">
        <s-grid gridTemplateColumns="1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr" gap="base">
          <Metric label="Conversations" value={String(stats.totalConversations)} />
          <Metric label="Resolution rate" value={`${resolutionRatePct}%`} />
          <Metric label="Revenue attributed" value={`$${revenue}`} />
          <Metric label="Conversion rate" value={`${conversionRatePct}%`} />
          <Metric label="Avg order value" value={`$${aov}`} />
          <Metric label="Cart recovery rate" value={`${cartRecoveryRatePct}%`} />
          <Metric label="Discounts used" value={String(stats.discountsUsedCount)} />
          <Metric
            label="Conversations this month"
            value={`${usage.used} / ${usage.limit}`}
          />
        </s-grid>
      </s-section>

      <s-section heading="Conversations">
        <s-stack direction="inline" gap="base">
          <s-link href={`/app?days=${days}`}>
            {filter === "escalated" ? "All" : "All (showing)"}
          </s-link>
          <s-link href={`/app?days=${days}&filter=escalated`}>
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

      {routingData.length > 0 && (
        <s-section heading="What customers ask about">
          {(() => {
            const total = routingData.reduce((s, r) => s + r.count, 0);
            return routingData.map((r) => (
              <div
                key={r.route}
                style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}
              >
                <span style={{ width: "120px", textTransform: "capitalize" }}>{r.route}</span>
                <div
                  style={{
                    flex: 1,
                    background: "#f0f0f0",
                    borderRadius: "4px",
                    height: "8px",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.round((r.count / total) * 100)}%`,
                      background: "#1a1a1a",
                      height: "8px",
                      borderRadius: "4px",
                    }}
                  />
                </div>
                <span style={{ width: "40px", textAlign: "right", fontSize: "13px" }}>
                  {Math.round((r.count / total) * 100)}%
                </span>
              </div>
            ));
          })()}
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
