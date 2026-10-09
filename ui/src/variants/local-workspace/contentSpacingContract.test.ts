import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(`src/variants/local-workspace/${file}`), "utf8");

const blockFor = (css: string, selector: string) => {
  const pattern = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`);
  // Use the selector's own rule: the last standalone block, after any grouped rule.
  let match: RegExpExecArray | null = null;
  for (let offset = 0, next; (next = pattern.exec(css.slice(offset))); ) {
    match = { ...next, index: offset + next.index } as RegExpExecArray;
    offset += next.index + next[0].length;
  }
  expect(match, `Missing CSS selector: ${selector}`).not.toBeNull();
  const open = css.indexOf("{", match!.index);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
};

const px = (block: string, property: string) => {
  const value = new RegExp(`(^|\\s)${property}:\\s*([^;]+);`).exec(block)?.[2];
  expect(value, `Missing ${property}`).toBeDefined();
  return value!.split(/\s+/).map((part) => Number.parseFloat(part));
};

describe("Content spacing contract", () => {
  it("separates workspace overview panels with one calm rhythm", () => {
    const css = read("LocalWorkspace.module.css");
    expect(px(blockFor(css, ".overviewGrid"), "gap")[0]).toBeGreaterThanOrEqual(16);
    expect(px(blockFor(css, ".mainColumn"), "gap")[0]).toBeGreaterThanOrEqual(16);

    for (const selector of [".panelHeading", ".repoTableRow", ".workspaceReadyBar"]) {
      const [vertical, horizontal = vertical] = px(blockFor(css, selector), "padding");
      expect(vertical, selector).toBeGreaterThanOrEqual(12);
      expect(horizontal, selector).toBeGreaterThanOrEqual(16);
    }
    expect(blockFor(css, ".panelHeading h2")).toMatch(/font-size:\s*14px/);
    expect(blockFor(css, ".workspaceReadyFacts code")).toMatch(/12px\/1\.4/);
  });

  it("gives side panels the same inset as the overview", () => {
    const workItems = read("WorkspaceWorkItemsPanel.module.css");
    expect(px(blockFor(workItems, ".header"), "padding")).toEqual([12, 16]);

    const agents = read("AgentStatePrototype.module.css");
    expect(px(blockFor(agents, ".heading"), "padding")).toEqual([12, 16]);
    expect(px(blockFor(agents, ".sessionList"), "padding")).toEqual([16]);
    const composer = blockFor(agents, ".prompt");
    expect(px(composer, "gap")[0]).toBeGreaterThanOrEqual(10);
    expect(composer).toMatch(/border-top:/);
  });

  it("groups the AI review into summary, findings, and follow-up sections", () => {
    const css = read("WorkspaceCodeReviewCard.module.css");
    expect(px(blockFor(css, ".result"), "gap")[0]).toBeGreaterThanOrEqual(24);
    for (const selector of [".overview", ".findingsGroup", ".followUp"]) {
      expect(css, selector).toMatch(new RegExp(`\\${selector}\\s*[,{]`));
    }
    const finding = px(blockFor(css, ".findingCard"), "padding");
    expect(finding[0]).toBeGreaterThanOrEqual(16);
  });

  it("separates stacked form fields and the feedback rail sections", () => {
    const css = read("LocalWorkspace.module.css");
    expect(px(blockFor(css, ".field + .field"), "margin-top")[0]).toBeGreaterThanOrEqual(16);

    const plans = read("PlanningDocumentsPanel.module.css");
    expect(px(blockFor(plans, ".feedbackComposer"), "padding")).toEqual([16]);
    expect(px(blockFor(plans, ".threadSections"), "padding")).toEqual([16]);
    expect(px(blockFor(plans, ".threadSections"), "gap")[0]).toBeGreaterThanOrEqual(20);
  });

  it("keeps removal dialog actions on one line at the standard control height", () => {
    const css = read("LocalWorkspace.module.css");
    expect(blockFor(css, ".dangerButton")).toMatch(/white-space:\s*nowrap/);
    const actions = blockFor(css, ".removalFooter :is(.secondaryButton, .dangerButton, .primaryButton)");
    expect(actions).toMatch(/height:\s*var\(--wts-control-height\)/);
    expect(actions).toMatch(/white-space:\s*nowrap/);
    expect(blockFor(css, ".removalFooter > div")).toMatch(/flex:\s*0 0 auto/);
    expect(blockFor(css, ".removalFooter > span")).toMatch(/min-width:\s*0/);
  });

  it("keeps removal recovery buttons compact and in one row", () => {
    const css = read("LocalWorkspace.module.css");
    const button = blockFor(css, ".removalRecoveryActions .secondaryButton");
    expect(button).toMatch(/height:\s*32px/);
    expect(button).toMatch(/box-shadow:\s*none/);
    const dialog = read("WorkspaceRemovalDialog.tsx");
    const start = dialog.indexOf('label="Copy recovery details"');
    const plans = dialog.indexOf(">Open Plans<");
    expect(dialog.slice(start, plans)).not.toContain("removalRecoveryActions");
  });

  it("keeps the My time period list inside the page width", () => {
    const css = read("AgentSessionsPanel.module.css");
    expect(css).toMatch(/\.panel \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    expect(blockFor(css, ".toolbar .reviewHistory")).toMatch(/min-width:\s*0/);
    expect(blockFor(css, ".toolbar .reviewHistoryList")).toMatch(/min-width:\s*0/);
  });
});
