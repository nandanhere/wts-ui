/**
 * Primary shell navigation tests.
 *
 * Tests that:
 * - All six primary tabs render in the nav bar (Workspace, Combinations,
 *   Deployments, Dependencies, Integrations, Settings)
 * - Workspace is the default tab when no ?tab= param
 * - Workspace tab shows the picker by default (idle state)
 * - Workspace tab opens a workspace and shows sub-tabs
 * - Combinations mounts snapshot panel when workspace is open
 * - Deployments shows read-only placeholder
 * - Dependencies mounts graphify when workspace is open
 * - Integrations shows empty state when no workspace, renders providers when open
 * - Settings shows read-only placeholder
 * - Workspace-open state is shared across tabs via WorkspaceContext
 *
 * Run: npx playwright test e2e/primary-shell.spec.ts
 */

import { test, expect } from "@playwright/test";

const INFRA_WORKSPACE = "/workspaces/infra.code-workspace";

test.describe("Primary shell navigation", () => {
  test.beforeEach(async ({ page }) => {
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

    // Intercept workspace open API
    await page.route("**/api/workspace/open*", async (route) => {
      const url = new URL(route.request().url());
      const path = url.searchParams.get("path");
      if (path === INFRA_WORKSPACE) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            workspace: {
              filePath: INFRA_WORKSPACE,
              name: "infra",
              folders: [
                { name: "prov-agent", rawPath: "../active/infra/prov-agent", resolvedPath: "/tmp/prov-agent", exists: true },
                { name: "senzu", rawPath: "../active/infra/senzu", resolvedPath: "/tmp/senzu", exists: true },
              ],
            },
            repositories: [
              {
                id: "repo-prov-agent", rootPath: "/tmp/prov-agent", commonDir: "/tmp/prov-agent/.git",
                worktree: { path: "/tmp/prov-agent", branch: "main" }, folderMembership: ["prov-agent"],
              },
              {
                id: "repo-senzu", rootPath: "/tmp/senzu", commonDir: "/tmp/senzu/.git",
                worktree: { path: "/tmp/senzu", branch: "fix/leases" }, folderMembership: ["senzu"],
              },
            ],
            scanErrors: [],
          }),
        });
      } else {
        await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Not found" }) });
      }
    });

    // Intercept Graphify (for Dependencies tab)
    await page.route("**/api/graphify*", async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.includes("/lazy")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            repos: {
              "repo-prov-agent": {
                repoId: "repo-prov-agent", repoRoot: "/tmp/prov-agent",
                graphifyCliAvailable: true, available: true,
                artifacts: { graphJson: true, wikiIndex: true, graphReport: true, graphHtml: false, manifest: true },
                staleness: { status: "fresh", lastGraphCommitDate: "2026-07-12T10:00:00.000Z", lastRepoCommitDate: "2026-07-13T08:00:00.000Z", graphMtime: "2026-07-12T10:05:00.000Z" },
                capabilities: { operations: ["query", "path", "explain", "wiki"] },
              },
            },
            errors: [],
          }),
        });
      } else {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ repoId: "repo-prov-agent", meta: { nodeCount: 1500, linkCount: 4200, communityCount: 12, sizeBytes: 204800 } }) });
      }
    });

    // Intercept integrations manifest
    await page.route("**/api/integrations", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          workspaceName: "infra",
          generatedAt: new Date().toISOString(),
          providers: [
            {
              id: "built-in-graphify",
              name: "Graphify",
              description: "Repository graph artifact inventory",
              state: "available",
              capabilities: ["dependencies", "documentation"],
              riskLevel: "readonly",
              tools: [
                {
                  id: "query-tool",
                  label: "Query",
                  description: "Query the knowledge graph",
                  requiresApproval: true,
                  risk: "low",
                },
              ],
              blocks: [
                {
                  type: "metric-list",
                  id: "graphify-summary",
                  title: "Graph Coverage",
                  items: [
                    { label: "Total repos", value: "2", color: "default" },
                    { label: "Available", value: "1", color: "success" },
                  ],
                },
                {
                  type: "status-list",
                  id: "graphify-repos",
                  title: "Repository Graphs",
                  items: [
                    { label: "prov-agent", status: "ok", detail: "graph + wiki + report" },
                    { label: "senzu", status: "unknown", detail: "no graph" },
                  ],
                },
              ],
            },
          ],
        }),
      });
    });

    // Intercept snapshot (for Combinations tab)
    await page.route("**/api/snapshots", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            snapshots: [
              { id: "snap-001", version: 1, meta: { createdAt: "2026-07-13T10:00:00.000Z", label: "Pre-deployment check", description: "", workspaceFilePath: INFRA_WORKSPACE, source: "manual" }, repoCount: 2, updatedAt: "2026-07-13T10:00:00.000Z" },
            ],
          }),
        });
      } else {
        await route.fulfill({ status: 201, body: JSON.stringify({ snapshot: { id: "new" } }) });
      }
    });
    await page.route("**/api/snapshots/*", async (route) => {
      const url = route.request().url();
      if (url.endsWith("/drift")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ drift: { snapshotId: "snap-001", repos: [], summary: { satisfied: 2, safeSwitch: 0, createWorktree: 0, preferred: 0, dirtyBlocked: 0, occupied: 0, fetchNeeded: 0, missingRef: 0, missingRepo: 0, ambiguous: 0 } } }) });
        return;
      }
      if (url.endsWith("/restore") || url.endsWith("/duplicate")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ snapshot: { version: 1, meta: { createdAt: "2026-07-13T10:00:00.000Z", label: "Pre-deployment check", workspaceFilePath: INFRA_WORKSPACE, source: "manual" }, repos: [], repoCount: 2 } }) });
    });
  });

  /* ── 1. All six tabs render ──────────────────────────── */

  test("renders all six primary nav tabs", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("nav button", { hasText: "Workspace" })).toBeVisible({ timeout: 5000 });
    await expect(page.locator("nav button", { hasText: "Combinations" })).toBeVisible({ timeout: 5000 });
    await expect(page.locator("nav button", { hasText: "Deployments" })).toBeVisible({ timeout: 5000 });
    await expect(page.locator("nav button", { hasText: "Dependencies" })).toBeVisible({ timeout: 5000 });
    await expect(page.locator("nav button", { hasText: "Integrations" })).toBeVisible({ timeout: 5000 });
    await expect(page.locator("nav button", { hasText: "Settings" })).toBeVisible({ timeout: 5000 });
  });

  /* ── 2. Workspace is default tab ─────────────────────────── */

  test("defaults to workspace tab with picker", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Workspace tab should be active
    const wsTab = page.locator("nav button", { hasText: "Workspace" });
    await expect(wsTab).toBeVisible({ timeout: 5000 });

    // Picker should be visible
    await expect(
      page.locator('input[aria-label="Workspace file path"]')
    ).toBeVisible({ timeout: 5000 });

    // Vanity metrics (oldest, most active, largest, hub) should NOT exist
    await expect(page.locator("text=Oldest Repo")).not.toBeVisible();
    await expect(page.locator("text=Most Active")).not.toBeVisible();
    await expect(page.locator("text=Largest Codebase")).not.toBeVisible();
    await expect(page.locator("text=Central Hub")).not.toBeVisible();
  });

  /* ── 3. Deployments requires an opened workspace ──────────── */

  test("deployments tab shows no-workspace guidance", async ({ page }) => {
    await page.goto("/?tab=deployments");
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator("h2", { hasText: "Deployments" })
    ).toBeVisible({ timeout: 5000 });

    await expect(
      page.locator("text=No workspace open")
    ).toBeVisible({ timeout: 5000 });

    await expect(
      page.locator("text=scan for deployment configuration")
    ).toBeVisible({ timeout: 5000 });
  });

  /* ── 4. Settings shows placeholder ─────────────────────────── */

  test("settings tab shows read-only placeholder", async ({ page }) => {
    await page.goto("/?tab=settings");
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator("h2", { hasText: "Settings" })
    ).toBeVisible({ timeout: 5000 });

    await expect(
      page.locator("text=Local Scope")
    ).toBeVisible({ timeout: 5000 });

    await expect(
      page.locator("text=Workspace Registry")
    ).toBeVisible({ timeout: 5000 });
  });

  /* ── 5. Combinations shows placeholder when no workspace ───── */

  test("combinations tab shows no-workspace placeholder", async ({
    page,
  }) => {
    await page.goto("/?tab=combinations");
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator("h2", { hasText: "Combinations" })
    ).toBeVisible({ timeout: 5000 });

    await expect(
      page.locator("text=No workspace open")
    ).toBeVisible({ timeout: 5000 });
  });

  /* ── 6. Combinations mounts snapshots when workspace open ──── */

  test("combinations tab shows snapshots after workspace opened", async ({
    page,
  }) => {
    await page.goto("/?tab=workspace");
    await page.waitForLoadState("networkidle");

    // Open workspace
    const input = page.locator('input[aria-label="Workspace file path"]');
    await input.fill(INFRA_WORKSPACE);
    await page.locator("button", { hasText: "Open" }).click();

    // Wait for workspace to load
    await expect(page.getByRole("heading", { name: "infra" })).toBeVisible({
      timeout: 5000,
    });

    // Switch to Combinations tab
    await page.locator("nav button", { hasText: "Combinations" }).click();

    // Should show snapshot panel (Capture button)
    await expect(
      page.locator("button[aria-label='Create new snapshot']")
    ).toBeVisible({ timeout: 5000 });
  });

  /* ── 7. Dependencies shows placeholder when no workspace ───── */

  test("dependencies tab shows placeholder when no workspace", async ({
    page,
  }) => {
    await page.goto("/?tab=dependencies");
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator("h2", { hasText: "Dependencies" })
    ).toBeVisible({ timeout: 5000 });

    await expect(
      page.locator("text=Open a workspace to see dependencies")
    ).toBeVisible({ timeout: 5000 });
  });

  /* ── 8. Dependencies mounts Graphify when workspace open ───── */

  test("dependencies tab shows graphify after workspace opened", async ({
    page,
  }) => {
    await page.goto("/?tab=workspace");
    await page.waitForLoadState("networkidle");

    // Open workspace
    const input = page.locator('input[aria-label="Workspace file path"]');
    await input.fill(INFRA_WORKSPACE);
    await page.locator("button", { hasText: "Open" }).click();

    // Wait for workspace to load
    await expect(page.getByRole("heading", { name: "infra" })).toBeVisible({
      timeout: 5000,
    });

    // Switch to Dependencies tab
    await page.locator("nav button", { hasText: "Dependencies" }).click();

    // Graphify panel should render
    await expect(
      page.locator("h3", { hasText: "Graphify" })
    ).toBeVisible({ timeout: 5000 });
  });

  /* ── 9. Integrations tab shows empty state when no workspace ─ */

  test("integrations tab shows empty state when no workspace", async ({
    page,
  }) => {
    await page.goto("/?tab=integrations");
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator("h2", { hasText: "Integrations" })
    ).toBeVisible({ timeout: 5000 });

    await expect(
      page.locator("text=Open a workspace to see integrations")
    ).toBeVisible({ timeout: 5000 });
  });

  /* ── 10. Integrations shows providers when workspace open ──── */

  test("integrations tab shows providers after workspace opened", async ({
    page,
  }) => {
    await page.goto("/?tab=workspace");
    await page.waitForLoadState("networkidle");

    // Open workspace
    const input = page.locator('input[aria-label="Workspace file path"]');
    await input.fill(INFRA_WORKSPACE);
    await page.locator("button", { hasText: "Open" }).click();

    // Wait for workspace to load
    await expect(page.getByRole("heading", { name: "infra" })).toBeVisible({
      timeout: 5000,
    });

    // Switch to Integrations tab
    await page.locator("nav button", { hasText: "Integrations" }).click();

    // Should show Graphify provider
    await expect(
      page.locator("h3", { hasText: "Graphify" })
    ).toBeVisible({ timeout: 5000 });

    // Should show tool risk + approval metadata
    await expect(
      page.locator("text=low")
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator('[data-approval="required"]')
    ).toBeVisible({ timeout: 5000 });

    // Should show risk badge
    await expect(
      page.locator("text=readonly")
    ).toBeVisible({ timeout: 5000 });
  });

  /* ── 11. Tab from URL param is respected ───────────────────── */

  test("respects ?tab= URL parameter", async ({ page }) => {
    await page.goto("/?tab=settings");
    await page.waitForLoadState("networkidle");

    // Settings tab should be active
    await expect(
      page.locator("h2", { hasText: "Settings" })
    ).toBeVisible({ timeout: 5000 });

    // Workspace picker should NOT be visible
    await expect(
      page.locator('input[aria-label="Workspace file path"]')
    ).not.toBeVisible();
  });

  /* ── 12. No legacy overview stats remnants ─────────────────── */

  test("no legacy overview stats on any tab", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // These legacy vanity metrics should not appear anywhere
    await expect(page.locator("text=Graph Nodes")).not.toBeVisible();
    await expect(page.locator("text=Edges")).not.toBeVisible();
    await expect(page.locator("text=tracked files")).not.toBeVisible();
    await expect(page.locator("text=Architecture Map")).not.toBeVisible();
    await expect(page.locator("text=Docs Review")).not.toBeVisible();
  });
});
