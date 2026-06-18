import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useState } from "react";

const PAGE_SIZE = 50;

const DATE_RANGE_OPTIONS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "all";
  const days = url.searchParams.get("days") ?? "all";
  const page = Math.max(0, Number(url.searchParams.get("page") || "0"));

  const statusFilter =
    status === "escalated"
      ? { escalated: true }
      : status === "discount"
      ? { discountCode: { not: null } }
      : {};

  const dateFilter =
    days !== "all"
      ? {
          startedAt: {
            gte: new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000),
          },
        }
      : {};

  const where = { shopDomain: shop, ...statusFilter, ...dateFilter };

  const [conversations, total] = await Promise.all([
    prisma.conversation.findMany({
      where,
      orderBy: { lastMessageAt: "desc" },
      take: PAGE_SIZE,
      skip: page * PAGE_SIZE,
    }),
    prisma.conversation.count({ where }),
  ]);

  return { conversations, total, page, status, days };
};

const FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "escalated", label: "Escalated" },
  { value: "discount", label: "Has discount" },
] as const;

export default function Conversations() {
  const { conversations, total, page, status, days } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const filtered = search.trim()
    ? conversations.filter((c) =>
        c.sessionId.toLowerCase().includes(search.toLowerCase())
      )
    : conversations;

  return (
    <s-page heading="Conversations">
      {/* Date range filter */}
      <s-section>
        <s-stack direction="inline" gap="base">
          {DATE_RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.set("days", opt.value);
                next.set("page", "0");
                setSearchParams(next);
              }}
              style={{
                padding: "5px 14px",
                borderRadius: "6px",
                border: "1px solid #d1d1d1",
                background: days === opt.value ? "#1a1a1a" : "transparent",
                color: days === opt.value ? "#fff" : "#1a1a1a",
                cursor: "pointer",
                fontWeight: days === opt.value ? 600 : 400,
                fontSize: "13px",
              }}
            >
              {opt.label}
            </button>
          ))}
        </s-stack>
      </s-section>

      {/* Filter tabs */}
      <s-section>
        <s-stack direction="inline" gap="base">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.set("status", opt.value);
                next.set("page", "0");
                setSearchParams(next);
              }}
              style={{
                padding: "6px 16px",
                borderRadius: "6px",
                border: "1px solid #1a1a1a",
                background: status === opt.value ? "#1a1a1a" : "transparent",
                color: status === opt.value ? "#fff" : "#1a1a1a",
                cursor: "pointer",
                fontWeight: status === opt.value ? 600 : 400,
                fontSize: "14px",
              }}
            >
              {opt.label}
            </button>
          ))}
        </s-stack>
      </s-section>

      {/* Search */}
      <s-section>
        <s-text-field
          label="Search by session ID"
          value={search}
          onInput={(e: Event) => {
            const target = e.target as HTMLInputElement;
            setSearch(target.value);
          }}
          placeholder="Type a session ID..."
        />
      </s-section>

      {/* Table */}
      <s-section>
        {filtered.length === 0 ? (
          <s-paragraph>No conversations found.</s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Started</s-table-header>
              <s-table-header>Session ID</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Messages</s-table-header>
              <s-table-header>Revenue</s-table-header>
              <s-table-header>Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {filtered.map((c) => (
                <s-table-row key={c.id}>
                  <s-table-cell>
                    <Link
                      to={`/app/conversations/${c.id}`}
                      style={{ color: "#1a1a1a", textDecoration: "none", fontWeight: 500 }}
                    >
                      {new Date(c.startedAt).toLocaleString()}
                    </Link>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text tone="neutral">
                      {c.sessionId.slice(0, 12)}…
                    </s-text>
                  </s-table-cell>
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

        {/* Pagination */}
        {total > 0 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "16px" }}>
            <span style={{ fontSize: "13px", color: "#888" }}>
              Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
            </span>
            <div style={{ display: "flex", gap: "8px" }}>
              {page > 0 && (
                <button
                  onClick={() => {
                    const n = new URLSearchParams(searchParams);
                    n.set("page", String(page - 1));
                    setSearchParams(n);
                  }}
                  style={{ padding: "5px 14px", border: "1px solid #d1d1d1", borderRadius: "6px", background: "#fff", cursor: "pointer", fontSize: "13px" }}
                >
                  Previous
                </button>
              )}
              {page < totalPages - 1 && (
                <button
                  onClick={() => {
                    const n = new URLSearchParams(searchParams);
                    n.set("page", String(page + 1));
                    setSearchParams(n);
                  }}
                  style={{ padding: "5px 14px", border: "1px solid #d1d1d1", borderRadius: "6px", background: "#1a1a1a", color: "#fff", cursor: "pointer", fontSize: "13px" }}
                >
                  Next
                </button>
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
