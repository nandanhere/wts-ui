import { defineConfig, devices } from "@playwright/test";
import feedback from "./playwright.feedback.config";

export default defineConfig({
  ...feedback,
  testMatch: "agent-result-layout.spec.ts",
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
});
