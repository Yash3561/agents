import { test, expect } from "@playwright/test";

const STORE_URL =
  process.env.SHOPIFY_STORE_URL ?? "https://neonping-dev-a509ojgs.myshopify.com";

test.describe("NeonPing Widget — Storefront", () => {
  test("does not initialize on storefront while np_enabled is false", async ({ page }) => {
    await page.goto(STORE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => null);

    const config = await page.evaluate(
      () => (window as Window & { __neonping_cfg?: unknown }).__neonping_cfg,
    );
    expect(config).toBeUndefined();

    const launcher = page.locator("#np-launcher");
    await expect(launcher).toHaveCount(0);
  });

  test("does not initialize on cart page while np_enabled is false", async ({ page }) => {
    await page.goto(`${STORE_URL}/cart`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => null);

    const config = await page.evaluate(
      () => (window as Window & { __neonping_cfg?: unknown }).__neonping_cfg,
    );
    expect(config).toBeUndefined();

    const launcher = page.locator("#np-launcher");
    await expect(launcher).toHaveCount(0);
  });

  // Skipped while extensions/chat-widget/blocks/chat.liquid hard-gates the
  // storefront widget behind np_enabled = false. Re-enable by restoring the
  // theme app extension gate, then replacing the negative tests above with
  // launcher/open/message/product-card assertions.
  test.skip("proactive trigger fires after 30s on mobile", async () => {
    // This test requires a mobile viewport and waiting 30+ seconds.
    // Run manually: PWDEBUG=1 npx playwright test --grep "proactive"
  });
});
