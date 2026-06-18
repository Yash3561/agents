import type { ConversationSession } from "~/lib/session.server";

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

