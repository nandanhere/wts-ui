import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readPanelCss = (fileName: string) =>
  readFileSync(resolve(`src/variants/local-workspace/${fileName}`), "utf8");

const agentSessionsCss = readPanelCss("AgentSessionsPanel.module.css");
const userJourneysCss = readPanelCss("UserJourneys.module.css");
const verificationCss = readPanelCss("VerificationPanel.module.css");

describe("compact secondary-panel control cascade", () => {
  it("does not override every nested control with a blanket 44px minimum", () => {
    expect(agentSessionsCss).not.toMatch(
      /\.panel\s+(?:button|:is\([^)]*button)[^{]*\{[^}]*min-(?:width|height):\s*44px/,
    );
    expect(userJourneysCss).not.toMatch(
      /\.section\s+(?:button|:is\([^)]*button)[^{]*\{[^}]*min-(?:width|height):\s*44px/,
    );
    expect(verificationCss).not.toMatch(
      /:is\(\.surface,\s*\.empty\)\s+(?:button|:is\([^)]*button)[^{]*\{[^}]*min-(?:width|height):\s*44px/,
    );
  });

  it("retains the deliberate compact sizing for each panel's controls", () => {
    expect(agentSessionsCss).toMatch(
      /\.tab\s*\{[^}]*min-height:\s*36px/,
    );
    expect(agentSessionsCss).toMatch(
      /\.assignment select\s*\{[^}]*height:\s*36px/,
    );
    expect(userJourneysCss).toMatch(
      /\.runButton\s*\{[^}]*min-height:\s*32px/,
    );
    expect(userJourneysCss).toMatch(
      /\.evidence summary\s*\{[^}]*min-height:\s*35px/,
    );
    expect(verificationCss).toMatch(
      /\.agentRefreshButton\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px/,
    );
    expect(verificationCss).toMatch(
      /\.checkRunButton\s*\{[^}]*min-height:\s*36px/,
    );
  });

  it("keeps pressed and disabled feedback on actionable controls", () => {
    expect(agentSessionsCss).toMatch(/\.tab:active\s*\{/);
    expect(agentSessionsCss).toMatch(
      /\.ignoredToggle:active:not\(:disabled\),[\s\S]*?\.activitySource button:active:not\(:disabled\)\s*\{/,
    );
    expect(agentSessionsCss).toMatch(
      /\.assignment select:disabled\s*\{/,
    );

    expect(userJourneysCss).toMatch(
      /\.runButton:active:not\(:disabled\)\s*\{/,
    );
    expect(userJourneysCss).toMatch(/\.runButton:disabled\s*\{/);
    expect(userJourneysCss).toMatch(/\.evidence summary:active\s*\{/);

    expect(verificationCss).toMatch(
      /\.checkRunButton:active:not\(:disabled\)/,
    );
    expect(verificationCss).toMatch(/\.checkRunButton:disabled\s*\{/);
    expect(verificationCss).toMatch(/\.check summary:active\s*\{/);
  });
});
