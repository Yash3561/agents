import { useState, useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Prisma } from "@prisma/client";
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
      faqs = (JSON.parse(raw) as Faq[]).slice(0, 20);
    } catch {
      // keep empty
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
    const message = String(formData.get("testMessage") || "Hello");
    const apiBase = process.env.SHOPIFY_APP_URL ?? "";
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

  // --- FAQ state ---
  const [faqs, setFaqs] = useState<Faq[]>(merchant.customFaqs);

  // Fix A — toast fires only after server responds
  useEffect(() => {
    if (faqFetcher.state === "idle" && (faqFetcher.data as { saved?: string } | undefined)?.saved === "faqs") {
      shopify.toast.show("FAQ knowledge base saved");
    }
  }, [faqFetcher.state, faqFetcher.data, shopify]);

  useEffect(() => {
    if (quickFetcher.state === "idle" && (quickFetcher.data as { saved?: string } | undefined)?.saved === "quick_replies") {
      shopify.toast.show("Quick replies saved");
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
    // Fix C — validate before saving
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
  const [testMessage, setTestMessage] = useState("Hello");

  const runTest = () => {
    const fd = new FormData();
    fd.set("intent", "test-chat");
    fd.set("testMessage", testMessage);
    testFetcher.submit(fd, { method: "POST" });
  };

  const testResponse =
    (testFetcher.data as { testResponse?: string } | undefined)?.testResponse;
  const testLoading = testFetcher.state !== "idle";

  // --- Quick replies state ---
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
    <s-page heading="AI Config">
      {/* ------------------------------------------------------------------ */}
      {/* Section 1 — Custom Knowledge Base (FAQs)                            */}
      {/* ------------------------------------------------------------------ */}
      <s-section heading="Custom knowledge base">
        <s-text tone="neutral">
          Add up to 20 Q&amp;A pairs. The support agent will answer these questions exactly as
          written.
        </s-text>

        {/* Fix D — empty state */}
        {faqs.length === 0 ? (
          <div style={{ padding: "24px 0", textAlign: "center" }}>
            <s-text tone="subdued">
              FAQs let you teach your bot to answer common questions exactly the way you want — returns, shipping, sizing, and anything else customers ask repeatedly.
            </s-text>
            <div style={{ marginTop: "16px" }}>
              <s-button onClick={addFaq} variant="primary">Add your first FAQ</s-button>
            </div>
          </div>
        ) : (
          <>
            {/* Fix B — stable key using question text */}
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
                  <s-text-field
                    label="Answer"
                    value={faq.answer}
                    onInput={(e: Event) =>
                      updateFaq(idx, "answer", (e.target as HTMLInputElement).value)
                    }
                  ></s-text-field>
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
      {/* Section 2 — Chat Playground                                          */}
      {/* ------------------------------------------------------------------ */}
      <s-section heading="Chat playground">
        <s-text tone="neutral">
          Send a test message to the AI assistant and see the live response. Useful for verifying
          FAQ answers and tone before going live.
        </s-text>
        <s-text-field
          label="Test message"
          value={testMessage}
          onInput={(e: Event) => setTestMessage((e.target as HTMLInputElement).value)}
        ></s-text-field>
        <s-button
          variant="primary"
          onClick={runTest}
          {...(testLoading ? { loading: true } : {})}
        >
          Send test message
        </s-button>
        {testLoading ? (
          <s-text tone="neutral">Waiting for response...</s-text>
        ) : null}
        {testResponse && !testLoading ? (
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="base">
              <s-text tone="neutral">AI response:</s-text>
              <s-text>{testResponse}</s-text>
            </s-stack>
          </s-box>
        ) : null}
      </s-section>

      {/* ------------------------------------------------------------------ */}
      {/* Section 3 — Quick Replies                                            */}
      {/* ------------------------------------------------------------------ */}
      <s-section heading="Quick replies">
        <s-text tone="neutral">
          Up to 5 quick-reply buttons shown to customers at the start of a conversation. Leave
          blank to skip a slot.
        </s-text>
        {quickReplies.map((reply, i) => (
          <s-text-field
            key={i}
            label={`Button ${i + 1}`}
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
        <s-button variant="primary" onClick={submitQuickReplies}>
          Save quick replies
        </s-button>
      </s-section>
    </s-page>
  );
}
