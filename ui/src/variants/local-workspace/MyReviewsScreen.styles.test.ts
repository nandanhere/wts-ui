import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  resolve(__dirname, "./MyReviewsScreen.module.css"),
  "utf8",
);

describe("My reviews style contract", () => {
  it("keeps the page inside the shell and gives it vertical scrolling", () => {
    const pageRule = stylesheet.match(/\.page\s*\{([\s\S]*?)\n\}/)?.[1];

    expect(pageRule).toMatch(
      /height:\s*calc\(100dvh - var\(--workspace-chrome-height\)\);/,
    );
    expect(pageRule).toMatch(/min-height:\s*0;/);
    expect(pageRule).toMatch(/overflow-y:\s*auto;/);
  });
});
