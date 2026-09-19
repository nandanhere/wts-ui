import { defineConfig } from "@playwright/test";
import feedback from "./playwright.feedback.config";

export default defineConfig({ ...feedback, testMatch: ["product-motion.spec.ts", "dialog-motion.spec.ts"] });
