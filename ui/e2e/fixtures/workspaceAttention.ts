import type { Page, Route } from "@playwright/test";
import type { AgentConversation } from "../../src/lib/agentConversations";
import type { WorkspaceEvidence, WorkspaceView } from "../../src/lib/wtsClient";
import { comparison, discussions, localDiff, materialization, repositoryCatalogFixture, setupFixture, workspaceFixture } from "./productPolishData";

export const DRAFT_TEXT = "Keep my unrelated settings draft while I inspect workspace results.";
export const ids = [1, 2, 3, 4, 5].map(value => `${value}0000000-0000-4000-8000-000000000000`);
export const titles = ["Fix navigation spacing", "Keep retry receipts", "Verify checkout behavior", "Read review feedback", "Keep imported plans readable"];
const now = Date.now();
const records = ids.map((workspaceId, index) => workspaceFixture({ workspaceId, title: titles[index], intent: { type: "jira", issueKey: `ATTN-${101 + index}` },
  workspaceDisplayPath: `/fixture/attention/${index}`, workspaceLeaf: `attention-${index}`,
  repositories: [{ requestId: "repo_checkout", repositoryId: "repo_checkout", label: "checkout-api", baseRef: "main", worktreeLeaf: "checkout-api" }],
  lifecycle: { materializationState: "materialized", worktreeCount: 1, observedAtUnixMs: now },
  workflow: { state: (["ready", "active", "review", "parked", "active"] as const)[index]!, revision: 1, updatedAtUnixMs: now },
  createdAtUnixMs: now - index * 1000, updatedAtUnixMs: now - index * 1000 }));

function agent(index: number): AgentConversation {
  const prefix = (index + 6).toString(16);
  const conversationId = `${prefix}0000000-0000-4000-8000-000000000000`;
  const requestId = `${prefix}0000000-0000-4000-8000-000000000001`;
  return { schemaVersion: 1, conversationId, workspaceId: ids[index]!, repositoryId: "repo_checkout", workspaceDisplayPath: records[index]!.workspaceDisplayPath,
    provider: "codex", revision: 2, createdAtUnixMs: now - 5000, updatedAtUnixMs: now - 1000,
    source: { kind: "ui", route: `/sessions/${ids[index]}`, calloutId: "workspace.workbench", label: titles[index]! },
    messages: [
      { messageId: requestId, requestId, role: "user", status: "completed", body: `Please complete ${titles[index]!.toLowerCase()}.`, createdAtUnixMs: now - 5000 },
      { messageId: `${prefix}0000000-0000-4000-8000-000000000002`, requestId, role: "assistant", status: "completed", body: `Exact saved result: ${titles[index]}. The local changes are ready for review.`, createdAtUnixMs: now - 1000 },
    ] };
}
const conversations = [agent(0), agent(1), agent(4)];

