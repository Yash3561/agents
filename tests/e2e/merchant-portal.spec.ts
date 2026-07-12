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
 * What we CAN test here: public-facing platform endpoints that don't require a
 * Shopify admin session.
 */

const BASE_URL =
  process.env.STAGING_URL ??
  "https://neonping-staging.politeocean-a6f0ef16.southcentralus.azurecontainerapps.io";
test.describe("Public API endpoints", () => {
  test("health endpoint returns ok", async ({ request }) => {
    const response = await request.get(`${BASE_URL}/health`);
    expect(response.ok()).toBe(true);
    const body = await response.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  test("whatsapp webhook verification rejects invalid Meta token", async ({ request }) => {
    const response = await request.get(
      `${BASE_URL}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=invalid-e2e-token&hub.challenge=e2e-challenge`,
    );
    expect(response.status()).toBe(403);
    await expect(response.text()).resolves.toBe("Forbidden");
  });
});

// ── Skipped: require Shopify admin OAuth session ──────────────────────────────

test.skip("merchant settings page loads with WhatsApp channels tab in Shopify admin", async () => {
  /**
   * Requires: a valid embedded app session inside accounts.shopify.com.
   * Manual verification: log in to https://admin.shopify.com/store/neonping-dev/apps/...
   * and navigate to Settings. Confirm the Widget tab is absent, the default tab
   * is AI Behavior, and Settings?whatsapp opens Channels & Payments with the
   * Connect WhatsApp Business button.
   *
   * To run locally: use `shopify app dev` and click "Open app preview" from
   * the CLI, which opens the app with a valid session.
   */
});

test.skip("onboarding wizard completes WhatsApp setup", async () => {
  /**
   * Requires: fresh install of the app on a dev store (no onboarding completed).
   * Manual verification: uninstall/reinstall the app and complete the 3-step
   * wizard. Step 2 should be "Go live on WhatsApp", not storefront widget setup.
   */
});

test.skip("Inbox shows WhatsApp-only conversation list", async () => {
  /**
   * Requires: a valid Shopify admin session with at least one WhatsApp
   * conversation in the database. Manual verification: send an inbound WhatsApp
   * message through Meta's webhook, then check the Inbox in the merchant portal.
   */
});
