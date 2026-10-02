import { expect, test } from "@playwright/test";

const baseURL = "http://127.0.0.1:43210";

test("keeps 30 saved workspaces as one cheap, searchable portfolio", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);

  const bootstrapResponse = await request.get(`${baseURL}/api/v1/bootstrap`);
  expect(bootstrapResponse.ok()).toBeTruthy();
  const bootstrap = (await bootstrapResponse.json()) as {
    sessionToken: string;
  };

  for (let index = 0; index < 30; index += 1) {
    const ordinal = index + 1;
    const response = await request.post(`${baseURL}/api/v1/workspaces`, {
      data: {
        intent: {
          type: "repositorySet",
          label: `Scale set ${ordinal}`,
        },
        preferredProvider: "codex",
        repositories: [{ baseRef: "main", label: "storefront-ui" }],
        title: `Portfolio scale workspace ${ordinal}`,
      },
      headers: {
        "idempotency-key": globalThis.crypto.randomUUID(),
        origin: baseURL,
        "x-wts-request": "local-ui",
        "x-wts-session": bootstrap.sessionToken,
      },
    });
    expect(
      response.ok(),
      `workspace ${ordinal} failed with ${response.status()}: ${await response.text()}`,
    ).toBeTruthy();
  }

  const deepWorkspaceRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      path.includes("/materialization") ||
      path.includes("/evidence") ||
      path.includes("/test-runs")
    ) {
      deepWorkspaceRequests.push(path);
    }
  });

  await page.goto("/");

  const scaleCards = page.getByRole("button", {
    name: /^Open Scale set \d+: Portfolio scale workspace \d+$/,
  });
  await expect(scaleCards).toHaveCount(30);
  const firstCard = scaleCards.first();
  const firstCardShell = firstCard.locator("xpath=..");
  const laneCards = firstCardShell.locator("xpath=..");
  const laneGeometry = await laneCards.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(laneGeometry.scrollHeight).toBeGreaterThan(laneGeometry.clientHeight);

  await firstCard.hover();
  await page.mouse.wheel(0, 700);
  await expect
    .poll(() => laneCards.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);

  const stateEdge = await firstCardShell.evaluate((element) => {
    const style = getComputedStyle(element, "::before");
    return { backgroundColor: style.backgroundColor, width: style.width };
  });
  expect(stateEdge.width).toBe("3px");
  expect(stateEdge.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  await expect(
    page.getByRole("button", { name: /All workspaces 30/ }),
  ).toBeVisible();
  expect(deepWorkspaceRequests).toEqual([]);

  await page
    .getByRole("searchbox", { name: "Search local workspaces" })
    .fill("Scale set 30");
  await expect(
    page.getByRole("button", {
      name: "Open Scale set 30: Portfolio scale workspace 30",
    }),
  ).toBeVisible();
  await expect(scaleCards).toHaveCount(1);
  expect(deepWorkspaceRequests).toEqual([]);
});
