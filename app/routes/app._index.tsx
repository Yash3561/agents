import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useSearchParams } from "react-router";
import { Prisma } from "@prisma/client";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getUsage } from "../lib/billing.server";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const merchant = await prisma.merchant.upsert({
    where: { shopDomain: shop },
    update: {},
    create: { shopDomain: shop },
  });

  if (!merchant.onboardedAt) {
    const url = new URL(request.url);
    throw redirect(`/app/onboarding?${url.searchParams.toString()}`);
  }

  const url = new URL(request.url);
  const days = url.searchParams.get("days") || "30";
  const daysNum = parseInt(days, 10) || 30;
  const since = new Date(Date.now() - daysNum * 86400000);

  const [
    totalConversations,
    escalatedCount,
    conversionsCount,
    discountsUsedCount,
    revenueAgg,
    cartsCreatedCount,
    cartsRecoveredCount,
    recentEscalations,
    usage,
  ] = await Promise.all([
    prisma.conversation.count({ where: { shopDomain: shop, startedAt: { gte: since } } }),
    prisma.conversation.count({ where: { shopDomain: shop, escalated: true, startedAt: { gte: since } } }),
    prisma.conversation.count({ where: { shopDomain: shop, orderId: { not: null }, startedAt: { gte: since } } }),
    prisma.conversation.count({ where: { shopDomain: shop, discountCode: { not: null }, startedAt: { gte: since } } }),
    prisma.conversation.aggregate({
      where: { shopDomain: shop, orderId: { not: null }, startedAt: { gte: since } },
      _sum: { orderRevenueCents: true },
    }),
    prisma.conversation.count({ where: { shopDomain: shop, cartId: { not: null }, startedAt: { gte: since } } }),
    prisma.conversation.count({
      where: { shopDomain: shop, cartId: { not: null }, orderId: { not: null }, startedAt: { gte: since } },
    }),
    prisma.conversation.findMany({
      where: {
        shopDomain: shop,
        escalated: true,
        lastMessageAt: { gte: new Date(Date.now() - 48 * 3600000) },
      },
      orderBy: { lastMessageAt: "desc" },
      take: 5,
      select: { id: true, sessionId: true, lastMessageAt: true },
    }),
    getUsage(shop),
  ]);

  const rawRouting = await prisma.$queryRaw<Array<{ route: string; count: bigint }>>`
    SELECT "agentTrace"::json->0->>'route' as route, COUNT(*) as count
    FROM "Conversation" WHERE "shopDomain" = ${shop}
    AND "startedAt" >= ${since}
    AND "agentTrace" IS NOT NULL GROUP BY 1
  `;
  const routingData = rawRouting.map((r) => ({
    route: String(r.route || "unknown"),
    count: Number(r.count),
  }));

  const dailyCounts = await prisma.$queryRaw<Array<{ date: string; count: bigint }>>`
    SELECT DATE("startedAt")::text as date, COUNT(*) as count
    FROM "Conversation"
    WHERE "shopDomain" = ${shop}
    AND "startedAt" >= ${since}
    GROUP BY DATE("startedAt")
    ORDER BY date ASC
  `;
  const dailyData = dailyCounts.map((r) => ({
    date: r.date instanceof Date
      ? (r.date as unknown as Date).toISOString().slice(0, 10)
      : String(r.date).slice(0, 10),
    count: Number(r.count),
  }));

  return {
    days,
    shopDomain: shop,
    stats: {
      totalConversations,
      escalatedCount,
      conversionsCount,
      discountsUsedCount,
      revenueCents: revenueAgg._sum.orderRevenueCents ?? 0,
      cartsCreatedCount,
      cartsRecoveredCount,
    },
    recentEscalations,
    usage,
    routingData,
    dailyData,
  };
};

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-text tone="subdued">{label}</s-text>
      <div style={{ marginTop: "4px" }}>
        <s-heading>{value}</s-heading>
      </div>
      {sub && (
        <div style={{ marginTop: "2px" }}>
          <s-text tone="subdued">{sub}</s-text>
        </div>
      )}
    </s-box>
  );
}

function fillDates(
  data: Array<{ date: string; count: number }>,
  days: number,
): Array<{ date: string; count: number }> {
  const map = new Map(data.map((d) => [d.date, d.count]));
  const result: Array<{ date: string; count: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    result.push({ date: key, count: map.get(key) ?? 0 });
  }
  return result;
}

