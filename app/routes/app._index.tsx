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

// ─── HeroMetric card ──────────────────────────────────────────────────────────

interface HeroMetricProps {
  label: string;
  value: string;
  sub?: string;
  accent: string; // CSS color for the 4px top bar
}

function HeroMetric({ label, value, sub, accent }: HeroMetricProps) {
  return (
    <div style={{
      flex: "1 1 200px",
      background: "rgba(255,255,255,0.75)",
      backdropFilter: "blur(12px)",
      WebkitBackdropFilter: "blur(12px)",
      border: "1px solid rgba(255,255,255,0.9)",
      borderTop: `4px solid ${accent}`,
      borderRadius: "14px",
      padding: "24px 28px 20px",
      boxShadow: "0 4px 24px rgba(99,102,241,0.08), 0 1px 4px rgba(0,0,0,0.04)",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      minWidth: 0,
    }}>
      <div style={{ fontSize: "11px", color: "#6b7280", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.6px" }}>
        {label}
      </div>
      <div style={{ fontSize: "38px", fontWeight: 800, color: "#111827", lineHeight: 1.1, wordBreak: "break-word" }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "2px" }}>{sub}</div>
      )}
    </div>
  );
}

// ─── Metric card ──────────────────────────────────────────────────────────────

interface MetricProps {
  label: string;
  value: string;
  sub?: string;
  accent: string;
  textColor: string;
}

