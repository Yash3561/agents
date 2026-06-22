import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getUsage } from "../lib/billing.server";
import { adminGraphql } from "../lib/mcp/admin.server";

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

  const PAID_PLANS = new Set(["spark", "pulse", "surge"]);
  const hasPlan = PAID_PLANS.has(merchant.plan);

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
      select: { id: true, sessionId: true, lastMessageAt: true, messageCount: true },
    }),
    getUsage(shop),
  ]);

  const rawRouting = await prisma.$queryRaw<Array<{ route: string; count: bigint }>>`
    SELECT
      SPLIT_PART("agentTrace"::json->>0, ':', 2) as route,
      COUNT(*) as count
    FROM "Conversation"
    WHERE "shopDomain" = ${shop}
      AND "startedAt" >= ${since}
      AND "agentTrace" IS NOT NULL
      AND "agentTrace"::json->>0 LIKE 'orchestrator:%'
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

  return {
    hasPlan,
    days,
    shopDomain: shop,
    currencyCode,
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
    conversionByRoute: Object.fromEntries(conversionByRoute),
    topIntents,
  };
};

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
    recentEscalations,
    usage,
    routingData,
    dailyData,
    shopDomain,
    conversionByRoute,
    topIntents,
    currencyCode,
  } = loaderData;

  // ── Computed metrics ──────────────────────────────────────────────────────
  const escalationRatePct = stats.totalConversations
    ? Math.round((stats.escalatedCount / stats.totalConversations) * 100)
    : 0;
  const resolutionRatePct = 100 - escalationRatePct;
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
  const cartConversionRatePct = stats.cartsCreatedCount
    ? Math.round((stats.cartsRecoveredCount / stats.cartsCreatedCount) * 100)
    : 0;

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

  const usageBorderColor = isAtCapacity
    ? "#d82c0d"
    : isNearCapacity
    ? "#ffc453"
    : "#6d7175";

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

      {/* ── Performance (8 KPI grid) ── */}
      <s-section heading="Performance">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "12px",
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
            sub={`from ${stats.conversionsCount} orders`}
            borderColor="#008060"
          />
          <Metric
            label="Conversion rate"
            value={`${conversionRatePct}%`}
            sub={`${stats.conversionsCount} of ${stats.totalConversations} converted`}
            borderColor="#008060"
          />
          <Metric
            label="Avg order value"
            value={aov}
            borderColor="#2c6ecb"
          />
          <Metric
            label="Resolution rate"
            value={`${resolutionRatePct}%`}
            sub={`${stats.escalatedCount} escalated`}
            borderColor="#008060"
          />
          <Metric
            label="Cart conversion rate"
            value={`${cartConversionRatePct}%`}
            sub={`${stats.cartsCreatedCount} cart sessions`}
            borderColor="#008060"
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
            borderColor={usageBorderColor}
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
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
