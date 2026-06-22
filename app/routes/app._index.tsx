import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getUsage } from "../lib/billing.server";
import { adminGraphql } from "../lib/mcp/admin.server";
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

  const PAID_PLANS = new Set(["spark", "pulse", "surge"]);
  if (!PAID_PLANS.has(merchant.plan)) {
    // Return a minimal payload so the component renders an upgrade prompt inline.
    // Do NOT redirect to /app/billing — that pushes the path into the Shopify admin
    // outer URL, and direct navigation to that deep link shows a Shopify 404.
    return {
      hasPlan: false as const,
      shopDomain: shop,
      days: "30",
      currencyCode: "USD",
      stats: null,
      recentEscalations: [],
      usage: await getUsage(shop),
      routingData: [],
      dailyData: [],
      conversionByRoute: {},
      topIntents: [],
    };
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
    hasPlan: true as const,
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

function Metric({ label, value, sub, color, icon }: {
  label: string; value: string; sub?: string;
  color: { bg: string; border: string; text: string };
  icon: string;
}) {
  return (
    <div style={{
      background: color.bg,
      border: `1px solid ${color.border}`,
      borderRadius: "12px",
      padding: "16px 20px",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "13px", color: "#6b7280", fontWeight: 500 }}>{label}</span>
        <span style={{ fontSize: "20px" }}>{icon}</span>
      </div>
      <div style={{ fontSize: "28px", fontWeight: 700, color: color.text, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: "12px", color: "#9ca3af" }}>{sub}</div>}
    </div>
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
              <stop offset="5%" stopColor="#7c3aed" stopOpacity={0.12} />
              <stop offset="95%" stopColor="#7c3aed" stopOpacity={0} />
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
          <Tooltip content={<CustomTooltip />} cursor={{ stroke: "#7c3aed", strokeWidth: 1, strokeDasharray: "4 4" }} />
          <Area
            type="monotone"
            dataKey="count"
            stroke="#7c3aed"
            strokeWidth={2}
            fill="url(#convGradient)"
            dot={false}
            activeDot={{ r: 4, fill: "#7c3aed", strokeWidth: 0 }}
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
  const loaderData = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  if (!loaderData.hasPlan) {
    return (
      <s-page heading="Dashboard">
        <s-section>
          <div style={{ textAlign: "center", padding: "48px 24px" }}>
            <div style={{ fontSize: "48px", marginBottom: "16px" }}>🚀</div>
            <s-heading>Activate NeonPing</s-heading>
            <div style={{ maxWidth: "440px", margin: "12px auto 24px" }}>
              <s-text tone="neutral">
                Choose a plan to turn on your AI chat widget and start converting visitors into customers.
                All plans include a 7-day free trial — no charge until the trial ends.
              </s-text>
            </div>
            <a
              href="/app/billing"
              style={{
                display: "inline-block",
                padding: "12px 28px",
                background: "#008060",
                color: "#fff",
                borderRadius: "8px",
                fontWeight: 600,
                fontSize: "15px",
                textDecoration: "none",
              }}
            >
              Choose a plan
            </a>
          </div>
        </s-section>
      </s-page>
    );
  }

  const { stats, days, recentEscalations, usage, routingData, dailyData, shopDomain, conversionByRoute, topIntents, currencyCode } = loaderData;

  const escalationRatePct = stats.totalConversations
    ? Math.round((stats.escalatedCount / stats.totalConversations) * 100)
    : 0;
  const resolutionRatePct = 100 - escalationRatePct;
  const conversionRatePct = stats.totalConversations
    ? Math.round((stats.conversionsCount / stats.totalConversations) * 100)
    : 0;
  const fmt = (cents: number) =>
    new Intl.NumberFormat("en", { style: "currency", currency: currencyCode }).format(cents / 100);
  const revenue = fmt(stats.revenueCents);
  const aov = stats.conversionsCount
    ? fmt(stats.revenueCents / stats.conversionsCount)
    : fmt(0);
  const cartRecoveryRatePct = stats.cartsCreatedCount
    ? Math.round((stats.cartsRecoveredCount / stats.cartsCreatedCount) * 100)
    : 0;

  const usagePercent = Math.round((usage.used / usage.limit) * 100);
  const isAtCapacity = usage.used >= usage.limit;
  const isNearCapacity = usage.used >= usage.limit * 0.8 && !isAtCapacity;

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
                padding: "10px 12px",
                borderBottom: "1px solid #e1e1e1",
                borderLeft: "4px solid #d97706",
              }}
            >
              <span style={{ fontSize: "13px", color: "#444" }}>
                Session {e.sessionId.slice(0, 8)}
              </span>
              <span style={{ fontSize: "12px", color: "#888" }}>
                {e.messageCount} msg{e.messageCount !== 1 ? "s" : ""} · {new Date(e.lastMessageAt).toLocaleDateString()}
              </span>
              <a
                href={`/app/conversations/${e.id}`}
                style={{
                  fontSize: "13px",
                  fontWeight: 500,
                  color: "#1a1a1a",
                  textDecoration: "none",
                  padding: "4px 10px",
                  border: "1px solid #d1d1d1",
                  borderRadius: "5px",
                }}
              >
                Review
              </a>
            </div>
          ))}
        </s-section>
      )}

      {stats.totalConversations === 0 && (
        <s-section heading="Get started">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px", padding: "8px 0" }}>
            {[
              {
                step: "1",
                title: "Widget installed",
                desc: "Add the NeonPing app embed in your theme editor.",
                href: `https://admin.shopify.com/store/${shopDomain.replace(".myshopify.com", "")}/themes/current/editor?context=apps`,
                cta: "Open Theme Editor",
              },
              {
                step: "2",
                title: "Customize your bot",
                desc: "Set greeting, color, and AI personality to match your brand.",
                href: "/app/settings",
                cta: "Edit Settings",
              },
              {
                step: "3",
                title: "Go live",
                desc: "Share your store link — your first conversation will appear here.",
                href: null,
                cta: null,
              },
            ].map((item) => (
              <div
                key={item.step}
                style={{
                  background: "#fafafa",
                  border: "1px solid #e1e1e1",
                  borderRadius: "8px",
                  padding: "20px",
                }}
              >
                <div
                  style={{
                    width: "28px",
                    height: "28px",
                    borderRadius: "50%",
                    background: "#1a1a1a",
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
                <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "6px" }}>{item.title}</div>
                <div style={{ fontSize: "13px", color: "#666", marginBottom: item.cta ? "14px" : "0" }}>
                  {item.desc}
                </div>
                {item.cta && item.href && (
                  <a
                    href={item.href}
                    target={item.href.startsWith("http") ? "_blank" : undefined}
                    rel={item.href.startsWith("http") ? "noreferrer" : undefined}
                    style={{
                      display: "inline-block",
                      padding: "6px 14px",
                      background: "#1a1a1a",
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
        <ConversationsChart data={dailyData} days={days} />
      </s-section>

      <s-section heading="Performance">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px" }}>
          <Metric label="Conversations" value={String(stats.totalConversations)} color={{ bg: "#f5f3ff", border: "#ddd6fe", text: "#6d28d9" }} icon="💬" />
          <Metric label="Resolution rate" value={`${resolutionRatePct}%`} color={{ bg: "#f0fdf4", border: "#bbf7d0", text: "#15803d" }} icon="📈" />
          <Metric label="Revenue attributed" value={revenue} color={{ bg: "#eff6ff", border: "#bfdbfe", text: "#1d4ed8" }} icon="💰" />
          <Metric label="Conversion rate" value={`${conversionRatePct}%`} color={{ bg: "#f0fdf4", border: "#bbf7d0", text: "#15803d" }} icon="📈" />
          <Metric label="Avg order value" value={aov} color={{ bg: "#fff7ed", border: "#fed7aa", text: "#c2410c" }} icon="🛒" />
          <Metric label="Cart recovery rate" value={`${cartRecoveryRatePct}%`} color={{ bg: "#f0fdf4", border: "#bbf7d0", text: "#15803d" }} icon="📈" />
          <Metric label="Discounts used" value={String(stats.discountsUsedCount)} color={{ bg: "#eff6ff", border: "#bfdbfe", text: "#1d4ed8" }} icon="💰" />
          <Metric
            label="Monthly usage"
            value={`${usage.used} / ${usage.limit}`}
            sub={`${usagePercent}% used`}
            color={{ bg: "#f5f3ff", border: "#ddd6fe", text: "#6d28d9" }}
            icon="💬"
          />
        </div>
      </s-section>

      {(routingData.length > 0 || topIntents.length > 0) && (
        <s-section heading="What customers ask about">
          {routingData.length > 0 && (
            <div style={{ marginBottom: topIntents.length > 0 ? "20px" : "0" }}>
              <div style={{ fontSize: "12px", color: "#888", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "10px" }}>
                Conversation types
              </div>
              {(() => {
                const ROUTE_LABELS: Record<string, string> = {
                  shopping: "Product questions",
                  support: "Support & policies",
                  personalization: "Offers & discounts",
                  direct: "General chat",
                };
                const routeColor: Record<string, string> = {
                  shopping: "#2563eb",
                  support: "#7c3aed",
                  personalization: "#16a34a",
                  direct: "#6b7280",
                };
                const total = routingData.reduce((s, r) => s + r.count, 0);
                return routingData.map((r) => {
                  const conv = conversionByRoute[r.route];
                  const convPct = conv && conv.total > 0 ? Math.round((conv.converted / conv.total) * 100) : null;
                  return (
                    <div key={r.route} style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "10px" }}>
                      <span style={{ width: "160px", fontSize: "13px", color: "#444" }}>
                        {ROUTE_LABELS[r.route] ?? r.route}
                      </span>
                      <div style={{ flex: 1, background: "#f0f0f0", borderRadius: "4px", height: "6px" }}>
                        <div style={{ width: `${Math.round((r.count / total) * 100)}%`, background: routeColor[r.route] ?? "#d97706", height: "6px", borderRadius: "4px" }} />
                      </div>
                      <span style={{ width: "32px", textAlign: "right", fontSize: "12px", color: "#888" }}>
                        {Math.round((r.count / total) * 100)}%
                      </span>
                      {convPct !== null && (
                        <span style={{ width: "80px", fontSize: "11px", color: convPct > 0 ? "#2e7d32" : "#aaa" }}>
                          {convPct > 0 ? `${convPct}% converted` : "0% converted"}
                        </span>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          )}

          {topIntents.length > 0 && (
            <div>
              <div style={{ fontSize: "12px", color: "#888", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "10px" }}>
                Top customer intents
              </div>
              {topIntents.map((intent, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px" }}>
                  <span style={{ width: "20px", fontSize: "12px", color: "#aaa", textAlign: "right" }}>{i + 1}</span>
                  <span style={{ flex: 1, fontSize: "13px", color: "#333" }}>{intent.reason}</span>
                  <span style={{ fontSize: "12px", color: "#888", background: "#f5f5f5", borderRadius: "4px", padding: "2px 8px" }}>
                    {intent.count}×
                  </span>
                </div>
              ))}
            </div>
          )}
        </s-section>
      )}

      <s-section heading="Quick actions">
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          <a href="/app/conversations" style={{ flex: "1 1 160px", textDecoration: "none", border: "1px solid #e5e7eb", borderTop: "3px solid #2563eb", borderRadius: "8px", padding: "16px", background: "#fff", display: "block", color: "#1a1a1a", fontWeight: 500, fontSize: "14px" }}>
            View conversations
          </a>
          <a href="/app/settings" style={{ flex: "1 1 160px", textDecoration: "none", border: "1px solid #e5e7eb", borderTop: "3px solid #7c3aed", borderRadius: "8px", padding: "16px", background: "#fff", display: "block", color: "#1a1a1a", fontWeight: 500, fontSize: "14px" }}>
            Widget settings
          </a>
          <a href="/app/ai-config" style={{ flex: "1 1 160px", textDecoration: "none", border: "1px solid #e5e7eb", borderTop: "3px solid #7c3aed", borderRadius: "8px", padding: "16px", background: "#fff", display: "block", color: "#1a1a1a", fontWeight: 500, fontSize: "14px" }}>
            Knowledge base
          </a>
          <a href="/app/billing" style={{ flex: "1 1 160px", textDecoration: "none", border: "1px solid #e5e7eb", borderTop: "3px solid #16a34a", borderRadius: "8px", padding: "16px", background: "#fff", display: "block", color: "#1a1a1a", fontWeight: 500, fontSize: "14px" }}>
            Billing
          </a>
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
