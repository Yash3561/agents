import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const merchant = await prisma.merchant.upsert({
    where: { shopDomain: shop },
    update: {},
    create: { shopDomain: shop },
  });

  if (!merchant.onboardedAt) {
    throw redirect("/app/onboarding");
  }

  const url = new URL(request.url);
  const days = url.searchParams.get("days") ?? "30";
  const daysNum = parseInt(days, 10) || 30;
  const since = new Date(Date.now() - daysNum * 24 * 60 * 60 * 1000);

  const [
    totalConversations,
    escalatedCount,
    conversionsCount,
    discountsUsedCount,
    revenueAgg,
    cartsCreatedCount,
    cartsRecoveredCount,
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
  ]);

  const dailyCounts = await prisma.$queryRaw<Array<{ date: string; count: bigint }>>`
    SELECT DATE("startedAt") as date, COUNT(*) as count
    FROM "Conversation"
    WHERE "shopDomain" = ${shop}
    AND "startedAt" >= ${since}
    GROUP BY DATE("startedAt")
    ORDER BY date ASC
  `;
  const dailyData = dailyCounts.map((r) => ({ date: String(r.date), count: Number(r.count) }));

  return {
    days,
    stats: {
      totalConversations,
      escalatedCount,
      conversionsCount,
      discountsUsedCount,
      revenueCents: revenueAgg._sum.orderRevenueCents ?? 0,
      cartsCreatedCount,
      cartsRecoveredCount,
    },
    dailyData,
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

function fillDates(data: Array<{ date: string; count: number }>, days: number): Array<{ date: string; count: number }> {
  const map = new Map(data.map((d) => [d.date, d.count]));
  const result: Array<{ date: string; count: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    result.push({ date: key, count: map.get(key) ?? 0 });
  }
  return result;
}

function ConversationsChart({ data, days }: { data: Array<{ date: string; count: number }>; days: string }) {
  const daysNum = parseInt(days, 10) || 30;
  const filled = fillDates(data, daysNum);
  const maxCount = Math.max(...filled.map((d) => d.count), 1);
  const allZero = filled.every((d) => d.count === 0);

  const W = 600;
  const H = 160;
  const padL = 0;
  const padR = 0;
  const padT = 10;
  const padB = 24;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const xOf = (i: number) => padL + (i / (filled.length - 1 || 1)) * chartW;
  const yOf = (count: number) => padT + chartH - (count / maxCount) * chartH;

  const points = filled.map((d, i) => `${xOf(i)},${yOf(d.count)}`).join(" ");
  const areaPath = allZero
    ? `M${padL},${padT + chartH} L${padL + chartW},${padT + chartH}`
    : `M${xOf(0)},${yOf(filled[0].count)} ` +
      filled.slice(1).map((d, i) => `L${xOf(i + 1)},${yOf(d.count)}`).join(" ") +
      ` L${xOf(filled.length - 1)},${padT + chartH} L${xOf(0)},${padT + chartH} Z`;

  // Pick 4-5 label indices
  const labelIndices = [0, Math.floor(filled.length / 3), Math.floor((2 * filled.length) / 3), filled.length - 1].filter(
    (v, i, arr) => arr.indexOf(v) === i
  );

  const formatDate = (iso: string) => {
    const [, m, d] = iso.split("-");
    return `${parseInt(m)}/${parseInt(d)}`;
  };

  // gridline Y positions at 25%, 50%, 75%, 100%
  const gridLines = [1, 0.75, 0.5, 0.25].map((pct) => ({
    y: padT + chartH - pct * chartH,
    label: Math.round(pct * maxCount),
  }));

  return (
    <div style={{ width: "100%", background: "#fafafa", borderRadius: "8px", padding: "0", overflow: "hidden" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height: "160px", display: "block" }}
      >
        {/* Grid lines */}
        {gridLines.map((gl) => (
          <line key={gl.y} x1={padL} y1={gl.y} x2={padL + chartW} y2={gl.y} stroke="#e5e5e5" strokeWidth="1" />
        ))}

        {/* Area fill */}
        {!allZero && (
          <path d={areaPath} fill="rgba(26,26,26,0.08)" />
        )}

        {/* Flat line when all zero */}
        {allZero && (
          <line
            x1={padL}
            y1={padT + chartH}
            x2={padL + chartW}
            y2={padT + chartH}
            stroke="#1a1a1a"
            strokeWidth="2"
          />
        )}

        {/* Polyline */}
        {!allZero && (
          <polyline points={points} fill="none" stroke="#1a1a1a" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        )}

        {/* X-axis labels */}
        {labelIndices.map((idx) => (
          <text
            key={idx}
            x={xOf(idx)}
            y={H - 4}
            textAnchor="middle"
            fontSize="10"
            fill="#888"
          >
            {filled[idx] ? formatDate(filled[idx].date) : ""}
          </text>
        ))}

        {/* No data label */}
        {allZero && (
          <text x={W / 2} y={H / 2} textAnchor="middle" fontSize="12" fill="#aaa">
            No conversations yet
          </text>
        )}
      </svg>
    </div>
  );
}

const DAY_OPTIONS = ["7", "14", "30", "90"];

export default function Index() {
  const { stats, dailyData, days } = useLoaderData<typeof loader>();
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

  return (
    <s-page heading="NeonPing Dashboard">
      {/* Time filter */}
      <s-section>
        <s-stack direction="inline" gap="base">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.set("days", d);
                setSearchParams(next);
              }}
              style={{
                padding: "6px 16px",
                borderRadius: "6px",
                border: "1px solid #1a1a1a",
                background: days === d ? "#1a1a1a" : "transparent",
                color: days === d ? "#fff" : "#1a1a1a",
                cursor: "pointer",
                fontWeight: days === d ? 600 : 400,
                fontSize: "14px",
              }}
            >
              {d}d
            </button>
          ))}
        </s-stack>
      </s-section>

      {/* Chart */}
      <s-section heading="Conversations over time">
        <ConversationsChart data={dailyData} days={days} />
      </s-section>

      {/* KPI cards */}
      <s-section heading="Performance">
        <s-grid gridTemplateColumns="1fr 1fr 1fr 1fr 1fr 1fr 1fr" gap="base">
          <Metric label="Conversations" value={String(stats.totalConversations)} />
          <Metric label="Resolution rate" value={`${resolutionRatePct}%`} />
          <Metric label="Revenue attributed" value={`$${revenue}`} />
          <Metric label="Conversion rate" value={`${conversionRatePct}%`} />
          <Metric label="Avg order value" value={`$${aov}`} />
          <Metric label="Cart recovery rate" value={`${cartRecoveryRatePct}%`} />
          <Metric label="Discounts used" value={String(stats.discountsUsedCount)} />
        </s-grid>
      </s-section>

      {/* Escalations needing attention */}
      {stats.escalatedCount > 0 && (
        <s-section heading="Escalations needing attention">
          <s-banner tone="warning">
            {stats.escalatedCount} conversation{stats.escalatedCount > 1 ? "s" : ""} escalated in the last {days} days.{" "}
            <s-link href="/app/conversations?status=escalated">View escalated conversations →</s-link>
          </s-banner>
        </s-section>
      )}

      {/* Quick actions */}
      <s-section heading="Quick actions">
        <s-stack direction="inline" gap="base">
          <s-button href="/app/conversations">View all conversations</s-button>
          <s-button href="/app/settings" variant="secondary">Widget settings</s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
