// Pure, framework-agnostic helpers shared between the inbox route files and
// their extracted UI components. No server-only imports here — this module
// runs in the browser too (status/label/time formatting used directly in JSX).

export interface ChatMessage {
  role: string;
  content: string;
  timestamp?: number;
  merchantRating?: "up" | "down";
}

export const TOOL_LABELS: Record<string, string | null> = {
  search_catalog: "Searched product catalog",
  lookup_catalog: "Looked up product details",
  get_product: "Fetched product info",
  create_cart: "Created cart",
  update_cart: "Updated cart",
  get_cart: "Checked cart contents",
  get_checkout_url: "Generated checkout link",
  offer_discount: "Offered discount code",
  search_policies_and_faqs: "Checked store policies",
  get_order: "Looked up order",
  get_customer_orders: "Fetched order history",
  unified: null, // internal routing — skip
};

export const DATE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
] as const;

export const CHANNEL_OPTS = [
  { value: "all", label: "All" },
  { value: "web", label: "Web" },
  { value: "whatsapp", label: "WhatsApp" },
] as const;

export function relTime(d: Date | string) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function formatPhone(sessionId: string): string {
  const digits = sessionId.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return `+${digits}`;
}

export type StatusKey = "needsReply" | "aiHandling" | "resolved";

export function getConversationStatus(conv: { resolved?: boolean | null; escalated?: boolean | null }): StatusKey {
  if (conv.resolved) return "resolved";
  if (conv.escalated) return "needsReply";
  return "aiHandling";
}

export function statusLabel(status: StatusKey) {
  return status === "needsReply"
    ? "Needs reply"
    : status === "aiHandling"
    ? "AI handling"
    : "Resolved";
}

export function statusTone(status: StatusKey): "success" | "warning" | "info" {
  return status === "resolved" ? "success" : status === "needsReply" ? "warning" : "info";
}
