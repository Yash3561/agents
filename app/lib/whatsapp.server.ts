import crypto from "crypto";

const META_BASE = "https://graph.facebook.com/v19.0";

// ---------------------------------------------------------------------------
// Token encryption — AES-256-CBC, key from ENCRYPTION_KEY env var (hex, 32 bytes)
// ---------------------------------------------------------------------------

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY ?? "";
  if (hex.length !== 64) throw new Error("ENCRYPTION_KEY must be 64 hex chars (32 bytes)");
  return Buffer.from(hex, "hex");
}

export function encryptToken(token: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

export function decryptToken(encrypted: string): string {
  const [ivHex, dataHex] = encrypted.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", getKey(), iv);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

export function verifyWebhookSignature(
  rawBody: string,
  xHubSignature: string,
  appSecret: string,
): boolean {
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from("sha256=" + expected, "utf8");
  const receivedBuf = Buffer.from(xHubSignature, "utf8");
  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

// ---------------------------------------------------------------------------
// Meta Cloud API helpers
// ---------------------------------------------------------------------------

export async function sendTextMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  text: string,
): Promise<void> {
  const res = await fetch(`${META_BASE}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta sendTextMessage failed: ${res.status} ${err}`);
  }
}

export function normalizePhone(raw: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return raw.startsWith("+") ? `+${digits}` : `+${digits}`;
}

export async function sendReplyButtons(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  body: string,
  buttons: Array<{ id: string; title: string }>,
  imageUrl?: string,
): Promise<void> {
  const res = await fetch(`${META_BASE}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        ...(imageUrl ? { header: { type: "image", image: { link: imageUrl } } } : {}),
        body: { text: body },
        action: {
          buttons: buttons.map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta sendReplyButtons failed: ${res.status} ${err}`);
  }
}

export async function sendCheckoutMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  productTitle: string,
  price: string,
  checkoutUrl: string,
  productPageUrl: string,
): Promise<void> {
  const priceStr = price ? ` — ${price}` : "";
  const body = `✅ Added to your cart!\n\n*${productTitle}*${priceStr} × 1\n\nTap below to complete your order.\nOr view product: ${productPageUrl}`;
  const res = await fetch(`${META_BASE}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "cta_url",
        body: { text: body },
        action: {
          name: "cta_url",
          parameters: { display_text: "Checkout Now →", url: checkoutUrl },
        },
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta sendCheckoutMessage failed: ${res.status} ${err}`);
  }
}

export async function sendVariantList(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  variants: Array<{ id: string; title: string; price: string; currency?: string }>,
  relativeUrl: string,
): Promise<void> {
  const CURRENCY_SYM: Record<string, string> = { USD: "$", INR: "₹", EUR: "€", GBP: "£" };
  const res = await fetch(`${META_BASE}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: "Choose your option:" },
        action: {
          button: "Select",
          sections: [{
            title: "Available options",
            rows: variants.slice(0, 10).map((v) => {
              const sym = CURRENCY_SYM[v.currency ?? ""] ?? v.currency ?? "";
              return {
                id: `vadd|${v.id}|${relativeUrl}`,
                title: v.title.slice(0, 24),
                description: v.price ? `${sym}${v.price}` : "",
              };
            }),
          }],
        },
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta sendVariantList failed: ${res.status} ${err}`);
  }
}

export async function sendCarousel(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  // variantId encodes "actualVariantId|relativeProductUrl" or "select_variant|productId|url"
  cards: Array<{ imageUrl?: string; body: string; variantId: string }>,
  intro = "Here are some products for you:",
): Promise<void> {
  const res = await fetch(`${META_BASE}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "carousel",
        body: { text: intro.slice(0, 1024) },
        action: {
          cards: cards.map((c, i) => ({
            card_index: i,
            type: "button",
            ...(c.imageUrl ? { header: { type: "image", image: { link: c.imageUrl } } } : {}),
            body: { text: c.body.slice(0, 160) },
            action: {
              buttons: [
                { type: "quick_reply", quick_reply: { id: `add_cart|${c.variantId}`, title: "Add to Cart" } },
                { type: "quick_reply", quick_reply: { id: `know_more|${c.variantId}`, title: "Know More" } },
              ],
            },
          })),
        },
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta sendCarousel failed: ${res.status} ${err}`);
  }
}

export async function sendListMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  body: string,
  buttonText: string,
  sections: Array<{
    title: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }>,
): Promise<void> {
  const res = await fetch(`${META_BASE}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: body },
        action: {
          button: buttonText.slice(0, 20),
          sections: sections.map((s) => ({
            title: s.title.slice(0, 24),
            rows: s.rows.slice(0, 10).map((r) => ({
              id: r.id,
              title: r.title.slice(0, 24),
              ...(r.description ? { description: r.description.slice(0, 72) } : {}),
            })),
          })),
        },
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta sendListMessage failed: ${res.status} ${err}`);
  }
}

export async function sendTemplate(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  templateName: string,
  languageCode: string,
  components: Array<{ type: string; parameters: Array<{ type: string; text?: string }> }>,
): Promise<void> {
  const res = await fetch(`${META_BASE}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: { name: templateName, language: { code: languageCode }, components },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta sendTemplate failed: ${res.status} ${err}`);
  }
}

export async function registerDefaultTemplates(wabaId: string, accessToken: string): Promise<void> {
  const templates = [
    {
      name: "neonping_cart_recovery",
      category: "UTILITY",
      language: "en",
      components: [
        {
          type: "BODY",
          text: "Hi {{1}}, you left {{2}} in your cart. Complete your order here: {{3}}",
          example: { body_text: [["there", "Blue Sneakers", "https://example.com/cart"]] },
        },
        { type: "FOOTER", text: "Reply STOP to unsubscribe" },
      ],
    },
    {
      name: "neonping_cod_confirm",
      category: "UTILITY",
      language: "en",
      components: [
        {
          type: "BODY",
          text: "Hi {{1}}, your order {{2}} (COD ₹{{3}}) is confirmed! We'll update you when it ships.",
          example: { body_text: [["there", "#1001", "999"]] },
        },
      ],
    },
  ];

  for (const tpl of templates) {
    try {
      const res = await fetch(`${META_BASE}/${wabaId}/message_templates`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(tpl),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: { error_user_msg?: string; message?: string } };
        if (body.error?.error_user_msg?.includes("same name") || body.error?.message?.includes("duplicate")) continue;
        console.warn(`[wa-templates] Failed to register ${tpl.name}:`, body.error);
      }
    } catch (e) {
      console.warn(`[wa-templates] Error registering ${tpl.name}:`, e);
    }
  }
}
