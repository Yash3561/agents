import { test, expect } from "@playwright/test";

/**
 * Merchant portal E2E tests.
 *
 * NOTE: Full embedded Shopify admin tests (settings page, onboarding wizard,
 * conversations dashboard) require a valid Shopify session token and cannot
 * run in headless CI without a pre-authenticated Shopify CLI session.
 * Those tests are marked test.skip with a comment explaining what manual
 * verification is needed.
 *
 * What we CAN test here: the public-facing API endpoints that the widget and
 * external callers use — these don't require auth.
 */

const BASE_URL =
  process.env.STAGING_URL ??
  "https://neonping-staging.politeocean-a6f0ef16.southcentralus.azurecontainerapps.io";
const DEV_STORE = "neonping-dev-a509ojgs.myshopify.com";

test.describe("Public API endpoints", () => {
  test("health endpoint returns ok", async ({ request }) => {
    const response = await request.get(`${BASE_URL}/health`);
    expect(response.ok()).toBe(true);
    const body = await response.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  test("widget-config returns valid shape for known shop", async ({ request }) => {
    const response = await request.get(
      `${BASE_URL}/api/widget-config?shop=${DEV_STORE}`,
    );
    expect(response.ok()).toBe(true);
    const body = await response.json() as Record<string, unknown>;
    // Either has config fields or is empty (shop not found) — never a 4xx/5xx
    // If merchant exists, validate shape
    if (Object.keys(body).length > 0) {
      expect(typeof body.color === "string" || body.color === undefined).toBe(true);
      expect(typeof body.position === "string" || body.position === undefined).toBe(true);
    }
  });

  test("greeting endpoint returns valid shape", async ({ request }) => {
    const response = await request.get(
      `${BASE_URL}/api/greeting?shop=${DEV_STORE}`,
    );
    expect(response.ok()).toBe(true);
    const body = await response.json() as { greeting: string | null };
    // greeting must be either a string or null
    expect(body.greeting === null || typeof body.greeting === "string").toBe(true);
  });
});

// ── Skipped: require Shopify admin OAuth session ──────────────────────────────

test.skip("merchant settings page loads in Shopify admin", async () => {
  /**
   * Requires: a valid embedded app session inside accounts.shopify.com.
   * Manual verification: log in to https://admin.shopify.com/store/neonping-dev/apps/...
   * and navigate to Settings.
   *
   * To run locally: use `shopify app dev` and click "Open app preview" from
   * the CLI, which opens the app with a valid session.
   */
});

test.skip("onboarding wizard completes all 4 steps", async () => {
  /**
   * Requires: fresh install of the app on a dev store (no onboarding completed).
   * Manual verification: uninstall/reinstall the app and complete the wizard.
   */
});

test.skip("conversations dashboard shows conversation list", async () => {
  /**
   * Requires: a valid Shopify admin session with at least one conversation in
   * the database. Manual verification: initiate a chat on the storefront, then
   * check the Conversations page in the merchant portal.
   */
});
