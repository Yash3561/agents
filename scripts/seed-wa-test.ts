/**
 * One-shot script: seeds the dev merchant with WhatsApp test credentials.
 * Run once after filling WA_TEST_* vars in .env:
 *   npx tsx scripts/seed-wa-test.ts
 */

import crypto from "crypto";
import { config } from "dotenv";
import { PrismaClient } from "@prisma/client";

config(); // load .env

const prisma = new PrismaClient();

function encryptToken(token: string): string {
  const hex = process.env.ENCRYPTION_KEY ?? "";
  if (hex.length !== 64) throw new Error("ENCRYPTION_KEY must be 64 hex chars");
  const key = Buffer.from(hex, "hex");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const enc = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + enc.toString("hex");
}

const phoneNumberId = process.env.WA_TEST_PHONE_NUMBER_ID?.trim();
const rawToken = process.env.WA_TEST_ACCESS_TOKEN?.trim();
const phoneDisplay = process.env.WA_TEST_PHONE_DISPLAY?.trim();
const shopDomain = process.env.WA_TEST_SHOP_DOMAIN?.trim();

if (!phoneNumberId || !rawToken || !phoneDisplay || !shopDomain) {
  console.error("Missing env vars. Fill WA_TEST_PHONE_NUMBER_ID, WA_TEST_ACCESS_TOKEN, WA_TEST_PHONE_DISPLAY, WA_TEST_SHOP_DOMAIN in .env");
  process.exit(1);
}

const encrypted = encryptToken(rawToken);

const merchant = await prisma.merchant.update({
  where: { shopDomain },
  data: {
    waPhoneNumberId: phoneNumberId,
    waAccessToken: encrypted,
    waPhone: phoneDisplay,
    waConnectedAt: new Date(),
  },
  select: { shopDomain: true, waPhone: true, waPhoneNumberId: true },
});

console.log("✓ WhatsApp test credentials seeded:", merchant);
await prisma.$disconnect();
