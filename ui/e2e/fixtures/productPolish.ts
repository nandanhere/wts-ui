import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { test as base, expect, type Page, type Route, type TestInfo, type Locator } from "@playwright/test";
import { CHECKOUT, REPORTING, comparison, discussions, documents, localDiff, materialization, now, repositoryCatalogFixture, setupFixture, workspaces } from "./productPolishData";
export { CHECKOUT, REPORTING, expect };

const sourceRoot = resolve(process.env.WTS_POLISH_UI_ROOT ?? fileURLToPath(new URL("../../", import.meta.url)));
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client';
import {App} from '/src/App.tsx'; import {createWorkspaceClient} from '/src/lib/wtsClient.ts';
import {initializeTheme} from '/src/theme.tsx'; import '/src/global.css';
initializeTheme(); const client=createWorkspaceClient({runtime:'http',baseUrl:location.origin});
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App,{workspaceClient:client})));
</script></body></html>`;
export const test = base.extend<{}, { productOrigin: string }>({
  productOrigin: [async ({}, use) => {
    const cacheDir = resolve(tmpdir(), `wts-product-polish-vite-${createHash("sha256").update(sourceRoot).digest("hex").slice(0, 12)}`, "node_modules", ".vite");
    const server = await createServer({ configFile: false, root: sourceRoot, cacheDir, appType: "custom",
      plugins: [react(), { name: "isolated-full-product-fixture", configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (!/^\/(?:$|sessions(?:\/[^.?]*)?$|reviews$|time$|updates$)/.test(request.url?.split("?")[0] ?? "")) return next();
          void vite.transformIndexHtml(request.url!, html).then(result => { response.setHeader("Content-Type", "text/html"); response.end(result); }).catch(next);
        });
      } }], server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/playwright-report/**", "**/test-results/**", "**/dist/**"] } }, optimizeDeps: { include: ["react", "react-dom/client"] } });
    await server.listen(); const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("The fixture requires a local TCP port.");
    try { await use(`http://127.0.0.1:${address.port}`); } finally { await server.close(); }
  }, { scope: "worker" }],
});

