import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getUsage, PLAN_LIMITS } from "../lib/billing.server";
import { adminGraphql } from "../lib/mcp/admin.server";
import { runInsightsAnalysis, runRevenueNarrator } from "../lib/agents/merchant-analyst.server";

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

  const hasPlan = merchant.plan in PLAN_LIMITS;

  const url = new URL(request.url);
  const days = url.searchParams.get("days") || "30";
  const channel = url.searchParams.get("channel") || "all";
  const daysNum = parseInt(days, 10) || 30;
  const since = new Date(Date.now() - daysNum * 86400000);
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

  const channelFilter =
    channel === "whatsapp" ? { channel: "whatsapp" }
    : channel === "web" ? { NOT: { channel: "whatsapp" } }
    : {};

  const channelSql =
    channel === "whatsapp" ? Prisma.sql`AND "channel" = 'whatsapp'`
    : channel === "web" ? Prisma.sql`AND "channel" != 'whatsapp'`
    : Prisma.sql``;

  const baseWhere = { shopDomain: shop, startedAt: { gte: since }, ...channelFilter };

  const [
    totalConversations,
    conversionsCount,
    discountsUsedCount,
    revenueAgg,
    recentEscalations,
    usage,
    openNow,
    recentForResponseTime,
  ] = await Promise.all([
    prisma.conversation.count({ where: baseWhere }),
    prisma.conversation.count({ where: { ...baseWhere, orderId: { not: null } } }),
    prisma.conversation.count({ where: { ...baseWhere, discountCode: { not: null } } }),
    prisma.conversation.aggregate({
      where: { ...baseWhere, orderId: { not: null } },
      _sum: { orderRevenueCents: true },
    }),
    prisma.conversation.findMany({
      where: {
        shopDomain: shop,
        escalated: true,
        lastMessageAt: { gte: new Date(Date.now() - 48 * 3600000) },
      },
      orderBy: { lastMessageAt: "desc" },
      take: 5,
      select: { id: true, sessionId: true, lastMessageAt: true, messageCount: true },
    }),
    getUsage(shop),
    prisma.conversation.count({
      where: { shopDomain: shop, resolved: false, lastMessageAt: { gte: tenMinutesAgo }, ...channelFilter },
    }),
    prisma.conversation.findMany({
      where: baseWhere,
      orderBy: { startedAt: "desc" },
      take: 200,
      select: { messages: true },
    }),
  ]);

  // Compute avg first-response time from messages JSON
  const responseTimes = recentForResponseTime
    .map((c) => {
      const msgs = c.messages as Array<{ role: string; timestamp?: number }>;
      const firstUser = msgs.find((m) => m.role === "user");
      const firstBot = msgs.find((m) => m.role === "assistant" && (m.timestamp ?? 0) > (firstUser?.timestamp ?? 0));
      return firstUser?.timestamp != null && firstBot?.timestamp != null ? firstBot.timestamp - firstUser.timestamp : null;
    })
    .filter((t): t is number => t !== null);
  const avgResponseMs = responseTimes.length
    ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
    : null;

  const rawRouting = await prisma.$queryRaw<Array<{ route: string; count: bigint }>>`
    SELECT
      SPLIT_PART("agentTrace"::json->>0, ':', 2) as route,
      COUNT(*) as count
    FROM "Conversation"
    WHERE "shopDomain" = ${shop}
      AND "startedAt" >= ${since}
      AND "agentTrace" IS NOT NULL
      AND "agentTrace"::json->>0 LIKE 'orchestrator:%'
      ${channelSql}
    GROUP BY 1
    ORDER BY count DESC
  `;
  const routingData = rawRouting.map((r) => ({
    route: String(r.route || "unknown"),
    count: Number(r.count),
  }));

  const rawConversionByRoute = await prisma.$queryRaw<Array<{ route: string; converted: bigint; total: bigint }>>`
    SELECT
      SPLIT_PART("agentTrace"::json->>0, ':', 2) as route,
      COUNT(CASE WHEN "orderId" IS NOT NULL THEN 1 END) as converted,
      COUNT(*) as total
    FROM "Conversation"
    WHERE "shopDomain" = ${shop}
      AND "startedAt" >= ${since}
      AND "agentTrace" IS NOT NULL
      AND "agentTrace"::json->>0 LIKE 'orchestrator:%'
      ${channelSql}
    GROUP BY 1
  `;
  const conversionByRoute = new Map(
    rawConversionByRoute.map((r) => [
      String(r.route),
      { converted: Number(r.converted), total: Number(r.total) },
    ])
  );

  const rawIntents = await prisma.$queryRaw<Array<{ reason: string; count: bigint }>>`
    SELECT "routeReason" as reason, COUNT(*) as count
    FROM "Conversation"
    WHERE "shopDomain" = ${shop}
      AND "startedAt" >= ${since}
      AND "routeReason" IS NOT NULL
      AND "routeReason" != ''
      ${channelSql}
    GROUP BY "routeReason"
    ORDER BY count DESC
    LIMIT 10
  `;
  const topIntents = rawIntents.map((r) => ({ reason: String(r.reason), count: Number(r.count) }));

  const dailyCounts = await prisma.$queryRaw<Array<{ date: string; count: bigint }>>`
    SELECT DATE("startedAt")::text as date, COUNT(*) as count
    FROM "Conversation"
    WHERE "shopDomain" = ${shop}
    AND "startedAt" >= ${since}
    ${channelSql}
    GROUP BY DATE("startedAt")
    ORDER BY date ASC
  `;
  const dailyData = dailyCounts.map((r) => ({
    date: String(r.date).slice(0, 10),
    count: Number(r.count),
  }));

  let currencyCode = "USD";
  try {
    const shopData = await adminGraphql<{ shop: { currencyCode: string } }>(
      session.shop,
      session.accessToken ?? "",
      `{ shop { currencyCode } }`,
    );
    currencyCode = shopData.shop?.currencyCode ?? "USD";
  } catch {
    // fall back to USD silently
  }

  // Fetch cached AI insights + revenue narrative; auto-refresh if stale (non-blocking)
  const merchantData = await prisma.merchant.findUnique({
    where: { shopDomain: shop },
    select: { insightsJson: true, revenueNarrative: true },
  });

  const insightsRaw = merchantData?.insightsJson as { generatedAt?: string; topics?: unknown[] } | null;
  const insightsAge = insightsRaw?.generatedAt ? Date.now() - new Date(insightsRaw.generatedAt).getTime() : Infinity;
  if (insightsAge > 24 * 3600 * 1000) {
    void runInsightsAnalysis(shop).catch(() => null);
  }

  const narrativeRaw = merchantData?.revenueNarrative as { month?: string; generatedAt?: string } | null;
  const narrativeMonth = narrativeRaw?.month ? new Date(narrativeRaw.month).getMonth() : -1;
  if (narrativeMonth !== new Date().getMonth()) {
    void runRevenueNarrator(shop).catch(() => null);
  }

  return {
    hasPlan,
    days,
    channel,
    shopDomain: shop,
    currencyCode,
    insightsJson: insightsRaw ?? null,
    revenueNarrative: narrativeRaw ?? null,
    stats: {
      totalConversations,
      conversionsCount,
      discountsUsedCount,
      revenueCents: revenueAgg._sum.orderRevenueCents ?? 0,
    },
    openNow,
    avgResponseMs,
    recentEscalations,
    usage,
    routingData,
    dailyData,
    conversionByRoute: Object.fromEntries(conversionByRoute),
    topIntents,
  };
};

