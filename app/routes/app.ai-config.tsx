import { useState, useEffect, useRef } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Prisma } from "@prisma/client";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { sendTestMessage } from "../lib/test-chat";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Faq {
  question: string;
  answer: string;
}

interface ChatMessage {
  role: "user" | "ai";
  text: string;
}

const MAX_FAQS = 20;
const MAX_FAQ_QUESTION_LENGTH = 300;
const MAX_FAQ_ANSWER_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const merchant = await prisma.merchant.upsert({
    where: { shopDomain: session.shop },
    update: {},
    create: { shopDomain: session.shop },
  });
  const customFaqs = Array.isArray(merchant.customFaqs)
    ? (merchant.customFaqs as unknown as Faq[])
    : [];
  const quickReplies: string[] = merchant.quickReplies ?? [];
  return { merchant: { ...merchant, customFaqs, quickReplies }, shop: session.shop };
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  if (intent === "save-faqs") {
    const raw = String(formData.get("customFaqs") || "[]");
    let faqs: Faq[] = [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return { error: "Invalid FAQ data" };
      }
      faqs = parsed
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const record = entry as Record<string, unknown>;
          const question = String(record.question ?? "").trim().slice(0, MAX_FAQ_QUESTION_LENGTH);
          const answer = String(record.answer ?? "").trim().slice(0, MAX_FAQ_ANSWER_LENGTH);
          return question && answer ? { question, answer } : null;
        })
        .filter((entry): entry is Faq => entry !== null)
        .slice(0, MAX_FAQS);
    } catch {
      return { error: "Invalid FAQ data" };
    }
    await prisma.merchant.update({
      where: { shopDomain: session.shop },
      data: { customFaqs: faqs as unknown as Prisma.InputJsonValue },
    });
    return { saved: "faqs" };
  }

  if (intent === "save-quick-replies") {
    const replies = [0, 1, 2, 3, 4]
      .map((i) => String(formData.get(`quickReply${i}`) ?? "").trim())
      .filter(Boolean);
    await prisma.merchant.update({
      where: { shopDomain: session.shop },
      data: { quickReplies: replies },
    });
    return { saved: "quick_replies" };
  }

  if (intent === "test-chat") {
    const apiBase = process.env.SHOPIFY_APP_URL ?? "";
    if (!apiBase) {
      return { error: "Test chat is unavailable: SHOPIFY_APP_URL is not configured. Contact support." };
    }
    const message = String(formData.get("testMessage") || "Hello");
    const result = await sendTestMessage(session.shop, message, apiBase);
    return { testResponse: result.text };
  }

  return { error: "Unknown intent" };
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const QUICK_REPLY_PLACEHOLDERS = [
  "Find products",
  "Track my order",
  "Return policy",
  "Size guide",
  "Contact us",
];

