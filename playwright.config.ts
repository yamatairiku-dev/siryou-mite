import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run build && npm run start",
    url: "http://127.0.0.1:3000/health",
    reuseExistingServer: !process.env.CI,
    env: {
      NODE_ENV: "development",
      PORT: "3000",
      APP_NAME: "社内Webアプリ",
      APP_ORIGIN: "http://127.0.0.1:3000",
      AUTH_MODE: "dev",
      SESSION_SECRET: "test-session-secret-at-least-32-characters",
      SESSION_MAX_AGE_SECONDS: "28800",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
