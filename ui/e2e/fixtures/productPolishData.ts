import type { WorkspaceView, SetupSnapshot, RepositoryCatalog, WorkspaceMaterialization, WorkspaceRepositoryDiff, WorkspaceGitlabComparison, GitlabDiscussions } from "../../src/lib/wtsClient";

export function workspaceFixture(
  overrides: Partial<WorkspaceView> = {},
): WorkspaceView {
  return {
    schemaVersion: 1,
    workspaceId: "ws_01J_PERSISTED",
    recordVersion: 1,
    intent: { type: "jira", issueKey: "PLATFORM-42" },
    title: "Checkout retries create duplicate captures",
    phase: "draft",
    preferredProvider: "codex",
    repositories: [
      {
        requestId: "repo_checkout",
        label: "checkout-api",
        baseRef: "main",
        worktreeLeaf: "checkout-api",
      },
      {
        requestId: "repo_sdk",
        label: "payments-sdk",
        baseRef: "main",
        worktreeLeaf: "payments-sdk",
      },
    ],
    observedWorkItems: [],
    workspaceRootId: "root_local",
    workspaceLeaf: "platform-42-7fd1",
    workspaceDisplayPath: "~/cd/platform-42-7fd1",
    lifecycle: {
      materializationState: "notMaterialized",
      worktreeCount: 0,
      observedAtUnixMs: 1_721_776_400_000,
    },
    workflow: {
      state: "ready",
      revision: 1,
      updatedAtUnixMs: 1_721_776_400_000,
    },
    createdAtUnixMs: 1_721_776_400_000,
    updatedAtUnixMs: 1_721_776_400_000,
    ...overrides,
  };
}

export function setupFixture(): SetupSnapshot {
  return {
    checkedAtUnixMs: 1_721_776_400_000,
    repositoryCount: 1,
    integrations: [
      {
        id: "git",
        category: "sourceControl",
        status: "ready",
        installation: "detected",
        setup: "notRequired",
        runtime: "idle",
        wtsSupport: "available",
        verificationKind: "version",
        capabilities: ["worktreeMaterialization"],
        version: "2.49.0",
        lastProbeAt: 1_721_776_400_000,
        blockingFor: [],
      },
      {
        id: "vscode",
        category: "editor",
        status: "ready",
        installation: "detected",
        setup: "notRequired",
        runtime: "idle",
        wtsSupport: "available",
        verificationKind: "version",
        capabilities: ["workspaceLaunch"],
        version: "1.125.0",
        lastProbeAt: 1_721_776_400_000,
        blockingFor: [],
      },
      {
        id: "warp",
        category: "terminal",
        status: "notFound",
        installation: "missing",
        setup: "needsDependency",
        runtime: "idle",
        wtsSupport: "available",
        verificationKind: "configurationSignal",
        capabilities: ["terminalSession"],
        detail: "Warp.app was not found in an Applications folder.",
        diagnosticCode: "executableMissing",
        lastProbeAt: 1_721_776_400_000,
        blockingFor: ["warpLaunch"],
      },
      ...(["codex", "openCode", "hermes"] as const).map((id) => ({
        id,
        category: "agent" as const,
        status: "notConfigured" as const,
        installation: "detected" as const,
        setup: "unverified" as const,
        runtime: "idle" as const,
        wtsSupport: "available" as const,
        verificationKind: "version" as const,
        capabilities: ["agentSession" as const],
        lastProbeAt: 1_721_776_400_000,
        blockingFor: [],
      })),
      {
        id: "graphify",
        category: "knowledgeGraph",
        status: "ready",
        installation: "detected",
        setup: "notRequired",
        runtime: "idle",
        wtsSupport: "available",
        verificationKind: "version",
        capabilities: ["graphIndexing"],
        version: "0.8.42",
        lastProbeAt: 1_721_776_400_000,
        blockingFor: [],
      },
      {
        id: "jiraMcp",
        category: "issueTracker",
        status: "notConfigured",
        installation: "missing",
        setup: "needsDependency",
        runtime: "idle",
        wtsSupport: "available",
        verificationKind: "configurationSignal",
        capabilities: ["jiraIssueImport"],
        lastProbeAt: 1_721_776_400_000,
        blockingFor: ["jiraIssueImport"],
      },
      {
        id: "openProject",
        category: "issueTracker",
        status: "notConfigured",
        installation: "missing",
        setup: "needsDependency",
        runtime: "idle",
        wtsSupport: "available",
        verificationKind: "configurationSignal",
        capabilities: ["openProjectWorkPackageImport"],
        diagnosticCode: "openProjectEndpointNotConfigured",
        lastProbeAt: 1_721_776_400_000,
        blockingFor: ["openProjectWorkPackageImport"],
      },
    ],
  };
}

