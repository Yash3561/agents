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

// ─── Metric card ────────────────────────────────────────────────────────────

interface MetricProps {
  label: string;
  value: string;
  sub?: string;
  accent: string;       // border-top colour
  dimColor: string;     // background tint
  textColor: string;    // value text colour
}

function Metric({ label, value, sub, accent, dimColor, textColor }: MetricProps) {
  return (
    <div
      style={{
        background: dimColor,
        border: "1px solid rgba(0,0,0,0.07)",
        borderTop: `3px solid ${accent}`,
        borderRadius: "10px",
        padding: "18px 20px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: "12px", color: "#6b7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.4px" }}>
        {label}
      </div>
      <div style={{ fontSize: "26px", fontWeight: 700, color: textColor, lineHeight: 1.15, wordBreak: "break-word" }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "2px" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

// ─── Date fill helper ────────────────────────────────────────────────────────

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

// ─── CSS bar chart ────────────────────────────────────────────────────────────
// No charting library — recharts uses eval() which Shopify's CSP blocks.

function ConversationsChart({
  data,
  days,
}: {
  data: Array<{ date: string; count: number }>;
  days: string;
}) {
  const daysNum = parseInt(days, 10) || 30;
  const filled = fillDates(data, daysNum);
  const maxCount = Math.max(...filled.map((d) => d.count), 1);
  const allZero = filled.every((d) => d.count === 0);

  // Y-axis guide lines at 25 / 50 / 75 / 100 %
  const guides = [75, 50, 25];

  // Show at most 7 x-axis date labels to avoid crowding
  const labelCount = Math.min(7, filled.length);
  const labelIndices = new Set(
    Array.from({ length: labelCount }, (_, i) =>
      Math.round((i / Math.max(labelCount - 1, 1)) * (filled.length - 1))
    )
  );

  const fmtLabel = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      {/* Chart area with guide lines */}
      <div style={{ position: "relative" }}>
        {/* Horizontal guide lines */}
        {!allZero && guides.map((pct) => (
          <div
            key={pct}
            style={{
              position: "absolute",
              top: `${100 - pct}%`,
              left: 0,
              right: 0,
              height: "1px",
              background: "#f0f0f0",
              pointerEvents: "none",
            }}
          />
        ))}
        {/* Bars */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: "2px",
            height: "168px",
            padding: "0 4px",
            borderBottom: "2px solid #e5e7eb",
          }}
        >
          {filled.map((d) => {
            const heightPct = allZero ? 0 : (d.count / maxCount) * 100;
            return (
              <div
                key={d.date}
                title={`${fmtLabel(d.date)}: ${d.count} conversation${d.count !== 1 ? "s" : ""}`}
                style={{
                  flex: 1,
                  minWidth: "2px",
                  height: `${Math.max(heightPct, d.count > 0 ? 3 : 0)}%`,
                  background: "linear-gradient(to top, #6d28d9, #8b5cf6)",
                  borderRadius: "3px 3px 0 0",
                  transition: "opacity 0.15s ease",
                  cursor: "default",
                }}
              />
            );
          })}
        </div>
      </div>

      {/* X-axis labels */}
      <div
        style={{
          display: "flex",
          gap: "2px",
          padding: "5px 4px 0",
        }}
      >
        {filled.map((d, i) => (
          <div
            key={d.date}
            style={{
              flex: 1,
              minWidth: "2px",
              fontSize: "10px",
              color: "#9ca3af",
              textAlign: "center",
              overflow: "hidden",
              whiteSpace: "nowrap",
            }}
          >
            {labelIndices.has(i) ? fmtLabel(d.date) : ""}
          </div>
        ))}
      </div>

      {allZero && (
        <div style={{ textAlign: "center", padding: "12px 0 4px", fontSize: "13px", color: "#9ca3af" }}>
          No conversations in this period — share your store link to get started.
        </div>
      )}
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

  const usagePercent = Math.round((usage.used / usage.limit) * 100);
  const isAtCapacity = usage.used >= usage.limit;
  const isNearCapacity = usage.used >= usage.limit * 0.8 && !isAtCapacity;

  // ── Inline styles ─────────────────────────────────────────────────────────
  const sectionDivider: React.CSSProperties = {
    margin: "0 0 16px",
    borderBottom: "1px solid #f3f4f6",
    paddingBottom: "12px",
  };

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
        <div style={{ ...sectionDivider, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: "13px", color: "#6b7280" }}>
            {stats.totalConversations} total in period
          </span>
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
        </div>
        <ConversationsChart data={dailyData} days={days} />
      </s-section>

      {/* ── Performance metrics ── */}
      <s-section heading="Performance">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px" }}>
          <Metric
            label="Conversations"
            value={stats.totalConversations.toLocaleString()}
            sub={`in last ${days} days`}
            accent="#7c3aed"
            dimColor="#f5f3ff"
            textColor="#5b21b6"
          />
          <Metric
            label="Resolution rate"
            value={`${resolutionRatePct}%`}
            sub={`${escalationRatePct}% escalated`}
            accent="#16a34a"
            dimColor="#f0fdf4"
            textColor="#15803d"
          />
          <Metric
            label="Revenue attributed"
            value={revenue}
            sub={`${stats.conversionsCount} orders`}
            accent="#2563eb"
            dimColor="#eff6ff"
            textColor="#1d4ed8"
          />
          <Metric
            label="Conversion rate"
            value={`${conversionRatePct}%`}
            sub="chat to purchase"
            accent="#0891b2"
            dimColor="#ecfeff"
            textColor="#0e7490"
          />
          <Metric
            label="Avg order value"
            value={aov}
            sub="per converted chat"
            accent="#d97706"
            dimColor="#fffbeb"
            textColor="#b45309"
          />
          <Metric
            label="Cart recovery rate"
            value={`${cartRecoveryRatePct}%`}
            sub={`${stats.cartsRecoveredCount} of ${stats.cartsCreatedCount} carts`}
            accent="#16a34a"
            dimColor="#f0fdf4"
            textColor="#15803d"
          />
          <Metric
            label="Discounts used"
            value={stats.discountsUsedCount.toLocaleString()}
            sub="via chat conversations"
            accent="#7c3aed"
            dimColor="#f5f3ff"
            textColor="#5b21b6"
          />
          <Metric
            label="Monthly usage"
            value={`${usage.used.toLocaleString()} / ${usage.limit.toLocaleString()}`}
            sub={`${usagePercent}% of plan limit`}
            accent={isAtCapacity ? "#dc2626" : isNearCapacity ? "#d97706" : "#6b7280"}
            dimColor={isAtCapacity ? "#fef2f2" : isNearCapacity ? "#fffbeb" : "#f9fafb"}
            textColor={isAtCapacity ? "#b91c1c" : isNearCapacity ? "#b45309" : "#374151"}
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

      {/* ── Quick actions ── */}
      <s-section heading="Quick actions">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px" }}>
          {[
            { href: "/app/conversations", label: "View conversations", desc: "Browse chat history", accent: "#2563eb" },
            { href: "/app/settings", label: "Widget settings", desc: "Greeting, color, position", accent: "#7c3aed" },
            { href: "/app/ai-config", label: "Knowledge base", desc: "FAQs and AI personality", accent: "#0891b2" },
            { href: "/app/billing", label: "Billing & plan", desc: "Usage, limits, upgrade", accent: "#16a34a" },
          ].map((action) => (
            <a
              key={action.href}
              href={action.href}
              style={{
                textDecoration: "none",
                display: "block",
                padding: "18px 20px",
                background: "#fff",
                border: "1px solid #e5e7eb",
                borderTop: `3px solid ${action.accent}`,
                borderRadius: "10px",
                transition: "box-shadow 0.15s ease",
              }}
            >
              <div style={{ fontSize: "14px", fontWeight: 600, color: "#111827", marginBottom: "4px" }}>
                {action.label}
              </div>
              <div style={{ fontSize: "12px", color: "#6b7280" }}>
                {action.desc}
              </div>
            </a>
          ))}
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
