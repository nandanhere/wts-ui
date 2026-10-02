/**
 * Snapshot management Playwright tests.
 *
 * These test the snapshot UI components by:
 * - Verifying the SnapshotPanel renders in the workspace tab
 * - Interacting with snapshot list, create, delete, and detail views
 * - Using mocked snapshot API responses
 *
 * Run: npx playwright test e2e/snapshots.spec.ts
 */

import { test, expect } from "@playwright/test";

const INFRA_WORKSPACE = "/workspaces/infra.code-workspace";

/* ------------------------------------------------------------------ */
/*  Shared mock for workspace open                                     */
/* ------------------------------------------------------------------ */

async function mockWorkspaceOpen(page: import("@playwright/test").Page) {
  await page.route("**/api/workspace/open*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workspace: {
          filePath: INFRA_WORKSPACE,
          name: "infra",
          folders: [
            {
              name: "repo-a",
              rawPath: "../tmp/repo-a",
              resolvedPath: "/tmp/repo-a",
              exists: true,
            },
            {
              name: "repo-b",
              rawPath: "../tmp/repo-b",
              resolvedPath: "/tmp/repo-b",
              exists: true,
            },
          ],
        },
        repositories: [
          {
            id: "repo-a",
            rootPath: "/tmp/repo-a",
            commonDir: "/tmp/repo-a/.git",
            worktree: { path: "/tmp/repo-a", branch: "main" },
            folderMembership: ["repo-a"],
          },
          {
            id: "repo-b",
            rootPath: "/tmp/repo-b",
            commonDir: "/tmp/repo-b/.git",
            worktree: { path: "/tmp/repo-b", branch: "main" },
            folderMembership: ["repo-b"],
          },
        ],
        scanErrors: [],
      }),
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Mock factory helpers                                               */
/* ------------------------------------------------------------------ */

function makeSnapshotEntry(
  id: string,
  label: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    version: 1,
    meta: {
      createdAt: "2026-07-13T10:00:00.000Z",
      label,
      description: `Description for ${label}`,
      workspaceFilePath: "/tmp/test.code-workspace",
      source: "manual",
      ...overrides,
    },
    repoCount: 2,
    updatedAt: "2026-07-13T10:00:00.000Z",
  };
}

function makeSnapshotSchema(id: string, label: string) {
  return {
    version: 1,
    meta: {
      createdAt: "2026-07-13T10:00:00.000Z",
      label,
      description: `Description for ${label}`,
      workspaceFilePath: "/tmp/test.code-workspace",
      source: "manual",
    },
    repos: [
      {
        repoId: "repo-a",
        rootPath: "/tmp/repo-a",
        identity: {
          commonDir: "/tmp/repo-a/.git",
          remoteNames: ["origin"],
          remotePathHint: "org/repo-a",
        },
        head: {
          symbolicRef: "refs/heads/main",
          detached: false,
          sha: "abcdef1234567890abcdef1234567890abcdef12",
          upstream: "refs/remotes/origin/main",
        },
        worktree: { path: "/tmp/repo-a", logicalSlot: "primary" },
        dirty: {
          hasChanges: false,
          staged: 0,
          unstaged: 0,
          untracked: 0,
          conflicted: 0,
        },
      },
    ],
    repoCount: 1,
  };
}

function makeDriftResult(snapshotId: string) {
  return {
    snapshotId,
    repos: [
      {
        repoId: "repo-a",
        rootPath: "/tmp/repo-a",
        classification: "satisfied",
        explanation: "Repository is at the snapshot state: main @ abcdef12",
        repoExists: true,
        isClean: true,
        currentSha: "abcdef1234567890abcdef1234567890abcdef12",
        snapshotSha: "abcdef1234567890abcdef1234567890abcdef12",
        currentBranch: "main",
        snapshotBranch: "main",
        branchMatch: true,
        shaMatch: true,
        occupiedBy: null,
      },
    ],
    summary: {
      satisfied: 1,
      safeSwitch: 0,
      createWorktree: 0,
      preferred: 0,
      dirtyBlocked: 0,
      occupied: 0,
      fetchNeeded: 0,
      missingRef: 0,
      missingRepo: 0,
      ambiguous: 0,
    },
  };
}

