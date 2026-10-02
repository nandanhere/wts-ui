import { writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import type { Page, TestInfo } from "@playwright/test";
import { expect, measureInteraction, test } from "./fixtures/productPolish";
import { materialization, now, repositoryCatalogFixture, setupFixture, workspaceFixture } from "./fixtures/productPolishData";

interface RequestRecord {
  method: string;
  path: string;
  startedAt: number;
  completedAt?: number;
}

async function mountPortfolio(page: Page, origin: string, count: number) {
  const records = Array.from({ length: count }, (_, index) => workspaceFixture({
    workspaceId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    title: `Performance workspace ${index + 1}`,
    intent: { type: "jira", issueKey: `PERF-${index + 1}` },
    workspaceDisplayPath: `/fixture/workspaces/perf-${index + 1}`,
    repositories: [{ repositoryId: "repo_checkout", requestId: "repo_checkout", label: "checkout-api", baseRef: "main", worktreeLeaf: "checkout-api" }],
    lifecycle: { materializationState: "materialized", worktreeCount: 1, observedAtUnixMs: now },
    workflow: { state: "active", revision: 1, updatedAtUnixMs: now },
  }));
  const requests: RequestRecord[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  let active = 0;
  let maxActive = 0;
  let materializationGate: Promise<void> | undefined;
  let releaseMaterialization: (() => void) | undefined;
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install();
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("wts.appearance.theme.v1", "dark");
    const evidence = { interactions: [] as unknown[], longTasks: [] as number[], layoutShifts: [] as number[] };
    Object.assign(window, { __productEvidence: evidence });
    new PerformanceObserver(list => list.getEntries().forEach(entry => evidence.longTasks.push(entry.duration))).observe({ type: "longtask", buffered: true });
    new PerformanceObserver(list => list.getEntries().forEach(entry => {
      const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number };
      if (!shift.hadRecentInput) evidence.layoutShifts.push(shift.value);
    })).observe({ type: "layout-shift", buffered: true });
  });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const record: RequestRecord = { method, path, startedAt: Date.now() };
    requests.push(record);
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 80));
      if (path.endsWith("/materialization") && materializationGate) await materializationGate;
      let body: unknown;
      if (method !== "GET") {
        unexpected.push(`${method} ${path}`);
        return await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "fixture_write_blocked", message: "The performance fixture permits reads only.", retryable: false } }) });
      }
      if (path === "/api/v1/bootstrap") body = { apiVersion: "v1", origin, sessionToken: "workspace-performance" };
      else if (path === "/api/v1/workspaces") body = { workspaceRootId: "root_local", workspaceRootDisplayPath: "/fixture/workspaces", workspaces: records };
      else if (path === "/api/v1/setup") body = setupFixture();
      else if (path === "/api/v1/repositories") body = repositoryCatalogFixture();
      else if (path === "/api/v1/agent-sessions") body = { schemaVersion: 1, sessions: [] };
      else if (path === "/api/v1/agent-conversations") body = { schemaVersion: 1, conversations: [] };
      else if (/^\/api\/v1\/reviews\/(gitlab|github)$/.test(path)) body = { schemaVersion: 1, state: "fresh", fetchedAtUnixMs: now, reviews: [], detail: "No review requests in this fixture." };
      else {
        const match = path.match(/^\/api\/v1\/workspaces\/([^/]+)(.*)$/);
        const workspace = records.find(item => item.workspaceId === match?.[1]);
        const suffix = match?.[2];
        if (workspace && suffix === "") body = workspace;
        else if (workspace && suffix === "/materialization") body = materialization(workspace);
        else if (workspace && suffix === "/evidence") body = null;
        else if (workspace && suffix === "/verification/summary") body = {
          schemaVersion: 1, workspaceId: workspace.workspaceId,
          verificationPlan: { schemaVersion: 1, workspaceId: workspace.workspaceId, revision: 1, updatedAtUnixMs: now, checks: [] },
          verificationResult: { schemaVersion: 1, workspaceId: workspace.workspaceId, planRevision: 1, status: "notRun", checks: [], warnings: [] },
          verificationHistory: [],
        };
        else if (workspace && suffix === "/test-runs") body = { schemaVersion: 1, workspaceId: workspace.workspaceId, runs: [] };
        else if (workspace && suffix === "/work-items") body = { schemaVersion: 1, workspaceId: workspace.workspaceId, links: [] };
        else if (workspace && suffix === "/merge-requests/gitlab") body = { schemaVersion: 1, state: "fresh", fetchedAtUnixMs: now, mergeRequests: [], detail: "No merge requests in this fixture." };
        else if (workspace && suffix === "/integrations/gitlab") body = { schemaVersion: 1, cliState: "ready", accounts: [{ host: "gitlab.example.test", state: "signedIn", username: "fixture" }], detail: "The fixture account is ready." };
        else {
          unexpected.push(`${method} ${path}`);
          return await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "fixture_route_missing", message: "The performance fixture does not define this route.", retryable: false } }) });
        }
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    } finally {
      record.completedAt = Date.now();
      active -= 1;
    }
  });
  await page.goto(origin);
  return {
    records, requests, unexpected, errors,
    maxActive: () => maxActive,
    settle: async () => {
      await expect(page.locator('[data-ui="spaces.attention-summary"] [role="status"]')).toHaveCount(0, { timeout: 30_000 });
      await expect.poll(() => active).toBe(0);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    },
    holdMaterialization: () => { materializationGate = new Promise(resolve => { releaseMaterialization = resolve; }); },
    releaseMaterialization: () => { releaseMaterialization?.(); materializationGate = undefined; },
  };
}

