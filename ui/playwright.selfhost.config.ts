import { defineConfig, devices } from "@playwright/test";

const serverAddress =
  process.env.WTS_SELFHOST_E2E_ADDR ?? "127.0.0.1:43211";
const baseURL = `http://${serverAddress}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "self-hosting.spec.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    actionTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "bash ../scripts/start-selfhost-e2e-server.sh",
    env: {
      WTS_BROWSER_NODE: process.execPath,
      WTS_SELFHOST_E2E_ADDR: serverAddress,
    },
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