function makeRestorePlan(snapshotId: string) {
  return {
    snapshotId,
    repos: [
      {
        repoId: "repo-a",
        classification: "satisfied",
        steps: ["No action needed — repository already at snapshot state."],
        canAutoExecute: true,
        prerequisites: [],
      },
    ],
    summary: {
      total: 1,
      autoExecutable: 1,
      requiresManual: 0,
    },
    canRestoreAll: true,
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function openMockWorkspace(page: import("@playwright/test").Page) {
  // Navigate to workspace tab, mock open, and fill/open workspace
  await page.goto("/?tab=workspace");
  await page.waitForLoadState("networkidle");

  const input = page.locator('input[aria-label="Workspace file path"]');
  await input.fill(INFRA_WORKSPACE);
  await page.locator("button", { hasText: "Open" }).click();

  // Wait for sub-nav to confirm workspace loaded
  await expect(page.getByRole("heading", { name: "infra" })).toBeVisible({
    timeout: 5000,
  });
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

test.describe("Snapshot management UI", () => {
  test.beforeEach(async ({ page }) => {
    // Mock workspace open API
    await mockWorkspaceOpen(page);

    // Mock workspace recents
    await page.route("**/api/workspace", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          entries: [
            {
              filePath: INFRA_WORKSPACE,
              label: "infra",
              lastOpened: new Date().toISOString(),
              folderCount: 2,
              repoCount: 2,
            },
          ],
        }),
      });
    });

    await page.route("**/api/git/token", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "snapshot-test-token" }),
      });
    });

    // Intercept snapshot API calls
    await page.route("**/api/snapshots", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            snapshots: [
              makeSnapshotEntry("snap-001", "Pre-deployment check"),
              makeSnapshotEntry("snap-002", "Clean state backup"),
            ],
          }),
        });
      } else if (route.request().method() === "POST") {
        const body = JSON.parse(route.request().postData() || "{}");
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            snapshot: makeSnapshotEntry("snap-new", body.label),
          }),
        });
      } else {
        await route.fulfill({ status: 405 });
      }
    });

    // Intercept snapshot detail
    await page.route("**/api/snapshots/**", async (route) => {
      const url = route.request().url();
      if (url.endsWith("/drift")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            drift: makeDriftResult("snap-001"),
          }),
        });
        return;
      }
      if (url.endsWith("/restore")) {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              activation: {
                snapshotId: "snap-001",
                startedAt: "2026-07-14T10:00:00.000Z",
                finishedAt: "2026-07-14T10:00:01.000Z",
                repos: [
                  {
                    repoId: "repo-a",
                    classification: "satisfied",
                    action: "none",
                    branch: "main",
                    snapshotSha: "abcdef1234567890abcdef1234567890abcdef12",
                    executable: true,
                    explanation: "Already satisfied",
                    status: "already-satisfied",
                    message: "No Git operation was needed.",
                    durationMs: 0,
                  },
                ],
                summary: { total: 1, succeeded: 0, alreadySatisfied: 1, blocked: 0, failed: 0 },
              },
            }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            plan: makeRestorePlan("snap-001"),
          }),
        });
        return;
      }
      if (url.endsWith("/duplicate")) {
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            snapshot: makeSnapshotEntry("snap-dup", "Duplicated snapshot"),
          }),
        });
        return;
      }
      // Detail GET
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          snapshot: makeSnapshotSchema("snap-001", "Pre-deployment check"),
        }),
      });
    });

    // Navigate and open workspace
    await openMockWorkspace(page);
  });

  test("renders snapshot panel heading and capture button", async ({
    page,
  }) => {
    // Navigate to Snapshots sub-tab within workspace
    await page.locator("button", { hasText: "Snapshots" }).click();

    const heading = page.locator("h2", { hasText: "Snapshots" });
    await expect(heading).toBeVisible({ timeout: 5000 });

    const captureBtn = page.locator("button", { hasText: "Capture" });
    await expect(captureBtn).toBeVisible();
  });

  test("displays snapshot list after loading", async ({ page }) => {
    await page.locator("button", { hasText: "Snapshots" }).click();

    await expect(
      page.getByRole("button", { name: /^Pre-deployment check/ })
    ).toBeVisible({ timeout: 5000 });

    await expect(
      page.getByRole("button", { name: /^Clean state backup/ })
    ).toBeVisible({ timeout: 3000 });
  });

  test("shows duplicate and delete buttons per snapshot", async ({
    page,
  }) => {
    await page.locator("button", { hasText: "Snapshots" }).click();

    await expect(
      page.locator("button", { hasText: "Duplicate" }).first()
    ).toBeVisible({ timeout: 5000 });

    await expect(
      page.locator("button", { hasText: "Delete" }).first()
    ).toBeVisible({ timeout: 3000 });
  });

  test("selecting a snapshot loads detail view", async ({ page }) => {
    await page.locator("button", { hasText: "Snapshots" }).click();

    // Click on first snapshot
    await page
      .getByRole("button", { name: /^Pre-deployment check/ })
      .click({ timeout: 5000 });

    // Wait for detail to load — should show "Repository Drift" heading
    await expect(
      page.locator("text=Repository Drift")
    ).toBeVisible({ timeout: 5000 });

    // Should show drift classification badge
    await expect(
      page.getByText("Satisfied", { exact: true }).first()
    ).toBeVisible({ timeout: 3000 });
  });

  test("shows restore plan section in detail", async ({ page }) => {
    await page.locator("button", { hasText: "Snapshots" }).click();
    await page
      .getByRole("button", { name: /^Pre-deployment check/ })
      .click({ timeout: 5000 });

    await expect(
      page.getByRole("heading", { name: /^Restore Plan/ })
    ).toBeVisible({ timeout: 5000 });

    // Should show the preview-only banner
    await expect(
      page.locator("text=preview of the restore plan")
    ).toBeVisible({ timeout: 3000 });
  });

  test("requires confirmation and displays activation outcomes", async ({ page }) => {
    await page.locator("button", { hasText: "Snapshots" }).click();
    await page
      .getByRole("button", { name: /^Pre-deployment check/ })
      .click({ timeout: 5000 });

    await page.getByRole("button", { name: "Activate combination" }).click();
    await expect(
      page.getByRole("button", { name: "Confirm combination activation" })
    ).toBeVisible();

    await page
      .getByRole("button", { name: "Confirm combination activation" })
      .click();

    await expect(page.getByText("1 already satisfied", { exact: false })).toBeVisible();
    await expect(page.getByText("No Git operation was needed.")).toBeVisible();
  });

  test("shows confirm step when deleting a snapshot", async ({ page }) => {
    await page.locator("button", { hasText: "Snapshots" }).click();

    // Find and click Delete on first snapshot
    const deleteBtn = page
      .locator("button", { hasText: "Delete" })
      .first();
    await deleteBtn.click({ timeout: 5000 });

    // Should show "Delete?" confirmation
    await expect(
      page.locator("text=Delete?")
    ).toBeVisible({ timeout: 3000 });

    // Should show Confirm button
    await expect(
      page.locator("button", { hasText: "Confirm" })
    ).toBeVisible({ timeout: 3000 });
  });

  test("opens create form dialog when Capture is clicked", async ({
    page,
  }) => {
    await page.locator("button", { hasText: "Snapshots" }).click();
    await page.locator("button", { hasText: "Capture" }).click({
      timeout: 5000,
    });

    // Dialog should show
    await expect(
      page.locator("h3", { hasText: "Create Snapshot" })
    ).toBeVisible({ timeout: 3000 });

    // Should have label input
    await expect(
      page.locator("#snapshot-label")
    ).toBeVisible({ timeout: 3000 });

    // Should have submit button
    await expect(
      page.locator("button", { hasText: "Create Snapshot" })
    ).toBeVisible({ timeout: 3000 });
  });

  test("shows error state when API returns error", async ({ page }) => {
    // Override the list route to return an error
    await page.route("**/api/snapshots", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Server error" }),
        });
      }
    });

    // Reload and re-open
    await openMockWorkspace(page);
    await page.locator("button", { hasText: "Snapshots" }).click();

    // Should show error message
    await expect(
      page.locator("text=Snapshot error").first()
    ).toBeVisible({ timeout: 5000 });
  });

  test("displays drift classification badges", async ({ page }) => {
    await page.locator("button", { hasText: "Snapshots" }).click();
    await page
      .getByRole("button", { name: /^Pre-deployment check/ })
      .click({ timeout: 5000 });

    // Should show satisfied badge
    await expect(
      page.locator("text=Satisfied").first()
    ).toBeVisible({ timeout: 5000 });
  });

  test("duplicate button triggers duplicate API", async ({ page }) => {
    await page.locator("button", { hasText: "Snapshots" }).click();

    // Mock the duplicate response
    let duplicated = false;
    await page.route("**/api/snapshots/snap-001/duplicate", async (route) => {
      duplicated = true;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          snapshot: makeSnapshotEntry("snap-dup", "Duplicated"),
        }),
      });
    });

    await page.locator("button", { hasText: "Duplicate" }).first().click({
      timeout: 5000,
    });

    // Give it time to process
    await page.waitForTimeout(500);
    expect(duplicated).toBe(true);
  });

  test("shows empty state when no snapshots exist", async ({ page }) => {
    // Override to return empty
    await page.route("**/api/snapshots", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ snapshots: [] }),
        });
      }
    });

    await openMockWorkspace(page);
    await page.locator("button", { hasText: "Snapshots" }).click();

    await expect(
      page.locator("text=No snapshots yet")
    ).toBeVisible({ timeout: 5000 });
  });
});
