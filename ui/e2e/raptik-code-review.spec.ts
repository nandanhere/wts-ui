import { expect, test, type Page } from "@playwright/test";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Runs against the real wts-server from scripts/start-e2e-server.sh.
// That script points WTS at a fixture Raptik skill and a fake Codex CLI, so no agent or network is used.

async function seedMaterializedWorkspace(page: Page) {
  return page.evaluate(async () => {
    const bootstrap = (await (await fetch("/api/v1/bootstrap", { headers: { "X-WTS-Request": "local-ui" } })).json()) as { sessionToken: string };
    const headers = { Accept: "application/json", "Content-Type": "application/json", "X-WTS-Request": "local-ui", "X-WTS-Session": bootstrap.sessionToken };
    let repositories = await fetch("/api/v1/repositories", { headers });
    for (let attempt = 0; attempt < 20 && repositories.status === 429; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      repositories = await fetch("/api/v1/repositories", { headers });
    }
    if (!repositories.ok) throw new Error(await repositories.text());
    const catalog = (await repositories.json()) as { repositories: Array<{ id: string; label: string; defaultBranch: { name: string } }> };
    const storefront = catalog.repositories.find((repository) => repository.label === "storefront-ui");
    if (!storefront) throw new Error("The e2e server has no storefront-ui repository.");
    const created = await fetch("/api/v1/workspaces", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        intent: { type: "repositorySet", label: "Raptik review" },
        title: "Raptik review",
        preferredProvider: "codex",
        repositories: [{ repositoryId: storefront.id, label: storefront.label, baseRef: storefront.defaultBranch.name }],
      }),
    });
    if (!created.ok) throw new Error(await created.text());
    const workspaceId = ((await created.json()) as { workspace: { workspaceId: string } }).workspace.workspaceId;
    const preflight = await fetch(`/api/v1/workspaces/${workspaceId}/preflight`, { headers });
    if (!preflight.ok) throw new Error(await preflight.text());
    const { effectDigest } = (await preflight.json()) as { effectDigest: string };
    const materialized = await fetch(`/api/v1/workspaces/${workspaceId}/materialize`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ effectDigest }),
    });
    if (!materialized.ok) throw new Error(await materialized.text());
    const result = (await materialized.json()) as { materialization: { workspaceDisplayPath: string; worktrees: Array<{ targetDisplayPath: string; repositoryId: string }> } };
    return { workspaceId, workspacePath: result.materialization.workspaceDisplayPath, worktreePath: result.materialization.worktrees[0]!.targetDisplayPath };
  });
}

