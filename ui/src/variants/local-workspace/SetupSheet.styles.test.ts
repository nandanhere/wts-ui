import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const setupSheetStylesheet = readFileSync(
  resolve(
    process.cwd(),
    "src/variants/local-workspace/SetupSheet.module.css",
  ),
  "utf8",
);

const verificationPanelStylesheet = readFileSync(
  resolve(
    process.cwd(),
    "src/variants/local-workspace/VerificationPanel.module.css",
  ),
  "utf8",
);

function extractHexColors(css: string): string[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return noComments.match(/#(?:[0-9a-fA-F]{3,4}){1,2}\b/g) ?? [];
}

describe("SetupSheet style contract", () => {
  it("lets each button variant own its foreground color", () => {
    expect(setupSheetStylesheet).not.toMatch(
      /\.modal button\s*\{[^}]*color:\s*inherit/,
    );
    expect(setupSheetStylesheet).toMatch(
      /\.refreshButton\s*\{[^}]*color:\s*var\(--wts-on-primary\)/,
    );
  });

  it("uses theme tokens for the primary button interaction states", () => {
    expect(setupSheetStylesheet).toMatch(
      /\.refreshButton:hover:not\(:disabled\)\s*\{[^}]*background:\s*var\(--wts-blue-dark\)/,
    );
    expect(setupSheetStylesheet).toMatch(
      /\.refreshButton:focus-visible,[\s\S]*outline:\s*2px solid var\(--pref-blue\)/,
    );
  });

  it("does not force every modal button into a 44px box", () => {
    expect(setupSheetStylesheet).not.toMatch(
      /\.modal button\s*\{[^}]*min-(?:width|height):\s*44px/,
    );
    expect(setupSheetStylesheet).toMatch(
      /\.closeButton\s*\{[^}]*width:\s*var\(--pref-control-height\);[^}]*height:\s*var\(--pref-control-height\)/,
    );
    expect(setupSheetStylesheet).toMatch(
      /\.adapterVerifyButton\s*\{[^}]*min-height:\s*34px/,
    );
  });

  it("contains no hardcoded hex colors in SetupSheet.module.css", () => {
    const hexes = extractHexColors(setupSheetStylesheet);
    expect(hexes).toEqual([]);
  });

  it("contains no hardcoded hex colors in VerificationPanel.module.css", () => {
    const hexes = extractHexColors(verificationPanelStylesheet);
    expect(hexes).toEqual([]);
  });
});