function evidence(workspace: WorkspaceView): WorkspaceEvidence {
  const workspaceId = workspace.workspaceId;
  return {
    context: { schemaVersion: 1, workspaceId, workspaceRecordVersion: 1, title: workspace.title, intent: workspace.intent, preferredProvider: "codex", branchName: "wts/attention-103",
      workspaceDisplayPath: workspace.workspaceDisplayPath, codeWorkspaceDisplayPath: `${workspace.workspaceDisplayPath}/workspace.code-workspace`, evidenceDisplayPath: `${workspace.workspaceDisplayPath}/.wts`, createdAtUnixMs: now - 10000, wtsVersion: "0.1.0",
      repositories: [{ repositoryId: "repo_checkout", label: "checkout-api", requestedBaseRef: "main", resolvedBaseRef: "refs/heads/main", baseCommitOid: "a".repeat(40), worktreeDisplayPath: `${workspace.workspaceDisplayPath}/checkout-api` }], allowedRepositoryIds: ["repo_checkout"] },
    graphManifest: { schemaVersion: 1, workspaceId, status: "ready", graphDisplayPath: `${workspace.workspaceDisplayPath}/graphify-out/graph.json`, graphSha256: `sha256:${"a".repeat(64)}`, indexedAtUnixMs: now - 9000, indexedRepositories: [{ repositoryId: "repo_checkout", commitOid: "a".repeat(40) }], detail: "The fixture graph is ready." },
    verificationPlan: { schemaVersion: 1, workspaceId, revision: 1, updatedAtUnixMs: now - 8000, checks: [{ id: "checkout-unit", label: "Checkout unit tests", kind: "unit", repositoryId: "repo_checkout", workingDirectory: "checkout-api", executable: "cargo", args: ["test"], timeoutMs: 120000, outputLimitBytes: 65536, required: true, environmentNames: [], acceptanceFiles: [] }] },
    verificationResult: { schemaVersion: 1, workspaceId, planRevision: 1, status: "failed", startedAtUnixMs: now - 3000, completedAtUnixMs: now - 2000, durationMs: 1000, warnings: [], checks: [{ checkId: "checkout-unit", status: "failed", startedAtUnixMs: now - 3000, completedAtUnixMs: now - 2000, durationMs: 1000, exitCode: 101, logDisplayPath: `${workspace.workspaceDisplayPath}/.wts/logs/checkout-unit.log`, detail: "Expected one capture, received two." }] },
    verificationHistory: [],
    agentReport: { schemaVersion: 1, workspaceId, status: "notReported", displayPath: `${workspace.workspaceDisplayPath}/.wts/agent-report.json`, updatedAtUnixMs: null, summary: "", findings: [], nextActions: [], proposedChecks: [], validationFlows: [], flows: [], detail: "No agent report is present.",
      scope: { coverage: "unassessed", graphStatus: "notStarted", reviewedRepositoryIds: [], unresolvedRepositoryIds: [], skippedRepositories: [] }, environment: { status: "unassessed", summary: "", requirements: [], setupSteps: [], unresolved: [] } }, agentRuns: [],
  };
}