export default function AiConfig() {
  const { merchant } = useLoaderData<typeof loader>();
  const faqFetcher = useFetcher<typeof action>();
  const testFetcher = useFetcher<typeof action>();
  const quickFetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const playgroundRef = useRef<HTMLDivElement>(null);

  // --- FAQ state ---
  const [faqs, setFaqs] = useState<Faq[]>(merchant.customFaqs);

  useEffect(() => {
    if (faqFetcher.state === "idle" && (faqFetcher.data as { saved?: string } | undefined)?.saved === "faqs") {
      shopify.toast.show("FAQ knowledge base saved");
    }
  }, [faqFetcher.state, faqFetcher.data, shopify]);

  useEffect(() => {
    if (quickFetcher.state === "idle" && (quickFetcher.data as { saved?: string } | undefined)?.saved === "quick_replies") {
      shopify.toast.show("Conversation starters saved");
    }
  }, [quickFetcher.state, quickFetcher.data, shopify]);

  const addFaq = () => {
    if (faqs.length >= 20) return;
    setFaqs([...faqs, { question: "", answer: "" }]);
  };

  const updateFaq = (idx: number, field: keyof Faq, value: string) => {
    setFaqs(faqs.map((f, i) => (i === idx ? { ...f, [field]: value } : f)));
  };

  const deleteFaq = (idx: number) => {
    setFaqs(faqs.filter((_, i) => i !== idx));
  };

  const submitFaqs = () => {
    const hasEmpty = faqs.some((f) => !f.question.trim() || !f.answer.trim());
    if (hasEmpty) {
      shopify.toast.show("Please fill in all FAQ questions and answers", { isError: true });
      return;
    }
    const fd = new FormData();
    fd.set("intent", "save-faqs");
    fd.set("customFaqs", JSON.stringify(faqs));
    faqFetcher.submit(fd, { method: "POST" });
  };

  // --- Test chat state ---
  const [testMessage, setTestMessage] = useState("");
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const prevTestStateRef = useRef(testFetcher.state);

  // Append AI response when fetcher transitions from loading → idle
  useEffect(() => {
    if (prevTestStateRef.current !== "idle" && testFetcher.state === "idle") {
      const data = testFetcher.data as { testResponse?: string; error?: string } | undefined;
      if (data?.testResponse) {
        setChatHistory((prev) => [...prev, { role: "ai", text: data.testResponse! }]);
      } else if (data?.error) {
        setChatHistory((prev) => [...prev, { role: "ai", text: `Error: ${data.error}` }]);
      }
    }
    prevTestStateRef.current = testFetcher.state;
  }, [testFetcher.state, testFetcher.data]);

  const isTestLoading = testFetcher.state !== "idle";

  const runTest = () => {
    if (!testMessage.trim()) return;
    const fd = new FormData();
    fd.set("intent", "test-chat");
    fd.set("testMessage", testMessage);
    setChatHistory((prev) => [...prev, { role: "user", text: testMessage }]);
    setTestMessage("");
    testFetcher.submit(fd, { method: "POST" });
  };

  // --- Conversation starters state ---
  const [quickReplies, setQuickReplies] = useState<string[]>(
    Array.from({ length: 5 }, (_, i) => merchant.quickReplies[i] ?? ""),
  );

  const submitQuickReplies = () => {
    const fd = new FormData();
    fd.set("intent", "save-quick-replies");
    quickReplies.forEach((r, i) => fd.set(`quickReply${i}`, r));
    quickFetcher.submit(fd, { method: "POST" });
  };

  return (
    <s-page heading="Knowledge Base">
      {/* ------------------------------------------------------------------ */}
      {/* Section 1 — Conversation starters (customers see these first)       */}
      {/* ------------------------------------------------------------------ */}
      <s-section heading="Conversation starters">
        <s-banner tone="info">Up to 5 conversation starter buttons shown to customers at the start of a conversation. Leave blank to skip a slot.</s-banner>
        {quickReplies.map((reply, i) => (
          <s-text-field
            key={i}
            label={`Starter ${i + 1}`}
            name={`quickReply${i}`}
            value={reply}
            placeholder={QUICK_REPLY_PLACEHOLDERS[i]}
            onInput={(e: Event) => {
              const next = [...quickReplies];
              next[i] = (e.target as HTMLInputElement).value;
              setQuickReplies(next);
            }}
          ></s-text-field>
        ))}
        {quickReplies.some((r) => r.trim()) && (
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="base">
              <s-text tone="neutral">Preview — how customers will see these:</s-text>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {quickReplies.filter((r) => r.trim()).map((r, i) => (
                  <s-badge key={i} tone="success">{r}</s-badge>
                ))}
              </div>
            </s-stack>
          </s-box>
        )}
        <s-button variant="primary" onClick={submitQuickReplies}>
          Save conversation starters
        </s-button>
      </s-section>

      {/* ------------------------------------------------------------------ */}
      {/* Section 2 — Custom Knowledge Base (FAQs)                            */}
      {/* ------------------------------------------------------------------ */}
      <s-section heading="Custom knowledge base">
        <s-banner tone="info">Add up to 20 Q&amp;A pairs. The support agent will answer these questions exactly as written.</s-banner>

        {faqs.length === 0 ? (
          <div style={{ padding: "24px 0", textAlign: "center" }}>
            <s-text tone="neutral">
              FAQs let you teach your bot to answer common questions exactly the way you want — returns, shipping, sizing, and anything else customers ask repeatedly.
            </s-text>
            <div style={{ marginTop: "16px" }}>
              <s-button onClick={addFaq} variant="primary">Add your first FAQ</s-button>
            </div>
          </div>
        ) : (
          <>
            {faqs.map((faq, idx) => (
              <s-box key={faq.question || `faq-${idx}`} padding="base" background="subdued" borderRadius="base">
                <s-stack direction="block" gap="base">
                  <s-text-field
                    label={`Question ${idx + 1}`}
                    value={faq.question}
                    onInput={(e: Event) =>
                      updateFaq(idx, "question", (e.target as HTMLInputElement).value)
                    }
                  ></s-text-field>
                  {/* ponytail: cast through unknown — multiline is a valid web-component attr but not in generated TS types */}
                  <s-text-field
                    {...({ multiline: "" } as Record<string, unknown>)}
                    label="Answer"
                    value={faq.answer}
                    onInput={(e: Event) =>
                      updateFaq(idx, "answer", (e.target as HTMLInputElement).value)
                    }
                  ></s-text-field>
                  <div style={{ textAlign: "right", marginTop: "2px" }}>
                    <s-text tone="neutral">{faq.answer.length} characters</s-text>
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "8px" }}>
                    <s-button
                      variant="tertiary"
                      onClick={() => {
                        setTestMessage(faq.question);
                        playgroundRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                      }}
                    >
                      → Test this FAQ
                    </s-button>
                  </div>
                  <s-button
                    variant="tertiary"
                    tone="critical"
                    onClick={() => deleteFaq(idx)}
                  >
                    Remove
                  </s-button>
                </s-stack>
              </s-box>
            ))}

            <s-stack direction="inline" gap="base">
              <s-button
                variant="secondary"
                onClick={addFaq}
                {...(faqs.length >= 20 ? { disabled: true } : {})}
              >
                Add FAQ
              </s-button>
              <s-button variant="primary" onClick={submitFaqs}>
                Save knowledge base
              </s-button>
            </s-stack>
            <s-text tone="neutral">{faqs.length}/20 entries</s-text>
          </>
        )}
      </s-section>

      {/* ------------------------------------------------------------------ */}
      {/* Section 3 — Chat Playground                                          */}
      {/* ------------------------------------------------------------------ */}
      <div ref={playgroundRef}>
        <s-section heading="Chat playground">
          <s-text tone="neutral">
            Send a test message to the AI assistant and see the live response. Useful for verifying
            FAQ answers and tone before going live.
          </s-text>
          {chatHistory.length > 0 && (
            <div
              style={{
                maxHeight: "320px",
                overflowY: "auto",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                padding: "12px",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              {chatHistory.map((msg, i) => (
                <div
                  key={i}
                  style={{
                    alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
                    maxWidth: "80%",
                    padding: "8px 12px",
                    borderRadius: msg.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                    background: msg.role === "user" ? "var(--color-primary)" : "var(--color-surface)",
                    color: msg.role === "user" ? "#fff" : "var(--color-text)",
                    fontSize: "13px",
                    border: msg.role === "ai" ? "1px solid var(--color-border)" : "none",
                  }}
                >
                  {msg.text}
                </div>
              ))}
              {isTestLoading && (
                <div style={{ alignSelf: "flex-start", color: "var(--color-neutral)", fontSize: "13px", padding: "8px 12px" }}>
                  AI is thinking...
                </div>
              )}
            </div>
          )}
          {chatHistory.length > 0 && (
            <s-button variant="tertiary" onClick={() => setChatHistory([])}>Clear conversation</s-button>
          )}
          <s-text-field
            label="Test message"
            value={testMessage}
            onInput={(e: Event) => setTestMessage((e.target as HTMLInputElement).value)}
          ></s-text-field>
          <s-button
            variant="primary"
            onClick={runTest}
            {...(isTestLoading ? { loading: true } : {})}
          >
            Ask the AI
          </s-button>
        </s-section>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
