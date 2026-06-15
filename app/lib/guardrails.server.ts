import type { ConversationSession } from "~/lib/session.server";
import type { Merchant } from "@prisma/client";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class GuardrailError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "GuardrailError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Guards — each throws GuardrailError on violation, returns void on pass
// ---------------------------------------------------------------------------

/**
 * Blocks complete_checkout unless the buyer has explicitly confirmed.
 * buyer_confirmed is only set by the Orchestrator on unambiguous words:
 * "yes", "checkout", "buy it", "place order", "proceed", "confirm".
 */
export function assertCheckoutConfirmed(
  session: ConversationSession,
  toolName: string,
): void {
  if (toolName === "complete_checkout" && !session.buyer_confirmed) {
    throw new GuardrailError(
      "checkout_not_confirmed",
      "complete_checkout requires explicit buyer confirmation",
    );
  }
}

/** Prevents checkout creation on an empty cart. */
export function assertCartNotEmpty(lineItems: unknown[]): void {
  if (!lineItems || lineItems.length === 0) {
    throw new GuardrailError("cart_is_empty", "Cannot checkout with an empty cart");
  }
}

/**
 * Caps agent hops at 3 per turn.
 * Orchestrator calls this before dispatching to each specialist.
 */
export function assertHopBudget(session: ConversationSession): void {
  if (session.hop_count >= 3) {
    throw new GuardrailError(
      "hop_budget_exceeded",
      "Max 3 specialist hops per turn exceeded",
    );
  }
}

/** Enforces one discount per conversation. */
export function assertDiscountNotApplied(session: ConversationSession): void {
  if (session.discount_applied) {
    throw new GuardrailError(
      "discount_already_applied",
      "Only one discount allowed per conversation",
    );
  }
}

/**
 * Caps discount at merchant's configured maximum (default 15%, hard cap 20%).
 */
export function assertDiscountWithinLimit(
  pct: number,
  merchant: Pick<Merchant, "maxDiscountPct">,
): void {
  const limit = Math.min(merchant.maxDiscountPct, 20);
  if (pct > limit) {
    throw new GuardrailError(
      "discount_exceeds_limit",
      `Discount ${pct}% exceeds merchant limit of ${limit}%`,
    );
  }
}
