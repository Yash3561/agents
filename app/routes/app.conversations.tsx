import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useSearchParams } from "react-router";
import { FilterButtonGroup } from "~/components/FilterButtonGroup";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { adminGraphql } from "../lib/mcp/admin.server";
import { useRef } from "react";

// ponytail: inlined from conversation.server to keep this module client-safe
function computeOutcome(c: { orderId: string | null; escalated: boolean; cartId: string | null; lastMessageAt: Date }): "converted" | "in_cart" | "escalated" | "active" | "ended" {
  if (c.orderId) return "converted";
  if (c.escalated) return "escalated";
  if (new Date(c.lastMessageAt) > new Date(Date.now() - 10 * 60 * 1000)) return "active";
  if (c.cartId) return "in_cart";
  return "ended";
}

const PAGE_SIZE = 50;

const DATE_RANGE_OPTIONS = [
  { value: "1", label: "Last 24h" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
] as const;

const OUTCOME_OPTIONS = [
  { value: "all", label: "All" },
  { value: "purchased", label: "Purchased" },
  { value: "in_cart", label: "In Cart" },
  { value: "escalated_open", label: "Escalated (Open)" },
  { value: "escalated", label: "Escalated (All)" },
  { value: "active", label: "Live" },
  { value: "ended", label: "Ended" },
] as const;

const CUSTOMER_OPTIONS = [
  { value: "all", label: "All customers" },
  { value: "loggedin", label: "Logged-in" },
  { value: "anonymous", label: "Anonymous" },
] as const;

const CHANNEL_OPTIONS = [
  { value: "all", label: "All channels" },
  { value: "website", label: "Website" },
  { value: "whatsapp", label: "WhatsApp" },
] as const;

type BadgeTone = "success" | "critical" | "info" | "neutral" | "caution" | "warning" | "auto";

const OUTCOME_BADGE: Record<string, { tone: BadgeTone; label: string }> = {
  converted: { tone: "success",  label: "Purchased" },
  escalated: { tone: "critical", label: "Escalated" },
  active:    { tone: "info",     label: "Live now" },
  in_cart:   { tone: "caution",  label: "In Cart" },
  ended:     { tone: "neutral",  label: "Ended" },
};

function relativeTime(date: string | Date): string {
  const diff = Date.now() - new Date(date).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(date).toLocaleDateString("en", { month: "short", day: "numeric" });
}

function fmtValue(
  c: { orderId: string | null; orderRevenueCents: number | null; cartValue: number | null },
  currencyCode: string,
): string {
  if (c.orderRevenueCents) {
    return new Intl.NumberFormat("en", { style: "currency", currency: currencyCode }).format(
      c.orderRevenueCents / 100,
    );
  }
  if (c.cartValue) {
    return new Intl.NumberFormat("en", { style: "currency", currency: currencyCode }).format(
      c.cartValue,
    );
  }
  return "—";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const outcome = url.searchParams.get("outcome") ?? "all";
  const customer = url.searchParams.get("customer") ?? "all";
  const channel = url.searchParams.get("channel") ?? "all";
  const days = url.searchParams.get("days") ?? "all";
  const search = url.searchParams.get("q") ?? "";
  const page = Math.max(0, Number(url.searchParams.get("page") || "0"));

  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

  const outcomeFilter =
    outcome === "purchased" ? { orderId: { not: null } }
    : outcome === "escalated" ? { escalated: true }
    : outcome === "escalated_open" ? { escalated: true, resolved: false }
    : outcome === "in_cart" ? { cartId: { not: null }, orderId: null }
    : outcome === "active" ? { lastMessageAt: { gte: tenMinutesAgo } }
    : outcome === "ended" ? { cartId: null, orderId: null, escalated: false, lastMessageAt: { lt: tenMinutesAgo } }
    : {};

  const customerFilter =
    customer === "loggedin" ? { customerId: { not: null } }
    : customer === "anonymous" ? { customerId: null }
    : {};

  const channelFilter =
    channel === "whatsapp" ? { channel: "whatsapp" }
    : channel === "website" ? { NOT: { channel: "whatsapp" } }
    : {};

  const searchFilter = search.trim()
    ? {
        OR: [
          { firstUserMessage: { contains: search.trim(), mode: "insensitive" as const } },
          { sessionId: { contains: search.trim(), mode: "insensitive" as const } },
        ],
      }
    : {};

  const since =
    days === "1" ? new Date(Date.now() - 86_400_000)
    : days !== "all" ? new Date(Date.now() - Number(days) * 86_400_000)
    : null;
  const dateFilter = since ? { startedAt: { gte: since } } : {};

  const where = { shopDomain: shop, ...outcomeFilter, ...customerFilter, ...channelFilter, ...searchFilter, ...dateFilter };
  const dateOnlyWhere = { shopDomain: shop, ...dateFilter };

  const [
    conversations,
    total,
    totalCount,
    purchasedCount,
    inCartCount,
    escalatedCount,
    liveCount,
    shopData,
  ] = await Promise.all([
    prisma.conversation.findMany({
      where,
      orderBy: { lastMessageAt: "desc" },
      take: PAGE_SIZE,
      skip: page * PAGE_SIZE,
    }),
    prisma.conversation.count({ where }),
    prisma.conversation.count({ where: dateOnlyWhere }),
    prisma.conversation.count({ where: { ...dateOnlyWhere, orderId: { not: null } } }),
    prisma.conversation.count({ where: { ...dateOnlyWhere, cartId: { not: null }, orderId: null } }),
    prisma.conversation.count({ where: { ...dateOnlyWhere, escalated: true } }),
    prisma.conversation.count({ where: { ...dateOnlyWhere, lastMessageAt: { gte: tenMinutesAgo } } }),
    adminGraphql<{ shop: { currencyCode: string } }>(
      session.shop,
      session.accessToken ?? "",
      `{ shop { currencyCode } }`,
    ).catch(() => ({ shop: { currencyCode: "USD" } })),
  ]);

  const currencyCode = shopData.shop?.currencyCode ?? "USD";

  return {
    conversations,
    total,
    totalCount,
    purchasedCount,
    inCartCount,
    escalatedCount,
    liveCount,
    page,
    outcome,
    customer,
    channel,
    days,
    search,
    currencyCode,
  };
};

export default function Conversations() {
  const {
    conversations,
    total,
    totalCount,
    purchasedCount,
    inCartCount,
    escalatedCount,
    liveCount,
    page,
    outcome,
    customer,
    channel,
    days,
    search,
    currencyCode,
  } = useLoaderData<typeof loader>();

  const [searchParams, setSearchParams] = useSearchParams();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    next.set(key, value);
    next.set("page", "0");
    setSearchParams(next);
  }

  function handleSearchChange(value: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (value.trim()) {
        next.set("q", value.trim());
      } else {
        next.delete("q");
      }
      next.set("page", "0");
      setSearchParams(next);
    }, 400);
  }

  return (
    <s-page heading="Conversations">
      {/* Filters */}
      <s-section>
        <s-stack direction="block" gap="base">
          <FilterButtonGroup options={DATE_RANGE_OPTIONS} value={days} onChange={(v) => setParam("days", v)} />
          <FilterButtonGroup options={OUTCOME_OPTIONS} value={outcome} onChange={(v) => setParam("outcome", v)} />
          <FilterButtonGroup options={CUSTOMER_OPTIONS} value={customer} onChange={(v) => setParam("customer", v)} />
          <FilterButtonGroup options={CHANNEL_OPTIONS} value={channel} onChange={(v) => setParam("channel", v)} />
        </s-stack>
      </s-section>

      {/* Search */}
      <s-section>
        <s-text-field
          label="Search conversations"
          value={search}
          onInput={(e: Event) => {
            const target = e.target as HTMLInputElement;
            handleSearchChange(target.value);
          }}
          placeholder="Search by topic or session ID..."
        />
      </s-section>

      {/* Summary bar */}
      <s-section>
        <div style={{ padding: "8px 0", borderBottom: "1px solid var(--color-border)", marginBottom: "12px" }}>
          <s-text tone="neutral">
            {totalCount} total
            {purchasedCount > 0 && ` · ${purchasedCount} purchased`}
            {inCartCount > 0 && ` · ${inCartCount} in cart`}
            {escalatedCount > 0 && ` · ${escalatedCount} escalated`}
            {liveCount > 0 && <> · <strong style={{ color: "var(--color-warning)" }}>{liveCount} live now</strong></>}
          </s-text>
        </div>

        {/* Table */}
        {conversations.length === 0 ? (
          <s-paragraph>
            {totalCount === 0
              ? "No conversations yet. Share your store link to get your first chat."
              : "No conversations match the current filters. Try clearing the search or changing the filters above."}
          </s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Customer</s-table-header>
              <s-table-header>Topic</s-table-header>
              <s-table-header>Outcome</s-table-header>
              <s-table-header>Value</s-table-header>
              <s-table-header>Last Active</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {conversations.map((c) => {
                const outcomeKey = computeOutcome(c as Parameters<typeof computeOutcome>[0]);
                const badge = OUTCOME_BADGE[outcomeKey];
                const isOpenEscalation = c.escalated && !c.resolved;
                return (
                  <s-table-row key={c.id}>
                    <s-table-cell>
                      <div style={isOpenEscalation ? { borderLeft: "3px solid var(--color-critical)", paddingLeft: "8px", background: "#fff5f5", borderRadius: "2px" } : {}}>
                        <Link
                          to={`/app/conversations/${c.id}`}
                        >
                          {c.customerId ? (
                            <span>Customer</span>
                          ) : (
                            <s-text tone="neutral">Anonymous</s-text>
                          )}
                        </Link>
                      </div>
                    </s-table-cell>
                    <s-table-cell>
                      {c.firstUserMessage ? (
                        <s-text tone="neutral">
                          <span style={{ fontSize: "13px" }}>
                            {c.firstUserMessage.length > 90
                              ? c.firstUserMessage.slice(0, 90) + "…"
                              : c.firstUserMessage}
                          </span>
                        </s-text>
                      ) : (
                        <s-text tone="neutral">—</s-text>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                        <s-badge tone={badge.tone}>{badge.label}</s-badge>
                        {c.channel === "whatsapp" && <s-badge tone="success">WhatsApp</s-badge>}
                      </div>
                    </s-table-cell>
                    <s-table-cell>
                      {c.orderRevenueCents ? (
                        <s-text><strong style={{ color: "var(--color-success)" }}>{fmtValue(c, currencyCode)}</strong></s-text>
                      ) : c.cartValue ? (
                        <s-text tone="neutral">{fmtValue(c, currencyCode)}</s-text>
                      ) : (
                        <s-text tone="neutral">—</s-text>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <s-text tone="neutral">{relativeTime(c.lastMessageAt)}</s-text>
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}

        {/* Pagination */}
        {total > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: "16px",
            }}
          >
            <span style={{ fontSize: "13px", color: "#888" }}>
              Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
            </span>
            <div style={{ display: "flex", gap: "8px" }}>
              {page > 0 && (
                <s-button
                  onClick={() => {
                    const n = new URLSearchParams(searchParams);
                    n.set("page", String(page - 1));
                    setSearchParams(n);
                  }}
                >
                  Previous
                </s-button>
              )}
              {page < totalPages - 1 && (
                <s-button
                  variant="primary"
                  onClick={() => {
                    const n = new URLSearchParams(searchParams);
                    n.set("page", String(page + 1));
                    setSearchParams(n);
                  }}
                >
                  Next
                </s-button>
              )}
            </div>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
