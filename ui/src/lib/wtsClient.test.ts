import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceClientError,
  createWorkspaceClient,
  type AgentSession,
  type CloneRepositoryResult,
  type CodeWorkspaceFileImportResult,
  type CreateWorkspaceRequest,
  type MaterializeWorkspaceResult,
  type RemoveWorkspaceResult,
  type RepositoryCatalog,
  type RuntimeAnalysisResult,
  type SetupSnapshot,
  type WorkspaceClientOptions,
  type WorkspaceEvidence,
  type WorkspaceList,
  type WorkspacePreflight,
  type WorkspaceRemovalPreflight,
  type WorkspaceTestRunDetail,
  type WorkspaceView,
} from "./wtsClient";

const workspace: WorkspaceView = {
  schemaVersion: 1,
  workspaceId: "ws-platform-42",
  recordVersion: 1,
  intent: { type: "jira", issueKey: "PLATFORM-42" },
  title: "Checkout retries create duplicate captures",
  phase: "draft",
  preferredProvider: "codex",
  repositories: [
    {
      requestId: "repo-checkout-api",
      label: "checkout-api",
      baseRef: "main",
      worktreeLeaf: "checkout-api",
    },
  ],
  observedWorkItems: [
    {
      issueKey: "PAY-2190",
      sourceFiles: ["PLAN.md"],
      observedAtUnixMs: 1_721_776_500_000,
    },
  ],
  workspaceRootId: "root-local",
  workspaceLeaf: "PLATFORM-42",
  workspaceDisplayPath: "~/cd/PLATFORM-42",
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
};

const workspaceList: WorkspaceList = {
  workspaceRootId: "root-local",
  workspaceRootDisplayPath: "~/cd",
  workspaces: [workspace],
};

const createRequest: CreateWorkspaceRequest = {
  intent: { type: "jira", issueKey: "PLATFORM-42" },
  title: "Checkout retries create duplicate captures",
  preferredProvider: "codex",
  repositories: [{ label: "checkout-api", baseRef: "main" }],
};

const setupSnapshot: SetupSnapshot = {
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
      id: "warp",
      category: "terminal",
      status: "ready",
      installation: "detected",
      setup: "notRequired",
      runtime: "idle",
      wtsSupport: "available",
      verificationKind: "configurationSignal",
      capabilities: ["terminalSession"],
      detail: "Warp.app is installed and can accept workspace CLI handoffs.",
      lastProbeAt: 1_721_776_400_000,
      blockingFor: [],
    },
    {
      id: "jiraMcp",
      category: "issueTracker",
      status: "notConfigured",
      installation: "detected",
      setup: "unverified",
      runtime: "idle",
      wtsSupport: "detectionOnly",
      verificationKind: "configurationSignal",
      capabilities: ["jiraIssueImport"],
      diagnosticCode: "authenticationNotVerified",
      lastProbeAt: 1_721_776_400_000,
      blockingFor: ["jiraIssueImport"],
    },
    {
      id: "openProject",
      category: "issueTracker",
      status: "notConfigured",
      installation: "detected",
      setup: "unverified",
      runtime: "idle",
      wtsSupport: "available",
      verificationKind: "configurationSignal",
      capabilities: ["openProjectWorkPackageImport"],
      diagnosticCode: "authenticationNotVerified",
      lastProbeAt: 1_721_776_400_000,
      blockingFor: [],
    },
  ],
};

const repositoryCatalog: RepositoryCatalog = {
  repositoryRootDisplayPath: "/Users/test/repos",
  repositories: [
    {
      id: "repo_checkout",
      label: "checkout-api",
      checkoutLeaf: "checkout-api",
      displayPath: "/Users/test/repos/checkout-api",
      defaultBranch: {
        name: "main",
        fullRef: "refs/heads/main",
        commitOid: "0123456789abcdef0123456789abcdef01234567",
      },
    },
  ],
  skippedEntries: 0,
};

const clonedRepository: CloneRepositoryResult = {
  repository: {
    id: "repo_new_api",
    label: "new-api",
    checkoutLeaf: "new-api",
    displayPath: "/Users/test/repos/new-api",
    defaultBranch: {
      name: "main",
      fullRef: "refs/heads/main",
      commitOid: "23456789abcdef0123456789abcdef0123456789",
    },
  },
  repositoryRootDisplayPath: "/Users/test/repos",
  reusedExisting: false,
};

const refreshedRepository = {
  ...repositoryCatalog.repositories[0]!,
  originUrl: "https://gitlab.example.com/platform/checkout-api.git",
  availableBranches: [
    {
      name: "main",
      fullRef: "refs/heads/main",
      commitOid: "0123456789abcdef0123456789abcdef01234567",
      remote: false,
    },
    {
      name: "dev-local",
      fullRef: "refs/remotes/origin/dev-local",
      commitOid: "1123456789abcdef0123456789abcdef01234567",
      remote: true,
    },
  ],
};

const codeWorkspaceImport: CodeWorkspaceFileImportResult = {
  importId: "0198-0188-code-workspace-import",
  fileName: "payments.code-workspace",
  suggestedTitle: "Payments workspace",
  suggestedRepositorySetLabel: "VS Code · payments",
  folders: [
    {
      name: "Checkout API",
      rawPath: "platform/checkout-api",
      status: "matched",
      repositoryId: "repo_checkout",
      repositoryLabel: "checkout-api",
      repositoryDisplayPath: "/Users/test/repos/checkout-api",
      baseRef: "develop",
      message: "Matched checkout-api.",
    },
    {
      name: "Old dashboard",
      rawPath: "../old-dashboard",
      status: "missing",
      repositoryLabel: undefined,
      repositoryDisplayPath: undefined,
      baseRef: undefined,
      message: "No local repository matched this folder.",
    },
  ],
  repositories: [
    {
      repositoryId: "repo_checkout",
      label: "checkout-api",
      baseRef: "develop",
    },
  ],
  warnings: [
    {
      code: "folderMissing",
      message: "Old dashboard was not added.",
      folderName: "Old dashboard",
    },
    {
      code: "configurationIgnored",
      message: "Workspace settings and tasks were ignored.",
      folderName: undefined,
    },
  ],
  diagnostics: {
    catalog: {
      repositoryRootDisplayPath: "/Users/test/repos",
      repositoryCount: 1,
      skippedEntries: 0,
      repositories: [
        {
          label: "checkout-api",
          displayPath: "/Users/test/repos/checkout-api",
        },
      ],
      repositoriesTruncated: false,
    },
    folders: [
      {
        folderIndex: 0,
        status: "matched",
        reason: "matchedRelativePathSuffix",
        resolutionBasis: "relativePathSuffix",
        attempts: [
          {
            basis: "relativePathSuffix",
            value: "platform/checkout-api",
            candidateCount: 1,
          },
          {
            basis: "pathBasename",
            value: "checkout-api",
            candidateCount: 1,
          },
        ],
        candidates: [
          {
            label: "checkout-api",
            displayPath: "/Users/test/repos/checkout-api",
          },
        ],
        candidatesTruncated: false,
        duplicateRepository: false,
      },
      {
        folderIndex: 1,
        status: "missing",
        reason: "noCatalogMatch",
        attempts: [
          {
            basis: "pathBasename",
            value: "old-dashboard",
            candidateCount: 0,
          },
        ],
        candidates: [],
        candidatesTruncated: false,
        duplicateRepository: false,
      },
    ],
  },
};

const runtimeAnalysis: RuntimeAnalysisResult = {
  analysisDigest: `sha256:${"a".repeat(64)}`,
  repositories: [
    {
      repositoryId: "repo_checkout",
      repositoryLabel: "checkout-api",
      requestedBaseRef: "main",
      resolvedBaseRef: "refs/heads/main",
      commitOid: "0123456789abcdef0123456789abcdef01234567",
    },
  ],
  services: [
    {
      candidateId: "candidate_checkout_api",
      serviceId: "checkout-api",
      displayName: "Checkout API",
      repositoryId: "repo_checkout",
      repositoryLabel: "checkout-api",
      commitOid: "0123456789abcdef0123456789abcdef01234567",
      workingDirectory: ".",
      command: ["npm", "run", "dev"],
      dependencies: [],
      ports: [
        {
          portId: "http",
          environment: "PORT",
          preferredPort: 3_000,
          policy: "prefer",
          confidence: "declared",
          evidence: [
            {
              repositoryId: "repo_checkout",
              commitOid: "0123456789abcdef0123456789abcdef01234567",
              path: "package.json",
              detector: "packageScript",
              detail: "The dev script starts the HTTP service.",
            },
          ],
        },
      ],
      confidence: "corroborated",
      evidence: [
        {
          repositoryId: "repo_checkout",
          commitOid: "0123456789abcdef0123456789abcdef01234567",
          path: "src/server.ts",
          detector: "listenCall",
          detail: "The server binds the configured port.",
        },
      ],
      includedByDefault: true,
    },
  ],
  warnings: [],
  graph: {
    status: "ready",
    detail: "Structural graph matched the declared service.",
  },
};

const preflight: WorkspacePreflight = {
  workspaceId: workspace.workspaceId,
  workspaceDisplayPath: workspace.workspaceDisplayPath,
  codeWorkspaceDisplayPath: `${workspace.workspaceDisplayPath}/wts.code-workspace`,
  branchName: "wts/platform-42-01234567",
  ready: true,
  effectDigest: "sha256:effect",
  repositories: [
    {
      repositoryId: "repo_checkout",
      label: "checkout-api",
      sourceDisplayPath: "/Users/test/repos/checkout-api",
      requestedBaseRef: "main",
      resolvedBaseRef: "refs/heads/main",
      baseCommitOid: "0123456789abcdef0123456789abcdef01234567",
      targetDisplayPath: `${workspace.workspaceDisplayPath}/checkout-api--012345`,
    },
  ],
  blockers: [],
  warnings: [],
  graph: { status: "notStarted", detail: "Not started." },
};

const materializeResult: MaterializeWorkspaceResult = {
  replayed: false,
  materialization: {
    schemaVersion: 1,
    workspaceId: workspace.workspaceId,
    workspaceRecordVersion: 1,
    effectDigest: preflight.effectDigest,
    workspaceDisplayPath: preflight.workspaceDisplayPath,
    codeWorkspaceDisplayPath: preflight.codeWorkspaceDisplayPath,
    branchName: preflight.branchName,
    worktrees: [
      {
        repositoryId: "repo_checkout",
        label: "checkout-api",
        targetDisplayPath: preflight.repositories[0]!.targetDisplayPath,
        branchName: preflight.branchName,
        baseCommitOid: preflight.repositories[0]!.baseCommitOid,
        gitState: {
          headCommitOid: preflight.repositories[0]!.baseCommitOid,
          originUrl: "https://github.com/example/checkout-api.git",
          upstreamFullRef: "refs/remotes/origin/main",
        },
      },
    ],
    graph: preflight.graph,
  },
};

const repositorySyncResult = {
  workspaceId: workspace.workspaceId,
  repositoryId: "repo_checkout",
  repositoryLabel: "checkout-api",
  previousBaseCommitOid: preflight.repositories[0]!.baseCommitOid,
  baseCommitOid: "718063770fb21d18f5fe92aac26da4ce18f52f48",
  updated: true,
  graphRefreshed: true,
  graphDetail: "Workspace graph refreshed.",
  materialization: {
    ...materializeResult.materialization,
    worktrees: [
      {
        ...materializeResult.materialization.worktrees[0]!,
        baseCommitOid: "718063770fb21d18f5fe92aac26da4ce18f52f48",
        gitState: {
          ...materializeResult.materialization.worktrees[0]!.gitState!,
          headCommitOid: "718063770fb21d18f5fe92aac26da4ce18f52f48",
        },
      },
    ],
    graph: { status: "ready" as const, detail: "Workspace graph refreshed." },
  },
};

const repositoryAlignmentPreflight = {
  workspaceId: workspace.workspaceId,
  repositoryId: "repo_checkout",
  repositoryLabel: "checkout-api",
  baseRef: "main",
  remoteFullRef: "refs/remotes/upstream/main",
  currentCommitOid: preflight.repositories[0]!.baseCommitOid,
  targetCommitOid: "718063770fb21d18f5fe92aac26da4ce18f52f48",
  backupFullRef: `refs/wts/backups/${preflight.repositories[0]!.baseCommitOid}`,
  effectDigest: `sha256:${"a".repeat(64)}`,
};

const repositoryAlignmentResult = {
  workspaceId: workspace.workspaceId,
  repositoryId: "repo_checkout",
  repositoryLabel: "checkout-api",
  previousBaseCommitOid: repositoryAlignmentPreflight.currentCommitOid,
  baseCommitOid: repositoryAlignmentPreflight.targetCommitOid,
  backupFullRef: repositoryAlignmentPreflight.backupFullRef,
  graphRefreshed: true,
  graphDetail: "Workspace graph refreshed.",
  materialization: repositorySyncResult.materialization,
};

const repositoryAdditionPreflight = {
  workspaceId: workspace.workspaceId,
  repositoryId: "repo_web",
  repositoryLabel: "checkout-web",
  baseRef: "main",
  resolvedBaseRef: "refs/heads/main",
  baseCommitOid: "718063770fb21d18f5fe92aac26da4ce18f52f48",
  targetDisplayPath: `${workspace.workspaceDisplayPath}/checkout-web`,
  branchName: preflight.branchName,
  effectDigest: `sha256:${"b".repeat(64)}`,
};

const repositoryAdditionResult = {
  workspaceId: workspace.workspaceId,
  repositoryId: "repo_web",
  repositoryLabel: "checkout-web",
  replayed: false,
  graphRefreshed: false,
  graphDetail: "Re-index the workspace graph.",
  materialization: {
    ...materializeResult.materialization,
    worktrees: [...materializeResult.materialization.worktrees, {
      repositoryId: "repo_web",
      label: "checkout-web",
      targetDisplayPath: repositoryAdditionPreflight.targetDisplayPath,
      branchName: repositoryAdditionPreflight.branchName,
      baseCommitOid: repositoryAdditionPreflight.baseCommitOid,
    }],
  },
};

const repositoryRemovalResult = {
  workspaceId: workspace.workspaceId,
  repositoryId: "repo_web",
  repositoryLabel: "checkout-web",
  graphRefreshed: false,
  graphDetail: "Re-index the workspace graph.",
  materialization: materializeResult.materialization,
};

const repositoryBaseOpenResult = {
  repositoryId: "repo_checkout",
  forge: "github" as const,
  host: "github.com",
  baseRef: "main",
  commitOid: "0123456789abcdef0123456789abcdef01234567",
  accepted: true,
};

const changeRequestDraft = {
  schemaVersion: 1,
  workspaceId: workspace.workspaceId,
  repositoryId: "repo_checkout",
  repositoryLabel: "checkout-api",
  forge: "gitlab" as const,
  host: "gitlab.example.test",
  sourceRemoteName: "upstream",
  sourceBranch: "feat/PLATFORM-7197",
  sourceHeadCommitOid: "0123456789abcdef0123456789abcdef01234567",
  targetBranch: "main",
  commitSubject: "feat: validate admission",
  proposedBySessionId: "33333333-3333-4333-8333-333333333333",
  proposedByProvider: "codex" as const,
  commits: [{
    commitOid: "0123456789abcdef0123456789abcdef01234567",
    subject: "feat: validate admission",
  }],
  changedFiles: ["src/admission.rs", "tests/admission.test.rs"],
  worktreeClean: true,
  remoteMatches: true,
  title: "PLATFORM-7197: Validate admission",
  body: "## Summary\n\n- Validate admission",
  workItems: [{
    linkId: "22222222-2222-4222-8222-222222222222",
    issueKey: "PLATFORM-7197",
    summary: "Validate admission",
  }],
  verificationStatus: "passed" as const,
  verificationSummary: "8 verification checks passed",
  effectDigest: `sha256:${"a".repeat(64)}`,
};

const branchPublication = {
  workspaceId: workspace.workspaceId,
  repositoryId: "repo_checkout",
  repositoryLabel: "checkout-api",
  remoteName: "origin",
  branchName: "feat/PLATFORM-7197",
  headCommitOid: "0123456789abcdef0123456789abcdef01234567",
};

const changeRequestOpenResult = {
  workspaceId: workspace.workspaceId,
  repositoryId: "repo_checkout",
  forge: "gitlab" as const,
  host: "gitlab.example.test",
  sourceBranch: "feat/PLATFORM-7197",
  targetBranch: "main",
  sourceHeadCommitOid: "0123456789abcdef0123456789abcdef01234567",
  accepted: true,
};

const removalPreflight: WorkspaceRemovalPreflight = {
  workspaceId: workspace.workspaceId,
  kind: "materializedWorkspace",
  workspaceDisplayPath: workspace.workspaceDisplayPath,
  ready: true,
  effectDigest:
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  worktrees: [
    {
      repositoryId: "repo_checkout",
      label: "checkout-api",
      targetDisplayPath: preflight.repositories[0]!.targetDisplayPath,
      branchName: preflight.branchName,
      headCommitOid: "89abcdef0123456789abcdef0123456789abcdef",
      present: true,
    },
  ],
  generatedPaths: [
    `${workspace.workspaceDisplayPath}/.wts`,
    `${workspace.workspaceDisplayPath}/wts.code-workspace`,
  ],
  protectedPaths: [],
  retainedBranches: [preflight.branchName],
  blockers: [],
  warnings: ["Close editors before removing this workspace."],
};

