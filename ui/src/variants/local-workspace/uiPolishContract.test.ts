import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const globalCss = readFileSync(resolve("src/global.css"), "utf8");
const workspaceCss = readFileSync(
  resolve("src/variants/local-workspace/LocalWorkspace.module.css"),
  "utf8",
);

describe("WTS UI polish contract", () => {
  it("uses shared control sizing and tokenized elevation in the workspace shell", () => {
    expect(globalCss).toContain("--wts-control-height: 44px");
    expect(globalCss).toContain("--wts-control-height-compact: 44px");
    expect(globalCss).toMatch(
      /html\[data-theme="dark"\][\s\S]*--wts-shadow-md:\s*0 0 0 1px/,
    );

    expect(workspaceCss).toMatch(
      /\.primaryButton,[\s\S]*?min-height:\s*var\(--wts-control-height\)/,
    );
    expect(workspaceCss).toMatch(
      /\.headerRefreshButton\s*\{[\s\S]*?width:\s*var\(--wts-control-height-compact\)/,
    );
    expect(workspaceCss).toMatch(
      /\.commandStatus\s*\{[\s\S]*?box-shadow:\s*var\(--wts-shadow-md\)/,
    );
  });

  it("gives the 320px workspace header and tabs an explicit compact layout", () => {
    expect(workspaceCss).toMatch(
      /@media \(max-width:\s*360px\)\s*\{[\s\S]*?\.headerActions\s*\{[\s\S]*?grid-template-columns:/,
    );
    expect(workspaceCss).toMatch(
      /@media \(max-width:\s*360px\)\s*\{[\s\S]*?\.headerActions \.primaryButton\s*\{[\s\S]*?width:\s*100%/,
    );
    expect(workspaceCss).toMatch(
      /\.workspaceInlineViews\s*\{[\s\S]*?overflow-x:\s*auto/,
    );
    expect(workspaceCss).toMatch(
      /@media \(max-width:\s*760px\)\s*\{[\s\S]*?\.workspaceInlineViews \[role="tab"\]\s*\{[\s\S]*?min-width:\s*44px/,
    );
  });
});
