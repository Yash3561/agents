import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL:
      process.env.STAGING_URL ??
      "https://neonping-staging.politeocean-a6f0ef16.southcentralus.azurecontainerapps.io",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
});
