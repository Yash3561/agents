import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { adminGraphql } from "../lib/mcp/admin.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const id = params.id;
  if (!id) {
    throw new Response("Not Found", { status: 404 });
  }

  const conversation = await db.conversation.findUnique({ where: { id } });

  if (!conversation || conversation.shopDomain !== session.shop) {
    throw new Response("Not Found", { status: 404 });
  }

  let currencyCode = "USD";
  try {
    const shopData = await adminGraphql<{ shop: { currencyCode: string } }>(
      session.shop,
      session.accessToken ?? "",
      `{ shop { currencyCode } }`,
    );
    currencyCode = shopData.shop?.currencyCode ?? "USD";
  } catch {
    // fall back to USD
  }

  return { conversation, currencyCode };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const id = params.id;
  if (!id) throw new Response("Not Found", { status: 404 });

  const conversation = await db.conversation.findUnique({ where: { id } });
  if (!conversation || conversation.shopDomain !== session.shop) {
    throw new Response("Not Found", { status: 404 });
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "resolve") {
    await db.conversation.update({
      where: { id },
      data: { resolved: true, resolvedAt: new Date(), escalated: false },
    });
  }

  return null;
}

interface ChatMessage {
  role: string;
  content: string;
  timestamp?: string;
}

const TOOL_LABELS: Record<string, string | null> = {
  search_catalog: "🔍 Searched product catalog",
  lookup_catalog: "🔍 Looked up product details",
  get_product: "🔍 Fetched product info",
  create_cart: "🛒 Created cart",
  update_cart: "🛒 Updated cart",
  get_cart: "🛒 Checked cart contents",
  get_checkout_url: "✓ Generated checkout link",
  offer_discount: "🏷 Offered discount code",
  search_policies_and_faqs: "📋 Checked store policies",
  get_order: "📦 Looked up order",
  get_customer_orders: "📦 Fetched order history",
  unified: null, // internal routing — skip
};

