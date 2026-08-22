import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const localWorkspaceStylesheet = readFileSync(
  resolve(__dirname, "./LocalWorkspace.module.css"),
  "utf8",
);

function extractHexColors(css: string): string[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return noComments.match(/#(?:[0-9a-fA-F]{3,4}){1,2}\b/g) ?? [];
}

describe("LocalWorkspace style contract", () => {
  it("contains no hardcoded hex colors in LocalWorkspace.module.css", () => {
    const hexes = extractHexColors(localWorkspaceStylesheet);
    expect(hexes).toEqual([]);
  });

  it("includes responsive rules covering the mid-width range (760px to 1100px)", () => {
    // Should have fluid rules or media queries handling viewports up to 1100px or between 760px and 1100px
    const hasMidWidthMediaQuery =
      /@media\s*\([^)]*max-width:\s*(?:1100|1024|900|800)px[^)]*\)/i.test(
        localWorkspaceStylesheet,
      ) ||
      /@media\s*\([^)]*min-width:\s*760px[^)]*\)\s*and\s*\([^)]*max-width:\s*1100px[^)]*\)/i.test(
        localWorkspaceStylesheet,
      );

    expect(hasMidWidthMediaQuery).toBe(true);
  });

  it("keeps the removal dialog shell fixed while its body owns scrolling", () => {
    const dialogRule = localWorkspaceStylesheet.match(
      /\.removalDialog\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    const headerRule = localWorkspaceStylesheet.match(
      /\.removalHeader\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    const bodyRule = localWorkspaceStylesheet.match(
      /\.removalBody\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    const footerRule = localWorkspaceStylesheet.match(
      /\.removalFooter\s*\{([\s\S]*?)\n\}/,
    )?.[1];

    expect(dialogRule).toMatch(/overflow:\s*clip;/);
    expect(headerRule).toMatch(/flex:\s*0 0 auto;/);
    expect(bodyRule).toMatch(/min-height:\s*0;/);
    expect(bodyRule).toMatch(/flex:\s*1 1 auto;/);
    expect(bodyRule).toMatch(/overflow-y:\s*auto;/);
    expect(footerRule).toMatch(/flex:\s*0 0 auto;/);
  });
});
