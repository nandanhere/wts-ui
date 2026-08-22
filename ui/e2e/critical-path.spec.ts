import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

test("creates, materializes, and verifies a multi-repository workspace", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto("/sessions/new");

  const create = page.getByRole("dialog", { name: "New workspace" });
  await expect(create).toBeVisible();
  await create
    .locator("label")
    .filter({ hasText: "Repository set" })
    .click();
  await create.getByRole("textbox", { name: "Repositories" }).fill(
    "shopfront-ui, orders-api",
  );
  await create.getByRole("button", { name: /Review repositories/i }).click();

  await expect(
    create.getByRole("checkbox", { name: "Include shopfront-ui" }),
  ).toBeChecked();
  await expect(
    create.getByRole("checkbox", { name: "Include orders-api" }),
  ).toBeChecked();
  const progress = create.getByRole("list", {
    name: "Workspace creation progress",
  });
  const progressSteps = progress.getByRole("listitem");
  const back = create.getByRole("button", { name: "Back" });
  const analyzeServices = create.getByRole("button", {
    name: /Analyze services/i,
  });

  await page.mouse.move(0, 0);
  await expect(create).toHaveClass(/portalSurface/);
  await expect(progressSteps.nth(0).locator("span").first()).toHaveCSS(
    "background-color",
    "rgb(21, 122, 85)",
  );
  await expect(progressSteps.nth(1).locator("span").first()).toHaveCSS(
    "background-color",
    "rgb(11, 99, 206)",
  );
  await expect(back).toHaveCSS(
    "border-top-color",
    "rgb(190, 200, 214)",
  );
  await expect(analyzeServices).toHaveCSS(
    "background-color",
    "rgb(11, 99, 206)",
  );

  await analyzeServices.click();
  const repositorySelectionChanged = create.getByText(
    "Repository selection changed",
  );
  const checkoutService = create.getByRole("checkbox", {
    name: /Include orders api in runtime plan/i,
  });
  const serviceAnalysisError = create.getByText(
    "Service analysis could not finish",
  );
  const planHeading = create.getByRole("heading", {
    name: "Workspace plan",
  });
  await expect(
    repositorySelectionChanged
      .or(checkoutService)
      .or(serviceAnalysisError)
      .or(planHeading),
  ).toBeVisible();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await checkoutService.isVisible() || await planHeading.isVisible()) {
      break;
    }
    if (await serviceAnalysisError.isVisible()) {
      await create.getByRole("button", { name: "Retry" }).click();
    }
    await expect(
      repositorySelectionChanged
        .or(checkoutService)
        .or(serviceAnalysisError)
        .or(planHeading),
    ).toBeVisible();
    if (await repositorySelectionChanged.isVisible()) {
      await analyzeServices.click();
    }
    await expect(
      checkoutService.or(serviceAnalysisError).or(planHeading),
    ).toBeVisible();
  }
  let servicesConfigured = false;
  if (await planHeading.isVisible()) {
    // Analysis may advance directly when the selected repositories have no
    // editable runtime choice.
  } else if (await checkoutService.isVisible()) {
    servicesConfigured = true;
    await expect(checkoutService).toBeChecked();
    await expect(create.getByText("cargo run", { exact: true })).toBeVisible();
    await create
      .getByRole("spinbutton", {
        name: /Preferred port for orders api api/i,
      })
      .fill("46100");
    const reviewPlan = create.getByRole("button", { name: /Review plan/i });
    await expect(reviewPlan).toBeEnabled();
    await reviewPlan.click();
  } else {
    await expect(serviceAnalysisError).toBeVisible();
    await create
      .getByRole("button", { name: "Continue without services" })
      .click();
  }
  await expect(
    planHeading,
  ).toBeVisible();
  if (servicesConfigured) {
    await expect(
      create.getByText(/orders api · api 46100 \(prefer\)/i),
    ).toBeVisible();
  }
  await create.getByRole("button", { name: /Save workspace plan/i }).click();
  const saved = page.getByRole("dialog", { name: "Workspace plan saved" });
  await expect(saved.getByRole("heading", { name: /is saved/i })).toBeVisible();
  await saved.getByRole("button", { name: /Open saved plan/i }).click();

  await expect(
    page.getByRole("heading", {
      name: "Turn this saved plan into isolated worktrees",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review setup" }).click();
  await expect(
    page.getByRole("table", { name: "Workspace creation effects" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create workspace" }).click();
  const workspaceFacts = page.getByRole("region", {
    name: "Workspace facts",
  });
  await expect(workspaceFacts).toBeVisible();
  await expect(
    workspaceFacts.getByText("2 created", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("LOCAL WORKSPACE READY", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: /worktrees created safely/i }),
  ).toHaveCount(0);
  await expect(
    page.getByText("LOCAL STATUS", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("table", { name: "Managed worktrees" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Workspace plan" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Open workspace in VS Code" }),
  ).toBeEnabled();

  await page.getByRole("tab", { name: "Verification" }).click();
  await expect(
    page.getByRole("heading", { name: "Not run" }),
  ).toBeVisible();
  await expect(page.getByText("shopfront-ui", { exact: true })).toBeVisible();
  await expect(page.getByText("orders-api", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run all" }).click();
  await expect(
    page.getByRole("heading", { name: "Passed" }),
  ).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("2 of 2 checks passed")).toBeVisible();

  await page
    .getByText("Coverage planning", { exact: true })
    .click();
  const planning = page.getByRole("region", {
    name: "Expand verification coverage",
  });
  await expect(planning).toBeVisible();
  await page
    .getByText("Agent-reported analysis", { exact: true })
    .click();
  const agentReport = page.getByRole("region", {
    name: "No agent findings yet",
  });
  await expect(agentReport).toBeVisible();
  await expect(
    agentReport.getByRole("button", { name: "Refresh findings" }),
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
  const checkoutRepository = context.repositories.find(
    (repository) => repository.label === "orders-api",
  );
  expect(checkoutRepository).toBeDefined();
  await writeFile(
    join(evidencePath, "agent-report.json"),
    `${JSON.stringify(
      {
        schemaVersion: context.schemaVersion,
        workspaceId: context.workspaceId,
        updatedAtUnixMs: Date.now(),
        summary:
          "The checkout API has a deterministic unit-test candidate and an idempotency validation flow.",
        findings: [
          {
            id: "orders-idempotency",
            title: "Orders retries need deterministic coverage",
            detail:
              "The repository already owns a bounded Cargo test command for this behavior.",
            severity: "info",
            repositoryId: checkoutRepository!.repositoryId,
            evidence: ["orders-api/Cargo.toml:1"],
          },
        ],
        nextActions: [
          "Review the proposed Cargo check before adding it to the WTS-owned plan.",
        ],
        proposedChecks: [
          {
            id: "orders-agent-cargo",
            label: "Agent-proposed checkout tests",
            kind: "unit",
            repositoryId: checkoutRepository!.repositoryId,
            workingDirectory: checkoutRepository!.worktreeDisplayPath,
            executable: "cargo",
            args: ["test", "--quiet"],
            timeoutMs: 120_000,
            environmentNames: ["CI"],
            reason:
              "The checkout behavior is implemented and tested in this Rust crate.",
            evidence: ["orders-api/Cargo.toml:1"],
          },
        ],
        validationFlows: [
          {
            id: "orders-idempotency-flow",
            title: "Repeat a checkout request",
            goal: "Confirm retries do not create a second checkout result.",
            prerequisites: ["A checkout request fixture."],
            steps: [
              {
                id: "submit-twice",
                action: "Submit the same checkout request twice.",
                expected: "The second request returns the original result.",
                evidence: ["orders-api/src/lib.rs:1"],
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
  await agentReport
    .getByRole("button", { name: "Refresh findings" })
    .click();
  const reported = page.getByRole("region", { name: "Agent findings" });
  await expect(reported).toBeVisible();
  await reported.getByRole("tab", { name: /Findings/ }).click();
  await expect(
    reported.getByText("Orders retries need deterministic coverage"),
  ).toBeVisible();
  await reported.getByRole("tab", { name: /Coverage/ }).click();
  await expect(
    reported.getByText("cargo test --quiet", { exact: true }),
  ).toBeVisible();
  await reported.getByRole("tab", { name: /Flows/ }).click();
  await reported.getByText("Repeat a checkout request").click();
  await expect(
    reported.getByText(
      "Expected: The second request returns the original result.",
    ),
  ).toBeVisible();
  const promotionResponse = page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === "POST" &&
      new URL(response.url()).pathname.endsWith(
        "/verification/agent-proposals/orders-agent-cargo/promote",
      )
    );
  });
  await reported.getByRole("tab", { name: /Coverage/ }).click();
  await reported
    .getByRole("button", { name: "Add to verification" })
    .click();
  expect((await promotionResponse).ok()).toBe(true);
  await expect(
    reported.getByRole("button", { name: "Added to plan" }),
  ).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Not run" })).toBeVisible();
  await page.getByRole("button", { name: "Run all" }).click();
  await expect(
    page.getByRole("heading", { name: "Passed" }),
  ).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("3 of 3 checks passed")).toBeVisible();
  await expect(
    page.getByRole("region", {
      name: "Test the workflow a user sees",
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: "Add a supported verification check",
    }),
  ).toHaveCount(0);
  const graphIndexResponse = page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/graph/index")
    );
  });
  await planning.getByRole("button", { name: "Build graph" }).click();
  expect((await graphIndexResponse).ok()).toBe(true);
  await planning
    .getByRole("button", { name: "Prepare verification brief" })
    .click();
  await expect(
    page.getByRole("tab", { name: "CLI" }),
  ).toHaveAttribute("aria-selected", "true");
  const cli = page.getByRole("region", {
    name: /Start an agent in/i,
  });
  await expect(cli).toBeVisible();
  await expect(
    cli.getByRole("group", { name: "Open workspace with" }),
  ).toBeVisible();
  await expect(
    cli.getByRole("group", { name: "Terminal application" }),
  ).toBeVisible();
  await expect(cli.getByText("WHAT WTS DOES", { exact: true })).toHaveCount(0);
  await expect(
    cli.getByText(/foreground session, not a hidden job/i),
  ).toHaveCount(0);
  await expect(page.getByLabel("Prepared CLI task")).toContainText(
    /Read graphify-out\/graph\.json/,
  );
  await expect(page.getByLabel("Prepared CLI task")).toContainText(
    /Do not execute the proposal/,
  );
  await expect(page.getByLabel("Prepared CLI task")).toContainText(
    /\.wts\/agent-report\.json/,
  );
  await expect(
    cli.getByRole("button", { name: "Open Codex with WTS.md" }),
  ).toBeVisible();
  await expect(
    cli.getByRole("button", { name: "Open workspace in VS Code" }),
  ).toBeVisible();
  await expect(
    cli.getByText(/WTS\.md is ready/i),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Verification CLI handoff steps" }),
  ).toHaveCount(0);
});

test("keeps help and environment diagnostics discoverable without stacking dialogs", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Open How to use WTS" }).click();
  const guide = page.getByRole("dialog", { name: "How to use WTS" });
  await expect(guide).toBeVisible();
  await expect(guide.getByText("The working loop")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(guide).toBeHidden();

  await page
    .getByRole("button", {
      name: "Open Environment and integrations",
      exact: true,
    })
    .click();
  const environment = page.getByRole("dialog", {
    name: "Environment & integrations",
  });
  await expect(environment).toBeVisible();
  await expect(
    environment.getByRole("tab", { name: /^Repositories/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "How to use WTS" }),
  ).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(environment).toBeHidden();
});