const removeResult: RemoveWorkspaceResult = {
  workspaceId: workspace.workspaceId,
  replayed: false,
  removedWorktreeCount: 1,
  retainedBranches: [preflight.branchName],
  removedGeneratedPaths: removalPreflight.generatedPaths,
};

const workspaceEvidence: WorkspaceEvidence = {
  context: {
    schemaVersion: 1,
    workspaceId: workspace.workspaceId,
    workspaceRecordVersion: 1,
    title: workspace.title,
    intent: workspace.intent,
    preferredProvider: workspace.preferredProvider,
    branchName: preflight.branchName,
    workspaceDisplayPath: workspace.workspaceDisplayPath,
    codeWorkspaceDisplayPath: preflight.codeWorkspaceDisplayPath,
    evidenceDisplayPath: `${workspace.workspaceDisplayPath}/.wts`,
    createdAtUnixMs: workspace.createdAtUnixMs,
    wtsVersion: "0.1.0",
    repositories: [
      {
        repositoryId: "repo_checkout",
        label: "checkout-api",
        requestedBaseRef: "main",
        resolvedBaseRef: "refs/heads/main",
        baseCommitOid: preflight.repositories[0]!.baseCommitOid,
        worktreeDisplayPath: preflight.repositories[0]!.targetDisplayPath,
      },
    ],
    allowedRepositoryIds: ["repo_checkout"],
  },
  graphManifest: {
    schemaVersion: 1,
    workspaceId: workspace.workspaceId,
    status: "notStarted",
    graphDisplayPath: null,
    graphSha256: null,
    indexedAtUnixMs: null,
    indexedRepositories: [],
    detail: "Not indexed.",
  },
  verificationPlan: {
    schemaVersion: 1,
    workspaceId: workspace.workspaceId,
    revision: 1,
    updatedAtUnixMs: workspace.updatedAtUnixMs,
    checks: [],
  },
  verificationResult: {
    schemaVersion: 1,
    workspaceId: workspace.workspaceId,
    planRevision: 1,
    status: "notRun",
    startedAtUnixMs: null,
    completedAtUnixMs: null,
    durationMs: null,
    checks: [],
    warnings: [],
  },
  verificationHistory: [],
  agentReport: {
    schemaVersion: 1,
    workspaceId: workspace.workspaceId,
    status: "notReported",
    displayPath: `${workspace.workspaceDisplayPath}/.wts/agent-report.json`,
    updatedAtUnixMs: null,
    summary: "",
    findings: [],
    nextActions: [],
    proposedChecks: [
      {
        id: "checkout-cargo-test",
        label: "Checkout unit tests",
        kind: "unit",
        repositoryId: "repo_checkout",
        workingDirectory: preflight.repositories[0]!.targetDisplayPath,
        executable: "cargo",
        args: ["test", "--quiet"],
        timeoutMs: 120_000,
        environmentNames: ["CI"],
        reason: "The checkout implementation is a Rust crate.",
        evidence: ["checkout-api/Cargo.toml:1"],
      },
    ],
    validationFlows: [
      {
        id: "checkout-retry",
        title: "Retry a checkout",
        goal: "Confirm retries are idempotent.",
        prerequisites: ["A checkout fixture."],
        steps: [
          {
            id: "retry",
            action: "Submit the same request twice.",
            expected: "Only one capture is created.",
            evidence: ["checkout-api/src/retry.rs:84"],
          },
        ],
      },
    ],
    scope: {
      coverage: "unassessed",
      graphStatus: "notStarted",
      reviewedRepositoryIds: [],
      unresolvedRepositoryIds: [],
      skippedRepositories: [],
    },
    environment: {
      status: "unassessed",
      summary: "",
      requirements: [],
      setupSteps: [],
      unresolved: [],
    },
    flows: [],
    detail: "No agent report has been published.",
  },
  agentRuns: [],
};

const workspaceTestRun = {
  schemaVersion: 1,
  runId: "run-help-001",
  workspaceId: workspace.workspaceId,
  journeyId: "wts-help-preferences",
  title: "Help and Preferences",
  state: "passed",
  startedAtUnixMs: 1_721_776_401_000,
  completedAtUnixMs: 1_721_776_402_240,
  durationMs: 1_240,
  passedSteps: 4,
  failedSteps: 0,
  totalSteps: 4,
  failedStepId: null,
  message: null,
  artifactsDisplayPath: "/tmp/wts/runs/run-help-001",
  graphSha256: null,
} as const;

const workspaceTestRuns = {
  schemaVersion: 1,
  workspaceId: workspace.workspaceId,
  runs: [workspaceTestRun],
} as const;

// Mirrors the camelCase JSON emitted by Rust's TestRunResult. Optional values
// are deliberately omitted where serde(skip_serializing_if = "Option::is_none")
// applies so the client contract also covers its null normalization.
const workspaceTestRunDetailWire = {
  schemaVersion: 1,
  runId: workspaceTestRun.runId,
  workspaceId: workspace.workspaceId,
  journeyId: workspaceTestRun.journeyId,
  state: "failed",
  startedAtUnixMs: 1_721_776_401_000,
  completedAtUnixMs: 1_721_776_402_240,
  durationMs: 1_240,
  steps: [
    {
      stepId: "open-help",
      label: "Open Help",
      kind: "click",
      state: "passed",
      startedAtUnixMs: 1_721_776_401_100,
      completedAtUnixMs: 1_721_776_401_220,
      durationMs: 120,
    },
    {
      stepId: "check-preferences",
      label: "Check Preferences",
      kind: "assertVisible",
      state: "failed",
      startedAtUnixMs: 1_721_776_401_900,
      completedAtUnixMs: 1_721_776_402_100,
      durationMs: 200,
      screenshotArtifactId: "failure-shot-1",
      error: "Preferences dialog was not visible",
    },
  ],
  consoleErrors: [
    {
      kind: "pageerror",
      text: "Preferences failed to render",
      timestampUnixMs: 1_721_776_402_000,
    },
  ],
  requests: [
    {
      method: "GET",
      url: "http://127.0.0.1:<redacted>/api/v1/setup",
      status: 500,
    },
  ],
  artifacts: [
    {
      artifactId: "failure-shot-1",
      kind: "failureScreenshot",
      relativePath: "artifacts/failure-shot-1.png",
      displayPath: "~/cd/.wts/test-runs/run-help-001/failure-shot-1.png",
      bytes: 4_096,
      sha256: "a".repeat(64),
    },
  ],
  failure: {
    failedStepId: "check-preferences",
    failedStepKind: "assertVisible",
    name: "AssertionError",
    message: "Preferences dialog was not visible",
    consoleErrors: [
      {
        kind: "pageerror",
        text: "Preferences failed to render",
        timestampUnixMs: 1_721_776_402_000,
      },
    ],
    failedRequests: [
      {
        method: "GET",
        url: "http://127.0.0.1:<redacted>/api/v1/setup",
        failure: "HTTP 500",
      },
    ],
    artifactIds: ["failure-shot-1"],
  },
} as const;

