import type { Page } from "@playwright/test";

/**
 * Opens the NeonPing widget on the current page, types a message,
 * waits for the SSE stream to complete, and returns the last bot message text.
 */
export async function sendMessage(page: Page, message: string): Promise<string> {
  // Open the widget by clicking the launcher
  const launcher = page.locator("#np-launcher");
  await launcher.waitFor({ state: "visible", timeout: 10_000 });
  await launcher.click();

  // Wait for the input to be visible
  const input = page.locator("#np-input, [data-np-input]");
  await input.waitFor({ state: "visible", timeout: 5_000 });
  await input.fill(message);
  await input.press("Enter");

  // Wait for a bot message to appear after the user message
  const botMessages = page.locator(".np-bot, [data-np-role='assistant']");
  await botMessages.last().waitFor({ state: "visible", timeout: 30_000 });

  return (await botMessages.last().textContent()) ?? "";
}
