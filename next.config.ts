import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit the minimal self-hosted server used by the production container.
  output: "standalone",
  // The application does not use next/image. Avoid shipping a native image
  // optimizer so a build produced on arm64 remains portable to amd64.
  images: {
    unoptimized: true,
  },
  // This repository is not a monorepo; do not infer a broader root from
  // unrelated lockfiles elsewhere on the host.
  outputFileTracingRoot: process.cwd(),
  turbopack: {
    root: process.cwd(),
  },
  // Runtime repository paths are intentionally dynamic. Prevent that tracing
  // from copying build sources, local graph data, tests, or project notes into
  // the standalone deployment; the compiled .next output is retained.
  outputFileTracingExcludes: {
    "/*": [
      "./src/**/*",
      "./e2e/**/*",
      "./graphify-out/**/*",
      "./*.md",
      "./scripts/**/*",
      "./eslint.config.mjs",
      "./playwright.config.ts",
      "./postcss.config.mjs",
      "./tsconfig.json",
      "./node_modules/sharp/**/*",
      "./node_modules/@img/**/*",
    ],
  },
  // Keep local UI reviews clear; compile and runtime errors still surface.
  devIndicators: false,
};

export default nextConfig;
