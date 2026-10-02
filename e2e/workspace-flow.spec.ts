/**
 * Workspace integration flow tests.
 *
 * Tests that:
 * - The workspace panel can be opened with an existing .code-workspace file
 * - All four sub-tabs render (Repositories, Snapshots, Graphify, Diagnostics)
 * - Repository rows display with Git status and action buttons
 * - SnapshotPanel mounts only after repos are available
 * - GraphifyPanel mounts with workspacePath and repoIds
 * - Diagnostics renders definition/scan info
 *
 * Run: npx playwright test e2e/workspace-flow.spec.ts
 */

import { test, expect, type Page } from "@playwright/test";

const INFRA_WORKSPACE = "/workspaces/infra.code-workspace";

test.describe("Workspace integration flow", () => {
  test.beforeEach(async ({ page }) => {
    // Intercept workspace open API
    await page.route("**/api/workspace/open*", async (route) => {
      const url = new URL(route.request().url());
      const path = url.searchParams.get("path");
      // Only respond successfully for known workspace
      if (path === INFRA_WORKSPACE) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            workspace: {
              filePath: INFRA_WORKSPACE,
              name: "infra",
              folders: [
                {
                  name: "prov-agent",
                  rawPath: "../active/infra/prov-agent",
                  resolvedPath: "/repos/prov-agent",
                  exists: true,
                },
                {
                  name: "senzu",
                  rawPath: "../active/infra/senzu",
                  resolvedPath: "/repos/senzu",
                  exists: true,
                },
                {
                  name: "asset-status",
                  rawPath: "../active/infra/asset-status",
                  resolvedPath: "/repos/asset-status",
                  exists: true,
                },
              ],
            },
            repositories: [
              {
                id: "repo-prov-agent",
                rootPath: "/repos/prov-agent",
                commonDir: "/repos/prov-agent/.git",
                worktree: {
                  path: "/repos/prov-agent",
                  branch: "main",
                },
                folderMembership: ["prov-agent"],
              },
              {
                id: "repo-senzu",
                rootPath: "/repos/senzu",
                commonDir: "/repos/senzu/.git",
                worktree: {
                  path: "/repos/senzu",
                  branch: "fix/leases",
                },
                folderMembership: ["senzu"],
              },
            ],
            scanErrors: [],
          }),
        });
      } else {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "Workspace not found" }),
        });
      }
    });

    // Intercept workspace recents
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
              folderCount: 10,
              repoCount: 12,
            },
          ],
        }),
      });
    });

    // Intercept Git status endpoint
    await page.route("**/api/git/status*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          repos: [
            {
              repoId: "repo-prov-agent",
              rootPath: "/repos/prov-agent",
              currentBranch: "main",
              headRef: "refs/heads/main",
              headOid: "abc123def456",
              upstream: "origin/main",
              ahead: 0,
              behind: 0,
              v2Status: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
              worktrees: [{ isPrimary: true, branch: "main" }],
              localBranches: [{ name: "main" }],
              remotes: [{ name: "origin" }],
              remoteRefs: [{ ref: "refs/remotes/origin/main" }],
              errors: [],
              cachedAt: Date.now(),
            },
            {
              repoId: "repo-senzu",
              rootPath: "/repos/senzu",
              currentBranch: "fix/leases",
              headRef: "refs/heads/fix/leases",
              headOid: "def789abc012",
              upstream: "origin/fix/leases",
              ahead: 2,
              behind: 0,
              v2Status: {
                staged: 1,
                unstaged: 3,
                untracked: 2,
                conflicted: 0,
                files: [
                  { path: "internal/leases/manager.go", origPath: undefined, xy: "M.", stage: "index", staged: true, unstaged: false, conflicted: false },
                  { path: "internal/leases/store.go", origPath: undefined, xy: ".M", stage: "worktree", staged: false, unstaged: true, conflicted: false },
                  { path: "internal/scheduler/fix_test.go", origPath: undefined, xy: "MM", stage: "index", staged: true, unstaged: true, conflicted: false },
                  { path: "docs/leases-v2.md", origPath: undefined, xy: "??", stage: "untracked", staged: false, unstaged: false, conflicted: false },
                  { path: "internal/leases/README.md", origPath: undefined, xy: "??", stage: "untracked", staged: false, unstaged: false, conflicted: false },
                ],
                truncated: false,
              },
              worktrees: [{ isPrimary: true, branch: "fix/leases" }],
              localBranches: [{ name: "fix/leases" }],
              remotes: [{ name: "origin" }],
              remoteRefs: [{ ref: "refs/remotes/origin/fix/leases" }],
              errors: [],
              cachedAt: Date.now(),
            },
          ],
        }),
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
              {
                id: "snap-001",
                version: 1,
                meta: {
                  createdAt: "2026-07-13T10:00:00.000Z",
                  label: "Pre-deployment check",
                  description: "State before deployment",
                  workspaceFilePath: INFRA_WORKSPACE,
                  source: "manual",
                },
                repoCount: 2,
                updatedAt: "2026-07-13T10:00:00.000Z",
              },
            ],
          }),
        });
      } else {
        await route.fulfill({ status: 201, body: JSON.stringify({ snapshot: { id: "new" } }) });
      }
    });

    // Intercept snapshot detail
    await page.route("**/api/snapshots/*", async (route) => {
      const url = route.request().url();
      if (url.endsWith("/drift")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            drift: {
              snapshotId: "snap-001",
              repos: [],
              summary: { satisfied: 2, safeSwitch: 0, createWorktree: 0, preferred: 0, dirtyBlocked: 0, occupied: 0, fetchNeeded: 0, missingRef: 0, missingRepo: 0, ambiguous: 0 },
            },
          }),
        });
        return;
      }
      if (url.endsWith("/restore")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            plan: { snapshotId: "snap-001", repos: [], summary: { total: 2, autoExecutable: 2, requiresManual: 0 }, canRestoreAll: true },
          }),
        });
        return;
      }
      if (url.endsWith("/duplicate")) {
        await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ snapshot: { id: "dup" } }) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          snapshot: {
            version: 1,
            meta: {
              createdAt: "2026-07-13T10:00:00.000Z",
              label: "Pre-deployment check",
              workspaceFilePath: INFRA_WORKSPACE,
              source: "manual",
            },
            repos: [],
            repoCount: 2,
          },
        }),
      });
    });

    // Intercept Graphify status endpoint
    await page.route("**/api/graphify*", async (route) => {
      const url = new URL(route.request().url());
      // Only handle the main status endpoint, not lazy
      if (!url.pathname.includes("/lazy")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            repos: {
              "repo-prov-agent": {
                repoId: "repo-prov-agent",
                repoRoot: "/repos/prov-agent",
                graphifyCliAvailable: true,
                available: true,
                artifacts: {
                  graphJson: true,
                  wikiIndex: true,
                  graphReport: true,
                  graphHtml: false,
                  manifest: true,
                },
                staleness: {
                  status: "fresh",
                  lastGraphCommitDate: "2026-07-12T10:00:00.000Z",
                  lastRepoCommitDate: "2026-07-13T08:00:00.000Z",
                  graphMtime: "2026-07-12T10:05:00.000Z",
                },
                capabilities: { operations: ["query", "path", "explain", "wiki"] },
              },
              "repo-senzu": {
                repoId: "repo-senzu",
                repoRoot: "/repos/senzu",
                graphifyCliAvailable: true,
                available: false,
                artifacts: {
                  graphJson: false,
                  wikiIndex: false,
                  graphReport: false,
                  graphHtml: false,
                  manifest: false,
                },
                staleness: {
                  status: "absent",
                  lastGraphCommitDate: null,
                  lastRepoCommitDate: "2026-07-13T09:00:00.000Z",
                  graphMtime: null,
                },
                capabilities: { operations: [] },
              },
            },
            errors: [],
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ repoId: "repo-prov-agent", meta: { nodeCount: 1500, linkCount: 4200, communityCount: 12, sizeBytes: 204800 } }),
        });
      }
    });

    // Intercept Git action token
    await page.route("**/api/git/token", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "test-action-token" }),
      });
    });

    // Intercept session plan (GET) and execution (POST)
    await page.route(/\/api\/git\/session(?:\?|$)/, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            plan: {
              sessionId: null,
              repos: [
                {
                  repoId: "repo-prov-agent",
                  displayName: "prov-agent",
                  rootPath: "/repos/prov-agent",
                  selectedRemote: "origin",
                  baseBranch: "main",
                  cachedRefOid: "abc123def456",
                  cachedRefFound: true,
                  needsFetch: true,
                  blockers: [],
                  status: "ready",
                },
                {
                  repoId: "repo-senzu",
                  displayName: "senzu",
                  rootPath: "/repos/senzu",
                  selectedRemote: "origin",
                  baseBranch: "main",
                  cachedRefOid: "def789abc012",
                  cachedRefFound: true,
                  needsFetch: true,
                  blockers: [],
                  status: "ready",
                },
              ],
              summary: { total: 2, ready: 2, needsFetch: 2, blocked: 0 },
            },
            active: null,
          }),
        });
      } else if (route.request().method() === "POST") {
        // Verify action token
        const token = route.request().headers()["x-action-token"];
        if (token !== "test-action-token") {
          await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Missing or invalid action token" }) });
          return;
        }
        const body = JSON.parse(route.request().postData() ?? "{}");
        if (body.confirm !== "start") {
          await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: 'Body confirm must be exactly "start"' }) });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            execution: {
              sessionId: "e2e-test-session",
              status: "completed",
              results: [
                {
                  repoId: "repo-prov-agent",
                  displayName: "prov-agent",
                  rootPath: "/repos/prov-agent",
                  selectedRemote: "origin",
                  baseBranch: "main",
                  sessionBranch: "dashboard/session-e2e-test-session/main",
                  worktreePath: "/worktrees/repo-prov-agent-dashboard-session-e2e-test-session-main",
                  fetch: { success: true, durationMs: 1200 },
                  worktree: { success: true, path: "/worktrees/repo-prov-agent-dashboard-session-e2e-test-session-main", headOid: "abc123def456", headVerified: true },
                  success: true,
                },
                {
                  repoId: "repo-senzu",
                  displayName: "senzu",
                  rootPath: "/repos/senzu",
                  selectedRemote: "origin",
                  baseBranch: "main",
                  sessionBranch: "dashboard/session-e2e-test-session/main",
                  worktreePath: "/worktrees/repo-senzu-dashboard-session-e2e-test-session-main",
                  fetch: { success: true, durationMs: 950 },
                  worktree: { success: true, path: "/worktrees/repo-senzu-dashboard-session-e2e-test-session-main", headOid: "def789abc012", headVerified: true },
                  success: true,
                },
              ],
              startedAt: "2026-07-14T10:00:00.000Z",
              completedAt: "2026-07-14T10:00:03.000Z",
            },
          }),
        });
      } else {
        await route.fulfill({ status: 405, contentType: "application/json", body: JSON.stringify({ error: "Method not allowed" }) });
      }
    });

    // Navigate to dashboard
    await page.goto("/?tab=workspace");
    await page.waitForLoadState("networkidle");
  });

  /* ── 1. Navigate to workspace tab ─────────────────────────── */

  test("renders workspace panel with picker on load", async ({ page }) => {
    await expect(
      page.locator("h2", { hasText: "Workspace" })
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator('input[aria-label="Workspace file path"]')
    ).toBeVisible({ timeout: 5000 });
  });

  /* ── 2. Open current workspace ────────────────────────────── */

  test("opens current infra.code-workspace and shows sub-tabs", async ({
    page,
  }) => {
    // Type workspace path
    const input = page.locator('input[aria-label="Workspace file path"]');
    await input.fill(INFRA_WORKSPACE);
    await page.locator("button", { hasText: "Open" }).click();

    // Wait for sub-tabs to appear
    await expect(page.getByRole("heading", { name: "infra" })).toBeVisible({
      timeout: 5000,
    });
    await expect(
      page.locator("button", { hasText: "Snapshots" })
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator("button", { hasText: "Graphify" })
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator("button", { hasText: "Diagnostics" })
    ).toBeVisible({ timeout: 5000 });
  });

  /* ── 3. Repositories sub-tab ──────────────────────────────── */

  test("repos tab shows repository rows with Git status", async ({
    page,
  }) => {
    const input = page.locator('input[aria-label="Workspace file path"]');
    await input.fill(INFRA_WORKSPACE);
    await page.locator("button", { hasText: "Open" }).click();

    // Wait for repo rows to render
    await expect(
      page.locator("button[aria-label*='prov-agent']")
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator("button[aria-label*='senzu']")
    ).toBeVisible({ timeout: 5000 });

    // Git status should show branch names (mock returns fix/leases dirty)
    const senzuRow = page.locator("button[aria-label*='senzu']");
    await expect(senzuRow).toBeVisible({ timeout: 5000 });

    // Expand the senzu repo row to see Git actions
    await senzuRow.click();
    await expect(
      page.locator("button[aria-label='Fetch']")
    ).toBeVisible({ timeout: 5000 });
  });

  test("summary health metrics filter the repository list", async ({ page }) => {
    const input = page.locator('input[aria-label="Workspace file path"]');
    await input.fill(INFRA_WORKSPACE);
    await page.locator("button", { hasText: "Open" }).click();

    const cleanRepo = page.getByRole("button", { name: /prov-agent —/ });
    const dirtyRepo = page.getByRole("button", { name: /senzu —/ });
    await expect(cleanRepo).toBeVisible({ timeout: 5000 });
    await expect(dirtyRepo).toBeVisible({ timeout: 5000 });

    const dirtyFilter = page.getByRole("button", {
      name: "Filter repositories: dirty",
    });
    await expect(dirtyFilter).toBeVisible({ timeout: 5000 });
    await dirtyFilter.click();

    await expect(dirtyFilter).toHaveAttribute("aria-pressed", "true");
    await expect(dirtyRepo).toBeVisible();
    await expect(cleanRepo).toBeHidden();
    await expect(page.getByText("1 of 2 repo", { exact: false })).toBeVisible();

    await page.getByRole("button", { name: "Clear repository health filter" }).click();
    await expect(cleanRepo).toBeVisible();
    await expect(dirtyRepo).toBeVisible();
  });

  /* ── 4. Snapshots sub-tab ─────────────────────────────────── */

  test("snapshots tab mounts after workspace is opened", async ({
    page,
  }) => {
    const input = page.locator('input[aria-label="Workspace file path"]');
    await input.fill(INFRA_WORKSPACE);
    await page.locator("button", { hasText: "Open" }).click();

    // Wait for repos to load, then switch to Snapshots
    await expect(
      page.locator("button[aria-label*='prov-agent']")
    ).toBeVisible({ timeout: 5000 });

    await page.locator("button", { hasText: "Snapshots" }).click();

    // Snapshot heading should be visible
    await expect(
      page.locator("h2", { hasText: "Snapshots" })
    ).toBeVisible({ timeout: 5000 });

    // Capture button should be visible
    await expect(
      page.locator("button[aria-label='Create new snapshot']")
    ).toBeVisible({ timeout: 5000 });

    // Snapshot list should show the mock entry
    await expect(
      page.locator("text=Pre-deployment check")
    ).toBeVisible({ timeout: 5000 });
  });

  test("snapshots tab shows empty state when no repos registered", async ({
    page,
  }) => {
    // Override workspace open to return empty repos
    await page.route("**/api/workspace/open*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          workspace: { filePath: INFRA_WORKSPACE, name: "infra", folders: [], settings: {} },
          repositories: [],
          scanErrors: [],
        }),
      });
    }, { times: 1 });

    const input = page.locator('input[aria-label="Workspace file path"]');
    await input.fill(INFRA_WORKSPACE);
    await page.locator("button", { hasText: "Open" }).click();

    await page.locator("button", { hasText: "Snapshots" }).click();

    // Should show placeholder message, not snapshot panel
    await expect(
      page.locator("text=Open a workspace with repositories")
    ).toBeVisible({ timeout: 5000 });
  });

  /* ── 5. Graphify sub-tab ──────────────────────────────────── */

  test("graphify tab mounts with workspace path and repoids", async ({
    page,
  }) => {
    const input = page.locator('input[aria-label="Workspace file path"]');
    await input.fill(INFRA_WORKSPACE);
    await page.locator("button", { hasText: "Open" }).click();

    // Wait for repos to load
    await expect(
      page.locator("button[aria-label*='prov-agent']")
    ).toBeVisible({ timeout: 5000 });

    // Switch to Graphify tab
    await page.locator("button", { hasText: "Graphify" }).click();

    // Graphify header should be visible
    await expect(
      page.locator("h3", { hasText: "Graphify" })
    ).toBeVisible({ timeout: 5000 });

    // Should show summary with repo counts
    await expect(
      page.locator("text=2 repos")
    ).toBeVisible({ timeout: 5000 });

    // Should show available/absent badges
    await expect(
      page.locator("text=available").first()
    ).toBeVisible({ timeout: 5000 });

    // Search input should be present
    await expect(
      page.locator('input[aria-label="Search graphify repos"]')
    ).toBeVisible({ timeout: 5000 });
  });

  /* ── 6. Diagnostics sub-tab ───────────────────────────────── */

  test("diagnostics tab shows workspace definition and folder info", async ({
    page,
  }) => {
    const input = page.locator('input[aria-label="Workspace file path"]');
    await input.fill(INFRA_WORKSPACE);
    await page.locator("button", { hasText: "Open" }).click();

    // Wait for repos to load
    await expect(
      page.locator("button[aria-label*='prov-agent']")
    ).toBeVisible({ timeout: 5000 });

    // Switch to Diagnostics tab
    await page.locator("button", { hasText: "Diagnostics" }).click();

    // Should show workspace file info
    await expect(
      page.locator("div", { hasText: INFRA_WORKSPACE }).filter({ hasText: /^\/workspaces\/infra\.code-workspace$/ }).first()
    ).toBeVisible({ timeout: 5000 });

    // Should show folder count
    await expect(
      page.getByText("3 folders", { exact: true })
    ).toBeVisible({ timeout: 5000 });

    // Should show folder entries
    await expect(
      page.getByText("prov-agent", { exact: true })
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByText("senzu", { exact: true })
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByText("asset-status", { exact: true })
    ).toBeVisible({ timeout: 5000 });

    // Should show "All OK" since all folders exist
    await expect(
      page.locator("text=All OK")
    ).toBeVisible({ timeout: 5000 });
  });

  /* ── 7. Refresh button works ──────────────────────────────── */

  test("refresh button re-fetches workspace data", async ({ page }) => {
    const input = page.locator('input[aria-label="Workspace file path"]');
    await input.fill(INFRA_WORKSPACE);
    await page.locator("button", { hasText: "Open" }).click();

    await expect(
      page.locator("button[aria-label*='prov-agent']")
    ).toBeVisible({ timeout: 5000 });

    // Click refresh
    await page.locator('button[aria-label="Refresh"]').first().click();

    // Should still show repos after refresh
    await expect(
      page.locator("button[aria-label*='prov-agent']")
    ).toBeVisible({ timeout: 5000 });
  });

  /* ── 8. Back button returns to picker ─────────────────────── */

  test("back button returns to workspace picker", async ({ page }) => {
    const input = page.locator('input[aria-label="Workspace file path"]');
    await input.fill(INFRA_WORKSPACE);
    await page.locator("button", { hasText: "Open" }).click();

    await expect(
      page.locator("button[aria-label*='prov-agent']")
    ).toBeVisible({ timeout: 5000 });

    // Click Back
    await page.locator("button", { hasText: "Back" }).click();

    // Picker should reappear
    await expect(
      page.locator('input[aria-label="Workspace file path"]')
    ).toBeVisible({ timeout: 5000 });
  });

  /* ── 9. Expanded dirty repo shows exact changed files ────── */

  test("expanded dirty repo shows exact changed files and controls", async ({ page }) => {
    const input = page.locator('input[aria-label="Workspace file path"]');
    await input.fill(INFRA_WORKSPACE);
    await page.locator("button", { hasText: "Open" }).click();

    // Wait for senzu repo row (dirty — fix/leases with changes)
    const senzuRow = page.locator("button[aria-label*='senzu']");
    await expect(senzuRow).toBeVisible({ timeout: 5000 });

    // Expand senzu row
    await senzuRow.click();

    // Verify "Changed files" header shows expected count
    await expect(
      page.getByText(/Changed files \(5/, { exact: false })
    ).toBeVisible({ timeout: 5000 });

    // Verify each mocked changed file is listed
    const stagedFile = page.getByRole("link", { name: /Open changed file internal\/leases\/manager\.go/ });
    const unstagedFile = page.getByRole("link", { name: /Open changed file internal\/leases\/store\.go/ });
    await expect(stagedFile).toBeVisible({ timeout: 5000 });
    await expect(unstagedFile).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByRole("link", { name: /Open changed file internal\/scheduler\/fix_test\.go/ })
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByRole("link", { name: /Open changed file docs\/leases-v2\.md/ })
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByRole("link", { name: /Open changed file internal\/leases\/README\.md/ })
    ).toBeVisible({ timeout: 5000 });

    // Verify stage/unstaged/new labels show
    await expect(stagedFile.getByText("staged", { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(unstagedFile.getByText("unstaged", { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("new", { exact: true }).first()).toBeVisible({ timeout: 5000 });

    // Verify fetch action button is visible (remote-first control)
    await expect(
      page.locator("button[aria-label='Fetch']")
    ).toBeVisible({ timeout: 5000 });
    const gitControlLabels = page.locator("select[aria-label='Fetch remote']").locator("xpath=../..").locator("label");
    await expect(gitControlLabels.nth(0)).toContainText("Remote");
    await expect(gitControlLabels.nth(1)).toContainText("Branch");

    // Verify display of dirty branch name with ahead count
    await expect(
      page.getByTitle("refs/heads/fix/leases")
    ).toBeVisible({ timeout: 5000 });
  });

  /* ── 10. Clean session preview — shows plan with repo list ─ */

  test("clean session button shows preview with per-repo plan", async ({ page }) => {
    await openWorkspace(page);

    // Find the "Start clean session" button
    const startBtn = page.getByRole("button", { name: "Start clean session" });
    await expect(startBtn).toBeVisible({ timeout: 5000 });
    await startBtn.click();

    // Should show preview panel
    const preview = page.getByLabel("Clean session preview");
    await expect(preview).toBeVisible({ timeout: 5000 });

    // Should show disclosure text about fetch/branch/remote policy
    await expect(
      preview.getByText("origin → upstream → first")
    ).toBeVisible({ timeout: 5000 });
    await expect(
      preview.getByText("main → develop")
    ).toBeVisible({ timeout: 5000 });

    // Should show summary badges
    await expect(
      preview.getByText("2 repos", { exact: true })
    ).toBeVisible({ timeout: 5000 });
    await expect(
      preview.getByText("2 ready")
    ).toBeVisible({ timeout: 5000 });
    await expect(
      preview.getByText("2 needs fetch")
    ).toBeVisible({ timeout: 5000 });

    // Should show repo plan rows
    await expect(
      preview.getByText("prov-agent", { exact: true })
    ).toBeVisible({ timeout: 5000 });
    await expect(
      preview.getByText("senzu", { exact: true })
    ).toBeVisible({ timeout: 5000 });

    // Should show "Start session" action button
    await expect(
      preview.getByRole("button", { name: "Start session" })
    ).toBeVisible({ timeout: 5000 });
  });

  /* ── 11. Clean session execution — confirm shows results ──── */

  test("clean session execution shows per-repo results with Open links", async ({ page }) => {
    await openWorkspace(page);

    // Open preview
    await page.getByRole("button", { name: "Start clean session" }).click();
    await expect(page.getByLabel("Clean session preview")).toBeVisible({ timeout: 5000 });

    // Click "Start session"
    await page.getByRole("button", { name: "Start session" }).click();

    // Should show results panel
    await expect(
      page.getByText("Clean session created")
    ).toBeVisible({ timeout: 5000 });

    // Should show summary
    await expect(
      page.getByText("2/2 repos")
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByText("2 created")
    ).toBeVisible({ timeout: 5000 });

    // Should show per-repo result rows
    await expect(
      page.getByText("prov-agent", { exact: true }).first()
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByText("senzu", { exact: true }).first()
    ).toBeVisible({ timeout: 5000 });

    // Should show "Open in VS Code" links
    await expect(
      page.getByRole("link", { name: "Open prov-agent session worktree in VS Code" })
    ).toBeVisible({ timeout: 5000 });

    // Dismiss button should be present
    await expect(
      page.getByRole("button", { name: "Dismiss" })
    ).toBeVisible({ timeout: 5000 });
  });
});

/**
 * Helper: open the infra workspace through the picker UI.
 */
async function openWorkspace(page: Page): Promise<void> {
  const input = page.locator('input[aria-label="Workspace file path"]');
  await input.fill(INFRA_WORKSPACE);
  await page.locator("button", { hasText: "Open" }).click();
  await expect(
    page.locator("button[aria-label*='prov-agent']")
  ).toBeVisible({ timeout: 5000 });
}