export function repositoryCatalogFixture(): RepositoryCatalog {
  return {
    repositoryRootDisplayPath: "~/cd",
    repositories: [
      {
        id: "repo_checkout",
        label: "checkout-api",
        checkoutLeaf: "checkout-api",
        displayPath: "~/cd/checkout-api",
        defaultBranch: {
          name: "main",
          fullRef: "refs/heads/main",
          commitOid: "0123456789abcdef0123456789abcdef01234567",
        },
        availableBranches: [
          {
            name: "main",
            fullRef: "refs/heads/main",
            commitOid: "0123456789abcdef0123456789abcdef01234567",
            remote: false,
          },
          {
            name: "develop",
            fullRef: "refs/remotes/origin/develop",
            commitOid: "1123456789abcdef0123456789abcdef01234567",
            remote: true,
          },
          {
            name: "release/2026.07",
            fullRef: "refs/remotes/origin/release/2026.07",
            commitOid: "2123456789abcdef0123456789abcdef01234567",
            remote: true,
          },
        ],
      },
    ],
    skippedEntries: 0,
  };
}

export const CHECKOUT = "11111111-1111-4111-8111-111111111111";
export const REPORTING = "22222222-2222-4222-8222-222222222222";
const oid = (character: string) => character.repeat(40);
const digest = (character: string) => `sha256:${character.repeat(64)}`;
export const now = 1_790_000_000_000;
export const workspaces = [
  workspaceFixture({ workspaceId: CHECKOUT, title: "Prevent duplicate checkout captures", phase: "draft",
    workspaceDisplayPath: "/fixture/workspaces/platform-42", lifecycle: { materializationState: "materialized", worktreeCount: 2, observedAtUnixMs: now },
    workflow: { state: "active", revision: 2, updatedAtUnixMs: now }, createdAtUnixMs: now - 86_400_000, updatedAtUnixMs: now }),
  workspaceFixture({ workspaceId: REPORTING, title: "Keep settlement reports consistent", phase: "draft", intent: { type: "jira", issueKey: "PLATFORM-87" },
    workspaceDisplayPath: "/fixture/workspaces/platform-87", repositories: [{ requestId: "repo_reporting", repositoryId: "repo_reporting", label: "settlement-reports", baseRef: "main", worktreeLeaf: "settlement-reports" }],
    lifecycle: { materializationState: "materialized", worktreeCount: 1, observedAtUnixMs: now }, workflow: { state: "review", revision: 1, updatedAtUnixMs: now }, createdAtUnixMs: now - 172_800_000, updatedAtUnixMs: now - 600_000 }),
  workspaceFixture({ workspaceId: "33333333-3333-4333-8333-333333333333", title: "Review webhook delivery guarantees", intent: { type: "jira", issueKey: "PLATFORM-93" },
    createdAtUnixMs: now - 200_000, updatedAtUnixMs: now - 200_000 }),
];

