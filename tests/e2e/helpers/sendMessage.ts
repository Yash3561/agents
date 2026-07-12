import type { Page } from "@playwright/test";

/**
 * Historical storefront widget helper.
 *
 * The theme app extension currently gates the widget behind np_enabled = false,
 * so no launcher, input, or window.__neonping_cfg should exist. Keep this helper
 * as an explicit failure for any stale E2E test that still tries to drive the
 * disabled widget; restore the implementation if the widget is re-enabled.
 */
export async function sendMessage(page: Page, message: string): Promise<string> {
  void page;
  void message;
  throw new Error(
    "sendMessage cannot run because the storefront widget is disabled by np_enabled = false. Re-enable the widget before restoring widget chat E2E tests.",
  );
}