const workspaceTestRunDetail: WorkspaceTestRunDetail = {
  ...workspaceTestRunDetailWire,
  state: "failed",
  steps: [
    {
      ...workspaceTestRunDetailWire.steps[0],
      state: "passed",
      snapshotArtifactId: null,
      screenshotArtifactId: null,
      error: null,
    },
    {
      ...workspaceTestRunDetailWire.steps[1],
      state: "failed",
      snapshotArtifactId: null,
    },
  ],
  consoleErrors: [...workspaceTestRunDetailWire.consoleErrors],
  requests: [
    {
      ...workspaceTestRunDetailWire.requests[0],
      failure: null,
    },
  ],
  artifacts: [...workspaceTestRunDetailWire.artifacts],
  failure: {
    ...workspaceTestRunDetailWire.failure,
    consoleErrors: [...workspaceTestRunDetailWire.failure.consoleErrors],
    failedRequests: [
      {
        ...workspaceTestRunDetailWire.failure.failedRequests[0],
        status: null,
      },
    ],
    artifactIds: [...workspaceTestRunDetailWire.failure.artifactIds],
  },
  graphSha256: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("HTTP workspace client", () => {
  it("waits for a busy local host before it shows a read failure", async () => {
    vi.useFakeTimers();
    try {
      const busy = () => new Response(JSON.stringify({ error: { code: "operation_capacity_exhausted", message: "WTS is already running the maximum number of local operations. Retry shortly." } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "1" },
      });
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
        .mockResolvedValueOnce(busy())
        .mockResolvedValueOnce(jsonResponse(workspaceList));
      const client = createWorkspaceClient({ runtime: "http", fetch: fetchMock });

      const listed = client.listWorkspaces();
      await vi.advanceTimersByTimeAsync(1000);
      await expect(listed).resolves.toEqual(workspaceList);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      const exhausted = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
        .mockImplementation(async () => busy());
      const failing = createWorkspaceClient({ runtime: "http", fetch: exhausted });
      const failed = failing.listWorkspaces().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(failed).resolves.toMatchObject({ code: "operation_capacity_exhausted", status: 429 });
      expect(exhausted).toHaveBeenCalledTimes(5);

      const mutation = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
        .mockResolvedValueOnce(busy());
      const mutating = createWorkspaceClient({ runtime: "http", fetch: mutation });
      await expect(mutating.createWorkspace(createRequest, "busy-idem")).rejects.toMatchObject({ status: 429 });
      expect(mutation).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a bounded repository diff through the opaque workspace route", async () => {
    const response = {
      schemaVersion: 1,
      workspaceId: workspace.workspaceId,
      repositoryId: "repo-checkout-api",
      repositoryLabel: "checkout-api",
      baseCommitOid: "0123456789abcdef0123456789abcdef01234567",
      headCommitOid: "fedcba9876543210fedcba9876543210fedcba98",
      patchSha256: `sha256:${"a".repeat(64)}`,
      patch: "diff --git a/README.md b/README.md\n",
      patchTruncated: false,
      untrackedPaths: ["notes.txt"],
      untrackedPathsTruncated: false,
    };
    const graph = {
      graphSha256: "sha256:review",
      nodes: [
        {
          id: "checkout",
          label: "checkout",
          sourceFile: "src/checkout.ts",
          sourceLocation: "L12",
        },
      ],
      links: [],
      truncated: false,
    };
    const fileReview = {
      schemaVersion: 1,
      workspaceId: workspace.workspaceId,
      repositoryId: "repo-checkout-api",
      repositoryLabel: "checkout-api",
      baseCommitOid: "0123456789abcdef0123456789abcdef01234567",
      headCommitOid: "fedcba9876543210fedcba9876543210fedcba98",
      filePath: "src/retry policy.ts",
      patchSha256: `sha256:${"a".repeat(64)}`,
      contentSha256: `sha256:${"b".repeat(64)}`,
      content: "complete file\n",
      fullPatch: "diff --git a/src/retry policy.ts b/src/retry policy.ts\n",
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(response))
      .mockResolvedValueOnce(jsonResponse(fileReview))
      .mockResolvedValueOnce(jsonResponse(graph));
    const client = createWorkspaceClient({ runtime: "http", fetch: fetchMock });

    await expect(
      client.getWorkspaceRepositoryDiff(
        workspace.workspaceId,
        "repo-checkout-api",
      ),
    ).resolves.toEqual(response);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/v1/workspaces/${workspace.workspaceId}/repositories/repo-checkout-api/diff`,
    );
    await expect(
      client.getWorkspaceRepositoryFileReview(
        workspace.workspaceId,
        "repo-checkout-api",
        "src/retry policy.ts",
        `sha256:${"a".repeat(64)}`,
      ),
    ).resolves.toEqual(fileReview);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `/api/v1/workspaces/${workspace.workspaceId}/repositories/repo-checkout-api/file?path=src%2Fretry%20policy.ts&expectedPatchSha256=sha256%3A${"a".repeat(64)}`,
    );
    await expect(
      client.getWorkspaceRepositoryReviewGraph(
        workspace.workspaceId,
        "repo-checkout-api",
      ),
    ).resolves.toEqual(graph);
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      `/api/v1/workspaces/${workspace.workspaceId}/repositories/repo-checkout-api/review-graph`,
    );
  });

  it("reads sessions, ActivityWatch health, and an explicit bounded review through authenticated GET routes", async () => {
    const sessionList = {
      schemaVersion: 1,
      sessions: [],
      observedSessions: [
        {
          schemaVersion: 1,
          sessionId: "33333333-3333-4333-8333-333333333333",
          workspaceId: workspace.workspaceId,
          provider: "copilot",
          source: "copilotVscodeSnapshot",
          status: "working",
          activity: "editing",
          model: "claude-sonnet-4.5",
          startedAtUnixMs: 1_785_402_000_000,
          lastEventAtUnixMs: 1_785_402_100_000,
        },
      ],
    };
    const activityWatchStatus = {
      state: "unavailable",
      installation: "unknown",
      endpoint: "http://127.0.0.1:5600",
      capabilities: ["status"],
      detail: "ActivityWatch is not reachable.",
      diagnosticCode: "connectionFailed",
    };
    const activityWatchReview = {
      schemaVersion: 1,
      startedAtUnixMs: 1_785_402_000_000,
      endedAtUnixMs: 1_785_403_200_000,
      totalActiveSeconds: 1_140,
      sessions: [
        {
          id: "aw-0001",
          kind: "coding",
          startedAtUnixMs: 1_785_402_000_000,
          endedAtUnixMs: 1_785_403_200_000,
          durationSeconds: 1_140,
          description: "Coding work for PLATFORM-42",
          jiraIssueKey: "PLATFORM-42",
          suggestedJiraIssueKey: "PLATFORM-42",
          jiraSuggestionConfidence: 88,
          jiraSuggestionReason:
            "Activity context matches 3 distinctive words in the Jira summary",
          sourceEventCount: 2,
        },
      ],
      detail: "Derived locally without raw ActivityWatch event data.",
    };
    const activeJiraIssues = {
      schemaVersion: 1,
      issues: [
        {
          issueKey: "PLATFORM-42",
          summary: "Retry duplicate captures",
          status: "In Progress",
        },
      ],
      detail: "Assigned active Jira issues.",
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(sessionList))
      .mockResolvedValueOnce(jsonResponse(activityWatchStatus))
      .mockResolvedValueOnce(jsonResponse(activityWatchReview))
      .mockResolvedValueOnce(jsonResponse(activeJiraIssues));
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(client.listAgentSessions()).resolves.toEqual(sessionList);
    await expect(client.getActivityWatchStatus()).resolves.toEqual(
      activityWatchStatus,
    );
    await expect(
      client.getActivityWatchDailyReview(
        1_785_402_000_000,
        1_785_403_200_000,
      ),
    ).resolves.toEqual(activityWatchReview);
    await expect(client.listActiveJiraIssues()).resolves.toEqual(
      activeJiraIssues,
    );
    expect(fetchMock.mock.calls.slice(1).map(([url]) => url)).toEqual([
      "/api/v1/agent-sessions",
      "/api/v1/integrations/activity-watch/status",
      "/api/v1/integrations/activity-watch/daily-review?startedAtUnixMs=1785402000000&endedAtUnixMs=1785403200000",
      "/api/v1/jira/issues/active",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: { "X-WTS-Session": "session-123" },
    });
  });

  it("bootstraps once, reuses the session, and sends authenticated JSON", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(workspaceList))
      .mockResolvedValueOnce(
        jsonResponse({ workspace, replayed: false }, 201),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    const legacyList = await client.listWorkspaces();
    expect(legacyList).toEqual(workspaceList);
    expect(legacyList.workspaces[0]?.repositories[0]).not.toHaveProperty(
      "repositoryId",
    );
    await expect(
      client.createWorkspace(createRequest, "idem-123"),
    ).resolves.toEqual({ workspace, replayed: false });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/v1/bootstrap",
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-WTS-Request": "local-ui",
        },
      },
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/v1/workspaces",
      {
        headers: {
          Accept: "application/json",
          "X-WTS-Request": "local-ui",
          "X-WTS-Session": "session-123",
        },
      },
    ]);
    expect(fetchMock.mock.calls[2]).toEqual([
      "/api/v1/workspaces",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": "idem-123",
          "X-WTS-Request": "local-ui",
          "X-WTS-Session": "session-123",
        },
        body: JSON.stringify(createRequest),
      },
    ]);
  });

  it("persists a trimmed workspace display name through the HTTP rename contract", async () => {
    const renamed = { ...workspace, displayName: "Payments incident" };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(renamed));
    const client = createWorkspaceClient({ runtime: "http", fetch: fetchMock });

    await expect(
      client.renameWorkspace(workspace.workspaceId, "  Payments incident  "),
    ).resolves.toEqual(renamed);
    expect(fetchMock.mock.calls[1]).toEqual([
      `/api/v1/workspaces/${workspace.workspaceId}`,
      {
        method: "PATCH",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-WTS-Request": "local-ui",
          "X-WTS-Session": "session-123",
        },
        body: JSON.stringify({ title: "Payments incident" }),
      },
    ]);
  });

  it("sends agent lifecycle transitions through the authenticated local protocol", async () => {
    const running = {
      schemaVersion: 1,
      sessionId: "11111111-1111-4111-8111-111111111111",
      workspaceId: workspace.workspaceId,
      provider: "codex",
      terminal: "terminal",
      category: "implementation",
      status: "running",
      startedAtUnixMs: 2_000,
      lastHeartbeatAtUnixMs: 2_000,
      endedAtUnixMs: null,
      failure: null,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(running))
      .mockResolvedValueOnce(
        jsonResponse({ ...running, lastHeartbeatAtUnixMs: 3_000 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ...running,
          status: "completed",
          lastHeartbeatAtUnixMs: 4_000,
          endedAtUnixMs: 4_000,
        }),
      );
    const client = createWorkspaceClient({ runtime: "http", fetch: fetchMock });

    const started = await client.startAgentSessionPrototype(workspace.workspaceId);
    await expect(client.heartbeatAgentSession(started.sessionId)).resolves.toMatchObject({
      status: "running",
      lastHeartbeatAtUnixMs: 3_000,
    });
    await expect(client.completeAgentSession(started.sessionId)).resolves.toMatchObject({
      status: "completed",
      endedAtUnixMs: 4_000,
    });

    expect(fetchMock.mock.calls.slice(1).map(([url, init]) => [url, init?.method])).toEqual([
      [`/api/v1/workspaces/${workspace.workspaceId}/agent-sessions`, "POST"],
      [`/api/v1/agent-sessions/${running.sessionId}/heartbeat`, "POST"],
      [`/api/v1/agent-sessions/${running.sessionId}/complete`, "POST"],
    ]);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({
        provider: "codex",
        terminal: "terminal",
        category: "implementation",
      }),
    );
  });

  it("launches and stops an owned agent through the authenticated HTTP contract", async () => {
    const launching: AgentSession = {
      schemaVersion: 1,
      sessionId: "22222222-2222-4222-8222-222222222222",
      workspaceId: workspace.workspaceId,
      provider: "codex",
      terminal: "terminal",
      category: "implementation",
      status: "launching",
      startedAtUnixMs: 5_000,
      lastHeartbeatAtUnixMs: 5_000,
      endedAtUnixMs: null,
      failure: null,
    };
    const stopping: AgentSession = { ...launching, status: "stopping" };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(launching))
      .mockResolvedValueOnce(jsonResponse(stopping));
    const client = createWorkspaceClient({ runtime: "http", fetch: fetchMock });

    await expect(
      client.launchAgentSession(workspace.workspaceId, {
        provider: "codex",
        prompt: "  Implement the approved task.  ",
        category: "implementation",
      }),
    ).resolves.toEqual(launching);
    await expect(client.stopAgentSession(launching.sessionId)).resolves.toEqual(
      stopping,
    );

    expect(fetchMock.mock.calls[1]).toEqual([
      `/api/v1/workspaces/${workspace.workspaceId}/agents/codex/sessions`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          prompt: "Implement the approved task.",
          category: "implementation",
        }),
      }),
    ]);
    expect(fetchMock.mock.calls[2]?.slice(0, 1)).toEqual([
      `/api/v1/agent-sessions/${launching.sessionId}/stop`,
    ]);
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("POST");
  });

  it("reads bounded live detail for a WTS-managed agent session", async () => {
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const detail = {
      schemaVersion: 1,
      sessionId,
      workspaceId: workspace.workspaceId,
      provider: "codex",
      task: "Implement the approved task.",
      modelSelection: {
        authority: "providerDefault",
      },
      events: [
        {
          sequence: 1,
          observedAtUnixMs: 5_100,
          kind: "runsCommand",
          summary: "Codex runs a command.",
        },
      ],
      eventsTruncated: false,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(detail));
    const client = createWorkspaceClient({ runtime: "http", fetch: fetchMock });

    await expect(client.getAgentSessionDetail(sessionId)).resolves.toEqual(detail);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/v1/agent-sessions/${sessionId}`,
    );
  });

  it("forwards an optional repository identity pin when creating a workspace", async () => {
    const pinnedRequest: CreateWorkspaceRequest = {
      ...createRequest,
      repositories: [
        {
          repositoryId: "repo-checkout-api",
          label: "checkout-api-main",
          baseRef: "main",
        },
      ],
    };
    const pinnedWorkspace: WorkspaceView = {
      ...workspace,
      repositories: [
        {
          ...workspace.repositories[0]!,
          repositoryId: "repo-checkout-api",
          label: "checkout-api-main",
        },
      ],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({ workspace: pinnedWorkspace, replayed: false }, 201),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.createWorkspace(pinnedRequest, "pinned-idem"),
    ).resolves.toEqual({
      workspace: pinnedWorkspace,
      replayed: false,
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify(pinnedRequest),
    });
  });

  it("serializes and normalizes a reviewed runtime selection with its pinned repository", async () => {
    const runtime = {
      analysisDigest: runtimeAnalysis.analysisDigest,
      services: [
        {
          candidateId: "candidate_checkout_api",
          ports: [
            {
              portId: "http",
              preferredPort: 4_100,
              policy: "fixed" as const,
            },
          ],
        },
      ],
    };
    const request: CreateWorkspaceRequest = {
      ...createRequest,
      repositories: [
        {
          repositoryId: "repo_checkout",
          label: "checkout-api",
          baseRef: "main",
        },
      ],
      runtime,
    };
    const runtimeWorkspace: WorkspaceView = {
      ...workspace,
      repositories: [
        {
          ...workspace.repositories[0]!,
          repositoryId: "repo_checkout",
        },
      ],
      runtime,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({ workspace: runtimeWorkspace, replayed: false }, 201),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.createWorkspace(request, "runtime-idem"),
    ).resolves.toEqual({
      workspace: runtimeWorkspace,
      replayed: false,
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify(request),
    });
  });

  it("serializes and normalizes a bounded planning-home selection", async () => {
    const planning = {
      folder: "plansAndKanban" as const,
      format: "kanban" as const,
    };
    const request: CreateWorkspaceRequest = {
      ...createRequest,
      planning,
    };
    const planningWorkspace: WorkspaceView = {
      ...workspace,
      planning,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({ workspace: planningWorkspace, replayed: false }, 201),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.createWorkspace(request, "planning-idem"),
    ).resolves.toEqual({
      workspace: planningWorkspace,
      replayed: false,
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify(request),
    });
  });

  it.each([null, 42, " "])(
    "rejects malformed repository identity pins from workspace views: %p",
    async (repositoryId) => {
      const invalidWorkspace = {
        ...workspace,
        repositories: [
          {
            ...workspace.repositories[0],
            repositoryId,
          },
        ],
      };
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
        .mockResolvedValueOnce(
          jsonResponse({
            ...workspaceList,
            workspaces: [invalidWorkspace],
          }),
        );
      const client = createWorkspaceClient({
        runtime: "http",
        fetch: fetchMock,
      });

      await expect(client.listWorkspaces()).rejects.toMatchObject({
        code: "invalid_response",
        message:
          "WTS returned an invalid workspace payload at workspaceList.workspaces[0].repositories[0].repositoryId",
      });
    },
  );

  it("rejects a null repository identity pin before workspace creation", async () => {
    const invalidRequest = {
      ...createRequest,
      repositories: [
        {
          ...createRequest.repositories[0],
          repositoryId: null,
        },
      ],
    } as unknown as CreateWorkspaceRequest;
    const fetchMock = vi.fn<typeof fetch>();
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.createWorkspace(invalidRequest, "invalid-pin"),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message:
        "Invalid workspace creation request at createWorkspaceRequest.repositories[0].repositoryId",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes an OpenProject workspace intent without losing canonical identity", async () => {
    const openProjectWorkspace: WorkspaceView = {
      ...workspace,
      intent: {
        type: "openProject",
        workPackageId: 42,
        displayId: "APP-42",
      },
    };
    const response = {
      ...workspaceList,
      workspaces: [openProjectWorkspace],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(response));
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(client.listWorkspaces()).resolves.toEqual(response);
  });

  it("uses opaque workspace actions for setup, preflight, materialization, and VS Code", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(setupSnapshot))
      .mockResolvedValueOnce(jsonResponse(repositoryCatalog))
      .mockResolvedValueOnce(jsonResponse(preflight))
      .mockResolvedValueOnce(jsonResponse(null))
      .mockResolvedValueOnce(jsonResponse(materializeResult))
      .mockResolvedValueOnce(
        jsonResponse({
          provider: "vsCode",
          accepted: true,
          workspaceId: workspace.workspaceId,
          codeWorkspaceDisplayPath: preflight.codeWorkspaceDisplayPath,
        }),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(client.getSetupSnapshot()).resolves.toEqual(setupSnapshot);
    await expect(client.listRepositories()).resolves.toEqual(
      repositoryCatalog,
    );
    await expect(
      client.preflightWorkspace(workspace.workspaceId),
    ).resolves.toEqual(preflight);
    await expect(
      client.getWorkspaceMaterialization(workspace.workspaceId),
    ).resolves.toBeNull();
    await expect(
      client.materializeWorkspace(
        workspace.workspaceId,
        preflight.effectDigest,
        "materialize-key",
      ),
    ).resolves.toEqual(materializeResult);
    await expect(
      client.openWorkspaceInVscode(workspace.workspaceId),
    ).resolves.toMatchObject({ provider: "vsCode", accepted: true });

    expect(fetchMock.mock.calls.slice(1).map(([url]) => url)).toEqual([
      "/api/v1/setup",
      "/api/v1/repositories",
      `/api/v1/workspaces/${workspace.workspaceId}/preflight`,
      `/api/v1/workspaces/${workspace.workspaceId}/materialization`,
      `/api/v1/workspaces/${workspace.workspaceId}/materialize`,
      `/api/v1/workspaces/${workspace.workspaceId}/open/vscode`,
    ]);
    expect(fetchMock.mock.calls[5]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        "Idempotency-Key": "materialize-key",
        "X-WTS-Session": "session-123",
      },
      body: JSON.stringify({ effectDigest: preflight.effectDigest }),
    });
    expect(fetchMock.mock.calls[6]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        "X-WTS-Session": "session-123",
      },
    });
  });

  it("preserves a checkout folder name that differs from the repository label", async () => {
    const nestedCatalog: RepositoryCatalog = {
      ...repositoryCatalog,
      repositories: [
        {
          ...repositoryCatalog.repositories[0]!,
          label: "checkout-api-main",
          checkoutLeaf: "checkout-api",
          displayPath: "/Users/test/repos/platform/checkout-api",
        },
      ],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(nestedCatalog));
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(client.listRepositories()).resolves.toEqual(nestedCatalog);
  });

  it("rejects a repository catalog without its canonical checkout folder name", async () => {
    const invalidRepository = {
      ...repositoryCatalog.repositories[0],
    } as Record<string, unknown>;
    delete invalidRepository.checkoutLeaf;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({
          ...repositoryCatalog,
          repositories: [invalidRepository],
        }),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(client.listRepositories()).rejects.toMatchObject({
      code: "invalid_response",
      message:
        "WTS returned an invalid workspace payload at repositoryCatalog.repositories[0].checkoutLeaf",
    });
  });

  it("uses reviewed manual commands for re-index and workspace removal", async () => {
    const graph = {
      workspaceId: workspace.workspaceId,
      status: "ready",
      graphDisplayPath: `${workspace.workspaceDisplayPath}/graphify-out/graph.json`,
      detail: "Workspace graph refreshed.",
      durationMs: 184,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(graph))
      .mockResolvedValueOnce(jsonResponse(removalPreflight))
      .mockResolvedValueOnce(jsonResponse(removeResult));
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.reindexWorkspaceGraph(workspace.workspaceId),
    ).resolves.toEqual(graph);
    await expect(
      client.preflightWorkspaceRemoval(workspace.workspaceId),
    ).resolves.toEqual(removalPreflight);
    await expect(
      client.removeWorkspace(
        workspace.workspaceId,
        removalPreflight.effectDigest,
        "remove-key",
        true,
      ),
    ).resolves.toEqual(removeResult);

    expect(fetchMock.mock.calls.slice(1).map(([url]) => url)).toEqual([
      `/api/v1/workspaces/${workspace.workspaceId}/graph/reindex`,
      `/api/v1/workspaces/${workspace.workspaceId}/removal-preflight`,
      `/api/v1/workspaces/${workspace.workspaceId}/remove`,
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBeUndefined();
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        "Idempotency-Key": "remove-key",
        "X-WTS-Session": "session-123",
      },
      body: JSON.stringify({
        effectDigest: removalPreflight.effectDigest,
        deleteProtectedPaths: true,
      }),
    });
  });

  it("syncs one repository through the trusted HTTP identity route", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(repositorySyncResult));
    const client = createWorkspaceClient({ runtime: "http", fetch: fetchMock });

    await expect(
      client.syncWorkspaceRepository(
        ` ${workspace.workspaceId} `,
        " repo_checkout ",
      ),
    ).resolves.toEqual(repositorySyncResult);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/v1/workspaces/${workspace.workspaceId}/repositories/repo_checkout/sync`,
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        "X-WTS-Request": "local-ui",
        "X-WTS-Session": "session-123",
      },
    });
  });

  it("previews and applies repository alignment through digest-bound HTTP routes", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(repositoryAlignmentPreflight))
      .mockResolvedValueOnce(jsonResponse(repositoryAlignmentResult));
    const client = createWorkspaceClient({ runtime: "http", fetch: fetchMock });

    await expect(
      client.preflightWorkspaceRepositoryAlignment(
        workspace.workspaceId,
        "repo_checkout",
      ),
    ).resolves.toEqual(repositoryAlignmentPreflight);
    await expect(
      client.alignWorkspaceRepository(
        workspace.workspaceId,
        "repo_checkout",
        repositoryAlignmentPreflight.effectDigest,
      ),
    ).resolves.toEqual(repositoryAlignmentResult);

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/v1/workspaces/${workspace.workspaceId}/repositories/repo_checkout/alignment-preflight`,
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `/api/v1/workspaces/${workspace.workspaceId}/repositories/repo_checkout/align`,
    );
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        effectDigest: repositoryAlignmentPreflight.effectDigest,
      }),
    });
  });

  it("reviews and adds a repository through the current workspace HTTP routes", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(repositoryAdditionPreflight))
      .mockResolvedValueOnce(jsonResponse(repositoryAdditionResult))
      .mockResolvedValueOnce(jsonResponse(repositoryRemovalResult));
    const client = createWorkspaceClient({ runtime: "http", fetch: fetchMock });

    await client.preflightWorkspaceRepositoryAddition(workspace.workspaceId, "repo_web", "main");
    await client.addWorkspaceRepository(
      workspace.workspaceId,
      "repo_web",
      "main",
      repositoryAdditionPreflight.effectDigest,
    );
    await expect(
      client.removeWorkspaceRepository(workspace.workspaceId, "repo_web"),
    ).resolves.toEqual(repositoryRemovalResult);

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/v1/workspaces/${workspace.workspaceId}/repositories/addition-preflight`,
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ repositoryId: "repo_web", baseRef: "main" }),
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `/api/v1/workspaces/${workspace.workspaceId}/repositories`,
    );
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        repositoryId: "repo_web",
        baseRef: "main",
        effectDigest: repositoryAdditionPreflight.effectDigest,
      }),
    });
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      `/api/v1/workspaces/${workspace.workspaceId}/repositories/repo_web`,
    );
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("rejects a contradictory removal preview before enabling removal", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({
          ...removalPreflight,
          ready: true,
          blockers: [
            {
              code: "worktreeChanges",
              message: "The worktree contains local changes.",
              repositoryLabel: "checkout-api",
            },
          ],
        }),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.preflightWorkspaceRemoval(workspace.workspaceId),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message:
        "WTS returned an invalid workspace payload at workspaceRemovalPreflight",
    });
  });

  it("surfaces structured server errors without substituting sample data", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "workspace_store_unavailable",
              message: "The local workspace registry could not be read",
              retryable: true,
            },
          },
          503,
        ),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    const error = await client.listWorkspaces().catch((reason) => reason);

    expect(error).toBeInstanceOf(WorkspaceClientError);
    expect(error).toMatchObject({
      code: "workspace_store_unavailable",
      message: "The local workspace registry could not be read",
      retryable: true,
      status: 503,
    });
  });

  it("imports a VS Code workspace file through the explicit HTTP contract", async () => {
    const contents = JSON.stringify({
      folders: [{ name: "Checkout API", path: "platform/checkout-api" }],
      settings: { "editor.formatOnSave": true },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(codeWorkspaceImport));
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.importCodeWorkspaceFile({
        fileName: " payments.code-workspace ",
        contents,
      }),
    ).resolves.toEqual(codeWorkspaceImport);

    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/v1/code-workspaces/import",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-WTS-Session": "session-123",
        }),
        body: JSON.stringify({
          fileName: "payments.code-workspace",
          contents,
        }),
      }),
    ]);
  });

  it("clones one shallow branch through the explicit HTTP contract", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(clonedRepository));
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.cloneRepository({
        remoteUrl: " git@gitlab.example.com:platform/new-api.git ",
        branch: " master ",
        shallow: true,
      }),
    ).resolves.toEqual(clonedRepository);

    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/v1/repositories/clone",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-WTS-Session": "session-123",
        }),
        body: JSON.stringify({
          remoteUrl: "git@gitlab.example.com:platform/new-api.git",
          branch: "master",
          shallow: true,
        }),
      }),
    ]);
  });

  it.each(["http", "tauri"] as const)("preserves the selected clone base separately from the default branch through %s", async (runtime) => {
    const result = { ...clonedRepository, selectedBaseRef: "release/2026.07" };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(result));
    const invokeMock = vi.fn(async (): Promise<unknown> => result);
    const client = createWorkspaceClient({
      runtime,
      fetch: fetchMock,
      invoke: invokeMock as NonNullable<WorkspaceClientOptions["invoke"]>,
    });

    await expect(client.cloneRepository({
      remoteUrl: "https://gitlab.example.com/platform/new-api.git",
      branch: "release/2026.07",
    })).resolves.toEqual(result);
  });

  it.each(["", 42, null])("rejects an invalid selected clone base %j", async (selectedBaseRef) => {
    const invokeMock = vi.fn(async (): Promise<unknown> => ({
      ...clonedRepository,
      selectedBaseRef,
    }));
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke: invokeMock as NonNullable<WorkspaceClientOptions["invoke"]>,
    });

    await expect(client.cloneRepository({
      remoteUrl: "https://gitlab.example.com/platform/new-api.git",
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects unsafe repository remotes before transport", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.cloneRepository({
        remoteUrl: "https://user:secret@gitlab.example.com/team/repo.git",
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid clone branch before transport", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.cloneRepository({
        remoteUrl: "https://gitlab.example.com/team/repo.git",
        branch: "--upload-pack=unsafe",
        shallow: true,
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes and returns only repository branches reported by origin", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({ repository: refreshedRepository }),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.refreshRepositoryBranches("repo_checkout"),
    ).resolves.toEqual(refreshedRepository);
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/v1/repositories/repo_checkout/branches/refresh",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-WTS-Session": "session-123",
        }),
      }),
    ]);
  });

  it("analyzes selected repository bases through the strict HTTP contract", async () => {
    const request = {
      repositories: [
        {
          repositoryId: "repo_checkout",
          label: "checkout-api",
          baseRef: "release/2026.07",
        },
      ],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(runtimeAnalysis));
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(client.analyzeWorkspaceRuntime(request)).resolves.toEqual(
      runtimeAnalysis,
    );
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/v1/workspace-plans/runtime-analysis",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-WTS-Session": "session-123",
        }),
        body: JSON.stringify(request),
      }),
    ]);
  });

  it("rejects unknown runtime-analysis response authority", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({
          ...runtimeAnalysis,
          services: [
            {
              ...runtimeAnalysis.services[0],
              executablePath: "/tmp/untrusted",
            },
          ],
        }),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.analyzeWorkspaceRuntime({
        repositories: [
          {
            repositoryId: "repo_checkout",
            label: "checkout-api",
            baseRef: "main",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message:
        "WTS returned an invalid workspace payload at runtimeAnalysis.services[0].executablePath",
    });
  });

  it("rejects invalid runtime-analysis requests before transport", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.analyzeWorkspaceRuntime({
        repositories: [
          {
            label: "checkout-api",
            baseRef: "main",
            port: 3_000,
          } as never,
        ],
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message:
        "Invalid runtime analysis request at runtimeAnalysisRequest.repositories[0].port",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a pinned repository identity before runtime analysis", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.analyzeWorkspaceRuntime({
        repositories: [
          {
            label: "checkout-api",
            baseRef: "main",
          } as never,
        ],
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message:
        "Invalid runtime analysis request at runtimeAnalysisRequest.repositories[0].repositoryId",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts empty paths for numeric and pathless unsupported folder entries", async () => {
    const { diagnostics: _diagnostics, ...releaseImport } =
      codeWorkspaceImport;
    const unsupportedImport: CodeWorkspaceFileImportResult = {
      ...releaseImport,
      folders: [
        {
          name: "Folder 1",
          rawPath: "",
          status: "unsupported",
          message: "This workspace folder path is not a string.",
        },
        {
          name: "Named without a path",
          rawPath: "",
          status: "unsupported",
          message: "This workspace folder does not contain a path.",
        },
      ],
      repositories: [],
      warnings: [
        {
          code: "folderUnsupported",
          folderName: "Folder 1",
          message: "Folder 1 was not added to the plan.",
        },
        {
          code: "folderUnsupported",
          folderName: "Named without a path",
          message: "Named without a path was not added to the plan.",
        },
      ],
    };
    const contents = JSON.stringify({
      folders: [{ path: 404 }, { name: "Named without a path" }],
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(unsupportedImport));
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.importCodeWorkspaceFile({
        fileName: "unsupported.code-workspace",
        contents,
      }),
    ).resolves.toEqual(unsupportedImport);
  });

  it.each(["matched", "missing", "ambiguous"] as const)(
    "rejects an empty path for a %s imported folder",
    async (status) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
        .mockResolvedValueOnce(
          jsonResponse({
            ...codeWorkspaceImport,
            folders: [
              {
                ...codeWorkspaceImport.folders[0],
                rawPath: "",
                status,
              },
            ],
          }),
        );
      const client = createWorkspaceClient({
        runtime: "http",
        fetch: fetchMock,
      });

      await expect(
        client.importCodeWorkspaceFile({
          fileName: "invalid-empty-path.code-workspace",
          contents: "{}",
        }),
      ).rejects.toMatchObject({
        code: "invalid_response",
        message:
          "WTS returned an invalid workspace payload at codeWorkspaceFileImport.folders[0].rawPath",
      });
    },
  );

  it.each([null, 42, " "])(
    "rejects a malformed repository identity pin from a VS Code import: %p",
    async (repositoryId) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
        .mockResolvedValueOnce(
          jsonResponse({
            ...codeWorkspaceImport,
            repositories: [
              {
                ...codeWorkspaceImport.repositories[0],
                repositoryId,
              },
            ],
          }),
        );
      const client = createWorkspaceClient({
        runtime: "http",
        fetch: fetchMock,
      });

      await expect(
        client.importCodeWorkspaceFile({
          fileName: "payments.code-workspace",
          contents: "{}",
        }),
      ).rejects.toMatchObject({
        code: "invalid_response",
        message:
          "WTS returned an invalid workspace payload at codeWorkspaceFileImport.repositories[0].repositoryId",
      });
    },
  );

  it("accepts a release import response without debug diagnostics", async () => {
    const { diagnostics: _debugOnly, ...releaseImport } =
      codeWorkspaceImport;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(releaseImport));
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.importCodeWorkspaceFile({
        fileName: "payments.code-workspace",
        contents: "{}",
      }),
    ).resolves.toEqual(releaseImport);
  });

  it.each([
    {
      request: { fileName: "workspace.json", contents: "{}" },
      message: "Choose a file ending in .code-workspace",
    },
    {
      request: {
        fileName: "huge.code-workspace",
        contents: "x".repeat(48 * 1024 + 1),
      },
      message: "The VS Code workspace file must be 48 KiB or smaller",
    },
  ])(
    "rejects an invalid VS Code workspace file before transport",
    async ({ request, message }) => {
      const fetchMock = vi.fn<typeof fetch>();
      const client = createWorkspaceClient({
        runtime: "http",
        fetch: fetchMock,
      });

      await expect(
        client.importCodeWorkspaceFile(request),
      ).rejects.toMatchObject({
        code: "invalid_request",
        message,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects an unknown VS Code folder status from the service", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({
          ...codeWorkspaceImport,
          folders: [
            {
              ...codeWorkspaceImport.folders[0],
              status: "maybe",
            },
          ],
        }),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.importCodeWorkspaceFile({
        fileName: "payments.code-workspace",
        contents: "{}",
      }),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message:
        "WTS returned an invalid workspace payload at codeWorkspaceFileImport.folders[0].status",
    });
  });

  it.each([null, 42, " "])(
    "rejects a malformed repository identity pin from an imported folder: %p",
    async (repositoryId) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
        .mockResolvedValueOnce(
          jsonResponse({
            ...codeWorkspaceImport,
            folders: [
              {
                ...codeWorkspaceImport.folders[0],
                repositoryId,
              },
            ],
          }),
        );
      const client = createWorkspaceClient({
        runtime: "http",
        fetch: fetchMock,
      });

      await expect(
        client.importCodeWorkspaceFile({
          fileName: "payments.code-workspace",
          contents: "{}",
        }),
      ).rejects.toMatchObject({
        code: "invalid_response",
        message:
          "WTS returned an invalid workspace payload at codeWorkspaceFileImport.folders[0].repositoryId",
      });
    },
  );

  it("rejects an unknown VS Code diagnostic reason from the service", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({
          ...codeWorkspaceImport,
          diagnostics: {
            ...codeWorkspaceImport.diagnostics,
            folders: [
              {
                ...codeWorkspaceImport.diagnostics!.folders[0],
                reason: "guessedFromContents",
              },
            ],
          },
        }),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.importCodeWorkspaceFile({
        fileName: "payments.code-workspace",
        contents: "{}",
      }),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message:
        "WTS returned an invalid workspace payload at codeWorkspaceFileImport.diagnostics.folders[0].reason",
    });
  });

  it("uses explicit adapter endpoints for graph, agents, and issue trackers", async () => {
    const graph = {
      workspaceId: workspace.workspaceId,
      status: "ready",
      graphDisplayPath: `${workspace.workspaceDisplayPath}/graphify-out/graph.json`,
      detail: "Workspace-only structural graph ready.",
      durationMs: 120,
    };
    const agent = {
      workspaceId: workspace.workspaceId,
      provider: "codex",
      succeeded: true,
      output: "done",
      durationMs: 450,
    };
    const cliLaunch = {
      workspaceId: workspace.workspaceId,
      provider: "codex",
      terminal: "terminal",
      accepted: true,
      workspaceDisplayPath: workspace.workspaceDisplayPath,
    };
    const jiraVerification = {
      connected: true,
      serverName: "mcp-atlassian",
      serverVersion: "0.21.1",
      issueTool: "jira_get_issue",
    };
    const jiraIssue = {
      issueKey: "PLATFORM-42",
      summary: "Duplicate captures",
      status: "Open",
      content: "checkout-api",
      suggestedRepositories: ["checkout-api"],
      repositoryRecommendations: [
        {
          repositoryId: "repo_checkout",
          label: "checkout-api",
          confidence: 100,
          reason: "The imported issue references this repository's repository label.",
          sources: ["label", "workspaceHistory"],
        },
      ],
    };
    const openProjectVerification = {
      connected: true,
      instanceName: "Acme OpenProject",
      apiVersion: "v3",
      authenticatedUser: "Ada Developer",
    };
    const openProjectWorkPackage = {
      workPackageId: 42,
      displayId: "APP-42",
      subject: "Keep checkout state in sync",
      status: "In progress",
      project: "Checkout",
      content: "checkout-api",
      suggestedRepositories: ["checkout-api"],
      repositoryRecommendations: [
        {
          repositoryId: "repo_checkout",
          label: "checkout-api",
          confidence: 100,
          reason: "The imported issue references this repository's repository label.",
          sources: ["label"],
        },
      ],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(graph))
      .mockResolvedValueOnce(jsonResponse(cliLaunch))
      .mockResolvedValueOnce(jsonResponse(agent))
      .mockResolvedValueOnce(jsonResponse(jiraVerification))
      .mockResolvedValueOnce(jsonResponse(jiraIssue))
      .mockResolvedValueOnce(jsonResponse(openProjectVerification))
      .mockResolvedValueOnce(jsonResponse(openProjectWorkPackage));
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.indexWorkspaceGraph(workspace.workspaceId),
    ).resolves.toEqual(graph);
    await expect(
      client.openWorkspaceCli(workspace.workspaceId, "codex"),
    ).resolves.toEqual(cliLaunch);
    await expect(
      client.runWorkspaceAgent(workspace.workspaceId, "codex", "Fix it"),
    ).resolves.toEqual(agent);
    await expect(client.verifyJiraMcp()).resolves.toEqual(jiraVerification);
    await expect(client.importJiraIssue("platform-42")).resolves.toEqual(
      jiraIssue,
    );
    await expect(client.verifyOpenProject()).resolves.toEqual(
      openProjectVerification,
    );
    await expect(
      client.importOpenProjectWorkPackage("APP-42"),
    ).resolves.toEqual(openProjectWorkPackage);

    expect(fetchMock.mock.calls.slice(1).map(([url]) => url)).toEqual([
      `/api/v1/workspaces/${workspace.workspaceId}/graph/index`,
      `/api/v1/workspaces/${workspace.workspaceId}/open/cli/codex?terminal=terminal`,
      `/api/v1/workspaces/${workspace.workspaceId}/agents/codex/run`,
      "/api/v1/integrations/jira-mcp/verify",
      "/api/v1/jira/issues/PLATFORM-42/import",
      "/api/v1/integrations/open-project/verify",
      "/api/v1/open-project/work-packages/APP-42/import",
    ]);
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
    });
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBeUndefined();
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ prompt: "Fix it" }),
    });
    expect(fetchMock.mock.calls[6]?.[1]).toMatchObject({
      method: "POST",
    });
    expect(fetchMock.mock.calls[6]?.[1]?.body).toBeUndefined();
    expect(fetchMock.mock.calls[7]?.[1]).toMatchObject({
      method: "POST",
    });
    expect(fetchMock.mock.calls[7]?.[1]?.body).toBeUndefined();
  });

  it("rejects malformed CLI launch handoffs instead of inventing a session", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({
          workspaceId: workspace.workspaceId,
          provider: "codex",
          terminal: "terminal",
          accepted: true,
          workspaceDisplayPath: workspace.workspaceDisplayPath,
          sessionId: "not-a-real-session",
        }),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.openWorkspaceCli(workspace.workspaceId, "codex"),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message:
        "WTS returned an invalid workspace payload at workspaceCliLaunchResult.sessionId",
    });
  });

  it("writes a bounded workspace agent brief through the fixed HTTP route", async () => {
    const result = {
      workspaceId: workspace.workspaceId,
      workspaceDisplayPath: workspace.workspaceDisplayPath,
      briefDisplayPath: `${workspace.workspaceDisplayPath}/WTS.md`,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(result));
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.writeWorkspaceAgentBrief(
        workspace.workspaceId,
        "  Verify the real user flows.  ",
      ),
    ).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/v1/workspaces/${workspace.workspaceId}/agent-brief`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          taskMarkdown: "Verify the real user flows.",
        }),
      }),
    );
  });

  it("opens an exact repository base through an encoded HTTP route", async () => {
    const repositoryId = "repo/checkout api?";
    const baseRef = "feature/USB-NIC";
    const result = {
      ...repositoryBaseOpenResult,
      repositoryId,
      baseRef,
      forge: "gitlab" as const,
      host: "gitlab.example.com",
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(result));
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.openRepositoryBase(` ${repositoryId} `, ` ${baseRef} `),
    ).resolves.toEqual(result);

    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/v1/repositories/repo%2Fcheckout%20api%3F/open/base",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-WTS-Request": "local-ui",
          "X-WTS-Session": "session-123",
        },
        body: JSON.stringify({ baseRef }),
      },
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      baseRef,
    });
  });

  it("rejects a repository-base response whose identity does not match the request", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({
          ...repositoryBaseOpenResult,
          baseRef: "develop",
        }),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.openRepositoryBase("repo_checkout", "main"),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message:
        "WTS returned an invalid workspace payload at openRepositoryBaseResult.identity",
    });
  });

  it("prepares and opens a change-request draft through fixed HTTP routes", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(changeRequestDraft))
      .mockResolvedValueOnce(jsonResponse(changeRequestOpenResult));
    const client = createWorkspaceClient({ runtime: "http", fetch: fetchMock });

    await expect(
      client.prepareWorkspaceChangeRequest(workspace.workspaceId, " repo_checkout "),
    ).resolves.toEqual(changeRequestDraft);
    await expect(
      client.openWorkspaceChangeRequestDraft(
        workspace.workspaceId,
        "repo_checkout",
        changeRequestDraft.effectDigest,
        changeRequestDraft.title,
        changeRequestDraft.body,
      ),
    ).resolves.toEqual(changeRequestOpenResult);

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/v1/workspaces/${workspace.workspaceId}/change-requests/prepare`,
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      repositoryId: "repo_checkout",
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `/api/v1/workspaces/${workspace.workspaceId}/change-requests/open`,
    );
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      repositoryId: "repo_checkout",
      effectDigest: changeRequestDraft.effectDigest,
      title: changeRequestDraft.title,
      body: changeRequestDraft.body,
    });
  });

  it("publishes a change-request branch through the fixed HTTP route", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(branchPublication));
    const client = createWorkspaceClient({ runtime: "http", fetch: fetchMock });

    await expect(
      client.publishWorkspaceChangeRequestBranch(
        workspace.workspaceId,
        " repo_checkout ",
        "feat/custom-name",
      ),
    ).resolves.toEqual(branchPublication);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/v1/workspaces/${workspace.workspaceId}/change-requests/publish-branch`,
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      repositoryId: "repo_checkout",
      branchName: "feat/custom-name",
    });
  });

  it("rejects authority-bearing fields in a change-request draft response", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse({ ...changeRequestDraft, url: "https://evil.invalid" }));
    const client = createWorkspaceClient({ runtime: "http", fetch: fetchMock });
    await expect(
      client.prepareWorkspaceChangeRequest(workspace.workspaceId, "repo_checkout"),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each(["url", "sessionId", "path"])(
    "rejects an unexpected %s field in a repository-base response",
    async (field) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
        .mockResolvedValueOnce(
          jsonResponse({
            ...repositoryBaseOpenResult,
            [field]: "must-not-cross-the-contract",
          }),
        );
      const client = createWorkspaceClient({
        runtime: "http",
        fetch: fetchMock,
      });

      await expect(
        client.openRepositoryBase("repo_checkout", "main"),
      ).rejects.toMatchObject({
        code: "invalid_response",
        message: `WTS returned an invalid workspace payload at openRepositoryBaseResult.${field}`,
      });
    },
  );

  it("rejects a malformed repository-base commit identity", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({
          ...repositoryBaseOpenResult,
          commitOid: "not-a-git-object-id",
        }),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.openRepositoryBase("repo_checkout", "main"),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message:
        "WTS returned an invalid workspace payload at openRepositoryBaseResult.commitOid",
    });
  });

  it.each([
    ["", "main"],
    ["repo_checkout", ""],
    ["r".repeat(257), "main"],
    ["repo_checkout", "b".repeat(257)],
    ["repo_checkout", "é".repeat(129)],
  ])(
    "rejects missing or oversized repository-base inputs before transport",
    async (repositoryId, baseRef) => {
      const fetchMock = vi.fn<typeof fetch>();
      const client = createWorkspaceClient({
        runtime: "http",
        fetch: fetchMock,
      });

      await expect(
        client.openRepositoryBase(repositoryId, baseRef),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed OpenProject adapter responses", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({
          connected: true,
          instanceName: "Acme OpenProject",
          apiVersion: "v3",
          authenticatedUser: "Ada Developer",
          accessToken: "must-never-cross-the-contract",
        }),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(client.verifyOpenProject()).rejects.toMatchObject({
      code: "invalid_response",
      message:
        "WTS returned an invalid workspace payload at openProjectVerification.accessToken",
    });
  });

  it("rejects repository recommendations that do not match the serialized contract", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({
          issueKey: "PLATFORM-42",
          summary: "Duplicate captures",
          status: "Open",
          content: "checkout-api",
          suggestedRepositories: ["checkout-api"],
          repositoryRecommendations: [
            {
              repositoryId: "repo_checkout",
              label: "checkout-api",
              confidence: 101,
              reason: "Unbounded confidence must not cross the contract.",
              sources: ["invented"],
            },
          ],
        }),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(client.importJiraIssue("PLATFORM-42")).rejects.toMatchObject({
      code: "invalid_response",
      message:
        "WTS returned an invalid workspace payload at jiraIssueImport.repositoryRecommendations[0]",
    });
  });

  it("rejects an invalid OpenProject reference before transport", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.importOpenProjectWorkPackage("../42"),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message:
        "A numeric OpenProject work-package ID or semantic display ID is required",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads and runs the versioned workspace evidence contract", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(workspaceEvidence))
      .mockResolvedValueOnce(jsonResponse(workspaceEvidence))
      .mockResolvedValueOnce(jsonResponse(workspaceEvidence))
      .mockResolvedValueOnce(jsonResponse(workspaceEvidence))
      .mockResolvedValueOnce(jsonResponse(workspaceEvidence))
      .mockResolvedValueOnce(jsonResponse(workspaceEvidence));
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.getWorkspaceEvidence(workspace.workspaceId),
    ).resolves.toEqual(workspaceEvidence);
    await expect(
      client.promoteAgentVerificationCheck(
        workspace.workspaceId,
        "checkout-cargo-test",
      ),
    ).resolves.toEqual(workspaceEvidence);
    await expect(
      client.runWorkspaceVerification(workspace.workspaceId),
    ).resolves.toEqual(workspaceEvidence);
    await expect(
      client.runWorkspaceVerificationCheck?.(
        workspace.workspaceId,
        "checkout-cargo-test",
      ),
    ).resolves.toEqual(workspaceEvidence);
    await expect(
      client.rerunFailedWorkspaceVerification?.(workspace.workspaceId),
    ).resolves.toEqual(workspaceEvidence);
    await expect(
      client.cancelWorkspaceVerification?.(workspace.workspaceId),
    ).resolves.toEqual(workspaceEvidence);

    expect(fetchMock.mock.calls.slice(1).map(([url]) => url)).toEqual([
      `/api/v1/workspaces/${workspace.workspaceId}/evidence`,
      `/api/v1/workspaces/${workspace.workspaceId}/verification/agent-proposals/checkout-cargo-test/promote`,
      `/api/v1/workspaces/${workspace.workspaceId}/verification/run`,
      `/api/v1/workspaces/${workspace.workspaceId}/verification/checks/checkout-cargo-test/run`,
      `/api/v1/workspaces/${workspace.workspaceId}/verification/failed/run`,
      `/api/v1/workspaces/${workspace.workspaceId}/verification/cancel`,
    ]);
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
    });
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      method: "POST",
    });
  });

  it("normalizes structured flow coverage and defaults legacy reports safely", async () => {
    const structuredReport = {
      ...workspaceEvidence.agentReport,
      findings: [
        {
          id: "retry-risk",
          title: "Retry can duplicate a capture",
          detail: "The idempotency key is restored too late.",
          severity: "warning",
          repositoryId: "repo_checkout",
          evidence: ["checkout-api/src/retry.rs:84"],
          flowIds: ["checkout-retry"],
        },
      ],
      scope: {
        coverage: "complete",
        graphStatus: "ready",
        graphSha256: "abc123",
        reviewedRepositoryIds: ["repo_checkout"],
        unresolvedRepositoryIds: [],
        skippedRepositories: [],
      },
      environment: {
        status: "needsInput",
        summary: "The graph identifies a Node toolchain and one secret.",
        requirements: [
          {
            id: "node",
            repositoryId: "repo_checkout",
            kind: "toolchain",
            name: "Node.js 22",
            required: true,
            source: "repository",
            detail: "Declared by the repository.",
            evidence: [
              {
                repositoryId: "repo_checkout",
                path: ".tool-versions",
                line: 1,
              },
            ],
          },
        ],
        setupSteps: [
          {
            id: "install",
            repositoryId: "repo_checkout",
            workingDirectory: "/workspace/checkout-api",
            action: "Install dependencies.",
            command: ["npm", "ci"],
            evidence: [
              {
                repositoryId: "repo_checkout",
                path: "package-lock.json",
              },
            ],
          },
        ],
        unresolved: ["API token must be supplied."],
      },
      flows: [
        {
          id: "checkout-retry",
          title: "Retry a checkout",
          kind: "user",
          actors: ["Checkout client"],
          entryPoints: ["POST /captures"],
          steps: [
            {
              id: "accept",
              repositoryId: "repo_checkout",
              component: "Capture route",
              action: "Accept the retry request.",
              evidence: [
                {
                  repositoryId: "repo_checkout",
                  path: "checkout-api/src/retry.rs",
                  line: 84,
                },
              ],
            },
          ],
          expectedOutcome: "The original capture is returned.",
          risks: ["Duplicate capture"],
          existingCoverage: ["checkout-unit"],
          verificationCandidateIds: ["checkout-cargo-test"],
        },
      ],
    };
    const legacyReport = { ...workspaceEvidence.agentReport } as Record<
      string,
      unknown
    >;
    delete legacyReport.scope;
    delete legacyReport.environment;
    delete legacyReport.flows;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({
          ...workspaceEvidence,
          agentReport: structuredReport,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ...workspaceEvidence,
          agentReport: legacyReport,
        }),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    const structured = await client.getWorkspaceEvidence(workspace.workspaceId);
    expect(structured?.agentReport.scope).toEqual(structuredReport.scope);
    expect(structured?.agentReport.environment).toEqual(
      structuredReport.environment,
    );
    expect(structured?.agentReport.flows).toEqual(structuredReport.flows);
    expect(structured?.agentReport.findings[0]?.flowIds).toEqual([
      "checkout-retry",
    ]);

    const legacy = await client.getWorkspaceEvidence(workspace.workspaceId);
    expect(legacy?.agentReport.scope).toEqual({
      coverage: "unassessed",
      graphStatus: "notStarted",
      reviewedRepositoryIds: [],
      unresolvedRepositoryIds: [],
      skippedRepositories: [],
    });
    expect(legacy?.agentReport.flows).toEqual([]);
    expect(legacy?.agentReport.environment).toEqual({
      status: "unassessed",
      summary: "",
      requirements: [],
      setupSteps: [],
      unresolved: [],
    });
  });

  it("normalizes persisted verification history from the evidence contract", async () => {
    const completed = {
      ...workspaceEvidence.verificationResult,
      status: "passed" as const,
      startedAtUnixMs: 1_721_776_400_000,
      completedAtUnixMs: 1_721_776_401_250,
      durationMs: 1_250,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({
          ...workspaceEvidence,
          verificationHistory: [completed],
        }),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    const evidence = await client.getWorkspaceEvidence(workspace.workspaceId);

    expect(evidence?.verificationHistory).toEqual([completed]);
  });

  it("lists, reads, and runs strict local user-journey evidence", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(workspaceTestRuns))
      .mockResolvedValueOnce(jsonResponse(workspaceTestRunDetailWire))
      .mockResolvedValueOnce(jsonResponse(workspaceTestRun));
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.listWorkspaceTestRuns!(workspace.workspaceId),
    ).resolves.toEqual(workspaceTestRuns);
    await expect(
      client.getWorkspaceTestRun!(
        workspace.workspaceId,
        workspaceTestRun.runId,
      ),
    ).resolves.toEqual(workspaceTestRunDetail);
    await expect(
      client.runWorkspaceTestJourney!(workspace.workspaceId, {
        journeyId: "wts-help-preferences",
        baseUrl: "http://127.0.0.1:43210",
      }),
    ).resolves.toEqual(workspaceTestRun);

    expect(fetchMock.mock.calls.slice(1).map(([url]) => url)).toEqual([
      `/api/v1/workspaces/${workspace.workspaceId}/test-runs`,
      `/api/v1/workspaces/${workspace.workspaceId}/test-runs/${workspaceTestRun.runId}`,
      `/api/v1/workspaces/${workspace.workspaceId}/test-runs`,
    ]);
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        journeyId: "wts-help-preferences",
        baseUrl: "http://127.0.0.1:43210",
      }),
    });
  });

  it("normalizes omitted journey diagnostics and rejects non-loopback targets", async () => {
    const running = {
      ...workspaceTestRun,
      state: "running",
      passedSteps: 1,
    } as Record<string, unknown>;
    delete running.completedAtUnixMs;
    delete running.durationMs;
    delete running.failedStepId;
    delete running.message;
    delete running.graphSha256;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({
          schemaVersion: 1,
          workspaceId: workspace.workspaceId,
          runs: [running],
        }),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.listWorkspaceTestRuns!(workspace.workspaceId),
    ).resolves.toMatchObject({
      runs: [
        {
          state: "running",
          completedAtUnixMs: null,
          durationMs: null,
          failedStepId: null,
          message: null,
          graphSha256: null,
        },
      ],
    });
    await expect(
      client.runWorkspaceTestJourney!(workspace.workspaceId, {
        journeyId: "wts-help-preferences",
        baseUrl: "https://example.com",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects inconsistent user-journey results", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({
          schemaVersion: 1,
          workspaceId: workspace.workspaceId,
          runs: [
            {
              ...workspaceTestRun,
              passedSteps: 4,
              failedSteps: 1,
              totalSteps: 4,
            },
          ],
        }),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.listWorkspaceTestRuns!(workspace.workspaceId),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message:
        "WTS returned an invalid workspace payload at workspaceTestRuns.runs[0]",
    });
  });

  it("rejects deep user-journey evidence with a mismatched identity", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({
          ...workspaceTestRunDetailWire,
          runId: "run-from-another-request",
        }),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.getWorkspaceTestRun!(
        workspace.workspaceId,
        workspaceTestRun.runId,
      ),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message:
        "WTS returned an invalid workspace payload at workspaceTestRunDetail.identity",
    });
  });

  it("normalizes Rust-omitted optional evidence fields to null", async () => {
    const persisted = JSON.parse(JSON.stringify(workspaceEvidence));
    delete persisted.graphManifest.graphDisplayPath;
    delete persisted.graphManifest.graphSha256;
    delete persisted.graphManifest.indexedAtUnixMs;
    delete persisted.verificationResult.startedAtUnixMs;
    delete persisted.verificationResult.completedAtUnixMs;
    delete persisted.verificationResult.durationMs;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(persisted));
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(
      client.getWorkspaceEvidence(workspace.workspaceId),
    ).resolves.toEqual(workspaceEvidence);
  });

  it("rejects snake_case or incomplete response payloads", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({
          workspace_root_id: "root-local",
          workspaceRootDisplayPath: "~/cd",
          workspaces: [],
        }),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(client.listWorkspaces()).rejects.toMatchObject({
      code: "invalid_response",
      message:
        "WTS returned an invalid workspace payload at workspaceList.workspaceRootId",
    });
  });

  it("rejects internally inconsistent last-known lifecycle summaries", async () => {
    const invalidWorkspace = {
      ...workspace,
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 0,
        observedAtUnixMs: workspace.updatedAtUnixMs,
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({
          ...workspaceList,
          workspaces: [invalidWorkspace],
        }),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(client.listWorkspaces()).rejects.toMatchObject({
      code: "invalid_response",
      message:
        "WTS returned an invalid workspace payload at workspaceList.workspaces[0].lifecycle",
    });
  });

  it("rejects integration snapshots without Rust-owned verification truth", async () => {
    const incompleteIntegration = {
      ...setupSnapshot.integrations[0],
    } as Record<string, unknown>;
    delete incompleteIntegration.verificationKind;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({
          ...setupSnapshot,
          integrations: [incompleteIntegration],
        }),
      );
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(client.getSetupSnapshot()).rejects.toMatchObject({
      code: "invalid_response",
      message:
        "WTS returned an invalid workspace payload at setupSnapshot.integrations[0].verificationKind",
    });
  });

  it("discards a failed bootstrap promise so retry can reconnect", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection refused"))
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-456" }))
      .mockResolvedValueOnce(jsonResponse(workspaceList));
    const client = createWorkspaceClient({
      runtime: "http",
      fetch: fetchMock,
    });

    await expect(client.listWorkspaces()).rejects.toMatchObject({
      code: "transport_unavailable",
      retryable: true,
      message:
        "Cannot reach the local WTS host. Open this UI through `npm run desktop:dev`, or start `cargo run -p wts-server` and open its loopback URL; Vite alone cannot import workspaces.",
    });
    await expect(client.listWorkspaces()).resolves.toEqual(workspaceList);
    expect(fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/v1/bootstrap"),
    )).toHaveLength(2);
  });
});

