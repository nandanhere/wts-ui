import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e", testMatch: "workspace-attention.spec.ts", fullyParallel: false, workers: 1,
  forbidOnly: Boolean(process.env.CI), retries: 0, timeout: 60_000,
  outputDir: process.env.WTS_ATTENTION_OUTPUT ?? "test-results/workspace-attention",
  reporter: [["list"]], use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
