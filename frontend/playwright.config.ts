import { defineConfig, devices } from "@playwright/test";

/**
 * E2E for encrypted playback (RFC 0006).
 * Expects:
 *   - backend on :8080 with ADMIN_USERNAME/ADMIN_PASSWORD
 *   - frontend on :3000 (started by webServer below if not already up)
 *   - ENCRYPTION_CATALOG_KEY matching S3 ciphertext
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 60_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.PLAYWRIGHT_NO_WEBSERVER
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
