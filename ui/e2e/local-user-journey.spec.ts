import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

test.describe.configure({ mode: "serial" });

function apiResponse(
  page: Page,
  method: "GET" | "POST",
  pathname: string | RegExp,
) {
  return page.waitForResponse((response) => {
    const request = response.request();
    const foundPath = new URL(response.url()).pathname;
    return (
      request.method() === method &&
      (typeof pathname === "string"
        ? foundPath === pathname
        : pathname.test(foundPath))
    );
  });
}

async function successfulJson<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

test("keeps the application chrome operable at 320 pixels", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Open Spaces" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open Environment and integrations" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "Open command palette" }).click();
  await expect(page.getByRole("dialog", { name: "Commands" })).toBeVisible();
});

test("keeps the app-shell self-test out of workspace verification", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const bootstrapResponse = apiResponse(page, "GET", "/api/v1/bootstrap");
  await page.goto("/sessions/new");
  const bootstrap = await successfulJson<{
    apiVersion: string;
    origin: string;
    sessionToken: string;
  }>(await bootstrapResponse);
  expect(bootstrap).toMatchObject({
    apiVersion: "v1",
    origin: new URL(page.url()).origin,
  });
  expect(bootstrap.sessionToken).not.toHaveLength(0);

  const create = page.getByRole("dialog", { name: "New workspace" });
  await expect(create).toBeVisible();
  await create
    .getByText("Choose local repositories directly", { exact: true })
    .click();
  const repositoryPicker = create.getByRole("combobox", {
    name: "Repository to add",
  });
  await expect(repositoryPicker).toBeEnabled();
  await repositoryPicker.click();
  await page.getByRole("option", { name: /^storefront-ui ·/ }).click();
  await create.getByRole("button", { name: "Add repository" }).click();
  await create.getByRole("button", { name: /Review repositories/i }).click();
  await expect(
    create.getByRole("checkbox", { name: "Include storefront-ui" }),
  ).toBeChecked();
  await expect(
    create.getByRole("checkbox", { name: "Include checkout-api" }),
  ).toHaveCount(0);
  const analyzeServices = create.getByRole("button", {
    name: /Analyze services/i,
  });
  await analyzeServices.click();
  const repositorySelectionChanged = create.getByText(
    "Repository selection changed",
  );
  const noRunnableServices = create.getByRole("heading", { name: "No services to configure" });
  const serviceAnalysisError = create.getByText(
    "Service analysis could not finish",
  );
  const planHeading = create.getByRole("heading", {
    name: "Does this plan match the task?",
  });
  await expect(
    repositorySelectionChanged.or(noRunnableServices).or(serviceAnalysisError),
  ).toBeVisible();
  if (await repositorySelectionChanged.isVisible()) {
    await analyzeServices.click();
  }
  await expect(
    noRunnableServices.or(serviceAnalysisError).or(planHeading),
  ).toBeVisible();
  if (await planHeading.isVisible()) {
    // A zero-service analysis may advance directly to the plan.
  } else if (await serviceAnalysisError.isVisible()) {
    await create
      .getByRole("button", { name: "Continue without services" })
      .click();
  } else {
    await expect(noRunnableServices).toBeVisible();
    await create.getByRole("button", { name: /Review plan/i }).click();
  }
  await expect(planHeading).toBeVisible();

  const createWorkspaceResponse = apiResponse(
    page,
    "POST",
    "/api/v1/workspaces",
  );
  await create.getByRole("button", { name: /Save workspace plan/i }).click();
  const created = await successfulJson<{
    workspace: { workspaceId: string; repositories: unknown[] };
    replayed: boolean;
  }>(await createWorkspaceResponse);
  expect(created.replayed).toBe(false);
  expect(created.workspace.repositories).toHaveLength(1);

  const saved = page.getByRole("dialog", { name: "Workspace plan saved" });
  await expect(saved.getByRole("heading", { name: /is saved/i })).toBeVisible();
  await saved.getByRole("button", { name: /Open saved plan/i }).click();
  await expect(
    page.getByRole("heading", {
      name: "Turn this saved plan into isolated worktrees",
    }),
  ).toBeVisible();

  const preflightResponse = apiResponse(
    page,
    "GET",
    `/api/v1/workspaces/${created.workspace.workspaceId}/preflight`,
  );
  await page.getByRole("button", { name: "Review setup" }).click();
  const preflight = await successfulJson<{
    workspaceId: string;
    ready: boolean;
    effectDigest: string;
    repositories: unknown[];
  }>(await preflightResponse);
  expect(preflight).toMatchObject({
    workspaceId: created.workspace.workspaceId,
    ready: true,
  });
  expect(preflight.effectDigest).not.toHaveLength(0);
  expect(preflight.repositories).toHaveLength(1);
  await expect(
    page.getByRole("table", { name: "Workspace creation effects" }),
  ).toBeVisible();

  const materializeResponse = apiResponse(
    page,
    "POST",
    `/api/v1/workspaces/${created.workspace.workspaceId}/materialize`,
  );
  await page
    .getByRole("tabpanel", { name: "Workspace" })
    .getByRole("button", { name: "Create workspace" })
    .click();
  const materialized = await successfulJson<{
    replayed: boolean;
    materialization: {
      workspaceId: string;
      worktrees: Array<{ targetDisplayPath: string }>;
    };
  }>(await materializeResponse);
  expect(materialized.replayed).toBe(false);
  expect(materialized.materialization.workspaceId).toBe(
    created.workspace.workspaceId,
  );
  expect(materialized.materialization.worktrees).toHaveLength(1);
  const workspaceFacts = page.getByRole("region", {
    name: "Workspace facts",
  });
  await expect(workspaceFacts).toBeVisible();
  await expect(
    workspaceFacts.getByText("1 created", { exact: true }),
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

  const reviewLines = Array.from(
    { length: 80 },
    (_, line) => `export const reviewLine${line + 1} = ${line + 1};`,
  ).join("\n");
  await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      writeFile(
        join(
          materialized.materialization.worktrees[0]!.targetDisplayPath,
          "src",
          `review-${index + 1}.js`,
        ),
        `${reviewLines}\n`,
        "utf8",
      ),
    ),
  );

  await page.setViewportSize({ width: 2048, height: 997 });
  const evidenceRoute = `**/api/v1/workspaces/${created.workspace.workspaceId}/evidence`;
  await page.route(evidenceRoute, async (route) => {
    const response = await route.fetch();
    const evidence = (await response.json()) as {
      agentReport: Record<string, unknown>;
    };
    await route.fulfill({
      response,
      json: {
        ...evidence,
        agentReport: {
          ...evidence.agentReport,
          status: "ready",
          summary:
            "Review the request boundary before the formatting changes.",
          nextActions: [
            "Review the request boundary first.",
            "Confirm the fallback behavior.",
            "Review the formatting changes last.",
          ],
          findings: [
            {
              id: "request-boundary",
              title: "The request boundary needs review",
              detail: "Confirm the behavior before approval.",
              severity: "warning",
              repositoryId:
                materialized.materialization.worktrees[0]!.repositoryId,
              evidence: ["src/review-1.js:1"],
            },
          ],
        },
      },
    });
  });

  await page.getByRole("tab", { name: "Changes" }).click();
  const reviewScreen = page.getByTestId("repository-review-screen");
  const reviewToolbar = reviewScreen.getByTestId("repository-review-toolbar");
  const reportedRisk = reviewToolbar.getByLabel("1 reported risk");
  const changeNavigator = reviewScreen.getByLabel("Navigate changes");
  const reviewScroller = reviewScreen.getByTestId("patch-review-scroll");
  const nextChange = changeNavigator.getByRole("button", {
    name: "Next change",
  });
  await expect(changeNavigator.getByText("6 changes")).toBeVisible({
    timeout: 120_000,
  });
  await expect(reportedRisk).toBeVisible();
  await expect(reportedRisk).toHaveAttribute(
    "title", "Review the request boundary before the formatting changes.",
  );
  await expect(reviewScreen.getByRole("region", { name: "Agent review brief" })).toHaveCount(0);
  await expect(
    reviewScreen.getByText("Review the request boundary first."),
  ).toHaveCount(0);

  const readCompactGeometry = () =>
    reviewScreen.evaluate((screenElement) => {
      const toolbarElement = screenElement.querySelector<HTMLElement>(
        '[data-testid="repository-review-toolbar"]',
      );
      const scrollElement = screenElement.querySelector<HTMLElement>(
        '[data-testid="patch-review-scroll"]',
      );
      const firstDiffBody = screenElement.querySelector<HTMLElement>(
        '[id^="diff-body-"]',
      );
      if (!toolbarElement || !scrollElement || !firstDiffBody) {
        throw new Error("The compact change review surfaces are incomplete.");
      }
      const screenRect = screenElement.getBoundingClientRect();
      return {
        toolbarHeight: toolbarElement.getBoundingClientRect().height,
        firstCodeTop: firstDiffBody.getBoundingClientRect().top,
        screenHeight: screenRect.height,
        scrollHeight: scrollElement.getBoundingClientRect().height,
        viewportHeight: window.innerHeight,
      };
    });
  const compactGeometry = await readCompactGeometry();
  expect(compactGeometry.toolbarHeight).toBeLessThanOrEqual(60);
  expect(compactGeometry.firstCodeTop).toBeLessThan(
    compactGeometry.viewportHeight / 2,
  );
  expect(compactGeometry.scrollHeight).toBeGreaterThanOrEqual(
    compactGeometry.screenHeight * 0.65,
  );

  await page.setViewportSize({ width: 1280, height: 720 });
  const shortGeometry = await readCompactGeometry();
  expect(shortGeometry.toolbarHeight).toBeLessThanOrEqual(60);
  expect(shortGeometry.firstCodeTop).toBeLessThan(
    shortGeometry.viewportHeight * 0.62,
  );
  expect(shortGeometry.scrollHeight).toBeGreaterThanOrEqual(
    shortGeometry.screenHeight * 0.6,
  );
  await page.setViewportSize({ width: 2048, height: 997 });

  for (let change = 1; change <= 6; change += 1) {
    await nextChange.click();
    await expect(changeNavigator.getByText(`${change}/6`)).toBeVisible();
    const geometry = await reviewScreen.evaluate((screenElement) => {
      const navigatorElement = screenElement.querySelector<HTMLElement>(
        '[aria-label="Navigate changes"]',
      );
      const scrollElement = screenElement.querySelector<HTMLElement>(
        '[data-testid="patch-review-scroll"]',
      );
      const tabPanel = screenElement.parentElement;
      const tabViewport = tabPanel?.parentElement;
      if (!navigatorElement || !scrollElement || !tabPanel || !tabViewport) {
        throw new Error("The change review scroll surfaces are incomplete.");
      }
      const navigatorRect = navigatorElement.getBoundingClientRect();
      return {
        documentScrollTop: document.documentElement.scrollTop,
        innerScrollTop: scrollElement.scrollTop,
        navigatorBottom: navigatorRect.bottom,
        navigatorTop: navigatorRect.top,
        outerScrollTop: tabViewport.scrollTop,
        viewportHeight: window.innerHeight,
      };
    });
    expect(geometry.navigatorTop).toBeGreaterThanOrEqual(0);
    expect(geometry.navigatorBottom).toBeLessThanOrEqual(
      geometry.viewportHeight,
    );
    expect(geometry.outerScrollTop).toBe(0);
    expect(geometry.documentScrollTop).toBe(0);
  }

  await expect.poll(() => reviewScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(nextChange).toBeVisible();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(changeNavigator.getByText("5/6")).toBeVisible();

  await page.unroute(evidenceRoute);
  await page.getByRole("tab", { name: "Verify", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Not run" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run all" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("group").filter({
      hasText: /storefront-ui · UI tests/i,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Add a supported verification check",
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", {
      name: "Test the workflow a user sees",
    }),
  ).toHaveCount(0);

  await page.getByText("Improve coverage", { exact: true }).click();
  const graphPlanning = page.getByRole("region", {
    name: "Find gaps in verification",
  });
  await expect(graphPlanning).toBeVisible();
  await expect(
    graphPlanning.getByText(/build a repository graph before asking an agent/i),
  ).toBeVisible();
  const graphIndexResponse = apiResponse(
    page,
    "POST",
    `/api/v1/workspaces/${created.workspace.workspaceId}/graph/index`,
  );
  await page.getByText("Evidence and history", { exact: true }).click();
  const agentReport = page.getByRole("region", {
    name: "No agent findings yet",
  });
  await expect(agentReport).toBeVisible();
  await expect(
    agentReport.getByRole("button", { name: "Refresh findings" }),
  ).toBeVisible();
  await graphPlanning.getByRole("button", { name: "Build graph" }).click();
  const graphIndex = await successfulJson<{
    workspaceId: string;
    status: string;
  }>(await graphIndexResponse);
  expect(graphIndex).toMatchObject({
    workspaceId: created.workspace.workspaceId,
    status: "ready",
  });

  await expect(
    graphPlanning.getByRole("button", {
      name: "Prepare verification brief",
    }),
  ).toBeVisible({ timeout: 120_000 });
  await graphPlanning
    .getByRole("button", { name: "Prepare verification brief" })
    .click();
  const preparedBrief = page.getByRole("region", {
    name: "Verification brief ready",
  });
  await expect(preparedBrief).toBeVisible();
  await preparedBrief
    .getByText("Review prepared brief", { exact: true })
    .click();
  const preparedTask = preparedBrief.getByLabel("Prepared verification brief");
  await expect(preparedTask).toBeVisible();
  await expect(
    preparedTask,
  ).toContainText(
    /Do not assume WTS Help, WTS Preferences/,
  );
  await expect(preparedTask).toContainText(
    /Do not run project commands, modify repository files/,
  );
  await expect(preparedTask).toContainText(
    /wts-report --input/,
  );
  await expect(
    preparedBrief.getByRole("button", { name: "Open Codex with brief" }),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Verification CLI handoff steps" }),
  ).toHaveCount(0);
});