function requestCounts(requests: RequestRecord[]) {
  return requests.reduce<Record<string, number>>((counts, request) => {
    const key = request.path.replace(/\/workspaces\/[^/]+/, "/workspaces/:id");
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

async function saveReport(page: Page, testInfo: TestInfo, fixture: Awaited<ReturnType<typeof mountPortfolio>>, measurements: unknown) {
  const browser = await page.evaluate(() => (window as typeof window & { __productEvidence: unknown }).__productEvidence);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = await cdp.send("Performance.getMetrics");
  await cdp.detach();
  const report = {
    machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version, browser: page.context().browser()?.version() },
    conditions: "One Chromium worker. Full App with Vite development modules. All API reads use seeded fixtures with 80 ms delay. Writes fail. Timings include browser automation observation and two animation frames. These are local upper-bound observations, not native paint or backend measurements.",
    workspaceCount: fixture.records.length,
    measurements, browser, metrics: Object.fromEntries(metrics.metrics.filter(item => ["Documents", "Frames", "JSEventListeners", "LayoutObjects", "Nodes", "JSHeapUsedSize", "JSHeapTotalSize"].includes(item.name)).map(item => [item.name, item.value])),
    requestCounts: requestCounts(fixture.requests), maxActiveRequests: fixture.maxActive(), requests: fixture.requests,
    unexpected: fixture.unexpected, errors: fixture.errors,
  };
  const path = testInfo.outputPath("workspace-performance.json");
  await writeFile(path, JSON.stringify(report, null, 2));
  await testInfo.attach("workspace-performance.json", { path, contentType: "application/json" });
}

for (const count of [5, 30, 100]) {
  test(`${count} materialized workspaces keep search local and report board cost`, async ({ page, productOrigin }, testInfo) => {
    const fixture = await mountPortfolio(page, productOrigin, count);
    const measurements: Record<string, unknown> = {};
    try {
      const cards = page.getByRole("button", { name: /^Open PERF-\d+.* details$/ });
      await expect(cards).toHaveCount(count);
      measurements.boardReadyMs = await page.evaluate(() => performance.now());
      await fixture.settle();
      measurements.attentionReadyMs = await page.evaluate(() => performance.now());
      measurements.startupRequests = requestCounts(fixture.requests);
      measurements.startupMaxActiveRequests = fixture.maxActive();
      expect(fixture.requests.filter(request => /\/(materialization|evidence|test-runs)$/.test(request.path))).toEqual([]);
      const beforeSearch = fixture.requests.length;
      await page.getByRole("button", { name: "Search spaces", exact: true }).click();
      const search = page.getByRole("searchbox", { name: "Search local workspaces" });
      const start = await page.evaluate(() => performance.now());
      await search.fill(`PERF-${count}`);
      await expect(cards).toHaveCount(1);
      measurements.searchMs = await page.evaluate(start => performance.now() - start, start);
      await fixture.settle();
      expect(fixture.requests.length).toBe(beforeSearch);
      await search.clear();
      await expect(cards).toHaveCount(count);
      const beforeRefresh = fixture.requests.length;
      const expectedMrReads = fixture.requests.filter(request => request.path.endsWith("/merge-requests/gitlab")).length;
      const expectedSummaryReads = fixture.requests.filter(request => request.path.endsWith("/verification/summary")).length;
      await page.clock.fastForward(31_000);
      await fixture.settle();
      expect(fixture.requests.slice(beforeRefresh).filter(request => /\/(merge-requests\/gitlab|verification\/summary)$/.test(request.path)), "Idle attention refresh runs once per minute.").toEqual([]);
      await page.clock.fastForward(30_000);
      await expect.poll(() => fixture.requests.slice(beforeRefresh).filter(request => request.path.endsWith("/merge-requests/gitlab")).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(expectedMrReads);
      await expect.poll(() => fixture.requests.slice(beforeRefresh).filter(request => request.path.endsWith("/verification/summary")).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(expectedSummaryReads);
      await fixture.settle();
      measurements.minuteRefreshRequests = requestCounts(fixture.requests.slice(beforeRefresh));
      if (process.env.WTS_PERFORMANCE_BASELINE !== "1") {
        expect(fixture.maxActive(), "The board must bound request concurrency as the portfolio grows.").toBeLessThanOrEqual(12);
        expect(fixture.requests.filter(request => /\/(materialization|evidence|test-runs)$/.test(request.path))).toEqual([]);
      }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    } finally { await saveReport(page, testInfo, fixture, measurements); }
  });
}

test("five workspace returns show cached facts before status reads finish", async ({ page, productOrigin }, testInfo) => {
  const fixture = await mountPortfolio(page, productOrigin, 5);
  const measurements: Record<string, unknown> = {};
  try {
    await expect(page.getByRole("button", { name: /^Open PERF-1.* details$/ })).toBeVisible();
    await fixture.settle();
    const open = (index: number) => page.getByRole("button", { name: new RegExp(`^Open PERF-${index}\\b.* details$`) });
    const facts = page.getByLabel("Workspace facts");
    for (let index = 1; index <= 5; index += 1) {
      await measureInteraction(page, `cold workspace ${index}`, open(index), facts);
      await fixture.settle();
      await page.getByRole("button", { name: "Open Spaces", exact: true }).click();
      await fixture.settle();
    }
    measurements.warmupRequests = requestCounts(fixture.requests);
    const beforeReturns = fixture.requests.length;
    for (let cycle = 1; cycle <= 2; cycle += 1) {
      for (let index = 1; index <= 5; index += 1) {
        fixture.holdMaterialization();
        try {
          await measureInteraction(page, `cached workspace ${index}, cycle ${cycle}`, open(index), facts);
          await expect(facts).toContainText(`wts/perf-${index}`);
          expect(fixture.requests.filter(request => request.path.endsWith("/materialization") && !request.completedAt).length).toBeLessThanOrEqual(1);
        } finally { fixture.releaseMaterialization(); }
        await fixture.settle();
        await page.getByRole("button", { name: "Open Spaces", exact: true }).click();
        await fixture.settle();
      }
    }
    measurements.cachedReturnRequests = requestCounts(fixture.requests.slice(beforeReturns));
    if (process.env.WTS_PERFORMANCE_BASELINE !== "1") {
      const cachedRequests = fixture.requests.slice(beforeReturns);
      expect(cachedRequests.filter(request => request.path.endsWith("/merge-requests/gitlab")).length).toBeLessThanOrEqual(5);
      expect(cachedRequests.filter(request => request.path.endsWith("/agent-sessions")).length).toBeLessThanOrEqual(15);
      expect(cachedRequests.length).toBeLessThanOrEqual(55);
    }
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally { fixture.releaseMaterialization(); await saveReport(page, testInfo, fixture, measurements); }
});
