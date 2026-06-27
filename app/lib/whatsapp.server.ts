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

export async function sendReplyButtons(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  body: string,
  buttons: Array<{ id: string; title: string }>,
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
