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

export const MAX_NEGOTIATION_LEVEL = 3; // max 3 offers per conversation

/** Enforces negotiation level cap — throws when max offers reached. */
export function assertDiscountNegotiationAllowed(session: ConversationSession): void {
  if (session.discount_negotiation.level >= MAX_NEGOTIATION_LEVEL) {
    throw new GuardrailError(
      "discount_negotiation_exhausted",
      "Maximum discount offers reached for this conversation",
    );
  }
}

