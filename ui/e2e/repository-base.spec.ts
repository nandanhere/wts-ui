import { expect, test } from "@playwright/test";

const commitOid = "a".repeat(40);

test("hands selected bases to trusted GitHub and GitLab remotes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 500, height: 800 });

  await page.route("**/api/v1/repositories", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify({
        repositoryRootDisplayPath: "~/repos",
        repositories: [
          {
            id: "repo_github",
            label: "prov-agent",
            checkoutLeaf: "prov-agent",
            displayPath: "~/repos/prov-agent",
            originUrl: "https://github.com/acme/prov-agent.git",
            defaultBranch: {
              name: "main",
              fullRef: "refs/remotes/origin/main",
              commitOid,
            },
          },
          {
            id: "repo_gitlab",
            label: "senzu",
            checkoutLeaf: "senzu",
            displayPath: "~/repos/senzu",
            originUrl: "git@gitlab.example.com:infra/senzu.git",
            defaultBranch: {
              name: "main",
              fullRef: "refs/remotes/origin/main",
              commitOid,
            },
          },
          {
            id: "repo_internal",
            label: "asset-status",
            checkoutLeaf: "asset-status",
            displayPath: "~/repos/asset-status",
            originUrl: "ssh://code.example.com/infra/asset-status.git",
            defaultBranch: {
              name: "main",
              fullRef: "refs/remotes/origin/main",
              commitOid,
            },
          },
        ],
        skippedEntries: 0,
      }),
    });
  });

  await page.route("**/api/v1/code-workspaces/import", async (route) => {
    expect(route.request().method()).toBe("POST");
    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify({
        importId: "0198-0188-forge-e2e",
        fileName: "infra.code-workspace",
        suggestedTitle: "Infra",
        suggestedRepositorySetLabel: "VS Code · infra",
        folders: [
          {
            name: "prov-agent",
            rawPath: "../prov-agent",
            status: "matched",
            repositoryId: "repo_github",
            repositoryLabel: "prov-agent",
            repositoryDisplayPath: "~/repos/prov-agent",
            baseRef: "main",
          },
          {
            name: "senzu",
            rawPath: "../senzu",
            status: "matched",
            repositoryId: "repo_gitlab",
            repositoryLabel: "senzu",
            repositoryDisplayPath: "~/repos/senzu",
            baseRef: "feat/USB-NIC-visibility",
          },
          {
            name: "asset-status",
            rawPath: "../asset-status",
            status: "matched",
            repositoryId: "repo_internal",
            repositoryLabel: "asset-status",
            repositoryDisplayPath: "~/repos/asset-status",
            baseRef: "main",
          },
        ],
        repositories: [
          {
            repositoryId: "repo_github",
            label: "prov-agent",
            baseRef: "main",
          },
          {
            repositoryId: "repo_gitlab",
            label: "senzu",
            baseRef: "feat/USB-NIC-visibility",
          },
          {
            repositoryId: "repo_internal",
            label: "asset-status",
            baseRef: "main",
          },
        ],
        warnings: [],
      }),
    });
  });

  let handoff:
    | {
        repositoryId: string;
        baseRef: string;
      }
    | undefined;
  await page.route(
    /\/api\/v1\/repositories\/([^/]+)\/open\/base$/,
    async (route) => {
      const match = new URL(route.request().url()).pathname.match(
        /\/api\/v1\/repositories\/([^/]+)\/open\/base$/,
      );
      const body = route.request().postDataJSON() as { baseRef: string };
      handoff = {
        repositoryId: decodeURIComponent(match?.[1] ?? ""),
        baseRef: body.baseRef,
      };
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({
          repositoryId: handoff.repositoryId,
          forge: "github",
          host: "github.com",
          baseRef: handoff.baseRef,
          commitOid,
          accepted: true,
        }),
      });
    },
  );

  await page.goto("/sessions/new");
  const create = page.getByRole("dialog", { name: "New workspace" });
  await expect(create).toBeVisible();
  await create
    .locator("label")
    .filter({ hasText: "VS Code workspace file" })
    .click();
  await create
    .locator('input[type="file"][accept*=".code-workspace"]')
    .setInputFiles({
      name: "infra.code-workspace",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          folders: [
            { path: "../prov-agent" },
            { path: "../senzu" },
            { path: "../asset-status" },
          ],
        }),
      ),
    });
  await expect(
    create.getByText("Imported 3 repositories from infra.code-workspace."),
  ).toBeVisible();
  await create
    .getByRole("button", { name: /Review imported repositories/i })
    .click();

  const githubBase = create.getByRole("combobox", {
    name: "Base branch for prov-agent [repo_github]",
  });
  await githubBase.selectOption("release/2026.07");

  const githubAction = create.getByRole("button", {
    name: "Open prov-agent base release/2026.07 on GitHub (github.com) in browser",
  });
  const gitlabAction = create.getByRole("button", {
    name: "Open senzu base feat/USB-NIC-visibility on GitLab (gitlab.example.com) in browser",
  });
  const unsupportedAction = create.getByRole("button", {
    name: "Cannot open asset-status base in browser: no trusted GitHub or GitLab origin",
  });
  await expect(githubAction).toBeVisible();
  await expect(githubAction).toBeEnabled();
  await expect(gitlabAction).toBeVisible();
  await expect(gitlabAction).toBeEnabled();
  await expect(unsupportedAction).toBeVisible();
  await expect(unsupportedAction).toBeDisabled();

  const includeGithub = create.getByRole("checkbox", {
    name: "Include prov-agent [repo_github]",
  });
  await includeGithub.focus();
  await page.keyboard.press("Space");
  await expect(includeGithub).not.toBeChecked();
  await expect(githubBase).toBeDisabled();
  await expect(githubAction).toBeEnabled();

  const dialogBody = create.locator("[data-workspace-dialog-body]");
  const dimensions = await dialogBody.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(
    dimensions.clientWidth + 1,
  );
  const actionBox = await githubAction.boundingBox();
  expect(actionBox).not.toBeNull();
  expect(actionBox!.width).toBeLessThanOrEqual(40);
  expect(actionBox!.height).toBeLessThanOrEqual(40);

  await githubAction.click();
  expect(handoff).toEqual({
    repositoryId: "repo_github",
    baseRef: "release/2026.07",
  });
  await expect(create.getByRole("status")).toContainText(
    "Browser handoff accepted for prov-agent at release/2026.07",
  );
});
