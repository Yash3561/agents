import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useRouteError } from "react-router";
import { JourneyFunnel } from "~/components/JourneyFunnel";
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

  const agentTraceArr = Array.isArray(conversation.agentTrace)
    ? (conversation.agentTrace as string[])
    : [];

  const msgs = Array.isArray(conversation.messages)
    ? (conversation.messages as unknown as ChatMessage[])
    : [];

  const storeHandle = conversation.shopDomain.replace(".myshopify.com", "");

  const browsed = agentTraceArr.includes("search_catalog");
  const inCart = !!conversation.cartId;
  const purchased = !!conversation.orderId;

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
          <s-banner tone="critical">
            <s-stack direction="block" gap="base">
              <s-text>This conversation was escalated to your support team.</s-text>
              {(conversation as { customerEmail?: string | null }).customerEmail && (
                <s-text>
                  Customer email:{" "}
                  <s-link href={`mailto:${(conversation as { customerEmail?: string | null }).customerEmail}`}>
                    {(conversation as { customerEmail?: string | null }).customerEmail}
                  </s-link>
                </s-text>
              )}
              {conversation.resolved ? (
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <s-badge tone="info">Resolved</s-badge>
                  {(conversation as { resolvedAt?: Date | string | null }).resolvedAt && (
                    <s-text tone="neutral">
                      Resolved at {new Date((conversation as { resolvedAt?: Date | string | null }).resolvedAt as string | Date).toLocaleString()}
                    </s-text>
                  )}
                </div>
              ) : (
                <Form method="post">
                  <input type="hidden" name="intent" value="resolve" />
                  <s-button type="submit" tone="neutral">Mark as Resolved</s-button>
                </Form>
              )}
            </s-stack>
          </s-banner>
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
        <JourneyFunnel
          browsed={browsed}
          inCart={inCart}
          purchased={purchased}
          cartValue={conversation.cartValue}
          orderRevenue={conversation.orderRevenueCents}
          currency={currencyCode}
        />
      </s-section>

      {/* Details */}
      <s-section heading="Details">
        <s-stack direction="block" gap="base">
          <div style={{ display: "flex", gap: "16px" }}>
            <span style={{ minWidth: "120px", color: "var(--color-neutral)" }}><s-text tone="neutral">Customer</s-text></span>
            <s-text>
              {conversation.customerId ? (
                <s-link
                  href={`https://admin.shopify.com/store/${storeHandle}/customers/${conversation.customerId.replace("gid://shopify/Customer/", "")}`}
                  target="_blank"
                >
                  View in Shopify
                </s-link>
              ) : "Anonymous"}
            </s-text>
          </div>
          <div style={{ display: "flex", gap: "16px" }}>
            <span style={{ minWidth: "120px" }}><s-text tone="neutral">Started</s-text></span>
            <s-text>{new Date(conversation.startedAt).toLocaleString()}</s-text>
          </div>
          <div style={{ display: "flex", gap: "16px" }}>
            <span style={{ minWidth: "120px" }}><s-text tone="neutral">Last active</s-text></span>
            <s-text>{new Date(conversation.lastMessageAt).toLocaleString()}</s-text>
          </div>
          {conversation.discountCode && (
            <div style={{ display: "flex", gap: "16px" }}>
              <span style={{ minWidth: "120px" }}><s-text tone="neutral">Discount used</s-text></span>
              <s-text><strong>{conversation.discountCode}</strong></s-text>
            </div>
          )}
          {conversation.orderId && (
            <div style={{ display: "flex", gap: "16px" }}>
              <span style={{ minWidth: "120px" }}><s-text tone="neutral">Order</s-text></span>
              <s-text>
                <s-link href={`https://admin.shopify.com/store/${storeHandle}/orders/${conversation.orderId}`} target="_blank">
                  {conversation.orderId}
                </s-link>
              </s-text>
            </div>
          )}
          {conversation.escalated && (
            <div style={{ display: "flex", gap: "16px" }}>
              <span style={{ minWidth: "120px" }}><s-text tone="neutral">Status</s-text></span>
              <s-badge tone="critical">Escalated</s-badge>
            </div>
          )}
        </s-stack>
      </s-section>

      {/* AI Actions */}
      <s-section heading="AI Actions">
        {aiActions.length === 0 ? (
          <s-text tone="neutral">No tool actions recorded.</s-text>
        ) : (
          <s-stack direction="block" gap="base">
            {aiActions.map((action, i) => (
              <div key={i} style={{ padding: "4px 0", borderBottom: "1px solid var(--color-border)" }}>
                <s-text>{action}</s-text>
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