export interface RequestRecord { path: string; method: string; startedAt: number; completedAt?: number; fixtureDelayMs: number; failed: boolean }
export async function mountProduct(page: Page, origin: string, options: { theme?: "light" | "dark"; path?: string; delayMs?: number; services?: "empty" | "one"; feedbackQueue?: boolean; longConversationPath?: string } = {}) {
  const workspaceRecords = structuredClone(workspaces);
  const requests: RequestRecord[] = []; const unexpected: string[] = []; const errors: string[] = [];
  const delays = new Map<string, number>(); const failures = new Map<string, number>();
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(theme => {
    localStorage.clear(); localStorage.setItem("wts.appearance.theme.v1", theme);
    const evidence = { interactions: [] as Array<{ label: string; durationMs: number }>, longTasks: [] as number[], layoutShifts: [] as number[] };
    Object.assign(window, { __productEvidence: evidence });
    try { new PerformanceObserver(list => list.getEntries().forEach(item => evidence.longTasks.push(item.duration))).observe({ type: "longtask", buffered: true }); } catch {}
    try { new PerformanceObserver(list => list.getEntries().forEach(item => { const shift = item as PerformanceEntry & { hadRecentInput: boolean; value: number }; if (!shift.hadRecentInput) evidence.layoutShifts.push(shift.value); })).observe({ type: "layout-shift", buffered: true }); } catch {}
  }, options.theme ?? "light");
  const sendJson = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()); const method = route.request().method(); const path = url.pathname;
    const matchingDelay = [...delays].find(([key]) => path.includes(key))?.[1] ?? options.delayMs ?? 60;
    const record: RequestRecord = { path, method, startedAt: Date.now(), fixtureDelayMs: matchingDelay, failed: false }; requests.push(record);
    if (matchingDelay) await new Promise(resolve => setTimeout(resolve, matchingDelay));
    record.completedAt = Date.now();
    const fail = [...failures].find(([key, count]) => count > 0 && path.includes(key));
    if (fail) { failures.set(fail[0], fail[1] - 1); record.failed = true; return sendJson(route, { error: { code: "fixture_temporarily_unavailable", message: "The fixture connection is unavailable. Retry the request.", retryable: true } }, 503); }
    if (method === "POST" && path === "/api/v1/workspace-plans/runtime-analysis") {
      const input = route.request().postDataJSON();
      const repositories = input.repositories.map((repository: { repositoryId: string; label: string; baseRef: string }) => ({ repositoryId: repository.repositoryId, repositoryLabel: repository.label, requestedBaseRef: repository.baseRef, resolvedBaseRef: "refs/heads/main", commitOid: "a".repeat(40) }));
      return sendJson(route, { analysisDigest: `sha256:${"a".repeat(64)}`, repositories,
        services: options.services === "one" ? [{ candidateId: "candidate_checkout", serviceId: "checkout-api", displayName: "Checkout API", repositoryId: "repo_checkout", repositoryLabel: "checkout-api", commitOid: "a".repeat(40), workingDirectory: ".", command: ["npm", "start"], dependencies: [], confidence: "declared", evidence: [], includedByDefault: true, ports: [{ portId: "http", preferredPort: 4100, policy: "prefer", confidence: "declared", evidence: [] }] }] : [],
        warnings: options.services === "one" ? [] : ["No runnable services were inferred from the selected commits."], graph: { status: "ready", detail: "Checked two files at the selected commit." } });
    }
    const workflowId = path.match(/^\/api\/v1\/workspaces\/([^/]+)\/workflow$/)?.[1];
    if (method === "PATCH" && workflowId) {
      const workspace = workspaceRecords.find(item => item.workspaceId === workflowId)!;
      const request = route.request().postDataJSON();
      workspace.workflow = { state: request.state, revision: request.expectedRevision + 1, updatedAtUnixMs: now };
      return sendJson(route, workspace.workflow);
    }
    if (method !== "GET") { unexpected.push(`${method} ${path}`); return sendJson(route, { error: { code: "fixture_write_blocked", message: "This browser fixture does not send or change provider data.", retryable: false } }, 403); }
    if (path === "/api/v1/bootstrap") return sendJson(route, { apiVersion: "v1", origin, sessionToken: "product-polish-fixture" });
    expect(route.request().headers()["x-wts-session"]).toBe("product-polish-fixture");
    if (path === "/api/v1/workspaces") return sendJson(route, { workspaceRootId: "root_local", workspaceRootDisplayPath: "/fixture/workspaces", workspaces: workspaceRecords });
    if (path === "/api/v1/setup") return sendJson(route, setupFixture());
    if (path === "/api/v1/repositories") {
      const catalog = repositoryCatalogFixture(); catalog.repositories.push(...["payments-sdk", "settlement-reports"].map((label, index) => ({ ...catalog.repositories[0], id: index ? "repo_reporting" : "repo_sdk", label, checkoutLeaf: label, displayPath: `/fixture/repositories/${label}` })));
      return sendJson(route, catalog);
    }
    if (path === "/api/v1/agent-sessions") return sendJson(route, { schemaVersion: 1, sessions: [] });
    if (path === "/api/v1/agent-conversations") return sendJson(route, { schemaVersion: 1, conversations: [{ schemaVersion: 1,
      conversationId: "44444444-4444-4444-8444-444444444444", workspaceId: CHECKOUT, repositoryId: "repo_checkout", workspaceDisplayPath: "/fixture/workspaces/platform-42", provider: "codex", revision: 2,
      source: { kind: "ui", route: "/", calloutId: "spaces.toolbar", label: "Spaces toolbar" }, createdAtUnixMs: now - 100_000, updatedAtUnixMs: now - 90_000,
      messages: [{ messageId: "55555555-5555-4555-8555-555555555555", requestId: "fixture-task", role: "user", body: "Keep workspace navigation stable while data refreshes.", status: "completed", createdAtUnixMs: now - 100_000 },
        { messageId: "66666666-6666-4666-8666-666666666666", requestId: "fixture-task", role: "assistant", body: "The workspace now keeps cached content visible while the next request runs. The focused navigation checks passed.", status: "completed", createdAtUnixMs: now - 90_000 },
        ...(options.feedbackQueue ? [{ messageId: "77777777-7777-4777-8777-777777777777", requestId: "fixture-queued-task", role: "user", body: "Keep the selected repository and reply draft when this workspace refreshes.", submittedBody: "Keep the selected repository and reply draft when this workspace refreshes.", status: "queued", queueSequence: 2, queuePosition: 1, createdAtUnixMs: now - 80_000 }] : [])] }] });
    if (path === "/api/v1/reviews/gitlab" || path === "/api/v1/reviews/github") return sendJson(route, { schemaVersion: 1, state: "fresh", reviews: [], fetchedAtUnixMs: now, detail: "No review requests in this isolated fixture." });
    const discussionMatch = path.match(/^\/api\/v1\/reviews\/gitlab\/([^/]+)\/16\/discussions$/);
    if (discussionMatch) {
      const snapshot = discussions(decodeURIComponent(discussionMatch[1]));
      if (options.longConversationPath) snapshot.discussions[0].filePath = options.longConversationPath;
      return sendJson(route, snapshot);
    }
    if (path === "/api/v1/integrations/activity-watch/status") return sendJson(route, { state: "unavailable", installation: "unknown", endpoint: "http://127.0.0.1:5600", capabilities: ["status"], diagnosticCode: "connectionFailed", detail: "ActivityWatch is not connected in this isolated browser fixture." });
    const workspaceMatch = path.match(/^\/api\/v1\/workspaces\/([^/]+)(.*)$/);
    if (workspaceMatch) {
      const id = decodeURIComponent(workspaceMatch[1]); const suffix = workspaceMatch[2]; const workspace = workspaceRecords.find(item => item.workspaceId === id)!;
      if (!workspace) return sendJson(route, { error: { code: "workspace_not_found", message: "The fixture workspace was not found.", retryable: false } }, 404);
      if (!suffix) return sendJson(route, workspace);
      if (suffix === "/materialization") return sendJson(route, workspace.lifecycle?.materializationState === "materialized" ? materialization(workspace) : null);
      if (suffix === "/work-items") return sendJson(route, { schemaVersion: 1, workspaceId: id, links: [] });
      if (suffix === "/evidence") return sendJson(route, null);
      if (suffix === "/test-runs") return sendJson(route, { schemaVersion: 1, workspaceId: id, runs: [] });
      if (suffix === "/integrations/gitlab") return sendJson(route, { schemaVersion: 1, cliState: "ready", accounts: [{ host: "gitlab.example.test", state: "signedIn", username: "nandan" }], detail: "GitLab account fixture." });
      if (suffix === "/merge-requests/gitlab") return sendJson(route, { schemaVersion: 1, state: "fresh", fetchedAtUnixMs: now, detail: "GitLab MR fixture.", mergeRequests: id === CHECKOUT ? [{ id: "mr-16", repositoryId: "repo_checkout", iid: 16, projectPath: "payments/checkout-api", webUrl: "https://gitlab.example.test/payments/checkout-api/-/merge_requests/16", title: "Preserve one capture for each retry key", sourceBranch: materialization(workspace).branchName, targetBranch: "main", authorUsername: "nandan", updatedAt: "2026-09-18T08:00:00Z", draft: false, status: "open" }] : [] });
      if (suffix === "/planning/documents") return sendJson(route, { workspaceId: id, documents: Object.keys(documents).map(documentId => ({ documentId, fileName: `${workspace.workspaceDisplayPath}/${documentId.toUpperCase()}.md` })) });
      const document = suffix.match(/^\/planning\/documents\/(.+)$/);
      if (document) return sendJson(route, { workspaceId: id, documentId: document[1], fileName: `${workspace.workspaceDisplayPath}/${document[1].toUpperCase()}.md`, contents: documents[document[1] as keyof typeof documents], sha256: `sha256:${"a".repeat(64)}` });
      if (suffix === "/review/threads") return sendJson(route, { workspaceId: id, threads: [] });
      const repository = suffix.match(/^\/repositories\/([^/]+)(.*)$/);
      if (repository) {
        const repositoryId = decodeURIComponent(repository[1]);
        if (repository[2] === "/diff") return sendJson(route, localDiff(id, repositoryId));
        if (repository[2] === "/gitlab/16/comparison") return sendJson(route, comparison(id, repositoryId));
        if (repository[2] === "/source") return sendJson(route, { schemaVersion: 1, workspaceId: id, repositoryId, filePath: url.searchParams.get("filePath"), content: "export function capture(request) {\n  const receipt = captureOnce(request.id, request);\n  return receipt;\n}\n", revision: `sha256:${"a".repeat(64)}` });
        if (repository[2] === "/review-graph") return sendJson(route, null);
      }
    }
    unexpected.push(`${method} ${path}`); return sendJson(route, { error: { code: "fixture_route_missing", message: "This fixture route is not defined.", retryable: false } }, 404);
  });
  await page.goto(`${origin}${options.path ?? "/"}`);
  return { requests, unexpected, errors, delay: (path: string, milliseconds: number) => delays.set(path, milliseconds), failNext: (path: string, count = 1) => failures.set(path, count) };
}