describe("workspace Jira link transport", () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const linkId = "22222222-2222-4222-8222-222222222222";
  const idempotencyKey = "33333333-3333-4333-8333-333333333333";
  const digest = `sha256:${"a".repeat(64)}`;
  const snapshot = {
    issueKey: "PLATFORM-42",
    summary: "Prevent an incorrect server classification",
    status: "In Progress",
    content: "Review the server classification rules.",
    browserUrl: "https://jira.example.test/browse/PLATFORM-42",
    fetchedAtUnixMs: 1_786_000_000_000,
  };
  const link = {
    linkId,
    workspaceId,
    provider: "jira" as const,
    role: "primary" as const,
    snapshot,
    revision: 1,
    createdAtUnixMs: 1_786_000_000_100,
    updatedAtUnixMs: 1_786_000_000_100,
  };

  it("accepts an empty snapshot for a Jira link derived from workspace intent", async () => {
    const intentLink = {
      ...link,
      snapshot: {
        issueKey: "PLATFORM-42",
        content: "",
        fetchedAtUnixMs: 0,
      },
    };
    const invokeMock = vi.fn(async () => ({
      schemaVersion: 1,
      workspaceId,
      links: [intentLink],
    }));
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke: invokeMock as NonNullable<WorkspaceClientOptions["invoke"]>,
    });

    await expect(client.listWorkspaceWorkItemLinks(workspaceId)).resolves.toEqual({
      schemaVersion: 1,
      workspaceId,
      links: [intentLink],
    });
    expect(invokeMock).toHaveBeenCalledWith("list_workspace_work_item_links", {
      workspaceId,
    });
  });

  it("uses reviewed Jira-link arguments for every Tauri operation", async () => {
    const invokeMock = vi.fn(async (command: string): Promise<unknown> => {
      switch (command) {
        case "preview_workspace_jira_link":
          return { schemaVersion: 1, workspaceId, provider: "jira", role: "primary", snapshot, previewDigest: digest };
        case "confirm_workspace_jira_link":
          return { link, replayed: false };
        case "open_workspace_jira_preview":
        case "open_workspace_work_item":
          return { workspaceId, issueKey: "PLATFORM-42", accepted: true };
        case "list_workspace_work_item_links":
          return { schemaVersion: 1, workspaceId, links: [link] };
        case "unlink_workspace_work_item":
          return { workspaceId, linkId, removedRevision: 1 };
        case "propose_workspace_jira_issue":
          return {
            schemaVersion: 1,
            workspaceId,
            summary: "Prevent an incorrect server classification",
            description: "Plan content",
            sourceDocumentSha256: digest,
            canExecute: false,
            requiresExplicitApproval: true,
            detail: "Jira creation is unavailable.",
          };
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    });
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke: invokeMock as NonNullable<WorkspaceClientOptions["invoke"]>,
    });

    await client.previewWorkspaceJiraLink(workspaceId, " platform-42 ", "primary");
    await client.confirmWorkspaceJiraLink(
      workspaceId,
      "PLATFORM-42",
      "primary",
      digest,
      idempotencyKey,
    );
    await client.openWorkspaceJiraPreview(
      workspaceId,
      "PLATFORM-42",
      "primary",
      digest,
    );
    await client.listWorkspaceWorkItemLinks(workspaceId);
    await client.unlinkWorkspaceWorkItem(workspaceId, linkId, 1);
    await client.openWorkspaceWorkItem(workspaceId, linkId, 1);
    const proposal = await client.proposeWorkspaceJiraIssue(workspaceId);

    expect(proposal).toMatchObject({ canExecute: false, requiresExplicitApproval: true });
    expect(invokeMock.mock.calls).toEqual([
      ["preview_workspace_jira_link", { workspaceId, request: { issueKey: "PLATFORM-42", role: "primary" } }],
      ["confirm_workspace_jira_link", {
        workspaceId,
        request: {
          issueKey: "PLATFORM-42",
          role: "primary",
          expectedPreviewDigest: digest,
          idempotencyKey,
        },
      }],
      ["open_workspace_jira_preview", {
        workspaceId,
        request: {
          issueKey: "PLATFORM-42",
          role: "primary",
          expectedPreviewDigest: digest,
        },
      }],
      ["list_workspace_work_item_links", { workspaceId }],
      ["unlink_workspace_work_item", { workspaceId, linkId, request: { expectedRevision: 1 } }],
      ["open_workspace_work_item", { workspaceId, linkId, request: { expectedRevision: 1 } }],
      ["propose_workspace_jira_issue", { workspaceId }],
    ]);
  });

  it("uses the HTTP preview, trusted open, and confirmation routes without Jira headers", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse({ schemaVersion: 1, workspaceId, provider: "jira", role: "related", snapshot, previewDigest: digest }))
      .mockResolvedValueOnce(jsonResponse({ workspaceId, issueKey: "PLATFORM-42", accepted: true }))
      .mockResolvedValueOnce(jsonResponse({ link: { ...link, role: "related" }, replayed: false }));
    const client = createWorkspaceClient({ runtime: "http", fetch: fetchMock });

    await client.previewWorkspaceJiraLink(workspaceId, "PLATFORM-42", "related");
    await client.openWorkspaceJiraPreview(
      workspaceId,
      "PLATFORM-42",
      "related",
      digest,
    );
    await client.confirmWorkspaceJiraLink(
      workspaceId,
      "PLATFORM-42",
      "related",
      digest,
      idempotencyKey,
    );

    const previewRequest = fetchMock.mock.calls[1]![1]!;
    const openRequest = fetchMock.mock.calls[2]![1]!;
    const confirmRequest = fetchMock.mock.calls[3]![1]!;
    expect(fetchMock.mock.calls[1]![0]).toContain(`/workspaces/${workspaceId}/work-items/jira/preview`);
    expect(previewRequest.body).toBe(JSON.stringify({ issueKey: "PLATFORM-42", role: "related" }));
    expect(fetchMock.mock.calls[2]![0]).toContain(`/workspaces/${workspaceId}/work-items/jira/open-preview`);
    expect(openRequest.body).toBe(JSON.stringify({
      issueKey: "PLATFORM-42",
      role: "related",
      expectedPreviewDigest: digest,
    }));
    expect(fetchMock.mock.calls[3]![0]).toContain(`/workspaces/${workspaceId}/work-items/jira/confirm`);
    expect(confirmRequest.body).toBe(JSON.stringify({
      issueKey: "PLATFORM-42",
      role: "related",
      expectedPreviewDigest: digest,
      idempotencyKey,
    }));
    expect(JSON.stringify(confirmRequest.headers)).not.toContain("PLATFORM-42");
  });

  it("rejects a malformed digest and revision before transport", async () => {
    const invokeMock = vi.fn();
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke: invokeMock as NonNullable<WorkspaceClientOptions["invoke"]>,
    });
    await expect(
      client.confirmWorkspaceJiraLink(
        workspaceId,
        "PLATFORM-42",
        "primary",
        "sha256:bad",
        idempotencyKey,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      client.unlinkWorkspaceWorkItem(workspaceId, linkId, 0),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects a mismatched trusted-open result from Tauri", async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      workspaceId: "44444444-4444-4444-8444-444444444444",
      issueKey: "OTHER-1",
      accepted: true,
    });
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke: invokeMock as NonNullable<WorkspaceClientOptions["invoke"]>,
    });

    await expect(
      client.openWorkspaceJiraPreview(
        workspaceId,
        "PLATFORM-42",
        "primary",
        digest,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("Tauri workspace client", () => {
  it("reads a repository diff with the exact Tauri command", async () => {
    const response = {
      schemaVersion: 1,
      workspaceId: workspace.workspaceId,
      repositoryId: "repo-checkout-api",
      repositoryLabel: "checkout-api",
      baseCommitOid: "0123456789abcdef0123456789abcdef01234567",
      headCommitOid: "fedcba9876543210fedcba9876543210fedcba98",
      patchSha256: `sha256:${"a".repeat(64)}`,
      patch: "",
      patchTruncated: false,
      untrackedPaths: [],
      untrackedPathsTruncated: false,
    };
    const invokeMock = vi.fn(async (): Promise<unknown> => response);
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await expect(
      client.getWorkspaceRepositoryDiff(
        ` ${workspace.workspaceId} `,
        " repo-checkout-api ",
      ),
    ).resolves.toEqual(response);
    expect(invokeMock).toHaveBeenCalledWith("get_workspace_repository_diff", {
      workspaceId: workspace.workspaceId,
      repositoryId: "repo-checkout-api",
    });
  });

  it("reads repository graph context with a separate Tauri command", async () => {
    const response = {
      graphSha256: "sha256:review",
      nodes: [],
      links: [],
      truncated: false,
    };
    const invokeMock = vi.fn(async (): Promise<unknown> => response);
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await expect(
      client.getWorkspaceRepositoryReviewGraph(
        ` ${workspace.workspaceId} `,
        " repo-checkout-api ",
      ),
    ).resolves.toEqual(response);
    expect(invokeMock).toHaveBeenCalledWith(
      "get_workspace_repository_review_graph",
      {
        workspaceId: workspace.workspaceId,
        repositoryId: "repo-checkout-api",
      },
    );
  });

  it("reads one complete repository file with the exact Tauri command", async () => {
    const response = {
      schemaVersion: 1,
      workspaceId: workspace.workspaceId,
      repositoryId: "repo-checkout-api",
      repositoryLabel: "checkout-api",
      baseCommitOid: "0123456789abcdef0123456789abcdef01234567",
      headCommitOid: "fedcba9876543210fedcba9876543210fedcba98",
      filePath: "src/retry.ts",
      patchSha256: `sha256:${"a".repeat(64)}`,
      contentSha256: `sha256:${"b".repeat(64)}`,
      content: "complete file\n",
      fullPatch: "diff --git a/src/retry.ts b/src/retry.ts\n",
    };
    const invokeMock = vi.fn(async (): Promise<unknown> => response);
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await expect(
      client.getWorkspaceRepositoryFileReview(
        ` ${workspace.workspaceId} `,
        " repo-checkout-api ",
        "src/retry.ts",
        `sha256:${"a".repeat(64)}`,
      ),
    ).resolves.toEqual(response);
    expect(invokeMock).toHaveBeenCalledWith(
      "get_workspace_repository_file_review",
      {
        workspaceId: workspace.workspaceId,
        repositoryId: "repo-checkout-api",
        filePath: "src/retry.ts",
        expectedPatchSha256: `sha256:${"a".repeat(64)}`,
      },
    );
  });

  it("syncs one repository with the exact Tauri command", async () => {
    const invokeMock = vi.fn(async (): Promise<unknown> => repositorySyncResult);
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await expect(
      client.syncWorkspaceRepository(workspace.workspaceId, "repo_checkout"),
    ).resolves.toEqual(repositorySyncResult);
    expect(invokeMock).toHaveBeenCalledWith("sync_workspace_repository", {
      workspaceId: workspace.workspaceId,
      repositoryId: "repo_checkout",
    });
  });

  it("previews and applies repository alignment with exact Tauri commands", async () => {
    const invokeMock = vi
      .fn()
      .mockResolvedValueOnce(repositoryAlignmentPreflight)
      .mockResolvedValueOnce(repositoryAlignmentResult);
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await client.preflightWorkspaceRepositoryAlignment(
      workspace.workspaceId,
      "repo_checkout",
    );
    await client.alignWorkspaceRepository(
      workspace.workspaceId,
      "repo_checkout",
      repositoryAlignmentPreflight.effectDigest,
    );

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "preflight_workspace_repository_alignment",
      {
        workspaceId: workspace.workspaceId,
        repositoryId: "repo_checkout",
      },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "align_workspace_repository",
      {
        workspaceId: workspace.workspaceId,
        repositoryId: "repo_checkout",
        effectDigest: repositoryAlignmentPreflight.effectDigest,
      },
    );
  });

  it("reviews and adds a repository with exact Tauri commands", async () => {
    const invokeMock = vi
      .fn()
      .mockResolvedValueOnce(repositoryAdditionPreflight)
      .mockResolvedValueOnce(repositoryAdditionResult)
      .mockResolvedValueOnce(repositoryRemovalResult);
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke: invokeMock as unknown as NonNullable<WorkspaceClientOptions["invoke"]>,
    });

    await client.preflightWorkspaceRepositoryAddition(workspace.workspaceId, "repo_web", "main");
    await client.addWorkspaceRepository(
      workspace.workspaceId,
      "repo_web",
      "main",
      repositoryAdditionPreflight.effectDigest,
    );
    await expect(
      client.removeWorkspaceRepository(workspace.workspaceId, "repo_web"),
    ).resolves.toEqual(repositoryRemovalResult);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "preflight_workspace_repository_addition", {
      workspaceId: workspace.workspaceId,
      request: { repositoryId: "repo_web", baseRef: "main" },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "add_workspace_repository", {
      workspaceId: workspace.workspaceId,
      request: { repositoryId: "repo_web", baseRef: "main" },
      effectDigest: repositoryAdditionPreflight.effectDigest,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "remove_workspace_repository", {
      workspaceId: workspace.workspaceId,
      repositoryId: "repo_web",
    });
  });

  it("recognizes the Tauri 2 runtime marker without an HTTP fallback", async () => {
    vi.stubGlobal("isTauri", true);
    const invokeMock = vi.fn(async (command: string): Promise<unknown> => {
      expect(command).toBe("list_workspaces");
      return workspaceList;
    });

    try {
      const client = createWorkspaceClient({
        invoke:
          invokeMock as unknown as NonNullable<
            WorkspaceClientOptions["invoke"]
          >,
      });
      await expect(client.listWorkspaces()).resolves.toEqual(workspaceList);
      expect(invokeMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("launches and stops an owned agent with the exact Tauri commands", async () => {
    const launching: AgentSession = {
      schemaVersion: 1,
      sessionId: "33333333-3333-4333-8333-333333333333",
      workspaceId: workspace.workspaceId,
      provider: "openCode",
      terminal: "terminal",
      category: "review",
      status: "launching",
      startedAtUnixMs: 6_000,
      lastHeartbeatAtUnixMs: 6_000,
      endedAtUnixMs: null,
      failure: null,
    };
    const invokeMock = vi.fn(
      async (command: string): Promise<unknown> =>
        command === "launch_agent_session"
          ? launching
          : { ...launching, status: "stopping" },
    );
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await expect(
      client.launchAgentSession(` ${workspace.workspaceId} `, {
        provider: "openCode",
        prompt: "  Review the patch. ",
        category: "review",
      }),
    ).resolves.toEqual(launching);
    await expect(client.stopAgentSession(launching.sessionId)).resolves.toMatchObject({
      status: "stopping",
    });
    expect(invokeMock.mock.calls).toEqual([
      [
        "launch_agent_session",
        {
          workspaceId: workspace.workspaceId,
          provider: "openCode",
          prompt: "Review the patch.",
          category: "review",
        },
      ],
      ["stop_agent_session", { sessionId: launching.sessionId }],
    ]);
  });

  it("analyzes selected repository bases with the exact Tauri command", async () => {
    const invokeMock = vi.fn(async (): Promise<unknown> => runtimeAnalysis);
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });
    const request = {
      repositories: [
        {
          repositoryId: "repo_checkout",
          label: "checkout-api",
          baseRef: "main",
        },
      ],
    };

    await expect(client.analyzeWorkspaceRuntime(request)).resolves.toEqual(
      runtimeAnalysis,
    );
    expect(invokeMock).toHaveBeenCalledWith("analyze_workspace_runtime", {
      request,
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("opens a repository base with the exact Tauri command and arguments", async () => {
    const invokeMock = vi.fn(
      async (): Promise<unknown> => repositoryBaseOpenResult,
    );
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await expect(
      client.openRepositoryBase(" repo_checkout ", " main "),
    ).resolves.toEqual(repositoryBaseOpenResult);
    expect(invokeMock).toHaveBeenCalledWith("open_repository_base", {
      repositoryId: "repo_checkout",
      baseRef: "main",
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("publishes a change-request branch with the exact Tauri command", async () => {
    const invokeMock = vi.fn(async (): Promise<unknown> => branchPublication);
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke: invokeMock as unknown as NonNullable<WorkspaceClientOptions["invoke"]>,
    });

    await expect(
      client.publishWorkspaceChangeRequestBranch(
        workspace.workspaceId,
        " repo_checkout ",
        "feat/custom-name",
      ),
    ).resolves.toEqual(branchPublication);
    expect(invokeMock).toHaveBeenCalledWith(
      "publish_workspace_change_request_branch",
      {
        workspaceId: workspace.workspaceId,
        request: {
          repositoryId: "repo_checkout",
          branchName: "feat/custom-name",
        },
      },
    );
  });

  it("uses the exact command names and camelCase argument shape", async () => {
    const invokeMock = vi.fn(
      async (
        command: string,
        _args?: Record<string, unknown>,
      ): Promise<unknown> => {
        if (command === "list_workspaces") return workspaceList;
        if (command === "get_workspace") return workspace;
        if (command === "create_workspace") {
          return { workspace, replayed: false };
        }
        if (command === "get_setup_snapshot") return setupSnapshot;
        if (command === "list_repositories") return repositoryCatalog;
        if (command === "preflight_workspace") return preflight;
        if (command === "get_workspace_materialization") return null;
        if (command === "materialize_workspace") return materializeResult;
        if (command === "open_workspace_cli") {
          return {
            workspaceId: workspace.workspaceId,
            provider: "openCode",
            terminal: "terminal",
            accepted: true,
            workspaceDisplayPath: workspace.workspaceDisplayPath,
          };
        }
        if (command === "write_workspace_agent_brief") {
          return {
            workspaceId: workspace.workspaceId,
            workspaceDisplayPath: workspace.workspaceDisplayPath,
            briefDisplayPath: `${workspace.workspaceDisplayPath}/WTS.md`,
          };
        }
        return {
          provider: "vsCode",
          accepted: true,
          workspaceId: workspace.workspaceId,
          codeWorkspaceDisplayPath: preflight.codeWorkspaceDisplayPath,
        };
      },
    );
    const invoke =
      invokeMock as unknown as NonNullable<
        WorkspaceClientOptions["invoke"]
      >;
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke,
    });

    await client.listWorkspaces();
    await client.getWorkspace("ws-platform-42");
    await client.createWorkspace(createRequest, "idem-tauri");
    await client.getSetupSnapshot();
    await client.listRepositories();
    await client.preflightWorkspace("ws-platform-42");
    await client.getWorkspaceMaterialization("ws-platform-42");
    await client.materializeWorkspace(
      "ws-platform-42",
      "sha256:effect",
      "idem-materialize",
    );
    await client.openWorkspaceInVscode("ws-platform-42");
    await client.openWorkspaceCli("ws-platform-42", "openCode");
    await client.writeWorkspaceAgentBrief(
      "ws-platform-42",
      " Verify the user flow. ",
    );

    expect(invokeMock.mock.calls).toEqual([
      ["list_workspaces", undefined],
      ["get_workspace", { workspaceId: "ws-platform-42" }],
      [
        "create_workspace",
        {
          request: createRequest,
          idempotencyKey: "idem-tauri",
        },
      ],
      ["get_setup_snapshot", undefined],
      ["list_repositories", undefined],
      ["preflight_workspace", { workspaceId: "ws-platform-42" }],
      ["get_workspace_materialization", { workspaceId: "ws-platform-42" }],
      [
        "materialize_workspace",
        {
          workspaceId: "ws-platform-42",
          effectDigest: "sha256:effect",
        },
      ],
      ["open_workspace_in_vscode", { workspaceId: "ws-platform-42" }],
      [
        "open_workspace_cli",
        {
          workspaceId: "ws-platform-42",
          provider: "openCode",
          terminal: "terminal",
        },
      ],
      [
        "write_workspace_agent_brief",
        {
          workspaceId: "ws-platform-42",
          taskMarkdown: "Verify the user flow.",
        },
      ],
    ]);
  });

  it("uses matching Tauri manual-command names and reviewed arguments", async () => {
    const graph = {
      workspaceId: workspace.workspaceId,
      status: "ready",
      graphDisplayPath: `${workspace.workspaceDisplayPath}/graphify-out/graph.json`,
      detail: "Workspace graph refreshed.",
      durationMs: 184,
    };
    const invokeMock = vi.fn(
      async (command: string): Promise<unknown> => {
        if (command === "reindex_workspace_graph") return graph;
        if (command === "preflight_workspace_removal") {
          return removalPreflight;
        }
        return removeResult;
      },
    );
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await client.reindexWorkspaceGraph(workspace.workspaceId);
    await client.preflightWorkspaceRemoval(workspace.workspaceId);
    await client.removeWorkspace(
      workspace.workspaceId,
      removalPreflight.effectDigest,
      "remove-tauri",
      true,
    );

    expect(invokeMock.mock.calls).toEqual([
      [
        "reindex_workspace_graph",
        { workspaceId: workspace.workspaceId },
      ],
      [
        "preflight_workspace_removal",
        { workspaceId: workspace.workspaceId },
      ],
      [
        "remove_workspace",
        {
          workspaceId: workspace.workspaceId,
          effectDigest: removalPreflight.effectDigest,
          idempotencyKey: "remove-tauri",
          deleteProtectedPaths: true,
        },
      ],
    ]);
  });

  it("uses matching Tauri evidence and verification commands", async () => {
    const invokeMock = vi.fn(async (): Promise<unknown> => workspaceEvidence);
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await client.getWorkspaceEvidence("ws-platform-42");
    await client.promoteAgentVerificationCheck(
      "ws-platform-42",
      "checkout-cargo-test",
    );
    await client.runWorkspaceVerification("ws-platform-42");
    await client.runWorkspaceVerificationCheck?.(
      "ws-platform-42",
      "checkout-cargo-test",
    );
    await client.rerunFailedWorkspaceVerification?.("ws-platform-42");
    await client.cancelWorkspaceVerification?.("ws-platform-42");

    expect(invokeMock.mock.calls).toEqual([
      ["get_workspace_evidence", { workspaceId: "ws-platform-42" }],
      [
        "promote_agent_verification_check",
        {
          workspaceId: "ws-platform-42",
          proposalId: "checkout-cargo-test",
        },
      ],
      ["run_workspace_verification", { workspaceId: "ws-platform-42" }],
      [
        "run_workspace_verification_check",
        {
          workspaceId: "ws-platform-42",
          checkId: "checkout-cargo-test",
        },
      ],
      [
        "rerun_failed_workspace_verification",
        { workspaceId: "ws-platform-42" },
      ],
      ["cancel_workspace_verification", { workspaceId: "ws-platform-42" }],
    ]);
  });

  it("runs AI code review through the matching Tauri command", async () => {
    const invokeMock = vi.fn(async (): Promise<unknown> => ({
      workspaceId: "ws-platform-42",
      provider: "copilot",
      scope: "recentChanges",
      agent: "security-auditor",
      status: "completed",
      findings: [],
      actionableSteps: [],
      summary: "No issues found",
      timestamp: 12345678,
    }));
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    const result = await client.runWorkspaceCodeReview?.(
      "ws-platform-42",
      "copilot",
      "recentChanges",
      "claude-3.7-sonnet",
    );

    expect(result).toMatchObject({
      workspaceId: "ws-platform-42",
      provider: "copilot",
      scope: "recentChanges",
      status: "completed",
    });
    expect(invokeMock).toHaveBeenCalledWith("run_workspace_code_review", {
      workspaceId: "ws-platform-42",
      provider: "copilot",
      scope: "recentChanges",
      model: "claude-3.7-sonnet",
      agent: "claude-3.7-sonnet",
    });
  });

  it("sends Raptik review options over HTTP and reads saved reviews and inferred models", async () => {
    const review = {
      schemaVersion: 2,
      workspaceId: "3f0f1c2e-2a4b-4c55-9a1e-9d2f55d0c001",
      provider: "codex",
      scope: "recentChanges",
      mode: "skill",
      skill: { id: "team-review", label: "Team review", reviewer: "Asha" },
      outcome: "reviewed",
      summary: "One finding.",
      findings: [{ findingId: "f-1", severity: "critical", label: "blocking", filePath: "src/a.rs", line: 4, side: "additions", anchored: true, title: "Unbounded wait", explanation: "It can hang.", precedent: { body: "Add a timeout.", url: "https://gitlab.example/n/1", score: 5.2 } }, { title: "" }],
      actionableSteps: [],
      repositories: [{ repositoryId: "repo_a", repositoryLabel: "a", baseCommitOid: "b", headCommitOid: "h", patchSha256: "sha256:x", changedLines: 4, sizeGateExceeded: false, strictness: "strict", mergeRequest: { iid: 41, baseCommitOid: "b", startCommitOid: "s", headCommitOid: "h" } }],
      reviewedAtUnixMs: 9,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(review))
      .mockResolvedValueOnce(jsonResponse(null))
      .mockResolvedValueOnce(jsonResponse({ raptikSkillLoaded: true, defaultReviewSkill: "team-review", reviewSkills: [{ id: "team-review", label: "Team review", reviewer: "Asha", source: "~/skills/team-review", hasManifest: true, precedentCount: 3, sizeGateLines: 400 }, { label: "no id" }], providers: [{ provider: "codex", installed: true, defaultModel: "gpt-5.5", defaultSource: "~/.codex/config.toml", models: ["gpt-5.5"], modelSelectable: true }, { provider: "unknown", installed: true, models: [] }] }));
    const client = createWorkspaceClient({ runtime: "http", fetch: fetchMock });
    const workspaceId = review.workspaceId;

    const result = await client.runWorkspaceCodeReview?.(workspaceId, "codex", "recentChanges", " gpt-5.5 ", { repositoryId: "repo_a", ignoreSizeGate: true, skill: "team-review", mergeRequestIid: 41 });
    expect(result?.findings).toHaveLength(1);
    expect(result?.findings[0]).toMatchObject({ label: "blocking", anchored: true, side: "additions", precedent: { url: "https://gitlab.example/n/1" } });
    expect(result?.mode).toBe("skill");
    expect(result?.skill).toEqual({ id: "team-review", label: "Team review", reviewer: "Asha" });
    expect(result?.repositories?.[0]?.mergeRequest).toEqual({ iid: 41, baseCommitOid: "b", startCommitOid: "s", headCommitOid: "h" });
    await expect(client.getWorkspaceCodeReview?.(workspaceId)).resolves.toBeNull();
    await expect(client.listAgentModels?.(true)).resolves.toEqual({
      raptikSkillLoaded: true,
      reviewSkills: [{ id: "team-review", label: "Team review", reviewer: "Asha", source: "~/skills/team-review", hasManifest: true, precedentCount: 3, sizeGateLines: 400 }],
      defaultReviewSkill: "team-review",
      providers: [{ provider: "codex", installed: true, defaultModel: "gpt-5.5", defaultSource: "~/.codex/config.toml", models: ["gpt-5.5"], modelSelectable: true }],
    });

    expect(fetchMock.mock.calls.slice(1).map(([url]) => url)).toEqual([
      `/api/v1/workspaces/${workspaceId}/code-review/run`,
      `/api/v1/workspaces/${workspaceId}/code-review`,
      "/api/v1/agent-models?refresh=true",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      provider: "codex",
      scope: "recentChanges",
      model: "gpt-5.5",
      agent: "gpt-5.5",
      repositoryId: "repo_a",
      ignoreSizeGate: true,
      skill: "team-review",
      mergeRequestIid: 41,
    });
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Content-Type")).toBe("application/json");
  });

  it("reads the live code review trace after a sequence number", async () => {
    const workspaceId = "3f0f1c2e-2a4b-4c55-9a1e-9d2f55d0c001";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse({
        workspaceId,
        runId: "run-1",
        provider: "codex",
        model: "gpt-5.5",
        state: "running",
        startedAtUnixMs: 5,
        droppedSteps: 0,
        steps: [
          { sequence: 3, kind: "command", text: "git diff", itemId: "item-1", running: true, atUnixMs: 6 },
          { sequence: 4, kind: "unknown", text: "Other" },
          { sequence: "bad", text: "skip" },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse(null));
    const client = createWorkspaceClient({ runtime: "http", fetch: fetchMock });

    const trace = await client.getWorkspaceCodeReviewTrace?.(workspaceId, 2);
    expect(trace).toMatchObject({ runId: "run-1", model: "gpt-5.5", state: "running" });
    expect(trace?.steps).toEqual([
      { sequence: 3, kind: "command", text: "git diff", itemId: "item-1", running: true, atUnixMs: 6 },
      { sequence: 4, kind: "status", text: "Other", running: false, atUnixMs: 0 },
    ]);
    await expect(client.getWorkspaceCodeReviewTrace?.(workspaceId)).resolves.toBeNull();
    expect(fetchMock.mock.calls.slice(1).map(([url]) => url)).toEqual([
      `/api/v1/workspaces/${workspaceId}/code-review/trace?after=2`,
      `/api/v1/workspaces/${workspaceId}/code-review/trace`,
    ]);
  });

  it("imports a VS Code workspace file through the matching Tauri command", async () => {
    const contents = '{"folders":[{"path":"platform/checkout-api"}]}';
    const invokeMock = vi.fn(async (): Promise<unknown> => codeWorkspaceImport);
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await expect(
      client.importCodeWorkspaceFile({
        fileName: "payments.code-workspace",
        contents,
      }),
    ).resolves.toEqual(codeWorkspaceImport);
    expect(invokeMock).toHaveBeenCalledWith(
      "import_code_workspace_file",
      {
        request: {
          fileName: "payments.code-workspace",
          contents,
        },
      },
    );
  });

  it("clones a reviewed Git URL through the matching Tauri command", async () => {
    const invokeMock = vi.fn(async (): Promise<unknown> => clonedRepository);
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await expect(
      client.cloneRepository({
        remoteUrl: "ssh://git@gitlab.example.com/platform/new-api.git",
      }),
    ).resolves.toEqual(clonedRepository);
    expect(invokeMock).toHaveBeenCalledWith("clone_repository", {
      request: {
        remoteUrl: "ssh://git@gitlab.example.com/platform/new-api.git",
      },
    });
  });

  it("refreshes branches through the matching Tauri command", async () => {
    const invokeMock = vi.fn(
      async (): Promise<unknown> => ({
        repository: refreshedRepository,
      }),
    );
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await expect(
      client.refreshRepositoryBranches("repo_checkout"),
    ).resolves.toEqual(refreshedRepository);
    expect(invokeMock).toHaveBeenCalledWith(
      "refresh_repository_branches",
      { request: { repositoryId: "repo_checkout" } },
    );
  });

  it("uses matching Tauri OpenProject commands and semantic references", async () => {
    const verification = {
      connected: true,
      instanceName: "Acme OpenProject",
      apiVersion: "v3",
      authenticatedUser: "Ada Developer",
    };
    const workPackage = {
      workPackageId: 42,
      displayId: "APP-42",
      subject: "Keep checkout state in sync",
      status: null,
      project: "Checkout",
      content: "checkout-api",
      suggestedRepositories: ["checkout-api"],
      repositoryRecommendations: [
        {
          repositoryId: "repo_checkout",
          label: "checkout-api",
          confidence: 100,
          reason: "The imported issue references this repository's repository label.",
          sources: ["label"],
        },
      ],
    };
    const invokeMock = vi.fn(
      async (command: string): Promise<unknown> =>
        command === "verify_open_project" ? verification : workPackage,
    );
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await expect(client.verifyOpenProject()).resolves.toEqual(verification);
    await expect(
      client.importOpenProjectWorkPackage("APP-42"),
    ).resolves.toEqual({
      ...workPackage,
      status: undefined,
    });

    expect(invokeMock.mock.calls).toEqual([
      ["verify_open_project", undefined],
      ["import_open_project_work_package", { reference: "APP-42" }],
    ]);
  });

  it("uses matching Tauri user-journey commands", async () => {
    const invokeMock = vi.fn(
      async (command: string): Promise<unknown> =>
        command === "list_workspace_test_runs"
          ? workspaceTestRuns
          : command === "get_workspace_test_run"
            ? workspaceTestRunDetailWire
            : workspaceTestRun,
    );
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await client.listWorkspaceTestRuns!("ws-platform-42");
    await expect(
      client.getWorkspaceTestRun!("ws-platform-42", workspaceTestRun.runId),
    ).resolves.toEqual(workspaceTestRunDetail);
    await client.runWorkspaceTestJourney!("ws-platform-42", {
      journeyId: "wts-help-preferences",
      baseUrl: "http://localhost:43210",
    });

    expect(invokeMock.mock.calls).toEqual([
      ["list_workspace_test_runs", { workspaceId: "ws-platform-42" }],
      [
        "get_workspace_test_run",
        {
          workspaceId: "ws-platform-42",
          runId: workspaceTestRun.runId,
        },
      ],
      [
        "run_workspace_test_journey",
        {
          workspaceId: "ws-platform-42",
          request: {
            journeyId: "wts-help-preferences",
            baseUrl: "http://localhost:43210",
          },
        },
      ],
    ]);
  });

  it("uses the exact local session and ActivityWatch transport contracts", async () => {
    const sessionList = {
      schemaVersion: 1,
      sessions: [
        {
          schemaVersion: 1,
          sessionId: "01980188-1234-7abc-8def-123456789abc",
          workspaceId: "ws-platform-42",
          provider: "codex",
          terminal: "warp",
          category: "verification",
          status: "handoffAccepted",
          startedAtUnixMs: 1_721_776_400_000,
          lastHeartbeatAtUnixMs: 1_721_776_400_000,
          endedAtUnixMs: 1_721_776_400_000,
          failure: null,
        },
      ],
      observedSessions: [
        {
          schemaVersion: 1,
          sessionId: "33333333-3333-4333-8333-333333333333",
          workspaceId: "ws-platform-42",
          provider: "codex",
          source: "codexVscodeRollout",
          status: "working",
          activity: "thinking",
          latestUpdate: "Implemented the workspace cards and started validation.",
          updateKind: "progress",
          startedAtUnixMs: 1_721_776_400_000,
          lastEventAtUnixMs: 1_721_776_402_000,
        },
      ],
    };
    const activityWatchStatus = {
      state: "running",
      installation: "detected",
      endpoint: "http://127.0.0.1:5600",
      apiVersion: "v0",
      serverVersion: "0.13.2",
      capabilities: ["status"],
      detail: "ActivityWatch is reachable on loopback.",
    };
    const activityWatchReview = {
      schemaVersion: 1,
      startedAtUnixMs: 1_785_402_000_000,
      endedAtUnixMs: 1_785_403_200_000,
      totalActiveSeconds: 0,
      sessions: [],
      detail: "No active work found.",
    };
    const activeJiraIssues = {
      schemaVersion: 1,
      issues: [],
      detail: "No assigned active Jira issues.",
    };
    const invokeMock = vi.fn(
      async (command: string): Promise<unknown> =>
        command === "list_agent_sessions"
          ? sessionList
          : command === "get_activity_watch_status"
            ? activityWatchStatus
            : command === "get_activity_watch_daily_review"
              ? activityWatchReview
              : activeJiraIssues,
    );
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await expect(
      client.listAgentSessions(" ws-platform-42 "),
    ).resolves.toEqual(sessionList);
    await expect(client.getActivityWatchStatus()).resolves.toEqual(
      activityWatchStatus,
    );
    await expect(
      client.getActivityWatchDailyReview(
        1_785_402_000_000,
        1_785_403_200_000,
      ),
    ).resolves.toEqual(activityWatchReview);
    await expect(client.listActiveJiraIssues()).resolves.toEqual(
      activeJiraIssues,
    );
    expect(invokeMock.mock.calls).toEqual([
      ["list_agent_sessions", { workspaceId: "ws-platform-42" }],
      ["get_activity_watch_status", {}],
      [
        "get_activity_watch_daily_review",
        {
          startedAtUnixMs: 1_785_402_000_000,
          endedAtUnixMs: 1_785_403_200_000,
        },
      ],
      ["list_active_jira_issues", undefined],
    ]);
  });

  it("rejects privacy-expanding session payloads", async () => {
    const invokeMock = vi.fn(async (): Promise<unknown> => ({
      schemaVersion: 1,
      sessions: [
        {
          schemaVersion: 1,
          sessionId: "01980188-1234-7abc-8def-123456789abc",
          workspaceId: "ws-platform-42",
          provider: "codex",
          terminal: "warp",
          category: "verification",
          status: "handoffAccepted",
          startedAtUnixMs: 1_721_776_400_000,
          lastHeartbeatAtUnixMs: 1_721_776_400_000,
          endedAtUnixMs: 1_721_776_400_000,
          failure: null,
          transcript: "private agent conversation",
        },
      ],
    }));
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await expect(
      client.listAgentSessions("ws-platform-42"),
    ).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("rejects private content added to a local agent observation", async () => {
    const invokeMock = vi.fn(async (): Promise<unknown> => ({
      schemaVersion: 1,
      sessions: [],
      observedSessions: [
        {
          schemaVersion: 1,
          sessionId: "33333333-3333-4333-8333-333333333333",
          workspaceId: "ws-platform-42",
          provider: "codex",
          source: "codexVscodeRollout",
          status: "working",
          activity: "thinking",
          startedAtUnixMs: 1_721_776_400_000,
          lastEventAtUnixMs: 1_721_776_402_000,
          reasoning: "private reasoning",
        },
      ],
    }));
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await expect(
      client.listAgentSessions("ws-platform-42"),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("accepts only fixed agent input signals on managed and observed sessions", async () => {
    const invokeMock = vi.fn(async (): Promise<unknown> => ({
      schemaVersion: 1,
      sessions: [
        {
          schemaVersion: 1,
          sessionId: "44444444-4444-4444-8444-444444444444",
          workspaceId: "ws-platform-42",
          provider: "codex",
          terminal: "terminal",
          category: "implementation",
          status: "running",
          startedAtUnixMs: 1_721_776_400_000,
          lastHeartbeatAtUnixMs: 1_721_776_402_000,
          endedAtUnixMs: null,
          failure: null,
          needsInput: {
            kind: "access",
            detail: "Agent needs access.",
          },
        },
      ],
      observedSessions: [
        {
          schemaVersion: 1,
          sessionId: "33333333-3333-4333-8333-333333333333",
          workspaceId: "ws-platform-42",
          provider: "codex",
          source: "codexVscodeRollout",
          status: "working",
          activity: null,
          needsInput: {
            kind: "question",
            detail: "Agent has a question.",
          },
          startedAtUnixMs: 1_721_776_400_000,
          lastEventAtUnixMs: 1_721_776_402_000,
        },
      ],
    }));
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await expect(client.listAgentSessions("ws-platform-42")).resolves.toMatchObject({
      sessions: [{ needsInput: { kind: "access", detail: "Agent needs access." } }],
      observedSessions: [
        { needsInput: { kind: "question", detail: "Agent has a question." } },
      ],
    });
  });

  it("rejects an agent input signal that carries arbitrary request detail", async () => {
    const invokeMock = vi.fn(async (): Promise<unknown> => ({
      schemaVersion: 1,
      sessions: [],
      observedSessions: [
        {
          schemaVersion: 1,
          sessionId: "33333333-3333-4333-8333-333333333333",
          workspaceId: "ws-platform-42",
          provider: "codex",
          source: "codexVscodeRollout",
          status: "working",
          activity: null,
          needsInput: {
            kind: "question",
            detail: "Should I use the private production credential?",
          },
          startedAtUnixMs: 1_721_776_400_000,
          lastEventAtUnixMs: 1_721_776_402_000,
        },
      ],
    }));
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await expect(client.listAgentSessions("ws-platform-42")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("rejects an agent-authored update without its semantic kind", async () => {
    const invokeMock = vi.fn(async (): Promise<unknown> => ({
      schemaVersion: 1,
      sessions: [],
      observedSessions: [
        {
          schemaVersion: 1,
          sessionId: "33333333-3333-4333-8333-333333333333",
          workspaceId: "ws-platform-42",
          provider: "codex",
          source: "codexVscodeRollout",
          status: "idle",
          activity: null,
          latestUpdate: "Finished the requested work.",
          startedAtUnixMs: 1_721_776_400_000,
          lastEventAtUnixMs: 1_721_776_402_000,
        },
      ],
    }));
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await expect(
      client.listAgentSessions("ws-platform-42"),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("accepts the persisted user-stopped terminal session state", async () => {
    const stopped: AgentSession = {
      schemaVersion: 1,
      sessionId: "44444444-4444-4444-8444-444444444444",
      workspaceId: "ws-platform-42",
      provider: "codex",
      terminal: "terminal",
      category: "implementation",
      status: "interrupted",
      startedAtUnixMs: 7_000,
      lastHeartbeatAtUnixMs: 8_000,
      endedAtUnixMs: 8_000,
      failure: "userStopped",
    };
    const invokeMock = vi.fn(async (): Promise<unknown> => ({
      schemaVersion: 1,
      sessions: [stopped],
    }));
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke:
        invokeMock as unknown as NonNullable<
          WorkspaceClientOptions["invoke"]
        >,
    });

    await expect(client.listAgentSessions("ws-platform-42")).resolves.toEqual({
      schemaVersion: 1,
      sessions: [stopped],
    });
  });

  it("uses HTTP workflow and opaque generated planning-document routes", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const generatedId = `generated-${"c".repeat(64)}` as const;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(
        jsonResponse({ state: "review", revision: 2, updatedAtUnixMs: 7 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          workspaceId: workspace.workspaceId,
          documents: [{ documentId: generatedId, fileName: "evidence.csv" }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          workspaceId: workspace.workspaceId,
          documentId: generatedId,
          fileName: "evidence.csv",
          contents: "host,status\nnode-1,failed\n",
          sha256: digest,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          workspaceId: workspace.workspaceId,
          documentId: generatedId,
          fileName: "evidence.csv",
          contents: "host,status\nnode-1,passed\n",
          sha256: `sha256:${"b".repeat(64)}`,
        }),
      );
    const client = createWorkspaceClient({ runtime: "http", fetch: fetchMock });

    await expect(
      client.transitionWorkspaceWorkflow(workspace.workspaceId, "review", 1),
    ).resolves.toMatchObject({ state: "review", revision: 2 });
    await expect(
      client.listWorkspacePlanningDocuments(workspace.workspaceId),
    ).resolves.toMatchObject({ documents: [{ documentId: generatedId }] });
    await expect(
      client.readWorkspacePlanningDocument(workspace.workspaceId, generatedId),
    ).resolves.toMatchObject({ contents: "host,status\nnode-1,failed\n", sha256: digest });
    await expect(
      client.updateWorkspacePlanningDocument(
        workspace.workspaceId,
        generatedId,
        digest,
        "host,status\nnode-1,passed\n",
      ),
    ).resolves.toMatchObject({ contents: "host,status\nnode-1,passed\n" });

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/v1/workspaces/${workspace.workspaceId}/workflow`,
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `/api/v1/workspaces/${workspace.workspaceId}/planning/documents`,
    );
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      `/api/v1/workspaces/${workspace.workspaceId}/planning/documents/${generatedId}`,
    );
    expect(fetchMock.mock.calls[4]?.[0]).toBe(
      `/api/v1/workspaces/${workspace.workspaceId}/planning/documents/${generatedId}`,
    );
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toEqual({
      expectedSha256: digest,
      contents: "host,status\nnode-1,passed\n",
    });
  });

  it("uses HTTP board placement and follow-agent routes", async () => {
    const placement = {
      state: "review" as const,
      revision: 2,
      updatedAtUnixMs: 7,
      placement: { mode: "pinned" as const, rank: 1 },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(placement))
      .mockResolvedValueOnce(
        jsonResponse({
          ...placement,
          revision: 3,
          placement: { mode: "automatic", rank: 1 },
        }),
      );
    const client = createWorkspaceClient({ runtime: "http", fetch: fetchMock });
    const neighborId = "22222222-2222-4222-8222-222222222222";

    await expect(
      client.placeWorkspaceOnBoard(workspace.workspaceId, {
        state: "review",
        expectedRevision: 1,
        beforeWorkspaceId: neighborId,
      }),
    ).resolves.toEqual(placement);
    await expect(
      client.followWorkspaceAgent(workspace.workspaceId, 2),
    ).resolves.toMatchObject({
      revision: 3,
      placement: { mode: "automatic", rank: 1 },
    });

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/v1/workspaces/${workspace.workspaceId}/board-placement`,
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      state: "review",
      expectedRevision: 1,
      beforeWorkspaceId: neighborId,
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `/api/v1/workspaces/${workspace.workspaceId}/board-placement/follow-agent`,
    );
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      expectedRevision: 2,
    });
  });

  it("uses the matching Tauri workflow and planning commands", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const invokeMock = vi
      .fn()
      .mockResolvedValueOnce({ state: "parked", revision: 3, updatedAtUnixMs: 8 })
      .mockResolvedValueOnce({
        workspaceId: workspace.workspaceId,
        documents: [{ documentId: "findings", fileName: "FINDINGS.md" }],
      })
      .mockResolvedValueOnce({
        workspaceId: workspace.workspaceId,
        documentId: "findings",
        fileName: "FINDINGS.md",
        contents: "# Findings\n",
        sha256: digest,
      })
      .mockResolvedValueOnce({
        workspaceId: workspace.workspaceId,
        documentId: "findings",
        fileName: "FINDINGS.md",
        contents: "# Updated\n",
        sha256: `sha256:${"b".repeat(64)}`,
      });
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke: invokeMock as NonNullable<WorkspaceClientOptions["invoke"]>,
    });

    await client.transitionWorkspaceWorkflow(workspace.workspaceId, "parked", 2);
    await client.listWorkspacePlanningDocuments(workspace.workspaceId);
    await client.readWorkspacePlanningDocument(workspace.workspaceId, "findings");
    await client.updateWorkspacePlanningDocument(
      workspace.workspaceId,
      "findings",
      digest,
      "# Updated\n",
    );

    expect(invokeMock).toHaveBeenNthCalledWith(1, "transition_workspace_workflow", {
      workspaceId: workspace.workspaceId,
      request: { state: "parked", expectedRevision: 2 },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "list_workspace_planning_documents", {
      workspaceId: workspace.workspaceId,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "read_workspace_planning_document", {
      workspaceId: workspace.workspaceId,
      documentId: "findings",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "update_workspace_planning_document", {
      workspaceId: workspace.workspaceId,
      documentId: "findings",
      request: { expectedSha256: digest, contents: "# Updated\n" },
    });
  });

  it("uses matching Tauri board placement commands", async () => {
    const invokeMock = vi
      .fn()
      .mockResolvedValueOnce({
        state: "active",
        revision: 4,
        updatedAtUnixMs: 8,
        placement: { mode: "pinned", rank: 0 },
      })
      .mockResolvedValueOnce({
        state: "active",
        revision: 5,
        updatedAtUnixMs: 9,
        placement: { mode: "automatic", rank: 0 },
      });
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke: invokeMock as NonNullable<WorkspaceClientOptions["invoke"]>,
    });

    await client.placeWorkspaceOnBoard(workspace.workspaceId, {
      state: "active",
      expectedRevision: 3,
    });
    await client.followWorkspaceAgent(workspace.workspaceId, 4);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "place_workspace_on_board", {
      workspaceId: workspace.workspaceId,
      request: { state: "active", expectedRevision: 3 },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "follow_workspace_agent", {
      workspaceId: workspace.workspaceId,
      request: { expectedRevision: 4 },
    });
  });

  it("uses HTTP review-thread routes and preserves stale anchor metadata", async () => {
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const threadId = "22222222-2222-4222-8222-222222222222";
    const commentId = "33333333-3333-4333-8333-333333333333";
    const digest = `sha256:${"a".repeat(64)}`;
    const currentDigest = `sha256:${"b".repeat(64)}`;
    const thread = {
      threadId,
      workspaceId,
      target: {
        kind: "planningDocument",
        documentId: "plan",
        documentSha256: digest,
        line: 4,
      },
      anchorState: "stale",
      currentDocumentSha256: currentDigest,
      state: "open",
      revision: 1,
      comments: [{
        commentId,
        author: "user",
        body: "Check this condition.",
        createdAtUnixMs: 10,
      }],
      createdAtUnixMs: 10,
      updatedAtUnixMs: 10,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse({ workspaceId, threads: [thread] }))
      .mockResolvedValueOnce(jsonResponse(thread))
      .mockResolvedValueOnce(jsonResponse({
        ...thread,
        state: "resolved",
        revision: 2,
        updatedAtUnixMs: 12,
        resolvedAtUnixMs: 12,
      }));
    const client = createWorkspaceClient({ runtime: "http", fetch: fetchMock });

    await expect(client.listWorkspaceReviewThreads(workspaceId)).resolves.toEqual({
      workspaceId,
      threads: [thread],
    });
    await client.createWorkspaceReviewThread(
      workspaceId,
      thread.target as {
        kind: "planningDocument";
        documentId: "plan";
        documentSha256: string;
        line: number;
      },
      "Check this condition.",
    );
    await client.resolveWorkspaceReviewThread(workspaceId, threadId, 1);

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/v1/workspaces/${workspaceId}/review/threads`,
    );
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        target: thread.target,
        author: "user",
        body: "Check this condition.",
      }),
    });
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      `/api/v1/workspaces/${workspaceId}/review/threads/${threadId}/resolve`,
    );
  });

  it("uses matching Tauri review-thread commands", async () => {
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const threadId = "22222222-2222-4222-8222-222222222222";
    const digest = `sha256:${"a".repeat(64)}`;
    const response = {
      threadId,
      workspaceId,
      target: { kind: "planningDocument", documentId: "plan", documentSha256: digest },
      anchorState: "current",
      currentDocumentSha256: digest,
      state: "open",
      revision: 1,
      comments: [{
        commentId: "33333333-3333-4333-8333-333333333333",
        author: "user",
        body: "Check this.",
        createdAtUnixMs: 1,
      }],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };
    const invokeMock = vi
      .fn()
      .mockResolvedValueOnce({ workspaceId, threads: [] })
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce({
        ...response,
        state: "resolved",
        revision: 2,
        resolvedAtUnixMs: 2,
        updatedAtUnixMs: 2,
      });
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke: invokeMock as NonNullable<WorkspaceClientOptions["invoke"]>,
    });

    await client.listWorkspaceReviewThreads(workspaceId);
    await client.createWorkspaceReviewThread(
      workspaceId,
      { kind: "planningDocument", documentId: "plan", documentSha256: digest },
      "Check this.",
    );
    await client.resolveWorkspaceReviewThread(workspaceId, threadId, 1);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "list_workspace_review_threads", {
      workspaceId,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "create_workspace_review_thread", {
      workspaceId,
      request: {
        target: { kind: "planningDocument", documentId: "plan", documentSha256: digest },
        author: "user",
        body: "Check this.",
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "resolve_workspace_review_thread", {
      workspaceId,
      threadId,
      request: { expectedRevision: 1 },
    });
  });

  it("rejects invalid review comments before a transport call", async () => {
    const invokeMock = vi.fn();
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke: invokeMock as NonNullable<WorkspaceClientOptions["invoke"]>,
    });
    await expect(client.createWorkspaceReviewThread(
      "11111111-1111-4111-8111-111111111111",
      {
        kind: "planningDocument",
        documentId: "plan",
        documentSha256: `sha256:${"a".repeat(64)}`,
      },
      " ",
    )).rejects.toMatchObject({ code: "invalid_request" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("uses the same typed verification-check review target over HTTP and Tauri", async () => {
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const threadId = "22222222-2222-4222-8222-222222222222";
    const target = {
      kind: "verificationCheck" as const,
      planRevision: 7,
      completedAtUnixMs: 1_722_000_000_100,
      checkId: "checkout-api-cargo-test",
    };
    const thread = {
      threadId,
      workspaceId,
      target,
      anchorState: "current",
      currentVerificationCompletedAtUnixMs: target.completedAtUnixMs,
      state: "open",
      revision: 1,
      comments: [{
        commentId: "33333333-3333-4333-8333-333333333333",
        author: "user",
        body: "The local service was not running.",
        createdAtUnixMs: 1,
      }],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(thread))
      .mockResolvedValueOnce(jsonResponse({
        workspaceId,
        threads: [{
          ...thread,
          anchorState: "stale",
          currentVerificationCompletedAtUnixMs: undefined,
        }],
      }));
    const http = createWorkspaceClient({ runtime: "http", fetch: fetchMock });

    await expect(
      http.createWorkspaceReviewThread(
        workspaceId,
        target,
        "The local service was not running.",
      ),
    ).resolves.toEqual(thread);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        target,
        author: "user",
        body: "The local service was not running.",
      }),
    });
    await expect(http.listWorkspaceReviewThreads(workspaceId)).resolves.toMatchObject({
      threads: [{
        threadId,
        anchorState: "stale",
        target,
      }],
    });

    const invokeMock = vi.fn().mockResolvedValueOnce(thread);
    const tauri = createWorkspaceClient({
      runtime: "tauri",
      invoke: invokeMock as NonNullable<WorkspaceClientOptions["invoke"]>,
    });
    await expect(
      tauri.createWorkspaceReviewThread(
        workspaceId,
        target,
        "The local service was not running.",
      ),
    ).resolves.toEqual(thread);
    expect(invokeMock).toHaveBeenCalledWith("create_workspace_review_thread", {
      workspaceId,
      request: {
        target,
        author: "user",
        body: "The local service was not running.",
      },
    });
  });

  it("preserves the exact changed-line review target over HTTP and Tauri", async () => {
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const target = {
      kind: "codeChange" as const,
      repositoryId: "repo_checkout",
      baseCommitOid: "a".repeat(40),
      headCommitOid: "b".repeat(40),
      patchSha256: `sha256:${"c".repeat(64)}`,
      filePath: "src/checkout.ts",
      side: "additions" as const,
      line: 42,
    };
    const thread = {
      threadId: "22222222-2222-4222-8222-222222222222",
      workspaceId,
      target,
      anchorState: "current",
      state: "open",
      revision: 1,
      comments: [{
        commentId: "33333333-3333-4333-8333-333333333333",
        author: "user",
        body: "Explain this branch.",
        createdAtUnixMs: 1,
      }],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-123" }))
      .mockResolvedValueOnce(jsonResponse(thread));
    const http = createWorkspaceClient({ runtime: "http", fetch: fetchMock });

    await expect(
      http.createWorkspaceReviewThread(
        workspaceId,
        target,
        "Explain this branch.",
      ),
    ).resolves.toEqual(thread);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        target,
        author: "user",
        body: "Explain this branch.",
      }),
    });

    const invokeMock = vi.fn().mockResolvedValueOnce(thread);
    const tauri = createWorkspaceClient({
      runtime: "tauri",
      invoke: invokeMock as NonNullable<WorkspaceClientOptions["invoke"]>,
    });
    await expect(
      tauri.createWorkspaceReviewThread(
        workspaceId,
        target,
        "Explain this branch.",
      ),
    ).resolves.toEqual(thread);
    expect(invokeMock).toHaveBeenCalledWith("create_workspace_review_thread", {
      workspaceId,
      request: {
        target,
        author: "user",
        body: "Explain this branch.",
      },
    });

    await expect(
      tauri.createWorkspaceReviewThread(
        workspaceId,
        { ...target, filePath: "../secret" },
        "Read this file.",
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
