import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useState } from "react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "all";

  const statusFilter =
    status === "escalated"
      ? { escalated: true }
      : status === "discount"
      ? { discountCode: { not: null } }
      : {};

  const conversations = await prisma.conversation.findMany({
    where: { shopDomain: shop, ...statusFilter },
    orderBy: { lastMessageAt: "desc" },
    take: 50,
  });

  return { conversations, status };
};

const FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "escalated", label: "Escalated" },
  { value: "discount", label: "Has discount" },
] as const;

export default function Conversations() {
  const { conversations, status } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");

  const filtered = conversations.filter(
    (c) =>
      search.trim() === "" ||
      c.sessionId.toLowerCase().startsWith(search.toLowerCase()) ||
      c.sessionId.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <s-page heading="Conversations">
      {/* Filter tabs */}
      <s-section>
        <s-stack direction="inline" gap="base">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.set("status", opt.value);
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
          placeholder="Type a session ID prefix..."
          clearButton
          onClearButtonClick={() => setSearch("")}
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
                  <s-table-cell>{new Date(c.startedAt).toLocaleString()}</s-table-cell>
                  <s-table-cell>
                    <s-text tone="neutral" variant="body-sm">
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
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