export default function ConversationDetail() {
  const { conversation, currencyCode } = useLoaderData<typeof loader>();

  function fmtMoney(dollars: number) {
    return new Intl.NumberFormat("en", { style: "currency", currency: currencyCode }).format(dollars);
  }

  const agentTraceArr = Array.isArray(conversation.agentTrace)
    ? (conversation.agentTrace as string[])
    : [];

  const msgs = Array.isArray(conversation.messages)
    ? (conversation.messages as unknown as ChatMessage[])
    : [];

  const storeHandle = conversation.shopDomain.replace(".myshopify.com", "");

  // Funnel steps
  const browsed = agentTraceArr.includes("search_catalog");
  const inCart = !!conversation.cartId;
  const purchased = !!conversation.orderId;

  const funnelSteps = [
    { label: "Started", done: true, detail: undefined as string | undefined },
    { label: "Browsed", done: browsed, detail: undefined as string | undefined },
    {
      label: "Cart Added",
      done: inCart,
      detail: conversation.cartValue ? fmtMoney(conversation.cartValue) : undefined,
    },
    {
      label: "Purchased",
      done: purchased,
      detail: conversation.orderRevenueCents
        ? fmtMoney(conversation.orderRevenueCents / 100)
        : undefined,
    },
  ];

  // AI actions — filter out internal routing and unmapped steps
  const aiActions = agentTraceArr
    .map((step) => {
      if (step in TOOL_LABELS) return TOOL_LABELS[step];
      return null;
    })
    .filter((a): a is string => a !== null);

  return (
    <s-page heading="Conversation">
      {/* Back link */}
      <div style={{ marginBottom: "16px" }}>
        <s-link href="/app/conversations">← Back to Conversations</s-link>
      </div>

      {/* Escalation banner */}
      {conversation.escalated && (
        <s-section>
          <div
            style={{
              background: "#fff5f5",
              border: "1px solid #fca5a5",
              borderRadius: "8px",
              padding: "16px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <s-badge tone="critical">Escalated</s-badge>
              <span style={{ fontSize: "14px", fontWeight: 600, color: "#dc2626" }}>
                This conversation was escalated to your support team
              </span>
            </div>
            {(conversation as { customerEmail?: string | null }).customerEmail && (
              <div style={{ fontSize: "14px" }}>
                <span style={{ color: "#666" }}>Customer email: </span>
                <a
                  href={`mailto:${(conversation as { customerEmail?: string | null }).customerEmail}`}
                  style={{ color: "#1a1a1a", fontWeight: 600 }}
                >
                  {(conversation as { customerEmail?: string | null }).customerEmail}
                </a>
              </div>
            )}
            {conversation.resolved ? (
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <s-badge tone="info">Resolved</s-badge>
                {(conversation as { resolvedAt?: Date | string | null }).resolvedAt && (
                  <span style={{ fontSize: "13px", color: "#555" }}>
                    Resolved at{" "}
                    {new Date(
                      (conversation as { resolvedAt?: Date | string | null }).resolvedAt as string | Date,
                    ).toLocaleString()}
                  </span>
                )}
              </div>
            ) : (
              <Form method="post">
                <input type="hidden" name="intent" value="resolve" />
                <s-button type="submit" tone="neutral">
                  Mark as Resolved
                </s-button>
              </Form>
            )}
          </div>
        </s-section>
      )}

      {/* Topic / reason for contact */}
      {conversation.firstUserMessage && (
        <s-section heading="Reason for contact">
          <s-text tone="neutral">
            <span style={{ fontSize: "14px", fontStyle: "italic" }}>
              &quot;{conversation.firstUserMessage}&quot;
            </span>
          </s-text>
        </s-section>
      )}

      {/* Journey funnel */}
      <s-section heading="Journey">
        <div style={{ display: "flex", alignItems: "center", gap: "0", padding: "12px 0" }}>
          {funnelSteps.map((step, i) => (
            <div
              key={step.label}
              style={{
                display: "flex",
                alignItems: "center",
                flex: i < funnelSteps.length - 1 ? 1 : "none",
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  minWidth: "80px",
                }}
              >
                <div
                  style={{
                    width: "32px",
                    height: "32px",
                    borderRadius: "50%",
                    background: step.done ? "#008060" : "#e0e0e0",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: step.done ? "#fff" : "#999",
                    fontSize: "16px",
                    fontWeight: 700,
                  }}
                >
                  {step.done ? "✓" : "○"}
                </div>
                <div
                  style={{
                    fontSize: "12px",
                    fontWeight: 600,
                    marginTop: "4px",
                    color: step.done ? "#008060" : "#999",
                  }}
                >
                  {step.label}
                </div>
                {step.detail && (
                  <div style={{ fontSize: "11px", color: "#15803d", fontWeight: 500 }}>
                    {step.detail}
                  </div>
                )}
              </div>
              {i < funnelSteps.length - 1 && (
                <div
                  style={{
                    flex: 1,
                    height: "2px",
                    background: step.done ? "#008060" : "#e0e0e0",
                    margin: "0 4px",
                    marginBottom: "20px",
                  }}
                />
              )}
            </div>
          ))}
        </div>
      </s-section>

      {/* Details */}
      <s-section heading="Details">
        <s-stack direction="block" gap="base">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "120px 1fr",
              gap: "8px 16px",
              fontSize: "14px",
            }}
          >
            <span style={{ color: "#666" }}>Customer</span>
            <span>
              {conversation.customerId ? (
                <a
                  href={`https://admin.shopify.com/store/${storeHandle}/customers/${conversation.customerId.replace("gid://shopify/Customer/", "")}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "#1a1a1a" }}
                >
                  View in Shopify
                </a>
              ) : (
                "Anonymous"
              )}
            </span>
            <span style={{ color: "#666" }}>Started</span>
            <span>{new Date(conversation.startedAt).toLocaleString()}</span>
            <span style={{ color: "#666" }}>Last active</span>
            <span>{new Date(conversation.lastMessageAt).toLocaleString()}</span>
            {conversation.discountCode && (
              <>
                <span style={{ color: "#666" }}>Discount used</span>
                <span style={{ fontWeight: 600 }}>{conversation.discountCode}</span>
              </>
            )}
            {conversation.orderId && (
              <>
                <span style={{ color: "#666" }}>Order</span>
                <span>
                  <a
                    href={`https://admin.shopify.com/store/${storeHandle}/orders/${conversation.orderId}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "#1a1a1a" }}
                  >
                    {conversation.orderId}
                  </a>
                </span>
              </>
            )}
            {conversation.escalated && (
              <>
                <span style={{ color: "#666" }}>Status</span>
                <span>
                  <s-badge tone="critical">Escalated</s-badge>
                </span>
              </>
            )}
          </div>
        </s-stack>
      </s-section>

      {/* AI Actions */}
      <s-section heading="AI Actions">
        {aiActions.length === 0 ? (
          <s-text tone="neutral">No tool actions recorded.</s-text>
        ) : (
          <s-stack direction="block" gap="base">
            {aiActions.map((action, i) => (
              <div
                key={i}
                style={{ fontSize: "13px", padding: "4px 0", borderBottom: "1px solid #f5f5f5" }}
              >
                {action}
              </div>
            ))}
          </s-stack>
        )}
      </s-section>

      {/* Transcript */}
      <s-section heading="Transcript">
        {msgs.length === 0 ? (
          <p>No messages recorded.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {msgs.map((msg, i) => {
              const isUser = msg.role === "user";
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: isUser ? "flex-end" : "flex-start",
                  }}
                >
                  {!isUser && (
                    <span
                      style={{
                        fontSize: "11px",
                        color: "#555",
                        marginBottom: "2px",
                        marginLeft: "4px",
                      }}
                    >
                      NeonPing
                    </span>
                  )}
                  <div
                    style={{
                      textAlign: isUser ? "right" : "left",
                      background: isUser ? "#f0f0f0" : "#e8f4fd",
                      padding: "8px",
                      margin: "4px",
                      borderRadius: "8px",
                      maxWidth: "70%",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {msg.content}
                  </div>
                  {msg.timestamp && (
                    <div
                      style={{
                        fontSize: "10px",
                        color: "#aaa",
                        marginTop: "3px",
                        textAlign: isUser ? "right" : "left",
                      }}
                    >
                      {new Date(msg.timestamp).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
