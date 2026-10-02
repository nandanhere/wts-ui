import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["agent-feedback-simplicity.spec.ts", "agent-feedback-transcript.spec.ts", "agent-feedback-recovery.spec.ts", "agent-feedback-results.spec.ts", "agent-feedback-decisions.spec.ts", "agent-feedback-work-sets.spec.ts", "agent-result-layout.spec.ts"],
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
