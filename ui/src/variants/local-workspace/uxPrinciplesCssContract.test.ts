import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceCss = readFileSync(
  resolve("src/variants/local-workspace/LocalWorkspace.module.css"),
  "utf8",
);
const workItemsCss = readFileSync(
  resolve("src/variants/local-workspace/WorkspaceWorkItemsPanel.module.css"),
  "utf8",
);

const cssBlockStartingAt = (selector: string) => {
  const selectorIndex = workspaceCss.indexOf(selector);
  expect(selectorIndex, `Missing CSS selector: ${selector}`).toBeGreaterThanOrEqual(
    0,
  );

  const openingBrace = workspaceCss.indexOf("{", selectorIndex);
  expect(openingBrace, `Missing block for CSS selector: ${selector}`).toBeGreaterThan(
    selectorIndex,
  );

  let depth = 0;
  for (let index = openingBrace; index < workspaceCss.length; index += 1) {
    if (workspaceCss[index] === "{") depth += 1;
    if (workspaceCss[index] === "}") depth -= 1;
    if (depth === 0) return workspaceCss.slice(openingBrace + 1, index);
  }

  throw new Error(`Unclosed CSS block for selector: ${selector}`);
};

describe("Blink UX principles CSS contract", () => {
  it("keeps standard actions accessible without inflating compact controls", () => {
    expect(workspaceCss).toContain("--workspace-interactive-target: 44px");
    expect(workspaceCss).toContain("--workspace-chrome-height: 52px");
    expect(cssBlockStartingAt(".primaryButton,")).toContain(
      "min-height: var(--wts-control-height)",
    );
    expect(cssBlockStartingAt(".searchField button")).toContain("height: 28px");
    expect(cssBlockStartingAt(".issueProviderSelector button")).toContain(
      "min-height: 27px",
    );
    expect(workspaceCss).not.toMatch(
      /:is\(\.app, \.portalSurface\)[\s\S]*?:is\([\s\S]*?button,[\s\S]*?input,[\s\S]*?textarea[\s\S]*?\)\s*\{[\s\S]*?min-height:\s*var\(--workspace-interactive-target\)/,
    );
    expect(workspaceCss).toMatch(
      /\.chrome\s*\{[\s\S]*?height:\s*var\(--workspace-chrome-height\)/,
    );
    expect(workspaceCss).toMatch(
      /\.boardMain\s*\{[\s\S]*?height:\s*calc\(100dvh - var\(--workspace-chrome-height\)\)/,
    );
  });

  it("uses a compact header with a stacked identity and inline views", () => {
    const header = cssBlockStartingAt(".workbenchHeader");
    const identity = cssBlockStartingAt(
      ".workbenchIdentity > span:last-child",
    );

    expect(header).toContain(
      "grid-template-columns: minmax(180px, 1fr) auto auto",
    );
    expect(header).toContain("min-height: 44px");
    expect(header).toContain("padding: 4px 12px");
    expect(identity).toContain("flex-direction: column");
    expect(workspaceCss).not.toContain(".workspaceViewMenuTrigger");
    expect(workspaceCss).not.toMatch(/^\.tabBar\s*\{/m);
    expect(cssBlockStartingAt(".workspaceInlineViews")).toContain(
      "overflow-x: auto",
    );
  });

  it("keeps user-facing core typography at or above the 12px caption floor", () => {
    expect(workspaceCss).not.toMatch(
      /font-size:\s*(?:8|9|10|11)(?:\.0+)?px/,
    );
  });

  it("defines pressed feedback and unambiguous disabled cursors", () => {
    expect(workspaceCss).toMatch(
      /\.chromeNavButton:active,[\s\S]*?\.headerRefreshButton:active,[\s\S]*?\.menuItem:active\s*\{[\s\S]*?transform:\s*var\(--wts-control-active\);/,
    );
    expect(workspaceCss).not.toContain("cursor: wait");
    expect(workspaceCss).toMatch(
      /:is\([\s\S]*?:disabled,[\s\S]*?\[data-disabled\],[\s\S]*?\[aria-disabled="true"\][\s\S]*?\)\s*\{[\s\S]*?cursor:\s*not-allowed;/,
    );
  });

  it("uses a dark scrim without combining it with backdrop blur", () => {
    const dialogOverlay = cssBlockStartingAt(".dialogOverlay");
    const commandOverlay = cssBlockStartingAt(".commandOverlay");

    expect(dialogOverlay).toContain("background:");
    expect(dialogOverlay).not.toContain("backdrop-filter");
    expect(commandOverlay).toContain("background:");
    expect(commandOverlay).not.toContain("backdrop-filter");
  });

  it("uses lighter, shadowless elevated surfaces in dark mode", () => {
    const darkElevation = cssBlockStartingAt(
      ':global(html[data-theme="dark"])',
    );

    expect(workspaceCss).toMatch(
      /:global\(html\[data-theme="dark"\]\)[\s\S]*?:where\([\s\S]*?\.guideDialog,[\s\S]*?\.createDialog,[\s\S]*?\.menuContent,[\s\S]*?\.removalDialog,[\s\S]*?\.commandPalette[\s\S]*?\)\s*\{/,
    );
    expect(darkElevation).toContain("background: var(--wts-surface-subtle)");
    expect(darkElevation).toContain("box-shadow: none");
  });

  it("keeps workspace lanes scrollable and theme-derived", () => {
    const kanban = cssBlockStartingAt(".kanban");
    const lane = cssBlockStartingAt(".lane");
    const laneCards = cssBlockStartingAt(".laneCards");

    expect(kanban).toContain("align-items: start");
    expect(kanban).toContain("flex: 1 1 auto");
    expect(kanban).toContain("grid-template-rows: minmax(0, 1fr)");
    expect(lane).toContain("align-self: stretch");
    expect(lane).toContain("height: 100%");
    expect(lane).toContain("background: var(--wts-surface-subtle)");
    expect(lane).not.toMatch(/background:\s*(?:#|rgba?\()/);
    expect(laneCards).toContain("flex: 1 1 auto");
    expect(laneCards).toContain("overflow-y: auto");
    expect(laneCards).toContain("scrollbar-gutter: stable");
  });

  it("uses stronger card boundaries and lane state edges", () => {
    const card = cssBlockStartingAt(".workspaceCardShell");

    expect(card).toContain("border: 1px solid var(--line-strong)");
    expect(card).toContain("box-shadow:");
    expect(workspaceCss).toContain(".workspaceCardShell::before");
    expect(workspaceCss).toContain('.workspaceCardShell[data-lane="planned"]::before');
    expect(workspaceCss).toContain('.workspaceCardShell[data-lane="active"]::before');
    expect(workspaceCss).toContain('.workspaceCardShell[data-lane="attention"]::before');
  });

  it("keeps assigned review requests compact inside the Ready column", () => {
    const card = cssBlockStartingAt(".assignedReviewCard");
    const action = cssBlockStartingAt(".assignedReviewBody {");
    const title = cssBlockStartingAt(".assignedReviewCard h3 {");

    expect(card).toContain("background: var(--wts-surface)");
    expect(card).toContain("border: 1px solid var(--line-strong)");
    expect(workspaceCss).toContain(".assignedReviewCard::before");
    expect(action).toContain("padding: 12px 12px 12px 16px");
    expect(title).toContain("-webkit-line-clamp: 2");
  });

  it("keeps card actions in normal layout flow", () => {
    const actions = cssBlockStartingAt(".cardActions");
    const actionButton = cssBlockStartingAt(".cardActionButton");
    const issueLink = cssBlockStartingAt(".cardIssueLink");

    expect(actions).toContain("display: flex");
    expect(actions).toContain("border-top: 1px solid var(--line)");
    expect(actionButton).not.toContain("position: absolute");
    expect(issueLink).toContain("position: relative");
  });

  it("keeps plan decisions inside the phone-width creation dialog", () => {
    const phoneLayout = cssBlockStartingAt("@media (max-width: 520px)");

    expect(phoneLayout).toMatch(
      /\.manifestSummary\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    );
    expect(phoneLayout).toMatch(
      /\.planningChoices\s*\{[\s\S]*?grid-template-columns:\s*1fr/,
    );
  });

  it("uses the shared theme palette for Jira work items", () => {
    expect(workItemsCss).toContain("color: var(--wts-ink)");
    expect(workItemsCss).toContain("background: var(--wts-surface)");
    expect(workItemsCss).toContain("background: var(--wts-red-soft)");
    expect(workItemsCss).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
  });

  it("lets compact work items use the full row as a repository-style table", () => {
    expect(workItemsCss).toMatch(
      /\.panel\s*\{[\s\S]*?width:\s*100%;[\s\S]*?box-sizing:\s*border-box;[\s\S]*?max-width:\s*none;/,
    );
    expect(workItemsCss).toMatch(
      /\.linkTableHeader,\s*\.linkRow\s*\{[\s\S]*?grid-template-columns:\s*minmax\(280px,\s*1\.6fr\)\s*minmax\(110px,\s*0\.6fr\)\s*minmax\(120px,\s*0\.7fr\)\s*34px/,
    );
  });
});