function ConversationsChart({
  data,
  days,
}: {
  data: Array<{ date: string; count: number }>;
  days: string;
}) {
  const daysNum = parseInt(days, 10) || 30;
  const filled = fillDates(data, daysNum);

  // Format x-axis tick: show "Jun 15" style
  const fmtTick = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  // How many ticks to show on x-axis (avoid crowding)
  const tickCount = daysNum <= 7 ? daysNum : daysNum <= 14 ? 7 : daysNum <= 30 ? 6 : 7;
  const tickIndices = Array.from({ length: tickCount }, (_, i) =>
    Math.round((i / (tickCount - 1)) * (filled.length - 1))
  );
  const ticks = tickIndices.map((i) => filled[i]?.date).filter(Boolean) as string[];

  // Custom tooltip
  const CustomTooltip = ({
    active,
    payload,
    label,
  }: {
    active?: boolean;
    payload?: Array<{ value: number }>;
    label?: string;
  }) => {
    if (!active || !payload?.length || !label) return null;
    return (
      <div
        style={{
          background: "#fff",
          border: "1px solid #e1e1e1",
          borderRadius: "6px",
          padding: "8px 12px",
          fontSize: "13px",
          boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
        }}
      >
        <div style={{ color: "#888", marginBottom: "2px" }}>{fmtTick(label)}</div>
        <div style={{ color: "#1a1a1a", fontWeight: 600 }}>
          {payload[0].value} conversation{payload[0].value !== 1 ? "s" : ""}
        </div>
      </div>
    );
  };

  return (
    <div style={{ width: "100%", height: 200 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={filled}
          margin={{ top: 8, right: 8, left: -24, bottom: 0 }}
        >
          <defs>
            <linearGradient id="convGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#1a1a1a" stopOpacity={0.12} />
              <stop offset="95%" stopColor="#1a1a1a" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
          <XAxis
            dataKey="date"
            ticks={ticks}
            tickFormatter={fmtTick}
            tick={{ fontSize: 11, fill: "#999" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 11, fill: "#999" }}
            axisLine={false}
            tickLine={false}
          />
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <Tooltip content={<CustomTooltip />} cursor={{ stroke: "#1a1a1a", strokeWidth: 1, strokeDasharray: "4 4" }} />
          <Area
            type="monotone"
            dataKey="count"
            stroke="#1a1a1a"
            strokeWidth={2}
            fill="url(#convGradient)"
            dot={false}
            activeDot={{ r: 4, fill: "#1a1a1a", strokeWidth: 0 }}
            isAnimationActive={true}
            animationDuration={400}
            animationEasing="ease-out"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

const DAY_OPTIONS = [
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

export default function Index() {
  const { stats, days, recentEscalations, usage, routingData, dailyData, shopDomain } =
    useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

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

  const usagePercent = Math.round((usage.used / usage.limit) * 100);
  const isAtCapacity = usage.used >= usage.limit;
  const isNearCapacity = usage.used >= usage.limit * 0.8 && !isAtCapacity;

  const ROUTE_LABELS: Record<string, string> = {
    shopping: "Product questions",
    support: "Support & policies",
    personalization: "Offers & discounts",
    direct: "General chat",
  };

  return (
    <s-page heading="Dashboard">
      {isAtCapacity && (
        <s-banner tone="critical">
          {"You've reached your "}
          {usage.limit}
          {" conversation limit this month. "}
          <a href="/app/billing">Upgrade your plan</a>
          {" to continue."}
        </s-banner>
      )}
      {isNearCapacity && (
        <s-banner tone="warning">
          {"You've used "}
          {usagePercent}
          {"% of your "}
          {usage.limit}
          {" monthly conversations. "}
          <a href="/app/billing">Upgrade soon</a>
          {"."}
        </s-banner>
      )}

      {recentEscalations.length > 0 && (
        <s-section heading={`Needs attention (${recentEscalations.length})`}>
          {recentEscalations.map((e) => (
            <div
              key={e.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "10px 0",
                borderBottom: "1px solid #e1e1e1",
              }}
            >
              <span style={{ fontFamily: "monospace", fontSize: "13px", color: "#444" }}>
                {e.sessionId.slice(0, 8)}...
              </span>
              <span style={{ fontSize: "12px", color: "#888" }}>
                {new Date(e.lastMessageAt).toLocaleDateString()}
              </span>
              <a href={`/app/conversations/${e.id}`} style={{ fontSize: "13px", color: "#1a1a1a" }}>
                View
              </a>
            </div>
          ))}
        </s-section>
      )}

      <s-section heading="Conversations over time">
        <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
          {DAY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.set("days", opt.value);
                setSearchParams(next);
              }}
              style={{
                padding: "5px 14px",
                borderRadius: "6px",
                border: "1px solid #d1d1d1",
                background: days === opt.value ? "#1a1a1a" : "#fff",
                color: days === opt.value ? "#fff" : "#333",
                cursor: "pointer",
                fontSize: "13px",
                fontWeight: days === opt.value ? 600 : 400,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <ConversationsChart data={dailyData} days={days} />
      </s-section>

      <s-section heading="Performance">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px" }}>
          <Metric label="Conversations" value={String(stats.totalConversations)} />
          <Metric label="Resolution rate" value={`${resolutionRatePct}%`} />
          <Metric label="Revenue attributed" value={`$${revenue}`} />
          <Metric label="Conversion rate" value={`${conversionRatePct}%`} />
          <Metric label="Avg order value" value={`$${aov}`} />
          <Metric label="Cart recovery rate" value={`${cartRecoveryRatePct}%`} />
          <Metric label="Discounts used" value={String(stats.discountsUsedCount)} />
          <Metric
            label="Monthly usage"
            value={`${usage.used} / ${usage.limit}`}
            sub={`${usagePercent}% used`}
          />
        </div>
      </s-section>

      {routingData.length > 0 && (
        <s-section heading="What customers ask about">
          {(() => {
            const total = routingData.reduce((s, r) => s + r.count, 0);
            return routingData.map((r) => (
              <div
                key={r.route}
                style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "10px" }}
              >
                <span style={{ width: "160px", fontSize: "13px", color: "#444" }}>
                  {ROUTE_LABELS[r.route] ?? r.route}
                </span>
                <div style={{ flex: 1, background: "#f0f0f0", borderRadius: "4px", height: "6px" }}>
                  <div
                    style={{
                      width: `${Math.round((r.count / total) * 100)}%`,
                      background: "#1a1a1a",
                      height: "6px",
                      borderRadius: "4px",
                    }}
                  />
                </div>
                <span style={{ width: "36px", textAlign: "right", fontSize: "12px", color: "#888" }}>
                  {Math.round((r.count / total) * 100)}%
                </span>
              </div>
            ));
          })()}
        </s-section>
      )}

      <s-section heading="Quick actions">
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <s-button href="/app/conversations" variant="secondary">View conversations</s-button>
          <s-button href="/app/settings" variant="secondary">Widget settings</s-button>
          <s-button href="/app/ai-config" variant="secondary">Knowledge base</s-button>
          <s-button href="/app/billing" variant="secondary">Billing</s-button>
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
