import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readPanelCss = (fileName: string) =>
  readFileSync(resolve(`src/variants/local-workspace/${fileName}`), "utf8");

const panels = {
  agentSessions: readPanelCss("AgentSessionsPanel.module.css"),
  setup: readPanelCss("SetupSheet.module.css"),
  verification: readPanelCss("VerificationPanel.module.css"),
  userJourneys: readPanelCss("UserJourneys.module.css"),
};
const codeFeedback = readPanelCss("CodeReviewFeedbackPanel.module.css");
const patchViewer = readPanelCss("RepositoryPatchViewer.module.css");

describe("secondary panel UX contract", () => {
  it("keeps labels and captions at a legible dashboard minimum", () => {
    for (const css of Object.values(panels)) {
      expect(css).not.toMatch(/font-size:\s*(?:8|9|10|11)px/);
    }
  });

  it("keeps full-size activation targets where the context calls for them", () => {
    expect(panels.setup).toContain("--pref-control-height: 44px");
  });

  it("defines pressed feedback and non-misleading disabled cursors", () => {
    for (const css of Object.values(panels)) {
      expect(css).toMatch(/:active:not\(:disabled\)/);
      expect(css).not.toMatch(/cursor:\s*(?:wait|default)/);
    }
  });

  it("uses theme-aware elevation instead of hardcoded dark shadows", () => {
    expect(panels.userJourneys).toMatch(
      /\.section\s*\{[\s\S]*?box-shadow:\s*var\(--wts-shadow-sm\)/,
    );
    expect(panels.setup).toMatch(
      /\.themePreview\s*\{[\s\S]*?box-shadow:\s*var\(--wts-shadow-sm\)/,
    );
    expect(panels.setup).toMatch(
      /\.themePreview\[data-theme-preview="dark"\]\s*\{[\s\S]*?box-shadow:\s*none/,
    );
    expect(panels.verification).toContain(
      "--verify-shadow: var(--shadow-sm, var(--wts-shadow-sm));",
    );

    for (const css of Object.values(panels)) {
      expect(css).not.toMatch(
        /box-shadow:\s*[^;]*rgba\((?:9,\s*30,\s*66|0,\s*0,\s*0)/,
      );
    }
  });

  it("keeps verification planning actions in one responsive grid cell", () => {
    expect(panels.verification).toMatch(
      /\.planningActions\s*\{[^}]*display:\s*flex;[^}]*justify-self:\s*end;[^}]*flex-direction:\s*column;/,
    );
    expect(panels.verification).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.planningActions\s*\{[^}]*grid-column:\s*2;[^}]*justify-self:\s*stretch;/,
    );
  });

  it("contains review discussions inside the feedback rail", () => {
    expect(patchViewer).toMatch(
      /\.contextRail\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/,
    );
    expect(codeFeedback).toMatch(
      /\.panel\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/,
    );
    expect(codeFeedback).toMatch(
      /\.threads li\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/,
    );
    expect(codeFeedback).toMatch(
      /\.discussionBody table\s*\{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;/,
    );
  });
});