export async function mountAttention(page: Page, origin: string, theme: "light" | "dark") {
  const workspaces = structuredClone(records);
  const errors: string[] = []; const unexpected: string[] = []; const writes: string[] = []; const reads: string[] = [];
  let gitlabFailure = false; let passed = false;
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({ theme, body }) => {
    localStorage.clear(); localStorage.setItem("wts.appearance.theme.v1", theme);
    localStorage.setItem("wts.agent-feedback.shelf.v2", JSON.stringify({ version: 2, open: false, selectedId: "current-draft", drafts: [{ version: 1, id: "current-draft", open: false, body,
      request: { requestId: "90000000-0000-4000-8000-000000000010", provider: "codex", source: { kind: "ui", route: "/", calloutId: "environment.settings", label: "Unrelated settings draft" } } }] }));
  }, { theme, body: DRAFT_TEXT });
  const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()); const path = url.pathname; const method = route.request().method();
    const workflowId = path.match(/^\/api\/v1\/workspaces\/([^/]+)\/workflow$/)?.[1];
    if (method === "PATCH" && workflowId) {
      const workspace = workspaces.find(item => item.workspaceId === workflowId)!; const input = route.request().postDataJSON();
      workspace.workflow = { state: input.state, revision: input.expectedRevision + 1, updatedAtUnixMs: now };
      return json(route, workspace.workflow);
    }
    if (method !== "GET") { writes.push(`${method} ${path}`); return json(route, { error: { code: "fixture_write_blocked", message: "The fixture blocks provider and agent actions.", retryable: false } }, 403); }
    reads.push(path);
    if (path === "/api/v1/bootstrap") return json(route, { sessionToken: "attention-fixture" });
    if (path === "/api/v1/workspaces") return json(route, { workspaceRootId: "root_local", workspaceRootDisplayPath: "/fixture/attention", workspaces });
    if (path === "/api/v1/setup") return json(route, setupFixture());
    if (path === "/api/v1/repositories") return json(route, repositoryCatalogFixture());
    if (path === "/api/v1/agent-sessions") return json(route, { schemaVersion: 1, sessions: [] });
    if (path === "/api/v1/agent-conversations") return json(route, { schemaVersion: 1, conversations });
    const chat = path.match(/^\/api\/v1\/agent-conversations\/([^/]+)$/)?.[1];
    if (chat) return json(route, conversations.find(item => item.conversationId === chat));
    if (path === "/api/v1/reviews/gitlab" || path === "/api/v1/reviews/github") return json(route, { schemaVersion: 1, state: "fresh", reviews: [], fetchedAtUnixMs: now, detail: "No assigned reviews." });
    if (/\/reviews\/gitlab\/repo_checkout\/16\/discussions$/.test(path)) {
      const value = discussions(); value.discussions = value.discussions.slice(0, 2); value.fetchedAtUnixMs = now;
      return json(route, value);
    }
    const match = path.match(/^\/api\/v1\/workspaces\/([^/]+)(.*)$/);
    if (match) {
      const workspace = workspaces.find(item => item.workspaceId === match[1]); const suffix = match[2];
      if (!workspace) return json(route, { error: { code: "workspace_not_found", message: "Fixture workspace missing." } }, 404);
      if (!suffix) return json(route, workspace);
      if (suffix === "/materialization") return json(route, materialization(workspace));
      if (suffix === "/work-items") return json(route, { schemaVersion: 1, workspaceId: workspace.workspaceId, links: [] });
      if (suffix === "/test-runs") return json(route, { schemaVersion: 1, workspaceId: workspace.workspaceId, runs: [] });
      if (suffix === "/verification/summary" || suffix === "/evidence") {
        if (workspace.workspaceId !== ids[2]) return json(route, null);
        const value = evidence(workspace);
        if (passed) { value.verificationHistory = [structuredClone(value.verificationResult)]; value.verificationResult = { ...value.verificationResult, status: "passed", startedAtUnixMs: now + 1000, completedAtUnixMs: now + 2000, checks: value.verificationResult.checks.map(check => ({ ...check, status: "passed", exitCode: 0, startedAtUnixMs: now + 1000, completedAtUnixMs: now + 2000, detail: "The check passed." })) }; }
        return json(route, suffix === "/evidence" ? value : { schemaVersion: 1, workspaceId: workspace.workspaceId, verificationPlan: value.verificationPlan, verificationResult: value.verificationResult, verificationHistory: value.verificationHistory });
      }
      if (suffix === "/merge-requests/gitlab") {
        if (gitlabFailure && workspace.workspaceId === ids[3]) return json(route, { error: { code: "fixture_offline", message: "The GitLab fixture is offline.", retryable: true } }, 503);
        return json(route, { schemaVersion: 1, state: "fresh", fetchedAtUnixMs: now, detail: "Current fixture data.", mergeRequests: workspace.workspaceId === ids[3] ? [{ id: "mr-16", repositoryId: "repo_checkout", iid: 16, projectPath: "payments/checkout-api", webUrl: "https://gitlab.example.test/payments/checkout-api/-/merge_requests/16", title: "Preserve retry receipts", sourceBranch: materialization(workspace).branchName, targetBranch: "main", authorUsername: "nandan", updatedAt: new Date(now).toISOString(), draft: false, status: "open" }] : [] });
      }
      if (suffix === "/review/threads") return json(route, { workspaceId: workspace.workspaceId, threads: [] });
      if (suffix === "/integrations/gitlab") return json(route, { schemaVersion: 1, cliState: "ready", accounts: [{ host: "gitlab.example.test", state: "signedIn", username: "nandan" }], detail: "Fixture account." });
      if (suffix === "/repositories/repo_checkout/diff") return json(route, localDiff(workspace.workspaceId, "repo_checkout"));
      if (suffix === "/repositories/repo_checkout/gitlab/16/comparison") return json(route, comparison(workspace.workspaceId, "repo_checkout"));
      if (suffix === "/repositories/repo_checkout/review-graph") return json(route, null);
    }
    unexpected.push(`${method} ${path}`); return json(route, { error: { code: "fixture_route_missing", message: "This fixture route is unavailable." } }, 404);
  });
  await page.goto(origin);
  return { errors, unexpected, writes, reads, offline: (value: boolean) => { gitlabFailure = value; }, passCheck: () => { passed = true; } };
}
