import { test, expect } from "@playwright/test";
import { sendMessage } from "./helpers/sendMessage";

const STORE_URL =
  process.env.SHOPIFY_STORE_URL ?? "https://neonping-dev-a509ojgs.myshopify.com";

test.describe("NeonPing Widget — Storefront", () => {
  test("widget launcher appears on storefront", async ({ page }) => {
    await page.goto(STORE_URL);
    const launcher = page.locator("#np-launcher");
    await expect(launcher).toBeVisible({ timeout: 15_000 });
  });

  test("widget opens and receives a response", async ({ page }) => {
    await page.goto(STORE_URL);
    const botReply = await sendMessage(page, "hello");
    expect(botReply.length).toBeGreaterThan(0);
  });

  test("product search shows product cards", async ({ page }) => {
    await page.goto(STORE_URL);
    await sendMessage(page, "show me resistance bands");

    // Wait for at least one product card to render
    const productCards = page.locator(".np-product, [data-np-type='product']");
    await expect(productCards.first()).toBeVisible({ timeout: 20_000 });
    expect(await productCards.count()).toBeGreaterThanOrEqual(1);
  });

  test("widget is hidden on cart page", async ({ page }) => {
    await page.goto(`${STORE_URL}/cart`);

    // Give the widget JS time to run its page exclusion check
    await page.waitForTimeout(3_000);

    const launcher = page.locator("#np-launcher");
    // The launcher should either not exist or be hidden
    const isVisible = await launcher.isVisible().catch(() => false);
    expect(isVisible).toBe(false);
  });

  // Skipped: 30-second proactive trigger is too slow for CI
  test.skip("proactive trigger fires after 30s on mobile", async () => {
    // This test requires a mobile viewport and waiting 30+ seconds.
    // Run manually: PWDEBUG=1 npx playwright test --grep "proactive"
  });
});
