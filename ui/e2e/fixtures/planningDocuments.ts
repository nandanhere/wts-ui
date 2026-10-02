import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Page, type Route } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

export { expect };
export const workspaceId = "11111111-1111-4111-8111-111111111111";
const sourceRoot = resolve(process.env.WTS_PLANNING_UI_ROOT ?? fileURLToPath(new URL("../../", import.meta.url)));
const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const documentIdForPath = (path: string) => `generated-${createHash("sha256").update(path).digest("hex")}`;
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client';
import {PlanningDocumentsPanel} from '/src/variants/local-workspace/PlanningDocumentsPanel.tsx';
import {createWorkspaceClient} from '/src/lib/wtsClient.ts';
import {initializeTheme,ThemeProvider} from '/src/theme.tsx'; import '/src/global.css';
import workspaceStyles from '/src/variants/local-workspace/LocalWorkspace.module.css';
initializeTheme(); const client=createWorkspaceClient({runtime:'http',baseUrl:location.origin});
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,
  React.createElement(ThemeProvider,null,React.createElement('div',{className:workspaceStyles.portalSurface},
    React.createElement(PlanningDocumentsPanel,{client,workspaceId:'${workspaceId}',workspaceKey:'Nested planning'})))));
</script></body></html>`;

export const test = base.extend<{}, { planningOrigin: string }>({
  planningOrigin: [async ({}, use) => {
    const cacheDir = resolve(tmpdir(), `wts-planning-browser-${createHash("sha256").update(sourceRoot).digest("hex").slice(0, 12)}`, "node_modules", ".vite");
    const server = await createServer({
      configFile: false, root: sourceRoot, cacheDir, appType: "custom",
      plugins: [react(), { name: "isolated-planning-fixture", configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url !== "/") return next();
          void vite.transformIndexHtml("/", html).then(result => {
            response.setHeader("Content-Type", "text/html"); response.end(result);
          }).catch(next);
        });
      } }],
      server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/test-results/**", "**/dist/**"] } },
      optimizeDeps: { include: ["react", "react-dom/client"] },
    });
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("The fixture requires a local TCP port.");
    try { await use(`http://127.0.0.1:${address.port}`); } finally { await server.close(); }
  }, { scope: "worker" }],
});

interface FixtureDocument { workspaceId: string; documentId: string; fileName: string; contents: string; sha256: string }
export interface PlanningRequest { method: string; path: string; body?: unknown }

export async function mountPlanning(page: Page, origin: string) {
  const records: FixtureDocument[] = [
    { documentId: "plan", fileName: "PLAN.md", contents: "# Workspace plan\n\nUse the folders to review each feature.\n" },
    { documentId: "kanban", fileName: "KANBAN.md", contents: "# Workspace Kanban\n\n- [ ] Review the feature plans.\n" },
    { fileName: ".todo/checkout/PLAN.md", contents: "# Checkout plan\n\nKeep checkout retries safe.\n\n[Checkout Kanban](./KANBAN.md)\n\n[Reporting plan](../reporting/PLAN.md)\n" },
    { fileName: ".todo/checkout/KANBAN.md", contents: "# Checkout Kanban\n\n- [x] Add the request key.\n- [ ] Test a repeated request.\n\n[Checkout plan](./PLAN.md)\n" },
    { fileName: ".todo/reporting/PLAN.md", contents: "# Reporting plan\n\nPreserve the daily export totals.\n\n[Reporting Kanban](./KANBAN.md)\n" },
    { fileName: ".todo/reporting/KANBAN.md", contents: "# Reporting Kanban\n\n- [ ] Check the export totals.\n" },
  ].map(document => ({ ...document, workspaceId, documentId: document.documentId ?? documentIdForPath(document.fileName), sha256: sha256(document.contents) }));
  const documents = new Map(records.map(document => [document.documentId, document]));
  const requests: PlanningRequest[] = [];
  const blocked: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem("wts.appearance.theme.v1", "light"); });
  const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
  const prefix = `/api/v1/workspaces/${workspaceId}`;
  await page.route("**/*", async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    const block = () => { blocked.push(`${method} ${url.pathname}`); return json(route, { error: { code: "fixture_route_blocked", message: "This fixture blocks the request.", retryable: false } }, 403); };
    if (url.origin !== origin) return block();
    if (!url.pathname.startsWith("/api/")) return method === "GET" ? route.continue() : block();
    const record: PlanningRequest = { method, path: url.pathname };
    if (request.postData()) record.body = request.postDataJSON();
    requests.push(record);
    if (method === "GET" && url.pathname === "/api/v1/bootstrap") return json(route, { apiVersion: "v1", origin, sessionToken: "nested-planning-fixture" });
    expect(request.headers()["x-wts-session"]).toBe("nested-planning-fixture");
    if (method === "GET" && url.pathname === `${prefix}/planning/documents`) return json(route, { workspaceId, documents: records.map(({ documentId, fileName }) => ({ documentId, fileName })) });
    if (method === "GET" && url.pathname === `${prefix}/review/threads`) return json(route, { workspaceId, threads: [] });
    const documentId = url.pathname.startsWith(`${prefix}/planning/documents/`) ? decodeURIComponent(url.pathname.slice(`${prefix}/planning/documents/`.length)) : undefined;
    const document = documentId ? documents.get(documentId) : undefined;
    if (!document) return block();
    if (method === "GET") return json(route, document);
    if (method !== "PUT") return block();
    const body = record.body as { expectedSha256: string; contents: string };
    expect(Object.keys(body).sort()).toEqual(["contents", "expectedSha256"]);
    expect(body.expectedSha256).toBe(document.sha256);
    expect(typeof body.contents).toBe("string");
    const saved = { ...document, contents: body.contents, sha256: sha256(body.contents) };
    documents.set(document.documentId, saved);
    return json(route, saved);
  });
  await page.goto(origin);
  return { requests, blocked, errors, documents };
}
