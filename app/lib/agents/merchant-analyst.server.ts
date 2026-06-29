import { generateSummary } from "~/lib/llm.server";
import prisma from "~/db.server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InsightsTopic {
  label: string;
  count: number;
  sample: string;
  suggestion: string;
}

export interface InsightsResult {
  topics: InsightsTopic[];
  generatedAt: string;
}

export interface QAMeta {
  flagged: boolean;
  reason: string;
  runAt: string;
}

export interface RevenueNarrative {
  bullets: string[];
  month: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Agent 1 — QA Judge
// Scores a conversation 1-5, flags if score ≤ 2 or customer showed abandonment signals.
// Called after conversation ends (resolved or 30min idle).
// ---------------------------------------------------------------------------

export async function runQAJudge(conversationId: string): Promise<void> {
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conv || conv.qualityScore != null) return; // already scored

  const messages = (conv.messages as Array<{ role: string; content: string }>) ?? [];
  if (messages.length < 2) return; // not enough to judge

  const transcript = messages
    .slice(-30)
    .map((m) => `${m.role === "user" ? "Customer" : "AI"}: ${m.content}`)
    .join("\n");

  let raw: string;
  try {
    raw = await generateSummary(
      `You are a quality auditor for an AI shopping assistant. Evaluate the AI's performance in this conversation.
Score 1-5 (5=excellent, 1=poor/harmful). Flag if score ≤ 2, or if the customer shows frustration signals like repeating the same question 3+ times or saying "never mind", "forget it", "useless", "not helpful".
Respond ONLY with valid JSON: {"score": <number>, "flagged": <bool>, "reason": "<one sentence>"}`,
      transcript,
    );
  } catch {
    return; // fail open — don't write anything on error
  }

  let parsed: { score: number; flagged: boolean; reason: string };
  try {
    parsed = JSON.parse(raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim());
  } catch {
    return;
  }

  const score = Math.min(5, Math.max(1, Number(parsed.score) || 3));
  const flagged = parsed.flagged === true || score <= 2;

  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      qualityScore: score,
      qaMeta: { flagged, reason: parsed.reason ?? "", runAt: new Date().toISOString() } satisfies QAMeta,
    },
  });
}

// ---------------------------------------------------------------------------
// Agent 2 — Conversation Intelligence
// Classifies last 7 days of conversations into topics, surfaces actionable insights.
// Runs nightly or on merchant request. Writes to Merchant.insightsJson.
// ---------------------------------------------------------------------------

export async function runInsightsAnalysis(shopDomain: string): Promise<InsightsResult> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const convs = await prisma.conversation.findMany({
    where: { shopDomain, startedAt: { gte: since } },
    select: { firstUserMessage: true, routeReason: true },
    take: 200,
  });

  if (convs.length === 0) {
    const result: InsightsResult = { topics: [], generatedAt: new Date().toISOString() };
    await prisma.merchant.update({ where: { shopDomain }, data: { insightsJson: result as unknown as import("@prisma/client").Prisma.InputJsonValue } });
    return result;
  }

  const lines = convs
    .map((c: { firstUserMessage: string | null; routeReason: string | null }) => [c.firstUserMessage, c.routeReason].filter(Boolean).join(" | "))
    .filter(Boolean)
    .join("\n");

  let raw: string;
  try {
    raw = await generateSummary(
      `You are a CX analyst for a Shopify store. Analyze these customer messages and classify them into the top 5 topics.
For each topic, provide:
- label: short topic name (e.g. "Return policy", "Shipping time", "Size guide")
- count: estimated number of conversations in this bucket
- sample: a 10-15 word representative customer quote (from the data, slightly paraphrased for clarity)
- suggestion: one actionable sentence the merchant should do (e.g. "Add a return policy FAQ", "Add a size chart to product pages")

Respond ONLY with valid JSON: {"topics": [{"label":"...","count":N,"sample":"...","suggestion":"..."}]}
Sort by count descending. Maximum 5 topics.`,
      lines.slice(0, 8000),
    );
  } catch {
    const fallback: InsightsResult = { topics: [], generatedAt: new Date().toISOString() };
    return fallback;
  }

  let parsed: { topics: InsightsTopic[] };
  try {
    parsed = JSON.parse(raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim());
  } catch {
    const fallback: InsightsResult = { topics: [], generatedAt: new Date().toISOString() };
    return fallback;
  }

  const result: InsightsResult = {
    topics: (parsed.topics ?? []).slice(0, 5),
    generatedAt: new Date().toISOString(),
  };

  await prisma.merchant.update({ where: { shopDomain }, data: { insightsJson: result as unknown as import("@prisma/client").Prisma.InputJsonValue } });
  return result;
}