export function materialization(workspace: WorkspaceView): WorkspaceMaterialization {
  return { schemaVersion: 1, workspaceId: workspace.workspaceId, workspaceRecordVersion: workspace.recordVersion,
    effectDigest: digest("a"), workspaceDisplayPath: workspace.workspaceDisplayPath,
    codeWorkspaceDisplayPath: `${workspace.workspaceDisplayPath}/workspace.code-workspace`, branchName: `wts/${workspace.intent.type === "jira" ? workspace.intent.issueKey.toLowerCase() : "task"}`,
    worktrees: workspace.repositories.map(repository => ({ repositoryId: repository.repositoryId ?? repository.requestId, label: repository.label,
      targetDisplayPath: `${workspace.workspaceDisplayPath}/${repository.worktreeLeaf}`, branchName: `wts/${workspace.intent.type === "jira" ? workspace.intent.issueKey.toLowerCase() : "task"}`, baseCommitOid: oid("a") })),
    graph: { status: "ready", detail: "The local fixture graph is ready." } };
}
export const patch = (file: string, before: string, after: string) => `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -1,4 +1,4 @@\n export function capture(request) {\n-${before}\n+${after}\n   return receipt;\n }\n`;
export function localDiff(workspaceId: string, repositoryId: string): WorkspaceRepositoryDiff {
  return { schemaVersion: 1, workspaceId, repositoryId, repositoryLabel: repositoryId === "repo_sdk" ? "payments-sdk" : "checkout-api",
    baseCommitOid: oid("a"), headCommitOid: oid("c"), patchSha256: digest("c"),
    patch: patch("src/capture.ts", "  const receipt = charge(request);", "  const receipt = captureOnce(request.id, request);"),
    patchTruncated: false, untrackedPaths: ["tests/capture-retry.test.ts"], untrackedPathsTruncated: false };
}
export function comparison(workspaceId: string, repositoryId: string): WorkspaceGitlabComparison {
  const publishedPatch = patch("src/capture.ts", "  const receipt = charge(request);", "  const receipt = captureOnce(request.id, request);")
    + patch("src/idempotency.ts", "  return cache.get(key);", "  return cache.getOrCreate(key);")
    + patch("tests/capture.test.ts", "  expect(captures).toHaveLength(2);", "  expect(captures).toHaveLength(1);");
  const local = localDiff(workspaceId, repositoryId);
  return { schemaVersion: 1, workspaceId, repositoryId, repositoryLabel: "checkout-api", iid: 16, localHeadCommitOid: oid("c"), status: "ready",
    published: { schemaVersion: 1, repositoryId, iid: 16, baseCommitOid: oid("a"), startCommitOid: oid("a"), headCommitOid: oid("b"),
      commits: [], discussions: [], patch: publishedPatch, patchTruncated: false, fromCache: false, fetchedAtUnixMs: now },
    latestWork: { ...local, patch: publishedPatch }, sinceMr: { ...local, baseCommitOid: oid("b"), patch: patch("src/capture.ts", "  const receipt = captureOnce(request.id, request);", "  const receipt = await captureOnce(request.id, request);") } };
}
export function discussions(repositoryId = "repo_checkout"): GitlabDiscussions {
  return { schemaVersion: 1, repositoryId, iid: 16, scopeId: "f".repeat(64), viewerLogin: "nandan", fetchedAtUnixMs: now, fromCache: false, truncated: false,
    discussions: [
      { id: "retry-condition", resolvable: true, resolved: false, automated: false, filePath: "src/capture.ts", side: "additions", line: 2,
        position: { baseCommitOid: oid("a"), startCommitOid: oid("a"), headCommitOid: oid("b") }, comments: [
          { id: 41, body: "Can two requests with the same key race here? Please preserve the original receipt when a retry arrives.", authorLogin: "priya", createdAt: "2026-09-18T08:00:00Z" },
          { id: 42, body: "I added a deterministic concurrent retry case. The second request now waits for the first result.", authorLogin: "nandan", createdAt: "2026-09-18T08:10:00Z" }] },
      { id: "test-coverage", resolvable: true, resolved: true, automated: false, filePath: "tests/capture.test.ts", side: "additions", line: 2,
        comments: [{ id: 43, body: "The duplicate-capture regression is covered. Thank you.", authorLogin: "alex", createdAt: "2026-09-18T08:15:00Z" }] },
      { id: "automation-summary", resolvable: false, resolved: false, automated: true,
        comments: [{ id: 44, body: "## Review summary\n\nAll required checks passed.\n\n- Unit checks: passed\n- Contract checks: passed\n- Retry coverage: reviewed\n\n" + "The automated result is fixture data. ".repeat(15), authorLogin: "review-bot", createdAt: "2026-09-18T08:18:00Z" }] },
    ] };
}
export const documents = {
  readme: "# Checkout retry workspace\n\nPreserve one receipt for each idempotency key.\n\n## Repositories\n\n- checkout-api: capture and retry handling\n- payments-sdk: client request identity\n",
  plan: "# Implementation plan\n\n## Goal\n\nReturn the original receipt for repeated checkout requests.\n\n- [x] Inspect the current capture flow.\n- [x] Add a concurrent retry regression.\n- [ ] Verify error recovery.\n\n```mermaid\nflowchart LR\n  Request --> Key{Known key?}\n  Key -->|Yes| Receipt[Saved receipt]\n  Key -->|No| Capture[Create capture]\n  Capture --> Receipt\n```\n",
  findings: "# Findings\n\n## Confirmed defect\n\nTwo concurrent requests could create two captures before the original receipt was saved.\n\n## Validation\n\nA deterministic test now holds the first request while the second request starts.\n",
  kanban: "# Kanban\n\n## Ready\n\n- [ ] Verify timeout recovery\n\n## In progress\n\n- [ ] Review the MR comments\n\n## Done\n\n- [x] Add duplicate-capture coverage\n",
};
