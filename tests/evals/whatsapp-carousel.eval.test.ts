/**
 * Real-model eval: catches the carousel card formatter (formatCarousel,
 * app/lib/agents/whatsapp-formatter.server.ts) inventing product benefits
 * or claims that aren't grounded in the real description. Unlike the main
 * text reply — which only cites products search_catalog actually returned —
 * formatCarousel is a *second* LLM call that gets a truncated description
 * and is asked to "lead with the single most relevant benefit," which is a
 * real hallucination surface when the description is thin or missing.
 */
import { describe, it, expect } from "vitest";
import { hasCreds } from "./helpers/has-creds";
import { formatCarousel } from "~/lib/agents/whatsapp-formatter.server";
import type { CatalogProduct } from "~/lib/mcp/catalog.server";

function product(overrides: Partial<CatalogProduct>): CatalogProduct {
  return {
    id: "gid://shopify/Product/1",
    title: "Untitled",
    variants: [],
    currency: "USD",
    ...overrides,
  };
}

// Claims that only a real, materially-different product could earn — if the
// formatter attaches one of these to a product whose description never
// mentioned it, that's an invented benefit, not a summary.
const UNSUPPORTED_CLAIMS = /waterproof|organic|handmade|vegan|eco-friendly|bpa-free|non-toxic|lifetime warranty|award-winning|best-selling|clinically proven/i;

describe.skipIf(!hasCreds)("real-model eval: WhatsApp carousel card faithfulness", () => {
  it("does not invent a benefit for a product with no description", async () => {
    const noDescProduct = product({
      title: "Basic Water Bottle",
      description: undefined,
      price_min: "12.00",
    });

    const result = await formatCarousel(
      "show me water bottles",
      [noDescProduct, product({ id: "2", title: "Second Item", price_min: "9.00" })],
      "Here are some options:",
    );

    const card = result.cards[0];
    // With nothing to summarize, the card must not claim a specific material/
    // certification/feature that was never in the source data.
    expect(card.description).not.toMatch(UNSUPPORTED_CLAIMS);
    expect(card.description.length).toBeGreaterThan(0);
  });

  it("does not attach one product's real feature to a different product", async () => {
    const insulated = product({
      id: "1",
      title: "Insulated Steel Bottle",
      description: "Double-wall vacuum insulation keeps drinks cold for 24 hours.",
      price_min: "28.00",
    });
    const plain = product({
      id: "2",
      title: "Plastic Sport Bottle",
      description: "Lightweight BPA-free plastic bottle for everyday use.",
      price_min: "8.00",
    });

    const result = await formatCarousel("water bottles", [insulated, plain], "Here are some options:");

    // The plain bottle's card must not claim vacuum insulation / 24-hour cold
    // retention — that's the other product's feature, not this one's.
    expect(result.cards[1]?.description.toLowerCase()).not.toMatch(/vacuum insulat|24.hour/);
  });

  it("card price matches the real product price, not an invented one", async () => {
    const p1 = product({ id: "1", title: "Item A", description: "A nice item.", price_min: "19.99" });
    const p2 = product({ id: "2", title: "Item B", description: "Another nice item.", price_min: "34.50" });

    const result = await formatCarousel("show me items", [p1, p2], "Here are some options:");

    for (const [i, p] of [p1, p2].entries()) {
      const priceDigits = result.cards[i]?.price.replace(/[^0-9.]/g, "");
      expect(priceDigits).toContain(p.price_min);
    }
  });
});
