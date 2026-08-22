import { expect, test, type Locator, type Page } from "@playwright/test";

async function seedBoardWorkspaces(page: Page) {
  return page.evaluate(async () => {
    const bootstrapResponse = await fetch("/api/v1/bootstrap", {
      headers: { "X-WTS-Request": "local-ui" },
    });
    if (!bootstrapResponse.ok) throw new Error("WTS bootstrap failed.");
    const bootstrap = (await bootstrapResponse.json()) as {
      sessionToken: string;
    };
    const headers = {
      Accept: "application/json",
      "X-WTS-Request": "local-ui",
      "X-WTS-Session": bootstrap.sessionToken,
    };
    const repositoriesResponse = await fetch("/api/v1/repositories", {
      headers,
    });
    if (!repositoriesResponse.ok) {
      throw new Error("The repository list could not load.");
    }
    const catalog = (await repositoriesResponse.json()) as {
      repositories: Array<{
        id: string;
        label: string;
        defaultBranch: { name: string };
      }>;
    };
    const repository = catalog.repositories[0];
    if (!repository) throw new Error("The board test needs one repository.");

    const createWorkspace = async (title: string) => {
      const response = await fetch("/api/v1/workspaces", {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          intent: { type: "repositorySet", label: title },
          title,
          preferredProvider: "codex",
          repositories: [
            {
              repositoryId: repository.id,
              label: repository.label,
              baseRef: repository.defaultBranch.name,
            },
          ],
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      const created = (await response.json()) as {
        workspace: { workspaceId: string };
      };
      return created.workspace.workspaceId;
    };

    return [
      await createWorkspace("Board drag first"),
      await createWorkspace("Board drag second"),
    ];
  });
}

async function dragTo(
  page: Page,
  source: Locator,
  target: Locator,
  targetEdge: "center" | "bottom" = "center",
) {
  const handle = source.getByRole("button", { name: /^Drag workspace / });
  const sourceBox = await handle.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("The drag target is not visible.");
  const sourceX = sourceBox.x + sourceBox.width / 2;
  const sourceY = sourceBox.y + sourceBox.height / 2;
  const targetX = targetBox.x + targetBox.width / 2;
  const targetY =
    targetEdge === "bottom"
      ? targetBox.y + targetBox.height - 8
      : targetBox.y + targetBox.height / 2;
  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  await page.mouse.move(sourceX + 8, sourceY + 8, { steps: 2 });
  await expect(page.getByLabel("Workspace drop actions")).toBeVisible();
  await page.mouse.move(targetX, targetY, { steps: 10 });
  if (targetEdge === "bottom") {
    await expect(target).toHaveAttribute("data-drop-position", "after");
  } else {
    await expect(target).toHaveAttribute("data-drop-active", "true");
  }
  await page.waitForTimeout(100);
  await page.mouse.up();
}

async function dragBackToSource(
  page: Page,
  source: Locator,
  target: Locator,
) {
  const handle = source.getByRole("button", { name: /^Drag workspace / });
  const sourceBox = await handle.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("The drag target is not visible.");
  const sourcePoint = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2,
  };
  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  await page.mouse.down();
  await page.mouse.move(sourcePoint.x + 8, sourcePoint.y + 8, { steps: 2 });
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { steps: 8 },
  );
  await expect(target).toHaveAttribute("data-drop-position");
  await page.mouse.move(sourcePoint.x, sourcePoint.y, { steps: 8 });
  await expect(target).not.toHaveAttribute("data-drop-position");
  await page.mouse.up();
}

async function workspaceIds(lane: Locator) {
  return lane.locator("[data-workspace-id]").evaluateAll((cards) =>
    cards.map((card) => card.getAttribute("data-workspace-id")),
  );
}

async function seededWorkspaceIds(lane: Locator, ids: readonly string[]) {
  const all = await workspaceIds(lane);
  return all.filter((workspaceId): workspaceId is string =>
    Boolean(workspaceId && ids.includes(workspaceId)),
  );
}

function nextBoardPlacementRequest(page: Page) {
  return page.waitForRequest(
    (request) =>
      request.method() === "PATCH" &&
      /\/api\/v1\/workspaces\/[^/]+\/board-placement$/.test(request.url()),
  );
}

