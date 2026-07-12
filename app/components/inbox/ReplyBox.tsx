import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { InboxActionResult } from "~/lib/inbox.server";

interface ReplyBoxProps {
  conversationId: string;
  channel?: string | null;
  quickReplies: string[];
}

export function ReplyBox({ conversationId, channel, quickReplies }: ReplyBoxProps) {
  const shopify = useAppBridge();
  const replyFetcher = useFetcher<InboxActionResult>();
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const prevState = useRef<typeof replyFetcher.state>("idle");

  const [replyMode, setReplyMode] = useState<"reply" | "note">("reply");
  const [replyText, setReplyText] = useState("");
  const [showMacros, setShowMacros] = useState(false);
  const [macroQuery, setMacroQuery] = useState("");

  const isSubmitting = replyFetcher.state === "submitting";
  const filteredMacros = quickReplies.filter((r) => r.toLowerCase().includes(macroQuery.toLowerCase()));

  // Clear textarea and reset mode only after a successful send — an error
  // leaves the draft in place so the merchant doesn't lose what they typed.
  useEffect(() => {
    if (prevState.current === "submitting" && replyFetcher.state === "idle") {
      const error = (replyFetcher.data as { error?: string } | undefined)?.error;
      if (!error) {
        if (replyRef.current) replyRef.current.value = "";
        setReplyText("");
        setReplyMode("reply");
      }
    }
    prevState.current = replyFetcher.state;
  }, [replyFetcher.state, replyFetcher.data]);

  useEffect(() => {
    const error = (replyFetcher.data as { error?: string } | undefined)?.error;
    if (replyFetcher.state === "idle" && error) {
      shopify.toast.show(error, { isError: true });
    }
  }, [replyFetcher.state, replyFetcher.data, shopify]);

  function submit() {
    if (!replyText.trim()) return;
    replyFetcher.submit(
      { intent: "reply", conversationId, isNote: replyMode === "note" ? "true" : "false", message: replyText },
      { method: "POST" },
    );
  }

  return (
    <div style={{ borderTop: "1px solid var(--color-border)", background: "var(--color-surface-default)" }}>
      {/* Mode tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--color-border)", padding: "4px 8px 0" }}>
        <s-button variant={replyMode === "reply" ? "primary" : "tertiary"} onClick={() => setReplyMode("reply")}>
          Reply
        </s-button>
        <s-button variant={replyMode === "note" ? "primary" : "tertiary"} onClick={() => setReplyMode("note")}>
          Note
        </s-button>
      </div>
      <div style={{ padding: "12px 16px" }}>
        <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
          <div style={{ flex: 1, position: "relative" }}>
            {showMacros && filteredMacros.length > 0 && (
              <div style={{ position: "absolute", bottom: "100%", left: 0, right: 0, zIndex: 20, background: "var(--color-surface-default)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", boxShadow: "0 4px 12px var(--color-shadow-popover)", maxHeight: 192, overflowY: "auto", marginBottom: 4 }}>
                {filteredMacros.slice(0, 6).map((r, i) => (
                  <div
                    key={i}
                    role="option"
                    aria-selected={false}
                    tabIndex={0}
                    onClick={() => { setReplyText(r); setShowMacros(false); }}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { setReplyText(r); setShowMacros(false); } }}
                    style={{ padding: "8px 12px", cursor: "pointer", fontSize: 13, borderBottom: i < filteredMacros.length - 1 ? "1px solid var(--color-border)" : "none" }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "var(--color-surface)"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = ""; }}
                  >
                    {r}
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={replyRef}
              value={replyText}
              placeholder={replyMode === "note" ? "Leave an internal note (customer won't see this)…" : "Reply as store… (type / for quick replies, ⌘↵ to send)"}
              rows={2}
              style={{
                width: "100%", padding: "8px 12px", borderRadius: "var(--radius-sm)",
                border: `1px solid ${replyMode === "note" ? "var(--color-warning-border)" : "var(--color-border)"}`,
                fontSize: "13px", resize: "none", fontFamily: "inherit",
                background: replyMode === "note" ? "var(--color-warning-surface)" : "var(--color-surface-default)",
                boxSizing: "border-box",
              }}
              onChange={(e) => {
                const val = e.target.value;
                setReplyText(val);
                if (val.startsWith("/")) {
                  setMacroQuery(val.slice(1));
                  setShowMacros(true);
                } else {
                  setShowMacros(false);
                }
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
                if (e.key === "Escape") setShowMacros(false);
                if (e.key === "Enter" && !e.shiftKey && !showMacros) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </div>
          {quickReplies.length > 0 && (
            <s-button
              variant="tertiary"
              accessibilityLabel="Quick replies"
              onClick={() => setShowMacros((v) => !v)}
            >
              /
            </s-button>
          )}
          <button
            type="button"
            disabled={isSubmitting}
            onClick={submit}
            style={{
              padding: "8px 16px",
              background: isSubmitting ? "var(--color-neutral)" : replyMode === "note" ? "var(--color-warning)" : "var(--color-selection)",
              color: "var(--color-text-inverse)", border: "none",
              borderRadius: "var(--radius-sm)",
              cursor: isSubmitting ? "wait" : "pointer",
              fontSize: "13px", fontWeight: 600, flexShrink: 0,
              transition: "background 0.1s ease",
            }}
          >
            {isSubmitting ? "Saving…" : replyMode === "note" ? "Save Note" : "Send"}
          </button>
        </div>
        <div style={{ fontSize: "12px", color: "var(--color-neutral-light)", marginTop: "4px" }}>
          {replyMode === "note" ? "Internal only — not sent to customer or AI" : channel === "whatsapp" ? "Sends via WhatsApp to customer" : "Stored in conversation — AI picks up on next reply"}
        </div>
      </div>
    </div>
  );
}
