/**
 * Demo helper: fires the cart-recovery WhatsApp message immediately, instead
 * of waiting for the real 30-minute QStash delay (which requires QSTASH_TOKEN
 * to be set anyway — left unconfigured for the local demo).
 *
 * This hits the *real* production endpoint (app/routes/api.whatsapp.cart-recovery.tsx)
 * with the same shared-secret auth QStash would normally provide — no demo-only
 * code path, just skips the wait.
 *
 * Usage (with `npm run dev` already running):
 *   npx tsx scripts/demo-trigger-cart-recovery.ts \
 *     --phone 15551234567 \
 *     --items "Resistance Bands Set" \
 *     --checkout-url "https://your-shop.myshopify.com/cart/c/abc123"
 *
 * Reads SHOP_DOMAIN, WA_TEST_PHONE_NUMBER_ID, WA_TEST_ACCESS_TOKEN,
 * SHOPIFY_APP_URL, REVIEW_WORKER_SECRET/SHOPIFY_API_SECRET from .env —
 * same values already used by seed-wa-test.ts.
 */

import crypto from "crypto";
import { config } from "dotenv";

config();

function encryptToken(token: string): string {
  const hex = process.env.ENCRYPTION_KEY ?? "";
  if (hex.length !== 64) throw new Error("ENCRYPTION_KEY must be 64 hex chars");
  const key = Buffer.from(hex, "hex");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const enc = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + enc.toString("hex");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const phone = arg("phone");
const itemsArg = arg("items");
const checkoutUrl = arg("checkout-url");

const shopDomain = arg("shop") ?? process.env.WA_TEST_SHOP_DOMAIN;
const waPhoneNumberId = process.env.WA_TEST_PHONE_NUMBER_ID;
const waAccessTokenRaw = process.env.WA_TEST_ACCESS_TOKEN;
const appUrl = process.env.SHOPIFY_APP_URL;
const secret = process.env.REVIEW_WORKER_SECRET || process.env.SHOPIFY_API_SECRET;

if (!phone || !itemsArg || !checkoutUrl) {
  console.error("Usage: npx tsx scripts/demo-trigger-cart-recovery.ts --phone <e164 no +> --items <name> --checkout-url <url> [--shop <domain>]");
  process.exit(1);
}
if (!shopDomain || !waPhoneNumberId || !waAccessTokenRaw || !appUrl || !secret) {
  console.error(
    "Missing env: WA_TEST_SHOP_DOMAIN (or --shop), WA_TEST_PHONE_NUMBER_ID, WA_TEST_ACCESS_TOKEN, SHOPIFY_APP_URL, and REVIEW_WORKER_SECRET/SHOPIFY_API_SECRET must all be set.",
  );
  process.exit(1);
}

const storeName = shopDomain.replace(".myshopify.com", "");
const body = {
  shop: shopDomain,
  phone,
  checkoutId: `demo-${Date.now()}`,
  checkoutUrl,
  storeName,
  waPhoneNumberId,
  waAccessToken: encryptToken(waAccessTokenRaw), // route decrypts this itself
  items: [itemsArg],
};

const url = `${appUrl}/api/whatsapp/cart-recovery?token=${encodeURIComponent(secret)}`;

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

console.log(`POST ${url} -> ${res.status}`);
if (!res.ok) {
  console.error(await res.text().catch(() => "(no body)"));
  process.exit(1);
}
console.log("✓ Cart-recovery WhatsApp message triggered.");
