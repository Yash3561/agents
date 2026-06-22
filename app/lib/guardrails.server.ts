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