// ─── Action — manual refresh for AI cards ─────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  if (intent === "refresh-insights") {
    await runInsightsAnalysis(shop).catch(() => null);
  } else if (intent === "refresh-revenue") {
    await runRevenueNarrator(shop).catch(() => null);
  }
  return null;
}

// ─── Metric card (Polaris-native) ─────────────────────────────────────────────

function Metric({ label, value, sub, borderColor = "#e1e3e5" }: {
  label: string;
  value: string;
  sub?: string;
  borderColor?: string;
}) {
  return (
    <div style={{
      background: "#fff",
      border: "1px solid #e1e3e5",
      borderTop: `3px solid ${borderColor}`,
      borderRadius: "8px",
      padding: "16px 20px",
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      minWidth: 0,
    }}>
      <div style={{
        fontSize: "12px",
        color: "#6d7175",
        fontWeight: 500,
        textTransform: "uppercase",
        letterSpacing: "0.4px",
      }}>
        {label}
      </div>
      <div style={{
        fontSize: "28px",
        fontWeight: 600,
        color: "#202223",
        lineHeight: 1.2,
        wordBreak: "break-word",
      }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: "13px", color: "#8c9196" }}>{sub}</div>
      )}
    </div>
  );
}

// ─── Date fill helper ─────────────────────────────────────────────────────────

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

