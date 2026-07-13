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
      : "";
    return {
      title: p.title,
      // Empty (not a sentence like "No description available.") — a real sentence
      // there reads to the model as content to riff on, which is what was causing
      // it to invent specific claims ("durable", "boosts glute activation") for
      // products with no actual description on file.
      description: rawDesc.slice(0, 300),
      price: p.price_min ? `from ${sym}${p.price_min}` : "",
    };
  });

  const { object } = await generateObject({
    model: deployments.shopping(),
    schema: FormatterSchema,
    system: `You write WhatsApp carousel cards for a Shopify shopping assistant, from the customer's point of view — what would make THEM want to tap this card, not generic ad copy.

<grounding>
Every claim in a card must come from the product's given title, description, or price. Never invent a specific material, feature, certification, use-case, or quality (e.g. "durable", "eco-friendly", "boosts glute activation") that the description doesn't actually say. If a product's description is empty, you have no facts to lead with — write the description from its title and price alone (what kind of product it plainly is), and do not manufacture a benefit to fill the space. An honest, plain description beats a specific-sounding one that isn't true.
</grounding>

<intro>
One sentence, at most 80 characters. Speak to what this specific customer actually asked for — reread their message and reflect it back, don't write a generic store greeting. Match their tone (casual message → casual reply, formal → formal). Never say "Here are some options."
</intro>

<cards>
- heading: product name, at most 25 characters, truncate at a word boundary.
- description: at most 108 characters. Say what the product actually is or does using only facts given — when there's a real description, lead with whichever detail in it matters most for what the customer asked. Don't repeat the product name. No HTML, no asterisks.
- price: format as "*from $X.XX*" using the exact price given.
- Return exactly ${productData.length} cards, one per product, in the same order as given below.
</cards>

<fallback>
fallbackText: a plain-text summary of all the products above, at most 300 characters — used only if the carousel message itself fails to send.
</fallback>`,
    prompt: `Customer asked: "${customerMessage}"
Agent reply: "${agentText}"

Products:
${productData.map((p, i) => `${i + 1}. ${p.title} | ${p.price} | ${p.description || "(no description on file)"}`).join("\n")}`,
  });

  return object;
}
