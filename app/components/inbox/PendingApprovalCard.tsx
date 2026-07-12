import { useState } from "react";
import { useFetcher } from "react-router";
import type { InboxActionResult } from "~/lib/inbox.server";
import type { ChatMessage } from "~/lib/inbox-shared";

interface PendingApprovalCardProps {
  conversationId: string;
  message: ChatMessage;
}

/**
 * A high-stakes AI-drafted reply (discount/refund/order change) awaiting merchant
 * approval — see Merchant.requireApprovalForOffers. Approve sends the exact (or
 * edited) text via the same handleInboxAction WhatsApp send path the "reply"
 * intent uses. Reject discards the draft without sending anything.
 */
export function PendingApprovalCard({ conversationId, message }: PendingApprovalCardProps) {
  const fetcher = useFetcher<InboxActionResult>();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(message.content);
  const isBusy = fetcher.state !== "idle";
  const error = (fetcher.data as { error?: string } | undefined)?.error;

  function approve() {
    fetcher.submit(
      { intent: "approve-draft", conversationId, messageTimestamp: String(message.timestamp ?? ""), message: text },
      { method: "POST" },
    );
  }
  function reject() {
    fetcher.submit(
      { intent: "reject-draft", conversationId, messageTimestamp: String(message.timestamp ?? "") },
      { method: "POST" },
    );
  }

  return (
    <div style={{ margin: "4px 0", padding: "10px 12px", background: "var(--color-warning-surface)", border: "1px solid var(--color-warning-border)", borderRadius: "var(--radius-base)" }}>
      <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-text)", marginBottom: "6px" }}>
        Awaiting your approval — discount, refund, or order change
      </div>
      {editing ? (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          style={{ width: "100%", boxSizing: "border-box", padding: "8px", fontSize: "13px", fontFamily: "inherit", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)" }}
        />
      ) : (
        <div style={{ fontSize: "13px", whiteSpace: "pre-wrap", wordBreak: "break-word", marginBottom: "8px" }}>{text}</div>
      )}
      <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
        <s-button variant="primary" disabled={isBusy || !text.trim()} onClick={approve}>
          {editing ? "Send edited" : "Approve & send"}
        </s-button>
        {!editing && (
          <s-button variant="tertiary" disabled={isBusy} onClick={() => setEditing(true)}>Edit</s-button>
        )}
        <s-button variant="tertiary" tone="critical" disabled={isBusy} onClick={reject}>Reject</s-button>
      </div>
      {error && (
        <div style={{ marginTop: "6px", fontSize: "12px", color: "var(--color-critical)" }}>{error}</div>
      )}
    </div>
  );
}