function Metric({ label, value, sub, accent, textColor }: MetricProps) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.7)",
      backdropFilter: "blur(10px)",
      WebkitBackdropFilter: "blur(10px)",
      border: "1px solid rgba(209,213,219,0.5)",
      borderTop: `3px solid ${accent}`,
      borderRadius: "12px",
      padding: "18px 20px 16px",
      boxShadow: "0 4px 24px rgba(99,102,241,0.06), 0 1px 3px rgba(0,0,0,0.03)",
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      minWidth: 0,
    }}>
      <div style={{ fontSize: "11px", color: "#6b7280", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px" }}>
        {label}
      </div>
      <div style={{ fontSize: "24px", fontWeight: 700, color: textColor, lineHeight: 1.2, wordBreak: "break-word" }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "2px" }}>{sub}</div>
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

// ─── Smooth bezier path helper ────────────────────────────────────────────────

function smoothPath(points: Array<[number, number]>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0][0]} ${points[0][1]}`;
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const cx = (x0 + x1) / 2;
    d += ` C ${cx} ${y0} ${cx} ${y1} ${x1} ${y1}`;
  }
  return d;
}

// ─── LineChart ────────────────────────────────────────────────────────────────

function LineChart({
  data,
  days,
}: {
  data: Array<{ date: string; count: number }>;
  days: number;
}) {
  const [tooltip, setTooltip] = useState<{ svgX: number; svgY: number; date: string; count: number } | null>(null);

  const filled = fillDates(data, days);
  const maxCount = Math.max(...filled.map((d) => d.count), 1);

  const W = 800;
  const H = 180;
  const PAD_LEFT = 8;
  const PAD_RIGHT = 8;
  const PAD_TOP = 16;
  const PAD_BOTTOM = 28;
  const chartW = W - PAD_LEFT - PAD_RIGHT;
  const chartH = H - PAD_TOP - PAD_BOTTOM;

  const points: Array<[number, number]> = filled.map((d, i) => [
    PAD_LEFT + (i / Math.max(filled.length - 1, 1)) * chartW,
    PAD_TOP + chartH - (d.count / maxCount) * chartH,
  ]);

  const linePath = smoothPath(points);

  // Closed area path (line + bottom)
  const areaPath =
    linePath +
    ` L ${points[points.length - 1][0]} ${PAD_TOP + chartH}` +
    ` L ${points[0][0]} ${PAD_TOP + chartH} Z`;

  // X-axis labels: max 7, evenly distributed
  const labelIndices: number[] = [];
  const maxLabels = Math.min(7, filled.length);
  if (filled.length <= maxLabels) {
    filled.forEach((_, i) => labelIndices.push(i));
  } else {
    for (let l = 0; l < maxLabels; l++) {
      labelIndices.push(Math.round((l / (maxLabels - 1)) * (filled.length - 1)));
    }
  }

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    let nearest = 0;
    let nearestDist = Infinity;
    points.forEach(([px], i) => {
      const dist = Math.abs(px - mx);
      if (dist < nearestDist) { nearestDist = dist; nearest = i; }
    });
    const [sx, sy] = points[nearest];
    setTooltip({ svgX: sx, svgY: sy, date: filled[nearest].date, count: filled[nearest].count });
  };

  const isEmpty = filled.every((d) => d.count === 0);

  if (isEmpty) {
    return (
      <div style={{ height: "180px", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontSize: "14px", color: "#9ca3af" }}>
          No conversations in this period — share your store link to get started.
        </span>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", marginTop: "16px" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "200px", overflow: "visible", cursor: "crosshair" }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTooltip(null)}
      >
        <defs>
          <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6366f1" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Y-axis grid lines */}
        {[0.25, 0.5, 0.75].map((frac) => (
          <line
            key={frac}
            x1={PAD_LEFT}
            y1={PAD_TOP + chartH * (1 - frac)}
            x2={PAD_LEFT + chartW}
            y2={PAD_TOP + chartH * (1 - frac)}
            stroke="#e5e7eb"
            strokeWidth="1"
            strokeDasharray="4 4"
          />
        ))}

        {/* Baseline */}
        <line
          x1={PAD_LEFT} y1={PAD_TOP + chartH}
          x2={PAD_LEFT + chartW} y2={PAD_TOP + chartH}
          stroke="#e5e7eb" strokeWidth="1"
        />

        {/* Area fill */}
        <path d={areaPath} fill="url(#areaGrad)" />

        {/* Line */}
        <path d={linePath} fill="none" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

        {/* Data point dots */}
        {points.map(([px, py], i) => (
          <circle
            key={i}
            cx={px} cy={py} r="3"
            fill="#fff" stroke="#6366f1" strokeWidth="2"
            opacity={tooltip && filled[i].date === tooltip.date ? 0 : 0.7}
          />
        ))}

        {/* Hover active dot */}
        {tooltip && (() => {
          const idx = filled.findIndex((d) => d.date === tooltip.date);
          const pt = idx >= 0 ? points[idx] : null;
          if (!pt) return null;
          return (
            <circle
              cx={pt[0]}
              cy={tooltip.svgY}
              r="5.5"
              fill="#6366f1"
              stroke="#fff"
              strokeWidth="2"
            />
          );
        })()}

        {/* X-axis labels */}
        {labelIndices.map((idx) => {
          const [lx] = points[idx];
          const d = new Date(filled[idx].date + "T00:00:00Z");
          const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
          return (
            <text
              key={idx}
              x={lx}
              y={H - 4}
              textAnchor="middle"
              fontSize="10"
              fill="#9ca3af"
            >
              {label}
            </text>
          );
        })}
      </svg>

      {/* Hover tooltip */}
      {tooltip && (() => {
        const idx = filled.findIndex((d) => d.date === tooltip.date);
        const pt = idx >= 0 ? points[idx] : null;
        if (!pt) return null;
        const leftPct = (pt[0] / W) * 100;
        return (
          <div style={{
            position: "absolute",
            top: "8px",
            left: `${leftPct}%`,
            transform: leftPct > 70 ? "translateX(-110%)" : "translateX(8px)",
            background: "rgba(17,24,39,0.92)",
            backdropFilter: "blur(8px)",
            color: "#fff",
            padding: "8px 12px",
            borderRadius: "8px",
            fontSize: "12px",
            fontWeight: 500,
            pointerEvents: "none",
            whiteSpace: "nowrap",
            boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
          }}>
            <div style={{ color: "#d1d5db", marginBottom: "2px" }}>
              {new Date(tooltip.date + "T00:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}
            </div>
            <div style={{ fontSize: "16px", fontWeight: 700 }}>
              {tooltip.count} conversation{tooltip.count !== 1 ? "s" : ""}
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

const ROUTE_COLORS: Record<string, string> = {
  shopping: "#2563eb",
  support: "#7c3aed",
  personalization: "#16a34a",
  direct: "#6b7280",
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
    new Intl.NumberFormat("en", { style: "currency", currency: currencyCode }).format(cents / 100);
  const revenue = fmtCurrency(stats.revenueCents);
  const aov = stats.conversionsCount
    ? fmtCurrency(stats.revenueCents / stats.conversionsCount)
    : fmtCurrency(0);
  const cartRecoveryRatePct = stats.cartsCreatedCount
    ? Math.round((stats.cartsRecoveredCount / stats.cartsCreatedCount) * 100)
    : 0;

  const usagePercent = usage.limit > 0 ? Math.round((usage.used / usage.limit) * 100) : 0;
  const isAtCapacity = usage.limit > 0 && usage.used >= usage.limit;
  const isNearCapacity = usage.limit > 0 && usage.used >= usage.limit * 0.8 && !isAtCapacity;

  const daysNum = parseInt(days, 10) || 30;

  return (
    <s-page heading="Dashboard">
      {/* ── Banners ── */}
      {!hasPlan && (
        <s-banner tone="info">
          {"Your chat widget is inactive. "}
          <a href="/app/billing" style={{ fontWeight: 600 }}>Choose a plan</a>
          {" to activate NeonPing — all plans include a 7-day free trial."}
        </s-banner>
      )}
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

      {/* ── Overview (hero KPIs) ── */}
      <s-section heading="Overview">
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
          <HeroMetric
            label="Revenue attributed"
            value={revenue}
            sub={`from ${stats.conversionsCount} orders`}
            accent="#6366f1"
          />
          <HeroMetric
            label="Conversations"
            value={stats.totalConversations.toLocaleString()}
            sub={`last ${days} days`}
            accent="#8b5cf6"
          />
          <HeroMetric
            label="Conversion rate"
            value={`${conversionRatePct}%`}
            sub={`${stats.conversionsCount} of ${stats.totalConversations} converted`}
            accent="#06b6d4"
          />
        </div>
      </s-section>

      {/* ── Needs attention ── */}
      {recentEscalations.length > 0 && (
        <s-section heading={`Needs attention (${recentEscalations.length})`}>
          <div style={{ borderRadius: "8px", overflow: "hidden", border: "1px solid #fde68a" }}>
            {recentEscalations.map((e, idx) => (
              <div
                key={e.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "12px 16px",
                  borderBottom: idx < recentEscalations.length - 1 ? "1px solid #fde68a" : "none",
                  background: idx % 2 === 0 ? "#fffbeb" : "#fff",
                  borderLeft: "4px solid #d97706",
                }}
              >
                <div>
                  <span style={{ fontSize: "13px", fontWeight: 600, color: "#1a1a1a" }}>
                    Session {e.sessionId.slice(0, 8)}
                  </span>
                  <span style={{ fontSize: "12px", color: "#888", marginLeft: "10px" }}>
                    {e.messageCount} msg{e.messageCount !== 1 ? "s" : ""}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <span style={{ fontSize: "12px", color: "#9ca3af" }}>
                    {new Date(e.lastMessageAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </span>
                  <a
                    href={`/app/conversations/${e.id}`}
                    style={{
                      fontSize: "13px",
                      fontWeight: 500,
                      color: "#1a1a1a",
                      textDecoration: "none",
                      padding: "5px 12px",
                      border: "1px solid #d1d5db",
                      borderRadius: "6px",
                      background: "#fff",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Review
                  </a>
                </div>
              </div>
            ))}
          </div>
        </s-section>
      )}

      {/* ── Get started (shown only when no data yet) ── */}
      {stats.totalConversations === 0 && (
        <s-section heading="Get started">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px" }}>
            {[
              {
                step: "1",
                title: "Install widget",
                desc: "Enable the NeonPing app embed in your theme editor to show the chat widget on your storefront.",
                href: `https://admin.shopify.com/store/${shopDomain.replace(".myshopify.com", "")}/themes/current/editor?context=apps`,
                cta: "Open Theme Editor",
                accentColor: "#2563eb",
              },
              {
                step: "2",
                title: "Customize your bot",
                desc: "Set a greeting message, brand color, and AI tone that matches your store's voice.",
                href: "/app/settings",
                cta: "Edit Settings",
                accentColor: "#7c3aed",
              },
              {
                step: "3",
                title: "Go live",
                desc: "Share your store — your first conversation will appear here and start generating insights.",
                href: null,
                cta: null,
                accentColor: "#16a34a",
              },
            ].map((item) => (
              <div
                key={item.step}
                style={{
                  background: "#fafafa",
                  border: "1px solid #e5e7eb",
                  borderTop: `3px solid ${item.accentColor}`,
                  borderRadius: "10px",
                  padding: "20px",
                }}
              >
                <div
                  style={{
                    width: "30px",
                    height: "30px",
                    borderRadius: "50%",
                    background: item.accentColor,
                    color: "#fff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "13px",
                    fontWeight: 700,
                    marginBottom: "12px",
                  }}
                >
                  {item.step}
                </div>
                <div style={{ fontSize: "14px", fontWeight: 600, color: "#111827", marginBottom: "6px" }}>
                  {item.title}
                </div>
                <div style={{ fontSize: "13px", color: "#6b7280", lineHeight: "1.5", marginBottom: item.cta ? "16px" : "0" }}>
                  {item.desc}
                </div>
                {item.cta && item.href && (
                  <a
                    href={item.href}
                    target={item.href.startsWith("http") ? "_blank" : undefined}
                    rel={item.href.startsWith("http") ? "noreferrer" : undefined}
                    style={{
                      display: "inline-block",
                      padding: "7px 16px",
                      background: item.accentColor,
                      color: "#fff",
                      borderRadius: "6px",
                      textDecoration: "none",
                      fontSize: "13px",
                      fontWeight: 500,
                    }}
                  >
                    {item.cta}
                  </a>
                )}
              </div>
            ))}
          </div>
        </s-section>
      )}

      {/* ── Conversations chart ── */}
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
            <s-option key={opt.value} value={opt.value}>{opt.label}</s-option>
          ))}
        </s-select>
        <LineChart data={dailyData} days={daysNum} />
      </s-section>

      {/* ── Performance metrics ── */}
      <s-section heading="Performance">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "14px" }}>
          <Metric label="Resolution rate" value={`${resolutionRatePct}%`} accent="#16a34a" textColor="#15803d" />
          <Metric label="Avg order value" value={aov} accent="#d97706" textColor="#b45309" />
          <Metric label="Cart recovery rate" value={`${cartRecoveryRatePct}%`} accent="#0891b2" textColor="#0e7490" />
          <Metric label="Discounts used" value={String(stats.discountsUsedCount)} accent="#7c3aed" textColor="#6d28d9" />
          <Metric
            label="Monthly usage"
            value={`${usage.used} / ${usage.limit > 0 ? usage.limit.toLocaleString() : "∞"}`}
            sub={usage.limit > 0 ? `${usagePercent}% used` : "Unlimited"}
            accent={usagePercent >= 100 ? "#dc2626" : usagePercent >= 80 ? "#d97706" : "#6366f1"}
            textColor={usagePercent >= 100 ? "#dc2626" : usagePercent >= 80 ? "#d97706" : "#4f46e5"}
          />
        </div>
      </s-section>

      {/* ── What customers ask ── */}
      {(routingData.length > 0 || topIntents.length > 0) && (
        <s-section heading="What customers ask about">
          <div style={{ display: "grid", gridTemplateColumns: routingData.length > 0 && topIntents.length > 0 ? "1fr 1fr" : "1fr", gap: "24px" }}>

            {routingData.length > 0 && (
              <div>
                <div style={{ fontSize: "11px", color: "#9ca3af", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: "14px" }}>
                  Conversation types
                </div>
                {(() => {
                  const total = routingData.reduce((s, r) => s + r.count, 0);
                  return routingData.map((r) => {
                    const pct = total > 0 ? Math.round((r.count / total) * 100) : 0;
                    const conv = conversionByRoute[r.route];
                    const convPct = conv && conv.total > 0 ? Math.round((conv.converted / conv.total) * 100) : null;
                    const color = ROUTE_COLORS[r.route] ?? "#9ca3af";
                    return (
                      <div key={r.route} style={{ marginBottom: "14px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "5px" }}>
                          <span style={{ fontSize: "13px", color: "#374151", fontWeight: 500 }}>
                            {ROUTE_LABELS[r.route] ?? r.route}
                          </span>
                          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                            {convPct !== null && (
                              <span style={{ fontSize: "11px", color: convPct > 0 ? "#16a34a" : "#9ca3af", fontWeight: 600 }}>
                                {convPct}% converted
                              </span>
                            )}
                            <span style={{ fontSize: "12px", color: "#6b7280", minWidth: "32px", textAlign: "right" }}>
                              {pct}%
                            </span>
                          </div>
                        </div>
                        <div style={{ height: "6px", background: "#f3f4f6", borderRadius: "3px", overflow: "hidden" }}>
                          <div
                            style={{
                              width: `${pct}%`,
                              height: "100%",
                              background: color,
                              borderRadius: "3px",
                              transition: "width 0.3s ease",
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
                <div style={{ fontSize: "11px", color: "#9ca3af", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: "14px" }}>
                  Top customer intents
                </div>
                {topIntents.map((intent, i) => {
                  const maxIntentCount = topIntents[0]?.count ?? 1;
                  const pct = Math.round((intent.count / maxIntentCount) * 100);
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
                      <span style={{ width: "18px", fontSize: "11px", color: "#9ca3af", textAlign: "right", flexShrink: 0 }}>
                        {i + 1}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "3px" }}>
                          <span style={{ fontSize: "13px", color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "calc(100% - 40px)" }}>
                            {intent.reason}
                          </span>
                          <span style={{ fontSize: "11px", color: "#9ca3af", flexShrink: 0, marginLeft: "8px" }}>
                            {intent.count}x
                          </span>
                        </div>
                        <div style={{ height: "4px", background: "#f3f4f6", borderRadius: "2px", overflow: "hidden" }}>
                          <div style={{ width: `${pct}%`, height: "100%", background: "#7c3aed", borderRadius: "2px" }} />
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
