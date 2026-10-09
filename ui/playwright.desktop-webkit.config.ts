import { defineConfig, devices } from "@playwright/test";
import productPolish from "./playwright.product-polish.config";

// The macOS app renders in WKWebView. WebKit here is the closest automated match to the desktop app.
// The window size matches a laptop app window, which is smaller than a browser test page.
export default defineConfig({
  ...productPolish,
  testMatch: ["product-polish-scroll-audit.spec.ts", "real-desktop-scroll-audit.spec.ts", "product-polish-line-comment.spec.ts", "product-polish-add-repository.spec.ts", "product-polish-planning-markdown-editor.spec.ts", "product-polish-app-navigation.spec.ts"],
  outputDir: process.env.WTS_POLISH_OUTPUT ?? "test-results/desktop-webkit",
  projects: [
    { name: "desktop-webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 760 } } },
    { name: "desktop-webkit-short", use: { ...devices["Desktop Safari"], viewport: { width: 1100, height: 640 } } },
  ],
});