test("runs a Raptik AI review and shows its findings on the changed lines", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const seeded = await seedMaterializedWorkspace(page);

  await writeFile(
    join(seeded.worktreePath, "src", "checkout.js"),
    [
      "export function checkoutButtonLabel() {",
      "  return \"Place order\";",
      "}",
      "",
      "export function formatOrderTotal(order) {",
      "  return `$${Number(order.total).toFixed(2)} total`;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  await page.goto(`/sessions/${encodeURIComponent(seeded.workspaceId)}`);
  await page.getByRole("tab", { name: "Changes" }).click();
  const reviewScreen = page.getByTestId("repository-review-screen");
  await expect(reviewScreen.getByText("src/checkout.js").first()).toBeVisible({ timeout: 120_000 });

  await reviewScreen.getByRole("button", { name: "AI review" }).click();
  const card = page.getByRole("region", { name: "AI code review" });
  await expect(card.locator('[data-ui="verification.code-review-mode"]')).toHaveText("Raptik rules");
  await expect(card.getByRole("combobox", { name: "Code review skill" })).toContainText("Raptik rules");
  await expect(card.getByRole("combobox", { name: "Code review provider" })).toHaveText(/Codex/);
  await expect(card.getByRole("combobox", { name: "Code review model" })).toHaveText(/Default · gpt-e2e-review/);
  await expect(card.getByText("From ~/.codex/config.toml")).toBeVisible();
  await card.screenshot({ path: testInfo.outputPath("code-review-card-idle.png") });

  const runResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith(`/workspaces/${seeded.workspaceId}/code-review/run`));
  await card.getByRole("button", { name: "Review code" }).click();
  const trace = card.locator('[data-ui="verification.code-review-trace"]');
  await expect(trace.getByText("Codex reviews the changes")).toBeVisible({ timeout: 15_000 });
  const liveSteps = trace.getByRole("list", { name: "Agent steps" });
  await expect(liveSteps.getByText("rg -n total src/checkout.js").first()).toBeVisible({ timeout: 15_000 });
  await expect(liveSteps.getByText("Read the checkout diff first")).toBeVisible();
  await card.screenshot({ path: testInfo.outputPath("code-review-card-running.png") });
  const run = await runResponse;
  expect(run.ok(), await run.text()).toBe(true);
  const body = JSON.parse(run.request().postData() ?? "{}") as Record<string, unknown>;
  expect(body).toMatchObject({ provider: "codex", scope: "recentChanges" });
  expect(body.model).toBeUndefined();
  expect(typeof body.repositoryId).toBe("string");

  await expect(card.getByText("One Blocking item and one Nit.", { exact: false })).toBeVisible();
  await expect(card.getByText("1 Blocking")).toBeVisible();
  await expect(card.getByText("1 Nit")).toBeVisible();
  const activity = card.getByText(/Show agent activity \(\d+ steps\)/);
  await expect(activity).toBeVisible();
  await activity.click();
  await expect(card.getByRole("list", { name: "Agent steps" }).getByText("The total format can fail for a missing order.")).toBeVisible();

  const annotation = reviewScreen.getByRole("note", { name: "AI review: Blocking, A missing total shows NaN" });
  await expect(annotation).toBeVisible();
  await expect(annotation.getByText("Blocking: check that order.total is a number before you format it.", { exact: false })).toBeVisible();
  await expect(annotation.getByRole("link", { name: /Open the earlier comment/ })).toHaveAttribute(
    "href",
    "https://gitlab.example.test/sre-tools/storefront/-/merge_requests/7#note_42",
  );
  await expect(reviewScreen.getByRole("note", { name: "AI review: Nit, Move the label to a constant" })).toBeVisible();

  const panel = reviewScreen.getByRole("list", { name: "AI review findings" });
  await expect(panel.getByRole("listitem")).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("code-review-diff.png"), fullPage: false });

  const saved = JSON.parse(await readFile(join(seeded.workspacePath, ".wts", "code-review.json"), "utf8")) as {
    mode: string; outcome: string; findings: Array<{ anchored: boolean; label: string; line: number }>;
  };
  expect(saved).toMatchObject({ mode: "raptik", outcome: "reviewed" });
  expect(saved.findings.map((finding) => [finding.label, finding.line, finding.anchored])).toEqual([["blocking", 6, true], ["nit", 2, true]]);

  let recordFile = "";
  for (let directory = seeded.workspacePath; directory !== dirname(directory); directory = dirname(directory)) {
    const candidate = join(directory, "codex-review-args.txt");
    if (await access(candidate).then(() => true, () => false)) { recordFile = candidate; break; }
  }
  expect(recordFile, "The fake Codex CLI did not record its arguments.").not.toBe("");
  const args = (await readFile(recordFile, "utf8")).split("\n");
  expect(args.slice(0, 5)).toEqual(["exec", "--ephemeral", "--json", "--sandbox", "read-only"]);
  const prompt = args.slice(args.indexOf("--") + 1).join("\n");
  expect(prompt).toContain("E2E_RAPTIK_RULES");
  expect(prompt).toContain("E2E_RAPTIK_PLAYBOOK");
  expect(prompt).toContain("Number(order.total).toFixed(2)");

  await page.reload();
  await page.getByRole("tab", { name: "Changes" }).click();
  await expect(page.getByTestId("repository-review-screen").getByRole("note", { name: "AI review: Blocking, A missing total shows NaN" })).toBeVisible({ timeout: 60_000 });
});
