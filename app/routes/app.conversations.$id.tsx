import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

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

  return { conversation };
}

interface ChatMessage {
  role: string;
  content: string;
}

export default function ConversationDetail() {
  const { conversation } = useLoaderData<typeof loader>();

  const trace = Array.isArray(conversation.agentTrace)
    ? (conversation.agentTrace as string[])
    : [];

  const msgs = Array.isArray(conversation.messages)
    ? (conversation.messages as unknown as ChatMessage[])
    : [];

  return (
    <s-page heading="Conversation">
      <div style={{ marginBottom: "16px" }}>
        <s-link href="/app/conversations">← Back to Conversations</s-link>
      </div>

      {/* Details */}
      <s-section heading="Details">
        <s-stack direction="block" gap="base">
          <div>
            <strong>Session ID:</strong>{" "}
            <span style={{ fontFamily: "monospace" }}>
              {conversation.sessionId.slice(0, 8)}
            </span>
          </div>
          <div>
            <strong>Customer:</strong>{" "}
            {conversation.customerId ?? "Anonymous"}
          </div>
          <div>
            <strong>Cart value:</strong>{" "}
            {conversation.cartValue != null
              ? `$${conversation.cartValue.toFixed(2)}`
              : "—"}
          </div>
          <div>
            <strong>Revenue:</strong>{" "}
            {conversation.orderRevenueCents != null
              ? `$${(conversation.orderRevenueCents / 100).toFixed(2)}`
              : "—"}
          </div>
          <div>
            <strong>Discount code:</strong>{" "}
            {conversation.discountCode ?? "—"}
          </div>
          <div>
            <strong>Started:</strong>{" "}
            {new Date(conversation.startedAt).toLocaleDateString()}
          </div>
          {conversation.escalated ? (
            <div>
              <s-badge tone="critical">Escalated</s-badge>
            </div>
          ) : null}
        </s-stack>
      </s-section>

      {/* AI Routing */}
      <s-section heading="AI Routing">
        {trace.length === 0 ? (
          <p>No routing data.</p>
        ) : (
          <s-stack direction="inline" gap="base">
            {trace.map((step, i) => (
              <s-badge key={i} tone="info">
                {String(step)}
              </s-badge>
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
                </div>
              );
            })}
          </div>
        )}
      </s-section>
    </s-page>
  );
}