export async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath(`${name}.png`) });
}
export async function measureInteraction(page: Page, label: string, trigger: Locator, ready: Locator) {
  await page.evaluate(() => { Object.assign(window, { __interactionStart: undefined }); document.addEventListener("pointerdown", () => Object.assign(window, { __interactionStart: performance.now() }), { once: true, capture: true }); });
  await trigger.click(); await expect(ready).toBeVisible();
  return page.evaluate(async name => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); const host = window as typeof window & { __interactionStart?: number; __productEvidence: { interactions: unknown[] } }; const durationMs = performance.now() - host.__interactionStart!; host.__productEvidence.interactions.push({ label: name, durationMs }); return durationMs; }, label);
}
export async function saveEvidence(page: Page, testInfo: TestInfo, fixture: Awaited<ReturnType<typeof mountProduct>>) {
  const browser = page.isClosed() ? null : await page.evaluate(() => (window as typeof window & { __productEvidence: unknown }).__productEvidence).catch(() => null);
  const path = testInfo.outputPath("product-evidence.json");
  await writeFile(path, JSON.stringify({ sourceRoot, machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version, browser: page.context().browser()?.version() }, conditions: "Chromium, full App, Vite development modules, isolated HTTP fixtures, local loopback, one test worker. Interaction timing includes Playwright visibility observation plus two animation frames; it is an upper-bound observation, not a native paint measurement.", browser, requests: fixture.requests, unexpected: fixture.unexpected, errors: fixture.errors }, null, 2));
  await testInfo.attach("product-evidence.json", { path, contentType: "application/json" });
}
