import { generateObject } from "ai";
import { z } from "zod";
import { deployments } from "~/lib/llm.server";
import type { CatalogProduct } from "~/lib/mcp/catalog.server";

const CardSchema = z.object({
  heading:     z.string().max(25),
  description: z.string().max(108),
  price:       z.string().max(20),
});

const FormatterSchema = z.object({
  intro:        z.string().max(80),
  cards:        z.array(CardSchema).min(1).max(3),
  fallbackText: z.string().max(300),
});

export type FormatterOutput = z.infer<typeof FormatterSchema>;

// ponytail: CURRENCY_SYM duplicated from webhook — acceptable at this scale, YAGNI to extract
const CURRENCY_SYM: Record<string, string> = { USD: "$", INR: "₹", EUR: "€", GBP: "£" };

export async function formatCarousel(
  customerMessage: string,
  products: CatalogProduct[],
  agentText: string,
): Promise<FormatterOutput> {
  const productData = products.slice(0, 3).map((p) => {
    const sym = CURRENCY_SYM[p.currency ?? ""] ?? p.currency ?? "";
    const rawDesc = p.description
      ? p.description.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
      : "No description available.";
    return {
      title: p.title,
      description: rawDesc.slice(0, 300),
      price: p.price_min ? `from ${sym}${p.price_min}` : "",
    };
  });

  const { object } = await generateObject({
    model: deployments.shopping(),
    schema: FormatterSchema,
    system: `You format WhatsApp carousel cards for a Shopify shopping assistant. Write compelling, human card text.

Rules:
- intro: 1 sentence ≤80 chars. Be specific to what they asked. Match their tone (casual→casual, formal→formal). Never say "Here are some options".
- cards[].heading: Product name ≤25 chars, truncate at word boundary.
- cards[].description: ≤108 chars. Lead with the single most relevant BENEFIT for this specific customer based on their message. No HTML. No asterisks. Don't repeat the product name.
- cards[].price: Format as "*from $X.XX*" (with asterisks for bold). Use exact price given.
- fallbackText: Plain text summary ≤300 chars if carousel fails.
- Return exactly ${productData.length} cards, one per product.`,
    prompt: `Customer asked: "${customerMessage}"
Agent reply: "${agentText}"

Products:
${productData.map((p, i) => `${i + 1}. ${p.title} | ${p.price} | ${p.description}`).join("\n")}`,
  });

  return object;
}
