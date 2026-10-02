import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

test("uses WTS to create and verify a workspace for WTS", async ({ page }) => {
  test.setTimeout(15 * 60_000);

  const globalSessionsResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().endsWith("/api/v1/agent-sessions"),
  );
  const activityWatchResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("/api/v1/integrations/activity-watch/status"),
  );
  await page.goto("/time");
  expect((await globalSessionsResponse).ok()).toBe(true);
  expect((await activityWatchResponse).ok()).toBe(true);
  await expect(
    page.getByRole("heading", { name: "Agent sessions" }),
  ).toBeVisible();
  await expect(
    page.getByText("No WTS-managed agent sessions yet."),
  ).toBeVisible();
  await expect(page.getByText("Not measured yet")).toBeVisible();

  await page.goto("/sessions/new");

  const create = page.getByRole("dialog", { name: "New workspace" });
  await create
    .locator("label")
    .filter({ hasText: "Repository set" })
    .click();
  await create
    .getByRole("textbox", { name: "Repositories" })
    .fill("wts-ui");
  await create.getByRole("button", { name: /Review repositories/i }).click();
  await expect(
    create.getByRole("checkbox", { name: "Include wts-ui" }),
  ).toBeChecked();
  await expect(create.getByText("Matched locally", { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  const planHeading = create.getByRole("heading", { name: "Workspace plan" });
  const reviewPlan = create.getByRole("button", { name: /Review plan/i });
  const [runtimeAnalysisResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/v1/workspace-plans/runtime-analysis"),
      { timeout: 120_000 },
    ),
    create.getByRole("button", { name: /Analyze services/i }).click(),
  ]);
  expect(runtimeAnalysisResponse.ok()).toBe(true);
  const analysisReady = create.getByText("Analysis ready", { exact: true });
  await expect
    .poll(
      async () =>
        (await planHeading.isVisible()) ||
        (await analysisReady.isVisible()) ||
        ((await reviewPlan.isVisible()) && (await reviewPlan.isEnabled())),
      { timeout: 120_000 },
    )
    .toBe(true);
  if (await reviewPlan.isVisible()) {
    const runtimeChecks = create.getByRole("checkbox", {
      name: /Include .* in runtime plan/i,
    });
    for (let index = 0; index < (await runtimeChecks.count()); index += 1) {
      const runtimeCheck = runtimeChecks.nth(index);
      if (await runtimeCheck.isChecked()) {
        await runtimeCheck.locator("xpath=ancestor::label").click();
        await expect(runtimeCheck).not.toBeChecked();
      }
    }
    await expect(reviewPlan).toBeEnabled();
    await reviewPlan.click();
  }
  await expect(planHeading).toBeVisible();
  await create.getByRole("button", { name: /Save workspace plan/i }).click();
  const saved = page.getByRole("dialog", { name: "Workspace plan saved" });
  await saved.getByRole("button", { name: /Open saved plan/i }).click();

  await page.getByRole("button", { name: "Review setup" }).click();
  await expect(
    page.getByRole("table", { name: "Workspace creation effects" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create workspace" }).click();
  const workspaceFacts = page.getByRole("region", {
    name: "Workspace facts",
  });
  await expect(workspaceFacts.getByText("1 created", { exact: true })).toBeVisible(
    { timeout: 120_000 },
  );

  await page.getByRole("tab", { name: "Verification" }).click();
  await expect(
    page.getByRole("region", { name: "No agent findings yet" }),
  ).toBeVisible();
  const evidencePath = await page
    .getByText("Evidence stays local at")
    .locator("code")
    .innerText();
  const context = JSON.parse(
    await readFile(join(evidencePath, "context.json"), "utf8"),
  ) as {
    schemaVersion: number;
    workspaceId: string;
    repositories: Array<{
      repositoryId: string;
      label: string;
      worktreeDisplayPath: string;
    }>;
  };
  const repository = context.repositories.find(
    (candidate) => candidate.label === "wts-ui",
  );
  expect(repository).toBeDefined();

  await writeFile(
    join(evidencePath, "agent-report.json"),
    `${JSON.stringify(
      {
        schemaVersion: context.schemaVersion,
        workspaceId: context.workspaceId,
        updatedAtUnixMs: Date.now(),
        summary:
          "WTS can use its own verification contract to improve and validate WTS.",
        scope: {
          coverage: "complete",
          graphStatus: "notStarted",
          reviewedRepositoryIds: [repository!.repositoryId],
          unresolvedRepositoryIds: [],
          skippedRepositories: [],
        },
        flows: [
          {
            id: "wts-self-host-improvement",
            title: "WTS improves and verifies WTS",
            kind: "user",
            actors: ["WTS developer"],
            entryPoints: ["Verification tab"],
            steps: [
              {
                id: "publish-flow-report",
                repositoryId: repository!.repositoryId,
                component: "Agent report inbox",
                action:
                  "Publish a repository-accounted flow report through the trusted helper.",
                evidence: [
                  {
                    repositoryId: repository!.repositoryId,
                    path: "crates/wts-app/src/evidence.rs",
                    line: 85,
                  },
                ],
              },
              {
                id: "promote-check",
                repositoryId: repository!.repositoryId,
                component: "Verification plan",
                action:
                  "Promote a reviewed candidate into a WTS-owned plan revision.",
                evidence: [
                  {
                    repositoryId: repository!.repositoryId,
                    path: "crates/wts-app/src/service.rs",
                    line: 1191,
                  },
                ],
              },
            ],
            expectedOutcome:
              "The developer sees the mapped flow, promotes its check, and receives a trusted run result.",
            risks: [
              "An unscoped report could imply broader coverage than the agent performed.",
            ],
            existingCoverage: ["Real Rust host and browser critical path"],
            verificationCandidateIds: ["wts-agent-rust-suite"],
          },
        ],
        findings: [
          {
            id: "self-host-verification-contract",
            title: "Keep the agent-to-verification handoff covered",
            detail:
              "The WTS Rust workspace owns the trusted evidence and promotion boundary.",
            severity: "info",
            repositoryId: repository!.repositoryId,
            evidence: ["crates/wts-app/src/service.rs:1191"],
            flowIds: ["wts-self-host-improvement"],
          },
        ],
        nextActions: [
          "Promote the bounded JavaScript contract suite and inspect its persisted result.",
        ],
        proposedChecks: [
          {
            id: "wts-agent-rust-suite",
            label: "Agent-proposed WTS JavaScript contract suite",
            kind: "integration",
            repositoryId: repository!.repositoryId,
            workingDirectory: repository!.worktreeDisplayPath,
            executable: "npm",
            args: ["test", "--silent"],
            timeoutMs: 15 * 60_000,
            environmentNames: ["CI"],
            reason:
              "The repository's JavaScript contract tests exercise WTS adapters and workspace flows.",
            evidence: [
              "crates/wts-app/src/evidence.rs:85",
              "crates/wts-app/src/service.rs:1191",
            ],
          },
        ],
        validationFlows: [
          {
            id: "wts-self-host-flow",
            title: "WTS improves WTS",
            goal:
              "Create an isolated WTS worktree, receive an agent proposal, and convert it into trusted evidence.",
            prerequisites: ["A materialized workspace for the wts-ui repository."],
            steps: [
              {
                id: "publish",
                action: "Publish the bounded agent report.",
                expected: "Verification labels it agent-reported and unverified.",
                evidence: [".wts/agent-report.json"],
              },
              {
                id: "promote",
                action: "Promote the reviewed JavaScript test proposal.",
                expected:
                  "WTS creates a new plan revision without running the command.",
                evidence: [".wts/verification-plan.json"],
              },
              {
                id: "run",
                action: "Run the WTS-owned verification plan.",
                expected: "The promoted Rust check persists a trusted result.",
                evidence: [".wts/verification-result.json"],
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const emptyReport = page.getByRole("region", {
    name: "No agent findings yet",
  });
  await emptyReport
    .getByRole("button", { name: "Refresh findings" })
    .click();
  const report = page.getByRole("region", { name: "Workspace flow map" });
  await expect(
    report.getByText("WTS improves and verifies WTS"),
  ).toBeVisible();
  await expect(
    report.getByLabel("Workspace analysis coverage"),
  ).toContainText("complete · 1/1 reviewed");
  await report.getByRole("tab", { name: /^Coverage \d+$/ }).click();
  await expect(report.getByText("Repository accounting")).toBeVisible();
  await expect(
    report.getByText("npm test --silent", { exact: true }),
  ).toBeVisible();
  await report.getByRole("button", { name: "Add to verification" }).click();
  await expect(
    report.getByRole("button", { name: "Added to plan" }),
  ).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Not run" })).toBeVisible();

  await page.getByRole("button", { name: "Run all" }).click();
  const promotedCheck = page
    .locator("details")
    .filter({ hasText: "Agent-proposed WTS JavaScript contract suite" });
  await expect(promotedCheck.getByText("Passed", { exact: true })).toBeVisible({
    timeout: 12 * 60_000,
  });

  const result = JSON.parse(
    await readFile(join(evidencePath, "verification-result.json"), "utf8"),
  ) as {
    planRevision: number;
    status: string;
    checks: Array<{ checkId: string; status: string }>;
  };
  expect(result.planRevision).toBeGreaterThan(1);
  expect(result.status).toBe("passed");
  expect(result.checks).toHaveLength(3);
  expect(result.checks.every((check) => check.status === "passed")).toBe(true);
  expect(result.checks).toContainEqual(
    expect.objectContaining({
      checkId: "agent-wts-agent-rust-suite",
      status: "passed",
    }),
  );
});