// ---------------------------------------------------------------------------
// Agent 3 — Revenue Attribution Narrator
// Narrates monthly AI-attributed revenue in plain English bullets.
// Writes to Merchant.revenueNarrative. Regenerated on 1st of month or if null.
// ---------------------------------------------------------------------------

export async function runRevenueNarrator(shopDomain: string): Promise<RevenueNarrative> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [totalConvs, convertedConvs, waConvs] = await Promise.all([
    prisma.conversation.count({ where: { shopDomain, startedAt: { gte: monthStart } } }),
    prisma.conversation.findMany({
      where: { shopDomain, startedAt: { gte: monthStart }, orderId: { not: null } },
      select: { orderRevenueCents: true, channel: true, routeReason: true },
    }),
    prisma.conversation.findMany({
      where: { shopDomain, startedAt: { gte: monthStart }, channel: "whatsapp", orderId: { not: null } },
      select: { orderRevenueCents: true },
    }),
  ]);

  const totalRevenueCents = convertedConvs.reduce((s: number, c: { orderRevenueCents: number | null }) => s + (c.orderRevenueCents ?? 0), 0);
  const waRevenueCents = waConvs.reduce((s: number, c: { orderRevenueCents: number | null }) => s + (c.orderRevenueCents ?? 0), 0);
  const conversions = convertedConvs.length;
  const conversionRate = totalConvs > 0 ? ((conversions / totalConvs) * 100).toFixed(1) : "0";
  const aov = conversions > 0 ? Math.round(totalRevenueCents / conversions / 100) : 0;
  const waConversions = waConvs.length;
  const plan = (await prisma.merchant.findUnique({ where: { shopDomain }, select: { plan: true } }))?.plan ?? "free";

  const planPrices: Record<string, number> = { spark: 29, pulse: 79, surge: 199, free: 0 };
  const planCost = planPrices[plan] ?? 0;
  const roi = planCost > 0 && totalRevenueCents > 0 ? Math.round(totalRevenueCents / 100 / planCost) : null;

  const dataBlock = JSON.stringify({
    totalConversations: totalConvs,
    conversions,
    conversionRate: `${conversionRate}%`,
    totalRevenue: `$${(totalRevenueCents / 100).toFixed(2)}`,
    avgOrderValue: `$${aov}`,
    whatsappConversions: waConversions,
    whatsappRevenue: `$${(waRevenueCents / 100).toFixed(2)}`,
    planCostPerMonth: `$${planCost}`,
    roi: roi ? `${roi}x` : null,
    month: monthStart.toLocaleString("default", { month: "long", year: "numeric" }),
  });

  let bullets: string[];
  try {
    const raw = await generateSummary(
      `You are a business analyst writing a monthly performance summary for a Shopify merchant.
Write 3-4 plain English bullet points about their AI chat's performance this month.
Be specific with numbers. Be encouraging but accurate. Don't invent data not in the input.
If ROI is available, lead with it. Highlight WhatsApp if it performed well.
Format: return a JSON array of strings, e.g. ["Your AI helped...", "WhatsApp recovered..."]`,
      dataBlock,
    );
    const parsed = JSON.parse(raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim());
    bullets = Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch {
    bullets = [
      `Your AI chat handled ${totalConvs} conversations this month, converting ${conversions} into orders.`,
      `Total attributed revenue: $${(totalRevenueCents / 100).toFixed(2)}.`,
    ];
  }

  const result: RevenueNarrative = {
    bullets,
    month: monthStart.toISOString(),
    generatedAt: now.toISOString(),
  };

  await prisma.merchant.update({ where: { shopDomain }, data: { revenueNarrative: result as unknown as import("@prisma/client").Prisma.InputJsonValue } });
  return result;
}