// ─── LineChart (Polaris-native) ───────────────────────────────────────────────

function LineChart({
  data,
  daysNum,
}: {
  data: Array<{ date: string; count: number }>;
  daysNum: number;
}) {
  const [tooltip, setTooltip] = useState<{ idx: number } | null>(null);

  const filled = fillDates(data, daysNum);
  const maxCount = Math.max(...filled.map((d) => d.count), 1);

  // SVG coordinate space
  const W = 600, H = 160;
  const PL = 40, PR = 16, PT = 12, PB = 32;
  const cW = W - PL - PR;
  const cH = H - PT - PB;

  const pts: Array<[number, number]> = filled.map((d, i) => [
    PL + (i / Math.max(filled.length - 1, 1)) * cW,
    PT + cH - (d.count / maxCount) * cH,
  ]);

  function buildPath(points: Array<[number, number]>): string {
    if (points.length === 0) return "";
    if (points.length === 1) return `M${points[0][0]},${points[0][1]}`;
    let d = `M${points[0][0]},${points[0][1]}`;
    for (let i = 1; i < points.length; i++) {
      const [x0, y0] = points[i - 1];
      const [x1, y1] = points[i];
      const cx = (x0 + x1) / 2;
      d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
    }
    return d;
  }

  const linePath = buildPath(pts);
  const areaPath =
    pts.length > 0
      ? linePath +
        ` L${pts[pts.length - 1][0]},${PT + cH} L${pts[0][0]},${PT + cH} Z`
      : "";

  // Y-axis ticks
  const yTicks = [0.25, 0.5, 0.75, 1.0].map((f) => ({
    y: PT + cH - f * cH,
    label: String(Math.round(f * maxCount)),
  }));

  // X-axis labels: max 7
  const maxLabels = Math.min(7, filled.length);
  const labelIdxs =
    filled.length <= maxLabels
      ? filled.map((_, i) => i)
      : Array.from({ length: maxLabels }, (_, l) =>
          Math.round((l / (maxLabels - 1)) * (filled.length - 1))
        );

  const hoverIdx = tooltip?.idx ?? -1;

  const isEmpty = filled.every((d) => d.count === 0);

  if (isEmpty) {
    return (
      <div
        style={{
          height: "180px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ fontSize: "14px", color: "#8c9196" }}>
          No conversations in this period — share your store link to get started.
        </span>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", marginTop: "16px" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "220px", cursor: "default" }}
        onMouseMove={(e: React.MouseEvent<SVGSVGElement>) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const mx = ((e.clientX - rect.left) / rect.width) * W;
          let best = 0;
          let bestDist = Infinity;
          pts.forEach(([px], i) => {
            const dist = Math.abs(px - mx);
            if (dist < bestDist) {
              bestDist = dist;
              best = i;
            }
          });
          setTooltip({ idx: best });
        }}
        onMouseLeave={() => setTooltip(null)}
      >
        <defs>
          <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2c6ecb" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#2c6ecb" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Y grid lines + labels */}
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={PL}
              y1={tick.y}
              x2={W - PR}
              y2={tick.y}
              stroke="#f1f1f1"
              strokeWidth="1"
            />
            <text
              x={PL - 6}
              y={tick.y + 4}
              textAnchor="end"
              fontSize="10"
              fill="#8c9196"
            >
              {tick.label}
            </text>
          </g>
        ))}

        {/* Baseline */}
        <line
          x1={PL}
          y1={PT + cH}
          x2={W - PR}
          y2={PT + cH}
          stroke="#e1e3e5"
          strokeWidth="1"
        />

        {/* Area fill */}
        {areaPath && <path d={areaPath} fill="url(#chartFill)" />}

        {/* Line */}
        {linePath && (
          <path
            d={linePath}
            fill="none"
            stroke="#2c6ecb"
            strokeWidth="2"
            strokeLinecap="round"
          />
        )}

        {/* Hover vertical line */}
        {hoverIdx >= 0 && (
          <line
            x1={pts[hoverIdx][0]}
            y1={PT}
            x2={pts[hoverIdx][0]}
            y2={PT + cH}
            stroke="#c9cccf"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        )}

        {/* Data dot — only on hover */}
        {hoverIdx >= 0 && pts[hoverIdx] && (
          <circle
            cx={pts[hoverIdx][0]}
            cy={pts[hoverIdx][1]}
            r="4.5"
            fill="#fff"
            stroke="#2c6ecb"
            strokeWidth="2"
          />
        )}

        {/* X labels */}
        {labelIdxs.map((idx) => (
          <text
            key={idx}
            x={pts[idx][0]}
            y={H - 6}
            textAnchor="middle"
            fontSize="10"
            fill="#8c9196"
          >
            {new Date(filled[idx].date + "T00:00:00Z").toLocaleDateString(
              "en-US",
              { month: "short", day: "numeric", timeZone: "UTC" }
            )}
          </text>
        ))}
      </svg>

      {/* Tooltip */}
      {hoverIdx >= 0 &&
        pts[hoverIdx] &&
        (() => {
          const leftPct = (pts[hoverIdx][0] / W) * 100;
          return (
            <div
              style={{
                position: "absolute",
                top: "8px",
                left: `${leftPct}%`,
                transform:
                  leftPct > 65
                    ? "translateX(calc(-100% - 8px))"
                    : "translateX(8px)",
                background: "#202223",
                color: "#fff",
                padding: "8px 12px",
                borderRadius: "6px",
                fontSize: "12px",
                pointerEvents: "none",
                whiteSpace: "nowrap",
                zIndex: 10,
              }}
            >
              <div
                style={{
                  color: "#adb5bd",
                  marginBottom: "2px",
                  fontSize: "11px",
                }}
              >
                {new Date(
                  filled[hoverIdx].date + "T00:00:00Z"
                ).toLocaleDateString("en-US", {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                  timeZone: "UTC",
                })}
              </div>
              <div style={{ fontWeight: 600, fontSize: "14px" }}>
                {filled[hoverIdx].count} conversation
                {filled[hoverIdx].count !== 1 ? "s" : ""}
              </div>
            </div>
          );
        })()}
    </div>
  );
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DAY_OPTIONS = [
  { value: "7", label: "Last 7 days" },
  { value: "14", label: "Last 14 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

const ROUTE_LABELS: Record<string, string> = {
  shopping: "Product questions",
  support: "Support & policies",
  personalization: "Offers & discounts",
  direct: "General chat",
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function Index() {
  const loaderData = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const {
    hasPlan,
    stats,
    days,
    channel,
    openNow,
    avgResponseMs,
    recentEscalations,
    usage,
    routingData,
    dailyData,
    shopDomain,
    conversionByRoute,
    topIntents,
    currencyCode,
    insightsJson,
    revenueNarrative,
  } = loaderData;

  type InsightsTopic = { label: string; count: number; sample: string; suggestion: string };
  const insights = insightsJson as { topics?: InsightsTopic[]; generatedAt?: string } | null;
  const narrative = revenueNarrative as { bullets?: string[]; month?: string; generatedAt?: string } | null;

  // ── Computed metrics ──────────────────────────────────────────────────────
  const conversionRatePct = stats.totalConversations
    ? Math.round((stats.conversionsCount / stats.totalConversations) * 100)
    : 0;
  const fmtCurrency = (cents: number) =>
    new Intl.NumberFormat("en", {
      style: "currency",
      currency: currencyCode,
    }).format(cents / 100);
  const revenue = fmtCurrency(stats.revenueCents);
  const aov = stats.conversionsCount
    ? fmtCurrency(stats.revenueCents / stats.conversionsCount)
    : fmtCurrency(0);

  const revenuePerChat =
    stats.totalConversations > 0 && stats.revenueCents > 0
      ? fmtCurrency(stats.revenueCents / stats.totalConversations)
      : "—";

  const usagePercent =
    usage.limit > 0 ? Math.round((usage.used / usage.limit) * 100) : 0;
  const isAtCapacity = usage.limit > 0 && usage.used >= usage.limit;
  const isNearCapacity =
    usage.limit > 0 &&
    usage.used >= usage.limit * 0.8 &&
    !isAtCapacity;

  const daysNum = parseInt(days, 10) || 30;

  const fmtResponseTime = (ms: number | null) => {
    if (ms === null) return "—";
    const min = ms / 60000;
    return min < 1 ? `${Math.round(ms / 1000)}s` : `${min.toFixed(1)} min`;
  };
  const responseColor = avgResponseMs === null ? "#8c9196"
    : avgResponseMs < 180000 ? "#008060"
    : avgResponseMs < 600000 ? "#b98900"
    : "#d82c0d";

  const CHANNEL_TOGGLE = [
    { value: "all", label: "All channels" },
    { value: "web", label: "🌐 Web Widget" },
    { value: "whatsapp", label: "💚 WhatsApp" },
  ] as const;

  return (
    <s-page heading="Dashboard">
      {/* ── Banners ── */}
      {!hasPlan && (
        <s-banner tone="info">
          {"Your chat widget is inactive. "}
          <a href="/app/billing" style={{ fontWeight: 600 }}>
            Choose a plan
          </a>
          {" to activate NeonPing — all plans include a 7-day free trial."}
        </s-banner>
      )}
      {isAtCapacity && (
        <s-banner tone="critical">
          {"You've reached your "}
          {usage.limit}
          {" conversation limit for this billing cycle. "}
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
          {" conversation limit this billing cycle. "}
          <a href="/app/billing">Upgrade soon</a>
          {"."}
        </s-banner>
      )}

      {/* ── Needs attention ── */}
      {recentEscalations.length > 0 && (
        <s-section
          heading={`Needs attention (${recentEscalations.length})`}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "1px",
              background: "#e1e3e5",
              borderRadius: "8px",
              overflow: "hidden",
            }}
          >
            {recentEscalations.map((e) => (
              <div
                key={e.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "12px 16px",
                  background: "#fff",
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: "13px",
                      fontWeight: 500,
                      color: "#202223",
                    }}
                  >
                    Session {e.sessionId.slice(0, 8)}
                  </div>
                  <div style={{ fontSize: "12px", color: "#8c9196" }}>
                    {e.messageCount} message
                    {e.messageCount !== 1 ? "s" : ""} ·{" "}
                    {new Date(e.lastMessageAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </div>
                </div>
                <a
                  href={`/app/conversations/${e.id}`}
                  style={{
                    fontSize: "13px",
                    color: "#2c6ecb",
                    fontWeight: 500,
                    textDecoration: "none",
                  }}
                >
                  Review
                </a>
              </div>
            ))}
          </div>
        </s-section>
      )}

      {/* ── Conversations over time ── */}
      <s-section heading="Conversations over time">
        <s-select
          label="Date range"
          value={days}
          onChange={(e: Event) => {
            const next = new URLSearchParams(searchParams);
            next.set("days", (e.target as HTMLSelectElement).value);
            // preserve channel filter
            if (channel !== "all") next.set("channel", channel);
            setSearchParams(next);
          }}
        >
          {DAY_OPTIONS.map((opt) => (
            <s-option key={opt.value} value={opt.value}>
              {opt.label}
            </s-option>
          ))}
        </s-select>
        <LineChart data={dailyData} daysNum={daysNum} />
      </s-section>

      {/* ── Performance (6 KPI grid) ── */}
      <s-section heading="Performance">
        {/* Channel toggle */}
        <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
          {CHANNEL_TOGGLE.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.set("channel", opt.value);
                if (days !== "30") next.set("days", days);
                setSearchParams(next);
              }}
              style={{
                padding: "6px 16px",
                borderRadius: "6px",
                border: channel === opt.value ? "1px solid #2c6ecb" : "1px solid #d1d1d1",
                background: channel === opt.value ? "#2c6ecb" : "transparent",
                color: channel === opt.value ? "#fff" : "#1a1a1a",
                cursor: "pointer",
                fontWeight: channel === opt.value ? 600 : 400,
                fontSize: "13px",
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "14px",
          }}
        >
          <Metric
            label="Conversations"
            value={stats.totalConversations.toLocaleString()}
            sub={`last ${days} days`}
            borderColor="#2c6ecb"
          />
          <Metric
            label="Revenue attributed"
            value={revenue}
            sub={`from ${stats.conversionsCount} order${stats.conversionsCount !== 1 ? "s" : ""}`}
            borderColor="#008060"
          />
          <Metric
            label="Conversion rate"
            value={stats.totalConversations > 0 ? `${conversionRatePct}%` : "—"}
            sub={`${stats.conversionsCount} of ${stats.totalConversations} converted`}
            borderColor="#008060"
          />
          <Metric
            label="Avg order value"
            value={stats.conversionsCount > 0 ? aov : "—"}
            sub="per attributed order"
            borderColor="#2c6ecb"
          />
          <Metric
            label="Revenue per chat"
            value={revenuePerChat}
            sub="avg per conversation"
            borderColor="#2c6ecb"
          />
          <Metric
            label="Plan usage"
            value={`${usage.used} / ${usage.limit > 0 ? usage.limit.toLocaleString() : "∞"}`}
            sub={
              usage.limit > 0 ? `${usagePercent}% of billing cycle` : "Unlimited"
            }
            borderColor={usagePercent >= 100 ? "#d82c0d" : usagePercent >= 80 ? "#ffc453" : "#008060"}
          />
          <Metric
            label="Avg response time"
            value={fmtResponseTime(avgResponseMs)}
            sub={avgResponseMs !== null ? (avgResponseMs < 180000 ? "Excellent (< 3 min)" : avgResponseMs < 600000 ? "Good (< 10 min)" : "Slow (> 10 min)") : "No data yet"}
            borderColor={responseColor}
          />
          <Metric
            label="Active now"
            value={String(openNow)}
            sub={openNow === 1 ? "open conversation" : "open conversations"}
            borderColor={openNow > 0 ? "#d97706" : "#e1e3e5"}
          />
        </div>
      </s-section>

      {/* ── Get started (shown only when no data yet) ── */}
      {stats.totalConversations === 0 && (
        <s-section heading="Get started">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: "12px",
            }}
          >
            {[
              {
                n: "1",
                title: "Install widget",
                desc: "Enable the NeonPing app embed in your theme editor to show the chat widget on your storefront.",
                href: `https://admin.shopify.com/store/${shopDomain.replace(
                  ".myshopify.com",
                  ""
                )}/themes/current/editor?context=apps`,
                cta: "Open Theme Editor",
              },
              {
                n: "2",
                title: "Customize your bot",
                desc: "Set a greeting message, brand color, and AI tone that matches your store's voice.",
                href: "/app/settings",
                cta: "Edit Settings",
              },
              {
                n: "3",
                title: "Go live",
                desc: "Share your store — your first conversation will appear here and start generating insights.",
                href: null as string | null,
                cta: null as string | null,
              },
            ].map((step) => (
              <div
                key={step.n}
                style={{
                  background: "#fff",
                  border: "1px solid #e1e3e5",
                  borderRadius: "8px",
                  padding: "20px",
                }}
              >
                <div
                  style={{
                    width: "24px",
                    height: "24px",
                    borderRadius: "50%",
                    background: "#2c6ecb",
                    color: "#fff",
                    fontSize: "12px",
                    fontWeight: 700,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    marginBottom: "12px",
                  }}
                >
                  {step.n}
                </div>
                <div
                  style={{
                    fontSize: "14px",
                    fontWeight: 600,
                    color: "#202223",
                    marginBottom: "4px",
                  }}
                >
                  {step.title}
                </div>
                <div
                  style={{
                    fontSize: "13px",
                    color: "#6d7175",
                    lineHeight: "1.5",
                    marginBottom: step.cta ? "14px" : "0",
                  }}
                >
                  {step.desc}
                </div>
                {step.cta && step.href && (
                  <a
                    href={step.href}
                    target={
                      step.href.startsWith("http") ? "_blank" : undefined
                    }
                    rel={
                      step.href.startsWith("http")
                        ? "noreferrer"
                        : undefined
                    }
                    style={{
                      fontSize: "13px",
                      color: "#2c6ecb",
                      fontWeight: 500,
                      textDecoration: "none",
                    }}
                  >
                    {step.cta} →
                  </a>
                )}
              </div>
            ))}
          </div>
        </s-section>
      )}

      {/* ── What customers ask about ── */}
      {(routingData.length > 0 || topIntents.length > 0) && (
        <s-section heading="What customers ask about">
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                routingData.length > 0 && topIntents.length > 0
                  ? "1fr 1fr"
                  : "1fr",
              gap: "24px",
            }}
          >
            {routingData.length > 0 && (
              <div>
                <div
                  style={{
                    fontSize: "12px",
                    color: "#6d7175",
                    fontWeight: 500,
                    textTransform: "uppercase",
                    letterSpacing: "0.4px",
                    marginBottom: "14px",
                  }}
                >
                  Conversation types
                </div>
                {(() => {
                  const total = routingData.reduce(
                    (s, r) => s + r.count,
                    0
                  );
                  return routingData.map((r) => {
                    const pct =
                      total > 0
                        ? Math.round((r.count / total) * 100)
                        : 0;
                    const conv = conversionByRoute[r.route];
                    const convPct =
                      conv && conv.total > 0
                        ? Math.round(
                            (conv.converted / conv.total) * 100
                          )
                        : null;
                    return (
                      <div key={r.route} style={{ marginBottom: "14px" }}>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: "5px",
                          }}
                        >
                          <span
                            style={{
                              fontSize: "13px",
                              color: "#202223",
                              fontWeight: 500,
                            }}
                          >
                            {ROUTE_LABELS[r.route] ?? r.route}
                          </span>
                          <div
                            style={{
                              display: "flex",
                              gap: "10px",
                              alignItems: "center",
                            }}
                          >
                            {convPct !== null && (
                              <span
                                style={{
                                  fontSize: "11px",
                                  color:
                                    convPct > 0 ? "#008060" : "#8c9196",
                                  fontWeight: 600,
                                }}
                              >
                                {convPct}% converted
                              </span>
                            )}
                            <span
                              style={{
                                fontSize: "12px",
                                color: "#6d7175",
                                minWidth: "32px",
                                textAlign: "right",
                              }}
                            >
                              {pct}%
                            </span>
                          </div>
                        </div>
                        <div
                          style={{
                            height: "6px",
                            background: "#e1e3e5",
                            borderRadius: "3px",
                          }}
                        >
                          <div
                            style={{
                              width: `${pct}%`,
                              height: "100%",
                              background: "#2c6ecb",
                              borderRadius: "3px",
                            }}
                          />
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            )}

            {topIntents.length > 0 && (
              <div>
                <div
                  style={{
                    fontSize: "12px",
                    color: "#6d7175",
                    fontWeight: 500,
                    textTransform: "uppercase",
                    letterSpacing: "0.4px",
                    marginBottom: "14px",
                  }}
                >
                  Top customer intents
                </div>
                {topIntents.map((intent, i) => {
                  const maxIntentCount = topIntents[0]?.count ?? 1;
                  const pct = Math.round(
                    (intent.count / maxIntentCount) * 100
                  );
                  return (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                        marginBottom: "10px",
                      }}
                    >
                      <span
                        style={{
                          width: "18px",
                          fontSize: "11px",
                          color: "#8c9196",
                          textAlign: "right",
                          flexShrink: 0,
                        }}
                      >
                        {i + 1}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: "3px",
                          }}
                        >
                          <span
                            style={{
                              fontSize: "13px",
                              color: "#202223",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              maxWidth: "calc(100% - 40px)",
                            }}
                          >
                            {intent.reason}
                          </span>
                          <span
                            style={{
                              fontSize: "11px",
                              color: "#8c9196",
                              flexShrink: 0,
                              marginLeft: "8px",
                            }}
                          >
                            {intent.count}x
                          </span>
                        </div>
                        <div
                          style={{
                            height: "4px",
                            background: "#e1e3e5",
                            borderRadius: "2px",
                          }}
                        >
                          <div
                            style={{
                              width: `${pct}%`,
                              height: "100%",
                              background: "#2c6ecb",
                              borderRadius: "2px",
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </s-section>
      )}

      {/* ── AI Insights card ── */}
      <s-section heading="AI Insights — What customers need help with">
        {!insights?.topics?.length ? (
          <div style={{ padding: "24px", textAlign: "center", color: "#8c9196", fontSize: "13px" }}>
            {insightsJson === null
              ? "Analyzing your conversations… check back in a few minutes."
              : "Not enough conversations yet to surface patterns."}
            <Form method="post" style={{ marginTop: "12px", display: "inline-block" }}>
              <input type="hidden" name="intent" value="refresh-insights" />
              <button type="submit" style={{ padding: "6px 14px", fontSize: "12px", border: "1px solid #c9cccf", borderRadius: "5px", cursor: "pointer", background: "#fff" }}>
                Analyze now
              </button>
            </Form>
          </div>
        ) : (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <span style={{ fontSize: "12px", color: "#8c9196" }}>
                Based on last 7 days · Updated {insights.generatedAt ? new Date(insights.generatedAt).toLocaleDateString("en", { month: "short", day: "numeric" }) : "recently"}
              </span>
              <Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="refresh-insights" />
                <button type="submit" style={{ padding: "4px 10px", fontSize: "11px", border: "1px solid #c9cccf", borderRadius: "5px", cursor: "pointer", background: "#fff", color: "#6d7175" }}>
                  ↻ Refresh
                </button>
              </Form>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {(insights.topics as InsightsTopic[]).map((topic, i) => (
                <div key={i} style={{ background: "#fafafa", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "14px 16px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "6px" }}>
                    <div style={{ fontWeight: 600, fontSize: "14px", color: "#202223" }}>{topic.label}</div>
                    <span style={{ fontSize: "12px", color: "#6d7175", flexShrink: 0, marginLeft: "12px" }}>{topic.count} conversations</span>
                  </div>
                  <div style={{ fontSize: "12px", color: "#6d7175", fontStyle: "italic", marginBottom: "8px" }}>&ldquo;{topic.sample}&rdquo;</div>
                  <div style={{ fontSize: "12px", color: "#2c6ecb", display: "flex", alignItems: "center", gap: "4px" }}>
                    <span>💡</span>
                    <span>{topic.suggestion}</span>
                    {topic.suggestion?.toLowerCase().includes("faq") && (
                      <a href="/app/ai-config" style={{ marginLeft: "8px", fontSize: "11px", color: "#2c6ecb", fontWeight: 600 }}>Add to FAQ →</a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </s-section>

      {/* ── Revenue Attribution Narrator ── */}
      {(narrative?.bullets?.length ?? 0) > 0 && (
        <s-section heading="This Month's AI Impact">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <span style={{ fontSize: "12px", color: "#8c9196" }}>
              {narrative?.month ? new Date(narrative.month).toLocaleString("default", { month: "long", year: "numeric" }) : "Current month"}
            </span>
            <Form method="post" style={{ display: "inline" }}>
              <input type="hidden" name="intent" value="refresh-revenue" />
              <button type="submit" style={{ padding: "4px 10px", fontSize: "11px", border: "1px solid #c9cccf", borderRadius: "5px", cursor: "pointer", background: "#fff", color: "#6d7175" }}>
                ↻ Refresh
              </button>
            </Form>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {(narrative!.bullets as string[]).map((bullet, i) => (
              <div key={i} style={{ display: "flex", gap: "10px", fontSize: "14px", color: "#202223", lineHeight: "1.5" }}>
                <span style={{ color: "#008060", flexShrink: 0 }}>✓</span>
                <span>{bullet}</span>
              </div>
            ))}
          </div>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
