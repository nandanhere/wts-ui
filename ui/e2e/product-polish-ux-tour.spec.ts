import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { CHECKOUT, REPORTING, expect, mountProduct, test, type CodeReviewFixture } from "./fixtures/productPolish";

// A guided tour for the UX rater. It saves one screenshot for each main flow and
// a short note of what the user did. Run it with WTS_TOUR_DIR to keep the output.
const tourDir = resolve(process.env.WTS_TOUR_DIR ?? "test-results/ux-tour");
const notes: Array<{ file: string; step: string }> = [];
let index = 0;
async function shot(page: Page, step: string) {
  index += 1;
  const file = `${String(index).padStart(2, "0")}.png`;
  await page.waitForTimeout(350);
  await page.screenshot({ path: resolve(tourDir, file), animations: "disabled" });
  notes.push({ file, step });
}

const oid = (letter: string) => letter.repeat(40);
const codeReview: CodeReviewFixture = {
  runs: [], posted: [],
  review: (request) => ({
    schemaVersion: 2, workspaceId: CHECKOUT, provider: "codex", scope: "recentChanges", mode: "raptik",
    skill: { id: String(request.skill), label: "Raptik rules", reviewer: "Pratik" }, outcome: "reviewed",
    summary: "One issue and one question. No Blocking items.",
    findings: [
      { findingId: "f-1", severity: "warning", label: "issue", repositoryId: "repo_checkout", filePath: "src/capture.ts", line: 2, side: "additions", anchored: true,
        title: "Retry can capture twice", explanation: "Two requests with one key can pass the check together.", suggestedComment: "Issue: hold a lock for the key during the capture." },
      { findingId: "q-1", severity: "suggestion", label: "question", repositoryId: "repo_checkout", filePath: "src/idempotency.ts", line: 2, side: "additions", anchored: true,
        title: "Does getOrCreate expire keys?", explanation: "The cache has no visible expiry.", suggestedComment: "Question: when does getOrCreate drop an old key?" },
    ],
    actionableSteps: [],
    repositories: [{ repositoryId: "repo_checkout", repositoryLabel: "checkout-api", baseCommitOid: oid("a"), headCommitOid: oid("b"), patchSha256: "sha256:mr", changedLines: 6, sizeGateExceeded: false, strictness: "normal",
      mergeRequest: { iid: 16, baseCommitOid: oid("a"), startCommitOid: oid("a"), headCommitOid: oid("b") } }],
    reviewedAtUnixMs: Date.now(),
  }),
};

test("UX tour of the main WTS flows", async ({ page, productOrigin }) => {
  test.setTimeout(180_000);
  await mkdir(tourDir, { recursive: true });
  const theme = (process.env.WTS_TOUR_THEME as "dark" | "light") ?? "dark";
  await mountProduct(page, productOrigin, { theme, codeReview });
  await expect(page.getByRole("button", { name: /^Open PLATFORM-42.* details$/i })).toBeVisible();
  await shot(page, "Start screen: Spaces board with every workspace (the parallel-work home).");

  await page.getByRole("button", { name: /^Open PLATFORM-42.* details$/i }).click();
  await expect(page.getByLabel("Workspace facts")).toBeVisible();
  await shot(page, "Opened workspace PLATFORM-42: the Workspace overview tab.");

  await page.getByRole("tab", { name: "Plans", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Implementation plan", exact: true })).toBeVisible();
  await shot(page, "Plans tab: planning documents for the workspace.");

  await page.getByRole("tab", { name: /^(Changes|Code review)/ }).click();
  await expect(page.getByRole("combobox", { name: "Code comparison" })).toBeVisible();
  await shot(page, "Changes tab (MR workspace): code comparison with the MR.");

  await page.locator('[data-ui="repository-review.views"]').getByRole("button", { name: "AI review" }).click();
  await page.getByRole("region", { name: "AI code review" }).getByRole("button", { name: "Review code" }).click();
  await expect(page.getByRole("note", { name: /AI review: Issue/ })).toBeVisible();
  await shot(page, "Ran the AI code review on the MR: findings, agent questions, inline notes.");

  await page.locator('[data-ui="repository-review.views"]').getByRole("tab", { name: /^Conversations/ }).click();
  await expect(page.getByText("Can two requests with the same key race here?", { exact: false })).toBeVisible();
  await shot(page, "Conversations: GitLab MR threads.");

  const verify = page.getByRole("tab", { name: "Verify", exact: true });
  if (await verify.count()) {
    await verify.click();
    await shot(page, "Verify tab: tests and verification for the workspace.");
  }

  await page.getByRole("button", { name: "Open agent feedback", exact: true }).click();
  await expect(page.getByRole("log", { name: "Agent messages" })).toBeVisible();
  await shot(page, "Agent feedback panel: chat with the WTS agent.");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Open Spaces", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`^Open .* details$`) }).nth(1).click().catch(() => undefined);
  await shot(page, "Opened a second workspace from Spaces (switching between parallel work).");

  await page.getByRole("button", { name: "Open Spaces", exact: true }).click();
  await page.getByRole("button", { name: "New workspace", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New workspace", exact: true })).toBeVisible();
  await shot(page, "New workspace dialog: start new parallel work.");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Open Environment and integrations", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Environment & integrations" })).toBeVisible();
  await shot(page, "Settings: environment and integrations.");
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole("button", { name: "Open Spaces", exact: true }).click();
  await shot(page, "Spaces board at 1024x768 (laptop).");
  void REPORTING;
  await writeFile(resolve(tourDir, "notes.json"), JSON.stringify(notes, null, 2));
});