test("drags workspaces within a lane and into an empty lane", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/");
  const createdIds = await seedBoardWorkspaces(page);
  await page.reload();

  const board = page.getByRole("region", { name: "Local workspace board" });
  const ready = board.getByRole("region", { name: "Ready" });
  const active = board.getByRole("region", { name: "Active" });
  await expect
    .poll(() => seededWorkspaceIds(ready, createdIds))
    .toHaveLength(2);
  await expect
    .poll(() => seededWorkspaceIds(active, createdIds))
    .toHaveLength(0);

  const initialOrder = await seededWorkspaceIds(ready, createdIds);
  const source = ready.locator(
    `[data-workspace-id="${initialOrder[0]}"]`,
  );
  const target = ready.locator(
    `[data-workspace-id="${initialOrder[1]}"]`,
  );
  const placementRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "PATCH" &&
      request.url().endsWith("/board-placement")
    ) {
      placementRequests.push(request.url());
    }
  });
  await dragBackToSource(page, source, target);
  await page.waitForTimeout(150);
  expect(placementRequests).toHaveLength(0);
  expect(await seededWorkspaceIds(ready, createdIds)).toEqual(initialOrder);
  const reorderRequestPromise = nextBoardPlacementRequest(page);
  await dragTo(page, source, target, "bottom");
  const reorderRequest = await reorderRequestPromise;
  expect(reorderRequest.postDataJSON()).toMatchObject({
    state: "ready",
    afterWorkspaceId: initialOrder[1],
  });
  await expect
    .poll(() => seededWorkspaceIds(ready, createdIds))
    .toEqual([initialOrder[1], initialOrder[0]]);
  await expect(page.getByRole("heading", { name: "Spaces" })).toBeVisible();

  await page.reload();
  await expect
    .poll(() => seededWorkspaceIds(ready, createdIds))
    .toEqual([initialOrder[1], initialOrder[0]]);

  const moveRequestPromise = nextBoardPlacementRequest(page);
  await dragTo(
    page,
    ready.locator(`[data-workspace-id="${initialOrder[1]}"]`),
    active,
  );
  const moveRequest = await moveRequestPromise;
  expect(moveRequest.postDataJSON()).toMatchObject({ state: "active" });
  await expect
    .poll(() => seededWorkspaceIds(active, createdIds))
    .toEqual([initialOrder[1]]);
  await expect(seededWorkspaceIds(ready, createdIds)).resolves.toEqual([
    initialOrder[0],
  ]);
  await expect(page.getByRole("heading", { name: "Spaces" })).toBeVisible();
});

test("archives from the action shelf without reusing a prior card neighbor", async ({
  page,
}) => {
  await page.goto("/");
  const createdIds = await seedBoardWorkspaces(page);
  await page.reload();
  const board = page.getByRole("region", { name: "Local workspace board" });
  const ready = board.getByRole("region", { name: "Ready" });
  await expect
    .poll(() => seededWorkspaceIds(ready, createdIds))
    .toHaveLength(2);
  const initialOrder = await seededWorkspaceIds(ready, createdIds);
  const source = ready.locator(
    `[data-workspace-id="${initialOrder[0]}"]`,
  );
  const target = ready.locator(
    `[data-workspace-id="${initialOrder[1]}"]`,
  );
  const handle = source.getByRole("button", { name: /^Drag workspace / });
  const sourceBox = await handle.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("The drag target is not visible.");
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + 12, sourceBox.y + 12, { steps: 2 });
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { steps: 8 },
  );
  await expect(target).toHaveAttribute("data-drop-position");
  const archive = page.getByText("Move to Parked", { exact: true });
  const archiveBox = await archive.boundingBox();
  if (!archiveBox) throw new Error("The archive drop target is not visible.");
  const requestPromise = nextBoardPlacementRequest(page);
  await page.mouse.move(
    archiveBox.x + archiveBox.width / 2,
    archiveBox.y + archiveBox.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  const requestBody = (await requestPromise).postDataJSON();
  expect(requestBody).toEqual(
    expect.objectContaining({ state: "parked" }),
  );
  expect(requestBody).not.toHaveProperty("beforeWorkspaceId");
  expect(requestBody).not.toHaveProperty("afterWorkspaceId");
});

test("reorders a workspace from the keyboard drag handle", async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto("/");
  const createdIds = await seedBoardWorkspaces(page);
  await page.reload();

  const board = page.getByRole("region", { name: "Local workspace board" });
  const ready = board.getByRole("region", { name: "Ready" });
  await expect
    .poll(() => seededWorkspaceIds(ready, createdIds))
    .toHaveLength(2);
  const initialOrder = await seededWorkspaceIds(ready, createdIds);
  const source = ready.locator(
    `[data-workspace-id="${initialOrder[0]}"]`,
  );
  const handle = source.getByRole("button", { name: /^Drag workspace / });
  const requestPromise = nextBoardPlacementRequest(page);
  await handle.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  expect((await requestPromise).postDataJSON()).toMatchObject({ state: "ready" });
  await expect
    .poll(() => seededWorkspaceIds(ready, createdIds))
    .toEqual([initialOrder[1], initialOrder[0]]);
});

test("disables board placement while search hides workspaces", async ({
  page,
}) => {
  await page.goto("/");
  const createdIds = await seedBoardWorkspaces(page);
  await page.reload();

  await page.getByRole("button", { name: "Search spaces" }).click();
  await page
    .getByRole("searchbox", { name: "Search local workspaces" })
    .fill("Board drag first");
  const board = page.getByRole("region", { name: "Local workspace board" });
  const ready = board.getByRole("region", { name: "Ready" });
  const handle = ready
    .locator(`[data-workspace-id="${createdIds[0]}"]`)
    .getByRole("button", { name: "Drag workspace Board drag first" });
  await expect(handle).toBeDisabled();
});
