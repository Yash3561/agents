import { useFetcher } from "react-router";
import { JourneyFunnel } from "~/components/JourneyFunnel";
import { EmptyState } from "./EmptyState";
import { TOOL_LABELS, formatPhone } from "~/lib/inbox-shared";
import type { InboxLoaderData } from "~/lib/inbox.server";

// The list-row select shape, not the full loader "selected" row — both the
// virtualized-list-derived value and the loader's findFirst fallback (a
// superset of these fields) are structurally assignable to this narrower type.
type ConvItem = InboxLoaderData["conversations"][number];

interface CustomerSidebarProps {
  selected: ConvItem | null;
  storeHandle: string;
  currencyCode: string;
  dimmed?: boolean;
}

export function CustomerSidebar({ selected, storeHandle, currencyCode, dimmed }: CustomerSidebarProps) {
  const escalateFetcher = useFetcher();
  const trainFetcher = useFetcher();

  const fmtMoney = (dollars: number) =>
    new Intl.NumberFormat("en", { style: "currency", currency: currencyCode }).format(dollars);

  if (!selected) {
    return (
      <div style={{ width: 280, flexShrink: 0, overflowY: "auto", padding: "var(--spacing-md)", borderLeft: "1px solid var(--color-border)" }}>
        <div style={{ minHeight: 240, display: "flex", alignItems: "center", justifyContent: "center", padding: "var(--spacing-lg) var(--spacing-md-sm)" }}>
          <EmptyState heading="No conversation selected" subtext="Customer details appear here after you select a conversation." />
        </div>
      </div>
    );
  }

  const agentTraceArr = Array.isArray(selected.agentTrace) ? (selected.agentTrace as string[]) : [];
  const aiActions = agentTraceArr
    .map((step) => (step in TOOL_LABELS ? TOOL_LABELS[step] : null))
    .filter((a): a is string => a !== null);
  const journeyBrowsed = agentTraceArr.includes("search_catalog");
  const isSelectedFlagged = Boolean((selected.qaMeta as { flagged?: boolean } | null)?.flagged);

  return (
    <div style={{ width: 280, flexShrink: 0, overflowY: "auto", padding: "var(--spacing-md)", borderLeft: "1px solid var(--color-border)", opacity: dimmed ? 0.5 : 1, transition: "opacity 120ms ease", pointerEvents: dimmed ? "none" : undefined }}>
      <s-stack direction="block" gap="base">
        <div>
          <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>Customer</div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <s-avatar
              initials={(selected.customerName ?? "V").split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase()}
              size="base"
            ></s-avatar>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text)" }}>
              {selected.customerName ?? (selected.channel === "whatsapp" ? formatPhone(selected.sessionId) : "Visitor")}
            </div>
          </div>
          {selected.customerId && (
            <div style={{ marginTop: 4 }}>
              <s-link
                href={`https://admin.shopify.com/store/${storeHandle}/customers/${selected.customerId.replace("gid://shopify/Customer/", "")}`}
                target="_blank"
              >
                View in Shopify →
              </s-link>
            </div>
          )}
        </div>

        <div>
          <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>Channel</div>
          <span style={{ fontSize: "13px", color: "var(--color-text)" }}>
            {selected.channel === "whatsapp" ? "WhatsApp" : "Web Widget"}
          </span>
        </div>

        {selected.channel === "whatsapp" && (
          <div>
            <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>Phone</div>
            <span style={{ fontSize: "13px", color: "var(--color-text)" }}>
              {formatPhone(selected.sessionId)}
            </span>
          </div>
        )}

        <div>
          <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>Commerce</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ overflowX: "auto", paddingBottom: "4px" }}>
              <JourneyFunnel
                browsed={journeyBrowsed}
                inCart={!!selected.cartId}
                purchased={!!selected.orderId}
                cartValue={selected.cartValue}
                orderRevenue={selected.orderRevenueCents}
                currency={currencyCode}
                compact
              />
            </div>

            {selected.cartValue != null && (
              <div>
                <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>Cart Value</div>
                <span style={{ fontSize: "16px", fontWeight: 600, color: "var(--color-cart)" }}>
                  {fmtMoney(selected.cartValue)}
                </span>
              </div>
            )}

            {selected.orderId && (
              <s-box padding="base" background="subdued" border="base" borderRadius="base">
                <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Order</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "var(--color-text)" }}>
                      {selected.orderRevenueCents != null ? fmtMoney(selected.orderRevenueCents / 100) : "Order placed"}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--color-success)", marginTop: 4 }}>Revenue attributed ✓</div>
                  </div>
                  <a
                    href={`https://${storeHandle}.myshopify.com/admin/orders/${selected.orderId.replace("gid://shopify/Order/", "")}`}
                    target="_top"
                    style={{ fontSize: "var(--type-metadata)", color: "var(--color-text)", textDecoration: "none", fontWeight: 500 }}
                  >
                    View →
                  </a>
                </div>
              </s-box>
            )}

            {selected.discountCode && (
              <div>
                <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>Discount Used</div>
                <s-badge>{selected.discountCode}</s-badge>
              </div>
            )}
          </div>
        </div>

        {!selected.escalated && !selected.resolved && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid var(--color-border)", paddingTop: "16px" }}>
            <escalateFetcher.Form method="POST">
              <input type="hidden" name="intent" value="escalate" />
              <input type="hidden" name="conversationId" value={selected.id} />
              <div style={{ width: "100%" }}><s-button type="submit" variant="secondary">Escalate — Enable Reply</s-button></div>
            </escalateFetcher.Form>
          </div>
        )}

        <details style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)" }}>
          <summary style={{ padding: "8px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600, color: "var(--color-neutral)", listStyle: "none", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span>AI details</span>
          </summary>
          <div style={{ padding: "4px 12px 12px", display: "flex", flexDirection: "column", gap: "12px" }}>
            <div>
              <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>Details</div>
              <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: "12px" }}>
                <span style={{ color: "var(--color-neutral)" }}>Started</span>
                <span>{new Date(selected.startedAt as unknown as string).toLocaleDateString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                <span style={{ color: "var(--color-neutral)" }}>Messages</span>
                <span>{selected.messageCount}</span>
                {selected.qualityScore != null && (
                  <>
                    <span style={{ color: "var(--color-neutral)" }}>AI Quality</span>
                    <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                      <span style={{
                        fontWeight: 600, fontSize: "13px",
                        color: selected.qualityScore >= 4 ? "var(--color-success)" : selected.qualityScore >= 3 ? "var(--color-warning)" : "var(--color-critical)",
                      }}>
                        {selected.qualityScore.toFixed(1)}/5
                      </span>
                      {(selected.qaMeta as { flagged?: boolean } | null)?.flagged && (
                        <span style={{ fontSize: "12px", color: "var(--color-critical)" }}>● Needs review</span>
                      )}
                    </span>
                  </>
                )}
              </div>
            </div>

            {aiActions.length > 0 && (
              <div>
                <div style={{ fontSize: "12px", color: "var(--color-neutral)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "8px" }}>Tool calls</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {aiActions.map((a, i) => (
                    <div key={i} style={{ fontSize: 12, color: "var(--color-neutral)" }}>{a}</div>
                  ))}
                </div>
              </div>
            )}

            {isSelectedFlagged && (
              <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: "12px" }}>
                <s-banner tone="warning">
                  <s-text><strong>AI flagged this conversation</strong></s-text>
                  <s-text tone="neutral">{(selected.qaMeta as { reason?: string } | null)?.reason ?? "Low quality response detected."}</s-text>
                </s-banner>
                <div style={{ marginTop: "12px" }}>
                  <trainFetcher.Form method="POST">
                    <input type="hidden" name="intent" value="train" />
                    <input type="hidden" name="conversationId" value={selected.id} />
                    <s-stack direction="block">
                      <s-text-field
                        label="Customer question"
                        name="question"
                        value={selected.firstUserMessage ?? ""}
                      ></s-text-field>
                      <s-text-field
                        label="Correct answer"
                        name="answer"
                        placeholder="Correct answer to add to FAQ…"
                      ></s-text-field>
                      <div>
                        <s-button type="submit" variant="primary">Add to Knowledge Base</s-button>
                      </div>
                    </s-stack>
                  </trainFetcher.Form>
                </div>
              </div>
            )}
          </div>
        </details>
      </s-stack>
    </div>
  );
}
