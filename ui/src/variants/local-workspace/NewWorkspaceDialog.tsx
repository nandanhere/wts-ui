import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { Button, Checkbox, Input, Label, Radio, RadioGroup } from "react-aria-components";
import {
  CODE_WORKSPACE_FILE_MAX_BYTES,
  type CodeWorkspaceFileImportResult,
  type CloneRepositoryRequest,
  type CreateWorkspaceRequest,
  type JiraIssueImport,
  type OpenProjectWorkPackageImport,
  type RepositoryCatalog,
  type RepositorySummary,
  type RuntimeAnalysisResult,
  type RuntimePlanSelection,
  type RuntimePortPolicy,
  type WorkspacePlanningSelection,
  type WorkspaceClient,
  WorkspaceClientError,
  type WorkspaceView,
} from "../../lib/wtsClient";
import { useVisiblePolling } from "../../lib/useVisiblePolling";
import { SelectMenu } from "../../components/SelectMenu";
import { useDialogFocusReturn } from "../../components/useDialogFocusReturn";
import { Glyph } from "./Glyph";
import styles from "./LocalWorkspace.module.css";
import { type Provider, type Workspace } from "./workspaceTypes";
import {
  type RepositoryCloneHandle,
  type DeferredWorkspaceCreation,
  type RepoEvidence,
  type RuntimePortDraft,
  type RuntimeServiceDraft,
  type RuntimeDraftSnapshot,
  readTextFile,
  codeWorkspaceDiagnosticReasonLabels,
  codeWorkspaceDiagnosticBasisLabels,
  unsupportedUriDiagnosticValue,
  unsupportedDiagnosticValue,
  missingDiagnosticPathValue,
  codeWorkspaceFolderStatusLabel,
  codeWorkspaceDiagnosticsPayload,
  logCodeWorkspaceImportCompletion,
  logCodeWorkspaceImportFailure,
  issueKeyFrom,
  openProjectReferenceFrom,
  openProjectImportMatchesReference,
  importedIssueContent,
  workspaceIntentMatches,
  repositoryNamesFrom,
  repositoryLeafFromRemoteUrl,
  type IssueRepositoryUpstream,
  repositoryUpstreamsFromIssueContent,
  joinDisplayPath,
  repositoryEvidenceKey,
  moveCompositeFocus,
  catalogRepositoryFor,
  remoteMatchesRepositoryLabel,
  runtimeConfidenceLabels,
  runtimeAnalysisPreparationFor,
  claimedRuntimePorts,
  allocateFreeRuntimePort,
  runtimeDraftsFromAnalysis,
  validRuntimePort,
  runtimePortErrorId,
  type RepositoryForgeTarget,
  repositoryForgeTarget,
  forgeDisplayName,
  newIdempotencyKey,
  providerToRequest,
  providerMarks,
  type ReviewWorkspaceSeed,
  type DeferredCloneRequest,
} from "./workspaceCreation";
import { InfoTooltip } from "./InfoTooltip";

type CreateStep =
  "source" | "evidence" | "services" | "manifest" | "saving" | "saved";

type SourceMode = "issue" | "workspace" | "codeWorkspace" | "set";

type IssueProvider = "jira" | "openProject";

type CodeWorkspaceRepositoryAddMode = "existing" | "clone";

type RepositoryCloneState = "idle" | "loading" | "ready" | "error";

function RepositoryCloneTask({
  floating = false,
  message,
  onMoveToKanban,
  state,
}: {
  floating?: boolean;
  message: string;
  onMoveToKanban?: () => void;
  state: RepositoryCloneState;
}) {
  return (
    <aside
      aria-live="polite"
      className={
        floating
          ? `${styles.repositoryCloneTask} ${styles.backgroundRepositoryCloneTask}`
          : styles.repositoryCloneTask
      }
      data-error={state === "error" || undefined}
      data-state={state}
      data-ui="workspace-create.clone-task"
      data-ui-label="Repository clone task"
      role={state === "error" ? "alert" : "status"}
    >
      <span>
        <Glyph
          name={
            state === "loading"
              ? "refresh"
              : state === "error"
                ? "warning"
                : "check"
          }
          size={14}
        />
      </span>
      <div>
        <b>Repository clone</b>
        <p>{message}</p>
        {state === "loading" && (
          <small>
            {floating
              ? "You can continue workspace setup while this clone runs."
              : "You can add other repositories while this clone runs."}
          </small>
        )}
        {state === "loading" && onMoveToKanban && (
          <button
            className={styles.repositoryCloneDeferButton}
            onClick={onMoveToKanban}
            type="button"
          >
            Move to Kanban
          </button>
        )}
      </div>
    </aside>
  );
}

function RepositoryClonePreferences({
  branch,
  disabled,
  onBranchChange,
  onShallowChange,
  shallow,
}: {
  branch: string;
  disabled: boolean;
  onBranchChange: (branch: string) => void;
  onShallowChange: (shallow: boolean) => void;
  shallow: boolean;
}) {
  return (
    <div className={styles.repositoryClonePreferences}>
      <label>
        <span>Branch to clone</span>
        <input
          aria-label="Branch to clone"
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => onBranchChange(event.target.value)}
          placeholder="Default branch"
          spellCheck={false}
          type="text"
          value={branch}
        />
      </label>
      <label className={styles.repositoryCloneShallowOption}>
        <input
          checked={shallow}
          disabled={disabled}
          onChange={(event) => onShallowChange(event.target.checked)}
          type="checkbox"
        />
        <span>
          <b>Limit the clone</b>
          <small>Clone only this branch and its latest commit.</small>
        </span>
      </label>
    </div>
  );
}

const providers: Array<{
  id: Provider;
  description: string;
  capability: string;
}> = [
  {
    id: "Codex",
    description: "Interactive Codex CLI rooted at the generated workspace.",
    capability: "Terminal CLI",
  },
  {
    id: "OpenCode",
    description:
      "A terminal-native coding agent inside the selected worktrees.",
    capability: "Terminal session",
  },
  {
    id: "Hermes",
    description: "Interactive Hermes CLI rooted at the generated workspace.",
    capability: "Terminal CLI",
  },
  {
    id: "VS Code",
    description: "Open the workspace directly without an autonomous agent.",
    capability: "Editor only",
  },
  {
    id: "Copilot",
    description:
      "Interactive GitHub Copilot CLI rooted at the generated workspace.",
    capability: "Terminal CLI",
  },
];

function CodeWorkspaceDiagnosticsPanel({
  imported,
  copyState,
  onCopy,
}: {
  imported: CodeWorkspaceFileImportResult;
  copyState: "idle" | "copied" | "error";
  onCopy: () => void;
}) {
  const diagnostics = imported.diagnostics;
  if (!diagnostics) return null;

  return (
    <details
      className={styles.importDiagnostics}
      data-ui="workspace-import.diagnostics"
      data-ui-label="Import diagnostics"
    >
      <summary>
        <span className={styles.importDiagnosticsChevron}>
          <Glyph name="chevron" size={14} />
        </span>
        <span>
          <b>Developer diagnostics</b>
          <small>Trace trusted-root discovery and folder matching</small>
        </span>
        <span className={styles.importDiagnosticsBadge}>DEBUG DATA</span>
      </summary>

      <div className={styles.importDiagnosticsBody}>
        <p className={styles.importDiagnosticsBoundary}>
          WTS searches a bounded set of nested folders under the configured
          trusted source roots. Absolute paths can match exactly. Because the
          browser does not reveal the selected file’s parent directory, relative
          paths remain non-authoritative lookup hints: WTS first compares their
          safe path suffix inside the trusted catalog, then tries the final
          folder name and optional VS Code name. A workspace file never grants
          filesystem authority outside those roots.
        </p>

        <dl className={styles.importDiagnosticsFacts}>
          <div>
            <dt>Import ID</dt>
            <dd>
              <code>{imported.importId}</code>
            </dd>
          </div>
          <div>
            <dt>Discovery mode</dt>
            <dd>Nested repositories · bounded scan</dd>
          </div>
          <div className={styles.importDiagnosticsRootFact}>
            <dt>Primary trusted source root</dt>
            <dd>
              <code>{diagnostics.catalog.repositoryRootDisplayPath}</code>
            </dd>
          </div>
          <div>
            <dt>Repositories found</dt>
            <dd>
              {diagnostics.catalog.repositoryCount}{" "}
              {diagnostics.catalog.repositoryCount === 1
                ? "repository"
                : "repositories"}
            </dd>
          </div>
          <div>
            <dt>Entries skipped</dt>
            <dd>
              {diagnostics.catalog.skippedEntries} during bounded discovery
            </dd>
          </div>
        </dl>

        <section
          aria-labelledby="code-workspace-catalog-sample-title"
          className={styles.importDiagnosticsSection}
        >
          <header>
            <h4 id="code-workspace-catalog-sample-title">
              Discovered local sources
            </h4>
            <small>
              {diagnostics.catalog.repositories.length} shown
              {diagnostics.catalog.repositoriesTruncated ? " · truncated" : ""}
            </small>
          </header>
          {diagnostics.catalog.repositories.length > 0 ? (
            <ul className={styles.importDiagnosticsRepositories}>
              {diagnostics.catalog.repositories.map((repository, index) => (
                <li
                  key={`${repository.label}-${repository.displayPath}-${index}`}
                >
                  <b>{repository.label}</b>
                  <code>{repository.displayPath}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.importDiagnosticsEmpty}>
              No Git repositories were discovered under the configured trusted
              source roots within this bounded scan.
            </p>
          )}
        </section>

        <section
          aria-labelledby="code-workspace-folder-diagnostics-title"
          className={styles.importDiagnosticsSection}
        >
          <header>
            <h4 id="code-workspace-folder-diagnostics-title">
              Folder resolution
            </h4>
            <small>{diagnostics.folders.length} inspected</small>
          </header>
          <div className={styles.importDiagnosticsFolders}>
            {diagnostics.folders.map((diagnostic) => {
              const folder = imported.folders[diagnostic.folderIndex];
              return (
                <article
                  data-status={diagnostic.status}
                  key={`${diagnostic.folderIndex}-${diagnostic.reason}`}
                >
                  <header>
                    <span>
                      <b>
                        {folder?.name ?? `Folder ${diagnostic.folderIndex + 1}`}
                      </b>
                      <code>{folder?.rawPath || "No path supplied"}</code>
                    </span>
                    <em>{codeWorkspaceFolderStatusLabel(diagnostic.status)}</em>
                  </header>
                  <p>
                    {codeWorkspaceDiagnosticReasonLabels[diagnostic.reason]}
                    <code>{diagnostic.reason}</code>
                  </p>
                  {diagnostic.attempts.length > 0 && (
                    <ol
                      aria-label={`Matching attempts for ${
                        folder?.name ?? "folder"
                      }`}
                    >
                      {diagnostic.attempts.map((attempt, attemptIndex) => (
                        <li
                          key={`${attempt.basis}-${attempt.value}-${attemptIndex}`}
                        >
                          <span>
                            {codeWorkspaceDiagnosticBasisLabels[attempt.basis]}
                          </span>
                          <code>{attempt.value || "empty value"}</code>
                          <small>
                            {attempt.candidateCount}{" "}
                            {attempt.candidateCount === 1
                              ? "candidate"
                              : "candidates"}
                          </small>
                        </li>
                      ))}
                    </ol>
                  )}
                  {diagnostic.candidates.length > 0 && (
                    <div className={styles.importDiagnosticsCandidates}>
                      <b>
                        Decisive candidates
                        {diagnostic.candidatesTruncated ? " (truncated)" : ""}
                      </b>
                      <ul>
                        {diagnostic.candidates.map((candidate, index) => (
                          <li
                            key={`${candidate.label}-${candidate.displayPath}-${index}`}
                          >
                            <span>{candidate.label}</span>
                            <code>{candidate.displayPath}</code>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {diagnostic.duplicateRepository && (
                    <small className={styles.importDiagnosticsDuplicate}>
                      This match duplicated a repository selected by an earlier
                      folder.
                    </small>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        <footer className={styles.importDiagnosticsFooter}>
          <p>
            The copy includes local paths and repository labels. It excludes
            workspace-file contents, settings, tasks, extensions, and session
            credentials.
          </p>
          <button
            className={styles.importDiagnosticsCopy}
            onClick={onCopy}
            type="button"
          >
            <Glyph name={copyState === "copied" ? "check" : "copy"} size={14} />
            {copyState === "copied" ? "Diagnostics copied" : "Copy diagnostics"}
          </button>
          {copyState !== "idle" && (
            <span
              aria-live={copyState === "error" ? "assertive" : "polite"}
              className={styles.importDiagnosticsCopyStatus}
              role={copyState === "error" ? "alert" : "status"}
            >
              {copyState === "error"
                ? "Clipboard unavailable. Copy from this panel instead."
                : "Copied—review local paths before sharing."}
            </span>
          )}
        </footer>
      </div>
    </details>
  );
}

export function NewWorkspaceDialog({
  open,
  onOpenChange,
  onComplete,
  client,
  workspaces,
  workspaceRootDisplayPath,
  repositoryCatalog,
  initialTemplateWorkspaceId,
  initialRepositoryBaseOverrides,
  initialReviewWorkspace,
  initialPlanningEnabled,
  initialDeferredClone,
  onStartRepositoryClone,
  onDeferRepositoryClone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: (workspace: WorkspaceView) => void;
  client: WorkspaceClient;
  workspaces: Workspace[];
  workspaceRootDisplayPath: string;
  repositoryCatalog?: RepositoryCatalog;
  initialTemplateWorkspaceId?: string;
  initialRepositoryBaseOverrides?: Record<string, string>;
  initialReviewWorkspace?: ReviewWorkspaceSeed;
  initialPlanningEnabled?: boolean;
  initialDeferredClone?: DeferredWorkspaceCreation;
  onStartRepositoryClone: (
    request: CloneRepositoryRequest,
  ) => RepositoryCloneHandle;
  onDeferRepositoryClone: (request: DeferredCloneRequest) => void;
}) {
  const dialogFocusReturn = useDialogFocusReturn(
    '[data-dialog-initial-focus], [role="combobox"][aria-label="Saved plan to copy"]',
  );
  const isRevisionMode = Boolean(initialTemplateWorkspaceId);
  const [step, setStep] = useState<CreateStep>("source");
  const [furthestReviewStepNumber, setFurthestReviewStepNumber] = useState(1);
  const [sourceMode, setSourceMode] = useState<SourceMode>("issue");
  const [issueProvider, setIssueProvider] = useState<IssueProvider>("jira");
  const [sourceValue, setSourceValue] = useState("");
  const [templateWorkspaceId, setTemplateWorkspaceId] = useState("");
  const [revisionTitle, setRevisionTitle] = useState("");
  const [issueRepositories, setIssueRepositories] = useState("");
  const [jiraImport, setJiraImport] = useState<JiraIssueImport | null>(null);
  const [openProjectImport, setOpenProjectImport] =
    useState<OpenProjectWorkPackageImport | null>(null);
  const [sourceImportState, setSourceImportState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [sourceImportMessage, setSourceImportMessage] = useState("");
  const [codeWorkspaceImport, setCodeWorkspaceImport] =
    useState<CodeWorkspaceFileImportResult | null>(null);
  const [codeWorkspaceImportState, setCodeWorkspaceImportState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [codeWorkspaceImportMessage, setCodeWorkspaceImportMessage] =
    useState("");
  const [codeWorkspaceTitle, setCodeWorkspaceTitle] = useState("");
  const [codeWorkspaceAddedRepositoryIds, setCodeWorkspaceAddedRepositoryIds] =
    useState<string[]>([]);
  const [codeWorkspaceRepositoryToAdd, setCodeWorkspaceRepositoryToAdd] =
    useState("");
  const [codeWorkspaceRepositoryAddMode, setCodeWorkspaceRepositoryAddMode] =
    useState<CodeWorkspaceRepositoryAddMode>("existing");
  const [codeWorkspaceCloneUrl, setCodeWorkspaceCloneUrl] = useState("");
  const [codeWorkspaceCloneBranch, setCodeWorkspaceCloneBranch] = useState("");
  const [codeWorkspaceCloneShallow, setCodeWorkspaceCloneShallow] =
    useState(true);
  const [codeWorkspaceCloneState, setCodeWorkspaceCloneState] =
    useState<RepositoryCloneState>("idle");
  const [codeWorkspaceCloneMessage, setCodeWorkspaceCloneMessage] =
    useState("");
  const [issueRepositoryCloneKey, setIssueRepositoryCloneKey] = useState("");
  const [issueRepositoryCloneNotice, setIssueRepositoryCloneNotice] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const [issueRepositoryLocalMatches, setIssueRepositoryLocalMatches] =
    useState<Record<string, string>>({});
  const [issueRepositoryShowAllRemotes, setIssueRepositoryShowAllRemotes] =
    useState<Record<string, boolean>>({});
  const [codeWorkspaceClonedRepositories, setCodeWorkspaceClonedRepositories] =
    useState<RepositorySummary[]>([]);
  const [codeWorkspaceClonedBaseRefs, setCodeWorkspaceClonedBaseRefs] =
    useState<Record<string, string>>({});
  const [refreshedRepositories, setRefreshedRepositories] = useState<
    RepositorySummary[]
  >([]);
  const [refreshingRepositoryId, setRefreshingRepositoryId] = useState("");
  const [codeWorkspaceCloneRoot, setCodeWorkspaceCloneRoot] = useState("");
  const [codeWorkspaceExportState, setCodeWorkspaceExportState] = useState<
    "idle" | "downloaded" | "error"
  >("idle");
  const [
    codeWorkspaceDiagnosticsCopyState,
    setCodeWorkspaceDiagnosticsCopyState,
  ] = useState<"idle" | "copied" | "error">("idle");
  const [repos, setRepos] = useState<RepoEvidence[]>([]);
  const [openingRepositoryBaseKey, setOpeningRepositoryBaseKey] = useState("");
  const [repositoryBaseNotice, setRepositoryBaseNotice] = useState<{
    kind: "opening" | "success" | "error";
    message: string;
  } | null>(null);
  const [runtimeAnalysis, setRuntimeAnalysis] =
    useState<RuntimeAnalysisResult | null>(null);
  const [runtimeAnalysisState, setRuntimeAnalysisState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [runtimeAnalysisError, setRuntimeAnalysisError] = useState("");
  const [runtimeAnalysisElapsedSeconds, setRuntimeAnalysisElapsedSeconds] =
    useState(0);
  const [runtimeAnalysisFingerprint, setRuntimeAnalysisFingerprint] =
    useState("");
  const [runtimeServiceDrafts, setRuntimeServiceDrafts] = useState<
    Map<string, RuntimeServiceDraft>
  >(new Map());
  const [provider, setProvider] = useState<Provider>("Codex");
  const [planningEnabled, setPlanningEnabled] = useState(false);
  const [planningFolder, setPlanningFolder] =
    useState<WorkspacePlanningSelection["folder"]>("plansAndKanban");
  const [planningFormat, setPlanningFormat] =
    useState<WorkspacePlanningSelection["format"]>("kanban");
  const [saveError, setSaveError] = useState("");
  const [saveWarning, setSaveWarning] = useState("");
  const [savedWorkspace, setSavedWorkspace] = useState<WorkspaceView | null>(
    null,
  );
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousStepRef = useRef<CreateStep>("source");
  const idempotencyKeyRef = useRef("");
  const idempotencyRequestRef = useRef("");
  const dialogSessionGenerationRef = useRef(0);
  const sourceImportGenerationRef = useRef(0);
  const codeWorkspaceImportIdRef = useRef<string | null>(null);
  const repositoryCloneGenerationRef = useRef(0);
  const activeRepositoryCloneIdRef = useRef("");
  const repositoryEditRevisionRef = useRef(0);
  const repositoryBaseOpenGenerationRef = useRef(0);
  const runtimeAnalysisGenerationRef = useRef(0);
  const runtimeAnalysisCacheRef = useRef(
    new Map<string, RuntimeAnalysisResult>(),
  );
  const runtimeDraftSnapshotRef = useRef<RuntimeDraftSnapshot | null>(null);
  const reviewedSourceRepositoriesFingerprintRef = useRef("");
  const currentRuntimeFingerprintRef = useRef("");
  const saveGenerationRef = useRef(0);
  const activeSaveRef = useRef(false);
  const currentClientRef = useRef(client);
  const autoSuggestedRepositoriesRef = useRef<string | null>(null);

  useEffect(() => {
    dialogSessionGenerationRef.current += 1;
    sourceImportGenerationRef.current += 1;
    repositoryCloneGenerationRef.current += 1;
    activeRepositoryCloneIdRef.current = "";
    saveGenerationRef.current += 1;
    repositoryEditRevisionRef.current = 0;
    repositoryBaseOpenGenerationRef.current += 1;
    runtimeAnalysisGenerationRef.current += 1;
    runtimeAnalysisCacheRef.current.clear();
    runtimeDraftSnapshotRef.current = null;
    reviewedSourceRepositoriesFingerprintRef.current = "";
    currentRuntimeFingerprintRef.current = "";
    activeSaveRef.current = false;
    autoSuggestedRepositoriesRef.current = null;

    if (!open) {
      setStep("source");
      setFurthestReviewStepNumber(1);
      setSourceMode("issue");
      setIssueProvider("jira");
      setSourceValue("");
      setTemplateWorkspaceId("");
      setRevisionTitle("");
      setIssueRepositories("");
      setJiraImport(null);
      setOpenProjectImport(null);
      setSourceImportState("idle");
      setSourceImportMessage("");
      setCodeWorkspaceImport(null);
      codeWorkspaceImportIdRef.current = null;
      setCodeWorkspaceImportState("idle");
      setCodeWorkspaceImportMessage("");
      setCodeWorkspaceTitle("");
      setCodeWorkspaceAddedRepositoryIds([]);
      setCodeWorkspaceRepositoryToAdd("");
      setCodeWorkspaceRepositoryAddMode("existing");
      setCodeWorkspaceCloneUrl("");
      setCodeWorkspaceCloneBranch("");
      setCodeWorkspaceCloneShallow(true);
      setCodeWorkspaceCloneState("idle");
      setCodeWorkspaceCloneMessage("");
      setIssueRepositoryCloneKey("");
      setIssueRepositoryCloneNotice(null);
      setIssueRepositoryLocalMatches({});
      setIssueRepositoryShowAllRemotes({});
      setCodeWorkspaceClonedRepositories([]);
      setCodeWorkspaceClonedBaseRefs({});
      setRefreshedRepositories([]);
      setRefreshingRepositoryId("");
      setCodeWorkspaceCloneRoot("");
      setCodeWorkspaceExportState("idle");
      setCodeWorkspaceDiagnosticsCopyState("idle");
      setRepos([]);
      setOpeningRepositoryBaseKey("");
      setRepositoryBaseNotice(null);
      setRuntimeAnalysis(null);
      setRuntimeAnalysisState("idle");
      setRuntimeAnalysisError("");
      setRuntimeAnalysisElapsedSeconds(0);
      setRuntimeAnalysisFingerprint("");
      setRuntimeServiceDrafts(new Map());
      setProvider("Codex");
      setPlanningEnabled(false);
      setPlanningFolder("plansAndKanban");
      setPlanningFormat("kanban");
      setSaveError("");
      setSaveWarning("");
      setSavedWorkspace(null);
      idempotencyKeyRef.current = "";
      idempotencyRequestRef.current = "";
    }

    return () => {
      dialogSessionGenerationRef.current += 1;
      sourceImportGenerationRef.current += 1;
      repositoryCloneGenerationRef.current += 1;
      codeWorkspaceImportIdRef.current = null;
      repositoryBaseOpenGenerationRef.current += 1;
      runtimeAnalysisGenerationRef.current += 1;
      saveGenerationRef.current += 1;
      activeSaveRef.current = false;
    };
  }, [open]);

  useEffect(() => {
    if (currentClientRef.current === client) return;

    currentClientRef.current = client;
    sourceImportGenerationRef.current += 1;
    repositoryCloneGenerationRef.current += 1;
    repositoryBaseOpenGenerationRef.current += 1;
    runtimeAnalysisGenerationRef.current += 1;
    runtimeAnalysisCacheRef.current.clear();
    runtimeDraftSnapshotRef.current = null;
    currentRuntimeFingerprintRef.current = "";
    saveGenerationRef.current += 1;
    activeSaveRef.current = false;
    setOpeningRepositoryBaseKey("");
    setRepositoryBaseNotice(null);
    setRuntimeAnalysis(null);
    setRuntimeAnalysisState("idle");
    setRuntimeAnalysisError("");
    setRuntimeAnalysisFingerprint("");
    setRuntimeServiceDrafts(new Map());
    if (sourceImportState === "loading") {
      setSourceImportState("idle");
      setSourceImportMessage(
        "The workspace connection changed. Import this issue again.",
      );
    }
    if (codeWorkspaceImportState === "loading") {
      setCodeWorkspaceImportState("idle");
      setCodeWorkspaceImportMessage(
        "The workspace connection changed. Choose the VS Code workspace file again.",
      );
    }
    if (codeWorkspaceCloneState === "loading") {
      setCodeWorkspaceCloneState("idle");
      setCodeWorkspaceCloneMessage(
        "The workspace connection changed. Enter the repository URL again.",
      );
    }
    if (step === "saving" && !saveError) {
      setSaveError(
        "The workspace connection changed before the save completed. Review and retry the plan.",
      );
    }
  }, [client]);

  useEffect(() => {
    if (!open || !initialTemplateWorkspaceId) return;
    const sourceWorkspace = workspaces.find(
      (workspace) => workspace.id === initialTemplateWorkspaceId,
    );
    setSourceMode("workspace");
    setTemplateWorkspaceId(initialTemplateWorkspaceId);
    if (!sourceWorkspace) return;
    setProvider(sourceWorkspace.provider);
    setPlanningEnabled(
      initialPlanningEnabled ?? sourceWorkspace.planning !== undefined,
    );
    setPlanningFolder(sourceWorkspace.planning?.folder ?? "plansAndKanban");
    setPlanningFormat(sourceWorkspace.planning?.format ?? "kanban");
    setRevisionTitle(`${sourceWorkspace.title} · revised`);
    setRepos(
      sourceWorkspace.repositoryPlans.map((repository) => ({
        key: repositoryEvidenceKey(repository.repositoryId, repository.label),
        id: repository.label,
        ...(repository.repositoryId === undefined
          ? {}
          : { repositoryId: repository.repositoryId }),
        reason: `Revised from ${sourceWorkspace.key}`,
        confidence: 100,
        included: true,
        base:
          (repository.repositoryId
            ? initialRepositoryBaseOverrides?.[repository.repositoryId]
            : undefined) ?? repository.baseRef,
      })),
    );
    if (
      initialRepositoryBaseOverrides &&
      Object.keys(initialRepositoryBaseOverrides).length > 0
    ) {
      setStep("evidence");
    }
  }, [
    initialRepositoryBaseOverrides,
    initialPlanningEnabled,
    initialTemplateWorkspaceId,
    open,
    workspaces,
  ]);

  useEffect(() => {
    if (!open || !initialReviewWorkspace) return;
    const repository = initialReviewWorkspace.preparation.repository;
    setSourceMode("set");
    setSourceValue(
      `Review ${initialReviewWorkspace.review.repository} !${initialReviewWorkspace.review.number}`,
    );
    setCodeWorkspaceClonedRepositories([repository]);
    setCodeWorkspaceCloneRoot(
      initialReviewWorkspace.preparation.repositoryRootDisplayPath,
    );
    setCodeWorkspaceAddedRepositoryIds([repository.id]);
    setProvider("Codex");
    setPlanningEnabled(true);
  }, [initialReviewWorkspace, open]);

  useEffect(() => {
    if (!open || !initialDeferredClone) return;
    const draft = initialDeferredClone.draft;
    setSourceMode("set");
    setProvider(draft.provider);
    setPlanningEnabled(draft.planningEnabled);
    setPlanningFolder(draft.planningFolder);
    setPlanningFormat(draft.planningFormat);
    setRepos(draft.repositories);
    setRefreshedRepositories(draft.refreshedRepositories);
    setCodeWorkspaceClonedRepositories(draft.clonedRepositories);
    setCodeWorkspaceClonedBaseRefs(draft.clonedRepositoryBaseRefs);
    setCodeWorkspaceCloneRoot(draft.repositoryRootDisplayPath);
    setCodeWorkspaceAddedRepositoryIds(draft.addedRepositoryIds);
    setRuntimeAnalysis(draft.runtimeAnalysis);
    setRuntimeAnalysisState(
      draft.runtimeAnalysisState === "loading"
        ? "idle"
        : draft.runtimeAnalysisState,
    );
    setRuntimeAnalysisError(draft.runtimeAnalysisError);
    setRuntimeAnalysisFingerprint(draft.runtimeAnalysisFingerprint);
    setRuntimeServiceDrafts(draft.runtimeServiceDrafts);
    runtimeDraftSnapshotRef.current = draft.runtimeDraftSnapshot;
    reviewedSourceRepositoriesFingerprintRef.current =
      draft.reviewedSourceRepositoriesFingerprint;
    setCodeWorkspaceCloneUrl(
      initialDeferredClone.status === "error"
        ? initialDeferredClone.remoteUrl
        : "",
    );
    setCodeWorkspaceCloneBranch(initialDeferredClone.branch ?? "");
    setCodeWorkspaceCloneShallow(initialDeferredClone.shallow ?? true);
    setCodeWorkspaceCloneMessage(initialDeferredClone.message);
    setCodeWorkspaceCloneState(
      initialDeferredClone.status === "error" ? "error" : "ready",
    );
    setCodeWorkspaceRepositoryAddMode(
      initialDeferredClone.status === "error" ? "clone" : "existing",
    );
    if (initialDeferredClone.result) {
      const repository = initialDeferredClone.result.repository;
      setCodeWorkspaceClonedRepositories([
        ...draft.clonedRepositories.filter(
          (existing) => existing.id !== repository.id,
        ),
        repository,
      ]);
      setCodeWorkspaceClonedBaseRefs({
        ...draft.clonedRepositoryBaseRefs,
        [repository.id]:
          initialDeferredClone.result.selectedBaseRef ??
          repository.defaultBranch.name,
      });
      setCodeWorkspaceCloneRoot(
        initialDeferredClone.result.repositoryRootDisplayPath,
      );
      setCodeWorkspaceAddedRepositoryIds([
        ...new Set([...draft.addedRepositoryIds, repository.id]),
      ]);
    }
  }, [initialDeferredClone, open]);

  useEffect(() => {
    const stepChanged = previousStepRef.current !== step;
    previousStepRef.current = step;
    if (!open || !stepChanged) return;

    const frame = window.requestAnimationFrame(() => {
      stepHeadingRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, step]);

  useEffect(() => {
    const reviewStepNumber =
      step === "source"
        ? 1
        : step === "evidence"
          ? 2
          : step === "services"
            ? 3
            : step === "manifest"
              ? 4
              : 0;
    if (reviewStepNumber === 0) return;
    setFurthestReviewStepNumber((current) =>
      Math.max(current, reviewStepNumber),
    );
  }, [step]);

  useEffect(() => {
    if (step === "evidence") return;
    repositoryBaseOpenGenerationRef.current += 1;
    setOpeningRepositoryBaseKey("");
    setRepositoryBaseNotice(null);
  }, [step]);

  const runtimeAnalysisStartedAtRef = useRef<number>(0);
  useEffect(() => {
    if (runtimeAnalysisState === "loading") {
      runtimeAnalysisStartedAtRef.current = Date.now();
      setRuntimeAnalysisElapsedSeconds(0);
    }
  }, [runtimeAnalysisState]);

  useVisiblePolling(
    () => {
      if (runtimeAnalysisState === "loading") {
        setRuntimeAnalysisElapsedSeconds(
          Math.max(
            0,
            Math.floor(
              (Date.now() - runtimeAnalysisStartedAtRef.current) / 1000,
            ),
          ),
        );
      }
    },
    1000,
    { enabled: runtimeAnalysisState === "loading" },
  );

  const included = repos.filter((repo) => repo.included);
  const effectiveRepositoryCatalog = useMemo(() => {
    if (
      codeWorkspaceClonedRepositories.length === 0 &&
      refreshedRepositories.length === 0
    ) {
      return repositoryCatalog;
    }
    const repositories = new Map(
      (repositoryCatalog?.repositories ?? []).map((repository) => [
        repository.id,
        repository,
      ]),
    );
    for (const repository of codeWorkspaceClonedRepositories) {
      repositories.set(repository.id, repository);
    }
    for (const repository of refreshedRepositories) {
      repositories.set(repository.id, repository);
    }
    return {
      repositoryRootDisplayPath:
        repositoryCatalog?.repositoryRootDisplayPath ?? codeWorkspaceCloneRoot,
      repositories: Array.from(repositories.values()),
      skippedEntries: repositoryCatalog?.skippedEntries ?? 0,
    };
  }, [
    codeWorkspaceCloneRoot,
    codeWorkspaceClonedRepositories,
    refreshedRepositories,
    repositoryCatalog,
  ]);
  useEffect(() => {
    if (
      !effectiveRepositoryCatalog ||
      effectiveRepositoryCatalog.repositories.length === 0 ||
      repos.length === 0
    ) {
      return;
    }

    setRepos((current) => {
      const claimedRepositoryIds = new Set(
        current.flatMap((repository) =>
          repository.repositoryId ? [repository.repositoryId] : [],
        ),
      );
      let changed = false;
      const reconciled = current.map((repository) => {
        if (repository.repositoryId) return repository;
        const catalogRepository = catalogRepositoryFor(
          undefined,
          repository.id,
          effectiveRepositoryCatalog,
        );
        if (
          !catalogRepository ||
          claimedRepositoryIds.has(catalogRepository.id)
        ) {
          return repository;
        }

        claimedRepositoryIds.add(catalogRepository.id);
        changed = true;
        const selectedBaseAvailable =
          catalogRepository.availableBranches?.some(
            (branch) => branch.name === repository.base,
          ) ?? false;
        return {
          ...repository,
          repositoryId: catalogRepository.id,
          base: selectedBaseAvailable
            ? repository.base
            : catalogRepository.defaultBranch.name,
        };
      });
      return changed ? reconciled : current;
    });
  }, [effectiveRepositoryCatalog, repos]);
  const runtimeAnalysisPreparation = useMemo(
    () =>
      runtimeAnalysisPreparationFor(
        repos.filter((repo) => repo.included),
        effectiveRepositoryCatalog,
      ),
    [effectiveRepositoryCatalog, repos],
  );
  const runtimeAnalysisRequest = runtimeAnalysisPreparation.request;
  const currentRuntimeFingerprint = runtimeAnalysisPreparation.fingerprint;
  currentRuntimeFingerprintRef.current = currentRuntimeFingerprint;
  const isIssueSource = sourceMode === "issue";
  const isWorkspaceSource = sourceMode === "workspace";
  const isCodeWorkspaceSource = sourceMode === "codeWorkspace";
  const templateWorkspace = workspaces.find(
    (workspace) => workspace.id === templateWorkspaceId,
  );
  const catalogRepositoriesById = useMemo(
    () =>
      new Map(
        (effectiveRepositoryCatalog?.repositories ?? []).map((repository) => [
          repository.id,
          repository,
        ]),
      ),
    [effectiveRepositoryCatalog],
  );
  const importedCodeWorkspaceRepositoryIds = useMemo(
    () =>
      new Set(
        codeWorkspaceImport?.repositories.flatMap((repository) =>
          repository.repositoryId ? [repository.repositoryId] : [],
        ) ?? [],
      ),
    [codeWorkspaceImport],
  );
  const templateWorkspaceRepositoryIds = useMemo(
    () =>
      new Set(
        templateWorkspace?.repositoryPlans.flatMap((repository) =>
          repository.repositoryId ? [repository.repositoryId] : [],
        ) ?? [],
      ),
    [templateWorkspace],
  );
  const templateWorkspaceRepositoryLabels = useMemo(
    () =>
      new Set(
        templateWorkspace?.repositoryPlans.map((repository) =>
          repository.label.toLocaleLowerCase(),
        ) ?? [],
      ),
    [templateWorkspace],
  );
  const addedCodeWorkspaceRepositories = useMemo(
    () =>
      codeWorkspaceAddedRepositoryIds.flatMap((repositoryId) => {
        const repository = catalogRepositoriesById.get(repositoryId);
        return repository ? [repository] : [];
      }),
    [catalogRepositoriesById, codeWorkspaceAddedRepositoryIds],
  );
  const clonedCodeWorkspaceRepositoryIds = useMemo(
    () =>
      new Set(
        codeWorkspaceClonedRepositories.map((repository) => repository.id),
      ),
    [codeWorkspaceClonedRepositories],
  );
  const availableCodeWorkspaceRepositories = useMemo(
    () =>
      (effectiveRepositoryCatalog?.repositories ?? []).filter(
        (repository) =>
          !importedCodeWorkspaceRepositoryIds.has(repository.id) &&
          !templateWorkspaceRepositoryIds.has(repository.id) &&
          !templateWorkspaceRepositoryLabels.has(
            repository.label.toLocaleLowerCase(),
          ) &&
          !codeWorkspaceAddedRepositoryIds.includes(repository.id),
      ),
    [
      codeWorkspaceAddedRepositoryIds,
      importedCodeWorkspaceRepositoryIds,
      templateWorkspaceRepositoryIds,
      templateWorkspaceRepositoryLabels,
      effectiveRepositoryCatalog,
    ],
  );
  const codeWorkspaceCloneLeaf = repositoryLeafFromRemoteUrl(
    codeWorkspaceCloneUrl,
  );
  const codeWorkspaceCloneTarget = codeWorkspaceCloneLeaf
    ? joinDisplayPath(
        effectiveRepositoryCatalog?.repositoryRootDisplayPath ??
          codeWorkspaceCloneRoot,
        codeWorkspaceCloneLeaf,
      )
    : "";
  const jiraRepositoryUpstreams = useMemo(
    () => repositoryUpstreamsFromIssueContent(jiraImport?.content ?? ""),
    [jiraImport?.content],
  );
  const jiraRepositoryUpstreamsByLabel = useMemo(
    () =>
      new Map(
        jiraRepositoryUpstreams.map((upstream) => [
          upstream.label.toLocaleLowerCase(),
          upstream,
        ]),
      ),
    [jiraRepositoryUpstreams],
  );
  useEffect(() => {
    if (runtimeAnalysis && runtimeAnalysisState === "ready") {
      runtimeDraftSnapshotRef.current = {
        analysis: runtimeAnalysis,
        drafts: runtimeServiceDrafts,
      };
    }
  }, [runtimeAnalysis, runtimeAnalysisState, runtimeServiceDrafts]);

  useEffect(() => {
    if (
      !runtimeAnalysisFingerprint ||
      runtimeAnalysisFingerprint === currentRuntimeFingerprint
    ) {
      return;
    }
    runtimeAnalysisGenerationRef.current += 1;
    setRuntimeAnalysis(null);
    setRuntimeAnalysisState("idle");
    setRuntimeAnalysisError("");
    setRuntimeAnalysisFingerprint("");
    setRuntimeServiceDrafts(new Map());
  }, [currentRuntimeFingerprint, runtimeAnalysisFingerprint]);
  const enteredRepositories: Array<{
    repositoryId?: string;
    label: string;
    baseRef: string;
  }> = isWorkspaceSource
    ? [
        ...(templateWorkspace?.repositoryPlans.map((repository) => ({
          ...(repository.repositoryId === undefined
            ? {}
            : { repositoryId: repository.repositoryId }),
          label: repository.label,
          baseRef:
            (repository.repositoryId
              ? initialRepositoryBaseOverrides?.[repository.repositoryId]
              : undefined) ?? repository.baseRef,
        })) ?? []),
        ...addedCodeWorkspaceRepositories.map((repository) => ({
          repositoryId: repository.id,
          label: repository.label,
          baseRef:
            initialRepositoryBaseOverrides?.[repository.id] ??
            codeWorkspaceClonedBaseRefs[repository.id] ??
            repository.defaultBranch.name,
        })),
      ]
    : isCodeWorkspaceSource
      ? [
          ...(codeWorkspaceImport?.repositories ?? []),
          ...addedCodeWorkspaceRepositories.map((repository) => ({
            repositoryId: repository.id,
            label: repository.label,
            baseRef:
              codeWorkspaceClonedBaseRefs[repository.id] ??
              repository.defaultBranch.name,
          })),
        ]
      : sourceMode === "set"
        ? addedCodeWorkspaceRepositories.map((repository) => ({
            repositoryId: repository.id,
            label: repository.label,
            baseRef:
              initialRepositoryBaseOverrides?.[repository.id] ??
              codeWorkspaceClonedBaseRefs[repository.id] ??
              repository.defaultBranch.name,
          }))
      : repositoryNamesFrom(
          isIssueSource ? issueRepositories : sourceValue,
        ).map((label) => {
          const selectedRepositoryId = isIssueSource
            ? issueRepositoryLocalMatches[label.toLocaleLowerCase()]
            : undefined;
          const catalogRepository = catalogRepositoryFor(
            selectedRepositoryId,
            label,
            effectiveRepositoryCatalog,
          );
          return catalogRepository
            ? {
                repositoryId: catalogRepository.id,
                label: catalogRepository.label,
                baseRef: catalogRepository.defaultBranch.name,
              }
            : { label, baseRef: "main" };
        });
  const sourceRepositoryReview = enteredRepositories.map((repository) => ({
    repository,
    catalogRepository: catalogRepositoryFor(
      repository.repositoryId,
      repository.label,
      effectiveRepositoryCatalog,
    ),
    upstreamRepository:
      issueProvider === "jira"
        ? jiraRepositoryUpstreamsByLabel.get(
            repository.label.toLocaleLowerCase(),
          )
        : undefined,
  }));
  const enteredRepositoryNames = enteredRepositories.map(
    (repository) => repository.label,
  );
  const sourceRepositoriesFingerprint = JSON.stringify(
    enteredRepositories.map((repository) => [
      repository.repositoryId ?? "",
      repository.label,
      repository.baseRef,
    ]),
  );
  const jiraKey = issueKeyFrom(sourceValue);
  const openProjectReference = openProjectReferenceFrom(sourceValue);
  const draftKey = isIssueSource
    ? issueProvider === "jira"
      ? jiraKey
      : (openProjectImport?.displayId ?? openProjectReference ?? "")
    : isWorkspaceSource
      ? isRevisionMode
        ? (templateWorkspace?.key ?? "workspace")
        : `Copy of ${templateWorkspace?.key ?? "workspace"}`
      : isCodeWorkspaceSource
        ? (codeWorkspaceImport?.suggestedRepositorySetLabel ?? "")
        : initialReviewWorkspace
          ? `Review ${initialReviewWorkspace.preparation.repository.label} !${initialReviewWorkspace.review.number}`
          : `Local repositories · ${enteredRepositoryNames[0] ?? "workspace"}`;
  const draftTitle = isIssueSource
    ? issueProvider === "jira"
      ? (jiraImport?.summary ?? `Work on ${draftKey || "Jira issue"}`)
      : (openProjectImport?.subject ??
        `Work on ${draftKey || "OpenProject work package"}`)
    : isWorkspaceSource
      ? isRevisionMode
        ? revisionTitle.trim()
        : `${templateWorkspace?.title ?? "Saved WTS plan"} · copy`
      : isCodeWorkspaceSource
        ? codeWorkspaceTitle.trim()
      : initialReviewWorkspace
        ? `Review ${initialReviewWorkspace.review.repository} !${initialReviewWorkspace.review.number}`
        : `Repositories: ${
            enteredRepositoryNames.slice(0, 2).join(" + ") || "local work"
          }`;
  const importedIssue =
    issueProvider === "jira" && jiraImport
      ? {
          reference: jiraImport.issueKey,
          title: jiraImport.summary ?? jiraImport.issueKey,
          status: jiraImport.status,
          project: undefined,
          content: jiraImport.content,
          recommendations: jiraImport.repositoryRecommendations,
        }
      : issueProvider === "openProject" && openProjectImport
        ? {
            reference: openProjectImport.displayId,
            title: openProjectImport.subject,
            status: openProjectImport.status,
            project: openProjectImport.project,
            content: openProjectImport.content,
            recommendations: openProjectImport.repositoryRecommendations,
          }
        : null;
  const jiraKeyIsValid = /^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,9}$/.test(jiraKey);
  const openProjectReferenceIsValid = openProjectReference !== null;
  const canAnalyze =
    enteredRepositoryNames.length > 0 &&
    (!isRevisionMode || revisionTitle.trim().length > 0) &&
    (isWorkspaceSource
      ? templateWorkspace !== undefined
      : isCodeWorkspaceSource
        ? codeWorkspaceImportState === "ready" &&
          codeWorkspaceImport !== null &&
          codeWorkspaceTitle.trim().length > 0
        : sourceMode === "set"
          ? true
          : sourceValue.trim().length > 0 &&
            (sourceImportState !== "loading" || issueProvider === "jira") &&
            (issueProvider === "jira"
              ? jiraKeyIsValid
              : openProjectReferenceIsValid && openProjectImport !== null));
  const sourceBlockingMessage = canAnalyze
    ? null
    : enteredRepositoryNames.length === 0
      ? "Choose at least one local repository to continue."
      : isRevisionMode && revisionTitle.trim().length === 0
        ? "Add a title for the revised workspace."
        : isWorkspaceSource && templateWorkspace === undefined
          ? "Choose a saved WTS plan to copy."
          : isCodeWorkspaceSource && codeWorkspaceImportState !== "ready"
            ? "Import a valid VS Code workspace file first."
            : isCodeWorkspaceSource && codeWorkspaceTitle.trim().length === 0
              ? "Add a title for the imported workspace."
              : sourceValue.trim().length === 0
                ? sourceMode === "set"
                  ? "Name this workspace to continue."
                  : `Enter a ${issueProvider === "jira" ? "Jira issue key" : "work package reference"}.`
                : issueProvider === "jira" && !jiraKeyIsValid
                  ? "Enter a valid Jira issue key, such as PLATFORM-42."
                  : issueProvider === "openProject" &&
                      (!openProjectReferenceIsValid ||
                        openProjectImport === null)
                    ? "Import a valid OpenProject work package first."
                    : "Complete the required source details to continue.";
  const stepNumber =
    step === "source"
      ? 1
      : step === "evidence"
        ? 2
        : step === "services"
          ? 3
          : step === "manifest"
            ? 4
            : 5;

  const analyzeSource = () => {
    if (!canAnalyze) return;
    setRepositoryBaseNotice(null);
    if (isIssueSource && sourceImportState === "loading") {
      sourceImportGenerationRef.current += 1;
      setSourceImportState("idle");
      setSourceImportMessage(
        "Continuing with the repositories you entered manually. The pending Jira result will be ignored.",
      );
    }
    setRepos((current) => {
      if (
        reviewedSourceRepositoriesFingerprintRef.current ===
          sourceRepositoriesFingerprint &&
        current.length > 0
      ) {
        return current;
      }
      const currentByKey = new Map(
        current.map((repository) => [repository.key, repository]),
      );
      return enteredRepositories.map((sourceRepository) => {
        const key = repositoryEvidenceKey(
          sourceRepository.repositoryId,
          sourceRepository.label,
        );
        const existing = currentByKey.get(key);
        return {
          key,
          id: sourceRepository.label,
          ...(sourceRepository.repositoryId === undefined
            ? {}
            : { repositoryId: sourceRepository.repositoryId }),
          reason: isWorkspaceSource
            ? `${isRevisionMode ? "Revised" : "Copied"} from ${
                templateWorkspace?.key ?? "the saved workspace"
              }`
            : isCodeWorkspaceSource
              ? codeWorkspaceAddedRepositoryIds.includes(
                  sourceRepository.repositoryId ?? "",
                )
                ? clonedCodeWorkspaceRepositoryIds.has(
                    sourceRepository.repositoryId ?? "",
                  )
                  ? "Cloned from a reviewed Git URL"
                  : "Added from the local repository catalog"
                : `Imported from ${codeWorkspaceImport?.fileName ?? "VS Code workspace file"}`
              : "Selected by you for this workspace plan",
          confidence: 100,
          included: existing?.included ?? true,
          base: existing?.base ?? sourceRepository.baseRef,
        };
      });
    });
    reviewedSourceRepositoriesFingerprintRef.current =
      sourceRepositoriesFingerprint;
    setStep("evidence");
  };

  const importJira = async () => {
    if (!jiraKeyIsValid) return;
    const requestGeneration = ++sourceImportGenerationRef.current;
    const sessionGeneration = dialogSessionGenerationRef.current;
    const repositoryEditRevision = repositoryEditRevisionRef.current;
    const requestClient = client;
    setSourceImportState("loading");
    setSourceImportMessage("");
    try {
      const imported = await requestClient.importJiraIssue(jiraKey);
      if (
        requestGeneration !== sourceImportGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      if (issueKeyFrom(imported.issueKey) !== jiraKey) {
        throw new Error(
          `Jira returned ${imported.issueKey} while WTS was importing ${jiraKey}. Try the import again.`,
        );
      }
      const repositoriesWereEdited =
        repositoryEditRevision !== repositoryEditRevisionRef.current;
      const upstreamRepositories = repositoryUpstreamsFromIssueContent(
        imported.content,
      );
      const suggestedRepositories = Array.from(
        new Map(
          [
            ...imported.suggestedRepositories,
            ...upstreamRepositories.map((upstream) => upstream.label),
          ].map((label) => [label.toLocaleLowerCase(), label]),
        ).values(),
      );
      setJiraImport(imported);
      if (suggestedRepositories.length && !repositoriesWereEdited) {
        const suggestions = suggestedRepositories.join(", ");
        autoSuggestedRepositoriesRef.current = suggestions;
        setIssueRepositoryLocalMatches({});
        setIssueRepositoryShowAllRemotes({});
        setIssueRepositories(suggestions);
      } else if (!repositoriesWereEdited) {
        autoSuggestedRepositoriesRef.current = null;
        setIssueRepositoryLocalMatches({});
        setIssueRepositoryShowAllRemotes({});
      }
      setSourceImportMessage(
        repositoriesWereEdited
          ? "Imported issue context. Kept the repositories you edited while the import was running."
          : suggestedRepositories.length
            ? upstreamRepositories.length
              ? `Imported issue context and found ${suggestedRepositories.length} repository upstreams.`
              : `Imported issue context and matched ${suggestedRepositories.length} local repositories.`
            : "Imported issue context. No local repository names were found, so choose them below.",
      );
      setSourceImportState("ready");
    } catch (error) {
      if (
        requestGeneration !== sourceImportGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      setSourceImportMessage(
        error instanceof Error ? error.message : "Jira import failed.",
      );
      setSourceImportState("error");
    }
  };

  const importOpenProject = async () => {
    if (openProjectReference === null) return;
    const requestGeneration = ++sourceImportGenerationRef.current;
    const sessionGeneration = dialogSessionGenerationRef.current;
    const repositoryEditRevision = repositoryEditRevisionRef.current;
    const requestClient = client;
    setSourceImportState("loading");
    setSourceImportMessage("");
    try {
      const imported =
        await requestClient.importOpenProjectWorkPackage(openProjectReference);
      if (
        requestGeneration !== sourceImportGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      if (!openProjectImportMatchesReference(imported, openProjectReference)) {
        throw new Error(
          `OpenProject returned ${imported.displayId} while WTS was importing ${openProjectReference}. Try the import again.`,
        );
      }
      const repositoriesWereEdited =
        repositoryEditRevision !== repositoryEditRevisionRef.current;
      setOpenProjectImport(imported);
      if (imported.suggestedRepositories.length && !repositoriesWereEdited) {
        const suggestions = imported.suggestedRepositories.join(", ");
        autoSuggestedRepositoriesRef.current = suggestions;
        setIssueRepositories(suggestions);
      } else if (!repositoriesWereEdited) {
        autoSuggestedRepositoriesRef.current = null;
      }
      setSourceImportMessage(
        repositoriesWereEdited
          ? `Imported ${imported.displayId}. Kept the repositories you edited while the import was running.`
          : imported.suggestedRepositories.length
            ? `Imported ${imported.displayId} and matched ${imported.suggestedRepositories.length} local repositories.`
            : `Imported ${imported.displayId}. Choose the local repositories for this workspace below.`,
      );
      setSourceImportState("ready");
    } catch (error) {
      if (
        requestGeneration !== sourceImportGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      setSourceImportMessage(
        error instanceof Error ? error.message : "OpenProject import failed.",
      );
      setSourceImportState("error");
    }
  };

  const importCodeWorkspaceFile = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = "";
    const requestGeneration = ++sourceImportGenerationRef.current;
    const sessionGeneration = dialogSessionGenerationRef.current;
    const requestClient = client;

    setCodeWorkspaceImport(null);
    codeWorkspaceImportIdRef.current = null;
    setCodeWorkspaceTitle("");
    setCodeWorkspaceAddedRepositoryIds([]);
    setCodeWorkspaceRepositoryToAdd("");
    repositoryCloneGenerationRef.current += 1;
    setCodeWorkspaceRepositoryAddMode("existing");
    setCodeWorkspaceCloneUrl("");
    setCodeWorkspaceCloneBranch("");
    setCodeWorkspaceCloneShallow(true);
    setCodeWorkspaceCloneState("idle");
    setCodeWorkspaceCloneMessage("");
    setCodeWorkspaceClonedRepositories([]);
    setCodeWorkspaceClonedBaseRefs({});
    setCodeWorkspaceCloneRoot("");
    setCodeWorkspaceExportState("idle");
    setCodeWorkspaceDiagnosticsCopyState("idle");
    setRepos([]);
    setProvider("VS Code");
    if (!file) {
      setCodeWorkspaceImportState("idle");
      setCodeWorkspaceImportMessage("");
      return;
    }
    const rejectBeforeRead = (message: string) => {
      setCodeWorkspaceImportState("error");
      setCodeWorkspaceImportMessage(message);
      logCodeWorkspaceImportFailure(file.name, new Error(message));
    };
    if (!file.name.toLowerCase().endsWith(".code-workspace")) {
      rejectBeforeRead("Choose a file ending in .code-workspace.");
      return;
    }
    if (file.size === 0) {
      rejectBeforeRead("That VS Code workspace file is empty.");
      return;
    }
    if (file.size > CODE_WORKSPACE_FILE_MAX_BYTES) {
      rejectBeforeRead(
        "That file is larger than 48 KiB. Choose a smaller .code-workspace file.",
      );
      return;
    }

    setCodeWorkspaceImportState("loading");
    setCodeWorkspaceImportMessage(`Reading ${file.name}…`);
    try {
      const contents = await readTextFile(file);
      if (
        new TextEncoder().encode(contents).byteLength >
        CODE_WORKSPACE_FILE_MAX_BYTES
      ) {
        throw new Error(
          "That file is larger than 48 KiB. Choose a smaller .code-workspace file.",
        );
      }
      if (
        requestGeneration !== sourceImportGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      const imported = await requestClient.importCodeWorkspaceFile({
        fileName: file.name,
        contents,
      });
      if (
        requestGeneration !== sourceImportGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      if (imported.fileName !== file.name) {
        throw new Error(
          `WTS returned ${imported.fileName} while importing ${file.name}. Choose the file again.`,
        );
      }

      logCodeWorkspaceImportCompletion(imported);
      codeWorkspaceImportIdRef.current = imported.importId;
      setCodeWorkspaceImport(imported);
      setCodeWorkspaceTitle(imported.suggestedTitle);
      setCodeWorkspaceImportState("ready");
      const unmatchedFolderCount = imported.folders.filter(
        (folder) => folder.status !== "matched",
      ).length;
      const matchedFolderCount = imported.folders.length - unmatchedFolderCount;
      setCodeWorkspaceImportMessage(
        imported.repositories.length === 0
          ? imported.diagnostics
            ? `No trusted local repositories matched ${imported.fileName}. Open Developer diagnostics to inspect the bounded nested scan and folder reasons.`
            : `No trusted local repositories matched ${imported.fileName}. Check the configured repository root and folder entries.`
          : unmatchedFolderCount > 0
            ? `Imported ${matchedFolderCount} of ${imported.folders.length} folders from ${imported.fileName}. ${unmatchedFolderCount} not added.`
            : `Imported ${imported.repositories.length} ${
                imported.repositories.length === 1
                  ? "repository"
                  : "repositories"
              } from ${imported.fileName}.`,
      );
    } catch (error) {
      if (
        requestGeneration !== sourceImportGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      setCodeWorkspaceImportState("error");
      setCodeWorkspaceImportMessage(
        error instanceof Error
          ? error.message
          : "The VS Code workspace file could not be imported.",
      );
      logCodeWorkspaceImportFailure(file.name, error);
    }
  };

  const copyCodeWorkspaceDiagnostics = async () => {
    if (!codeWorkspaceImport?.diagnostics) return;
    const importId = codeWorkspaceImport.importId;
    const sourceGeneration = sourceImportGenerationRef.current;
    const dialogGeneration = dialogSessionGenerationRef.current;
    const isCurrentImport = () =>
      codeWorkspaceImportIdRef.current === importId &&
      sourceImportGenerationRef.current === sourceGeneration &&
      dialogSessionGenerationRef.current === dialogGeneration;
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable.");
      }
      await navigator.clipboard.writeText(
        JSON.stringify(
          codeWorkspaceDiagnosticsPayload(codeWorkspaceImport),
          null,
          2,
        ),
      );
      if (!isCurrentImport()) return;
      setCodeWorkspaceDiagnosticsCopyState("copied");
    } catch {
      if (!isCurrentImport()) return;
      setCodeWorkspaceDiagnosticsCopyState("error");
    }
  };

  const addCodeWorkspaceRepository = () => {
    if (
      !codeWorkspaceRepositoryToAdd ||
      importedCodeWorkspaceRepositoryIds.has(codeWorkspaceRepositoryToAdd) ||
      codeWorkspaceAddedRepositoryIds.includes(codeWorkspaceRepositoryToAdd) ||
      !catalogRepositoriesById.has(codeWorkspaceRepositoryToAdd)
    ) {
      return;
    }
    setCodeWorkspaceAddedRepositoryIds((current) => [
      ...current,
      codeWorkspaceRepositoryToAdd,
    ]);
    setCodeWorkspaceRepositoryToAdd("");
    setCodeWorkspaceExportState("idle");
  };

  const cloneCodeWorkspaceRepository = async () => {
    if (
      !codeWorkspaceCloneLeaf ||
      codeWorkspaceCloneState === "loading"
    ) {
      return;
    }

    const requestGeneration = ++repositoryCloneGenerationRef.current;
    const sessionGeneration = dialogSessionGenerationRef.current;
    const requestClient = client;
    const cloneRequest: CloneRepositoryRequest = {
      remoteUrl: codeWorkspaceCloneUrl.trim(),
      ...(codeWorkspaceCloneBranch.trim()
        ? { branch: codeWorkspaceCloneBranch.trim() }
        : {}),
      ...(codeWorkspaceCloneShallow ? { shallow: true } : {}),
    };
    const clone = onStartRepositoryClone(cloneRequest);
    activeRepositoryCloneIdRef.current = clone.id;
    setCodeWorkspaceCloneState("loading");
    setCodeWorkspaceCloneMessage(
      `Cloning ${codeWorkspaceCloneLeaf}${
        codeWorkspaceCloneBranch.trim()
          ? ` from ${codeWorkspaceCloneBranch.trim()}`
          : ""
      }${codeWorkspaceCloneShallow ? " with only the latest commit" : ""}…`,
    );
    setCodeWorkspaceExportState("idle");

    try {
      const result = await clone.promise;
      if (
        requestGeneration !== repositoryCloneGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }

      const alreadyInPlan =
        importedCodeWorkspaceRepositoryIds.has(result.repository.id) ||
        codeWorkspaceAddedRepositoryIds.includes(result.repository.id);
      setCodeWorkspaceClonedRepositories((current) => [
        ...current.filter(
          (repository) => repository.id !== result.repository.id,
        ),
        result.repository,
      ]);
      setCodeWorkspaceCloneRoot(result.repositoryRootDisplayPath);
      if (!alreadyInPlan) {
        const selectedBaseRef =
          result.selectedBaseRef ?? result.repository.defaultBranch.name;
        setCodeWorkspaceClonedBaseRefs((current) => ({
          ...current,
          [result.repository.id]: selectedBaseRef,
        }));
        setCodeWorkspaceAddedRepositoryIds((current) => [
          ...current,
          result.repository.id,
        ]);
        setRepos((current) => {
          if (
            current.length === 0 ||
            current.some(
              (repository) => repository.repositoryId === result.repository.id,
            )
          ) {
            return current;
          }
          return [
            ...current,
            {
              key: repositoryEvidenceKey(
                result.repository.id,
                result.repository.label,
              ),
              id: result.repository.label,
              repositoryId: result.repository.id,
              reason: "Cloned from a reviewed Git URL",
              confidence: 100,
              included: true,
              base: selectedBaseRef,
            },
          ];
        });
        setStep((current) =>
          current === "services" || current === "manifest"
            ? "evidence"
            : current,
        );
      }
      setCodeWorkspaceCloneUrl("");
      setCodeWorkspaceCloneBranch("");
      setCodeWorkspaceCloneShallow(true);
      setCodeWorkspaceCloneState("ready");
      setCodeWorkspaceCloneMessage(
        alreadyInPlan
          ? `${result.repository.label} is already included in this workspace plan.`
          : result.reusedExisting
            ? `Found ${result.repository.label} in the trusted repository root and added it to this plan.`
            : `Cloned ${result.repository.label} and added it to this workspace plan.`,
      );
    } catch (error) {
      if (
        requestGeneration !== repositoryCloneGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      setCodeWorkspaceCloneState("error");
      setCodeWorkspaceCloneMessage(
        error instanceof Error
          ? error.message
          : "The repository could not be cloned.",
      );
    }
  };

  const moveActiveCloneToKanban = () => {
    const cloneId = activeRepositoryCloneIdRef.current;
    if (
      !cloneId ||
      !codeWorkspaceCloneLeaf ||
      codeWorkspaceCloneState !== "loading"
    ) {
      return;
    }
    onDeferRepositoryClone({
      cloneId,
      title: draftTitle,
      repositoryLabel: codeWorkspaceCloneLeaf,
      cloneRequest: {
        remoteUrl: codeWorkspaceCloneUrl.trim(),
        ...(codeWorkspaceCloneBranch.trim()
          ? { branch: codeWorkspaceCloneBranch.trim() }
          : {}),
        ...(codeWorkspaceCloneShallow ? { shallow: true } : {}),
      },
      draft: {
        addedRepositoryIds: codeWorkspaceAddedRepositoryIds,
        clonedRepositories: codeWorkspaceClonedRepositories,
        clonedRepositoryBaseRefs: codeWorkspaceClonedBaseRefs,
        refreshedRepositories,
        repositoryRootDisplayPath: codeWorkspaceCloneRoot,
        repositories: repos,
        provider,
        planningEnabled,
        planningFolder,
        planningFormat,
        runtimeAnalysis,
        runtimeAnalysisState,
        runtimeAnalysisError,
        runtimeAnalysisFingerprint,
        runtimeServiceDrafts,
        runtimeDraftSnapshot: runtimeDraftSnapshotRef.current,
        reviewedSourceRepositoriesFingerprint:
          reviewedSourceRepositoriesFingerprintRef.current,
      },
      ...(initialDeferredClone
        ? { replacesTaskId: initialDeferredClone.id }
        : {}),
    });
  };

  const cloneIssueRepository = async (upstream: IssueRepositoryUpstream) => {
    if (issueRepositoryCloneKey) return;
    const requestGeneration = ++repositoryCloneGenerationRef.current;
    const sessionGeneration = dialogSessionGenerationRef.current;
    const requestClient = client;
    setIssueRepositoryCloneKey(upstream.label.toLocaleLowerCase());
    setIssueRepositoryCloneNotice(null);

    try {
      const result = await requestClient.cloneRepository({
        remoteUrl: upstream.remoteUrl,
      });
      if (
        requestGeneration !== repositoryCloneGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      setRefreshedRepositories((current) => [
        ...current.filter(
          (repository) => repository.id !== result.repository.id,
        ),
        result.repository,
      ]);
      setIssueRepositoryCloneKey("");
      setIssueRepositoryCloneNotice({
        kind: "success",
        message: result.reusedExisting
          ? `Found ${result.repository.label} in the trusted repository root.`
          : `Cloned ${result.repository.label} into the trusted repository root.`,
      });
    } catch (error) {
      if (
        requestGeneration !== repositoryCloneGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      setIssueRepositoryCloneKey("");
      setIssueRepositoryCloneNotice({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The repository could not be cloned.",
      });
    }
  };

  const removeCodeWorkspaceRepository = (repositoryId: string) => {
    setCodeWorkspaceAddedRepositoryIds((current) =>
      current.filter((candidate) => candidate !== repositoryId),
    );
    setCodeWorkspaceExportState("idle");
  };

  const downloadEditedCodeWorkspace = () => {
    if (!codeWorkspaceImport || addedCodeWorkspaceRepositories.length === 0) {
      return;
    }
    try {
      const folders = codeWorkspaceImport.folders
        .filter(
          (folder) =>
            folder.rawPath !== unsupportedUriDiagnosticValue &&
            folder.rawPath !== unsupportedDiagnosticValue &&
            folder.rawPath !== missingDiagnosticPathValue,
        )
        .map((folder) => ({
          name: folder.name,
          path: folder.rawPath,
        }));
      folders.push(
        ...addedCodeWorkspaceRepositories.map((repository) => ({
          name: repository.label,
          path: repository.displayPath,
        })),
      );
      const contents = `${JSON.stringify({ folders }, null, 2)}\n`;
      const baseName = codeWorkspaceImport.fileName.replace(
        /\.code-workspace$/i,
        "",
      );
      const anchor = document.createElement("a");
      anchor.download = `${baseName}.edited.code-workspace`;
      anchor.href = `data:application/json;charset=utf-8,${encodeURIComponent(
        contents,
      )}`;
      anchor.style.display = "none";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setCodeWorkspaceExportState("downloaded");
    } catch {
      setCodeWorkspaceExportState("error");
    }
  };

  const continueFromSource = (event: FormEvent) => {
    event.preventDefault();
    analyzeSource();
  };

  const updateRepo = (key: string, patch: Partial<RepoEvidence>) => {
    setRepositoryBaseNotice(null);
    setRepos((current) =>
      current.map((repo) => (repo.key === key ? { ...repo, ...patch } : repo)),
    );
  };

  const openRepositoryBase = async (
    repo: RepoEvidence,
    target: RepositoryForgeTarget,
  ) => {
    if (!repo.repositoryId || openingRepositoryBaseKey) return;
    const requestedBase = repo.base;
    const requestGeneration = ++repositoryBaseOpenGenerationRef.current;
    const sessionGeneration = dialogSessionGenerationRef.current;
    const requestClient = client;
    setOpeningRepositoryBaseKey(repo.key);
    setRepositoryBaseNotice({
      kind: "opening",
      message: `Resolving ${repo.id} at ${requestedBase} locally, then opening ${forgeDisplayName(target.forge)}…`,
    });
    try {
      const result = await requestClient.openRepositoryBase(
        repo.repositoryId,
        requestedBase,
      );
      if (
        requestGeneration !== repositoryBaseOpenGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      if (
        result.repositoryId !== repo.repositoryId ||
        result.baseRef !== requestedBase ||
        result.forge !== target.forge ||
        result.host !== target.host ||
        !result.accepted
      ) {
        throw new Error("WTS returned a mismatched repository base handoff.");
      }
      setRepositoryBaseNotice({
        kind: "success",
        message: `Browser handoff accepted for ${repo.id} at ${requestedBase} (${result.commitOid.slice(0, 12)}) on ${forgeDisplayName(target.forge)}.`,
      });
    } catch (error) {
      if (
        requestGeneration !== repositoryBaseOpenGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      setRepositoryBaseNotice({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The selected repository base could not be opened.",
      });
    } finally {
      if (
        requestGeneration === repositoryBaseOpenGenerationRef.current &&
        sessionGeneration === dialogSessionGenerationRef.current &&
        requestClient === currentClientRef.current
      ) {
        setOpeningRepositoryBaseKey("");
      }
    }
  };

  const refreshRepositoryBranches = async (repo: RepoEvidence) => {
    if (!repo.repositoryId || refreshingRepositoryId) return;
    const repositoryId = repo.repositoryId;
    const sessionGeneration = dialogSessionGenerationRef.current;
    const requestClient = client;
    setRefreshingRepositoryId(repositoryId);
    setRepositoryBaseNotice({
      kind: "opening",
      message: `Fetching current branches for ${repo.id} from origin…`,
    });
    try {
      const repository =
        await requestClient.refreshRepositoryBranches(repositoryId);
      if (
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      setRefreshedRepositories((current) => [
        ...current.filter((candidate) => candidate.id !== repository.id),
        repository,
      ]);
      const count = repository.availableBranches?.length ?? 0;
      setRepositoryBaseNotice({
        kind: "success",
        message: `Fetched ${count} ${count === 1 ? "branch" : "branches"} for ${repo.id}. Choose the base you want to pin.`,
      });
    } catch (error) {
      if (
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      setRepositoryBaseNotice({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : `Could not refresh branches for ${repo.id}.`,
      });
    } finally {
      if (
        sessionGeneration === dialogSessionGenerationRef.current &&
        requestClient === currentClientRef.current
      ) {
        setRefreshingRepositoryId("");
      }
    }
  };

  const analyzeRuntime = async (retry = false) => {
    if (!included.length) return;
    const request = runtimeAnalysisRequest;
    const fingerprint = currentRuntimeFingerprint;
    if (!request) {
      runtimeAnalysisGenerationRef.current += 1;
      setRuntimeAnalysisFingerprint(fingerprint);
      setRuntimeAnalysis(null);
      setRuntimeServiceDrafts(new Map());
      setRuntimeAnalysisError(
        `WTS needs one trusted local repository match for ${
          runtimeAnalysisPreparation.unresolvedLabels.length === 1
            ? runtimeAnalysisPreparation.unresolvedLabels[0]
            : runtimeAnalysisPreparation.unresolvedLabels.join(", ")
        } before it can inspect code. Refresh repository discovery or continue without services.`,
      );
      setRuntimeAnalysisState("error");
      return;
    }
    if (!retry) {
      if (
        runtimeAnalysisFingerprint === fingerprint &&
        runtimeAnalysisState !== "idle"
      ) {
        return;
      }
      const cached = runtimeAnalysisCacheRef.current.get(fingerprint);
      if (cached) {
        setRuntimeAnalysis(cached);
        setRuntimeAnalysisFingerprint(fingerprint);
        setRuntimeServiceDrafts(runtimeDraftsFromAnalysis(
          cached,
          workspaces,
          runtimeDraftSnapshotRef.current,
        ));
        setRuntimeAnalysisError("");
        setRuntimeAnalysisState("ready");
        return;
      }
    }

    const requestGeneration = ++runtimeAnalysisGenerationRef.current;
    const sessionGeneration = dialogSessionGenerationRef.current;
    const requestClient = client;
    setRuntimeAnalysisFingerprint(fingerprint);
    setRuntimeAnalysis(null);
    setRuntimeServiceDrafts(new Map());
    setRuntimeAnalysisError("");
    setRuntimeAnalysisState("loading");
    try {
      const result = await requestClient.analyzeWorkspaceRuntime(request);
      if (
        requestGeneration !== runtimeAnalysisGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      runtimeAnalysisCacheRef.current.set(fingerprint, result);
      if (fingerprint !== currentRuntimeFingerprintRef.current) return;
      setRuntimeAnalysis(result);
      setRuntimeServiceDrafts(runtimeDraftsFromAnalysis(
        result,
        workspaces,
        runtimeDraftSnapshotRef.current,
      ));
      setRuntimeAnalysisError("");
      setRuntimeAnalysisState("ready");
    } catch (error) {
      if (
        requestGeneration !== runtimeAnalysisGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current ||
        fingerprint !== currentRuntimeFingerprintRef.current
      ) {
        return;
      }
      setRuntimeAnalysisError(
        error instanceof WorkspaceClientError
          ? `${error.message} (${error.code})`
          : error instanceof Error
            ? error.message
            : "WTS could not analyze the selected repository bases.",
      );
      setRuntimeAnalysisState("error");
    }
  };

  const setRuntimeServiceIncluded = (
    candidateId: string,
    included: boolean,
  ) => {
    setRuntimeServiceDrafts((current) => {
      const next = new Map(current);
      const draft = next.get(candidateId);
      if (!draft) return current;
      next.set(candidateId, { ...draft, included });
      return next;
    });
  };

  const updateRuntimePort = (
    candidateId: string,
    portId: string,
    update: Partial<Pick<RuntimePortDraft, "preferredPort" | "policy">>,
  ) => {
    setRuntimeServiceDrafts((current) => {
      const next = new Map(current);
      const draft = next.get(candidateId);
      if (!draft) return current;
      next.set(candidateId, {
        ...draft,
        ports: draft.ports.map((port) =>
          port.portId === portId ? { ...port, ...update } : port,
        ),
      });
      return next;
    });
  };

  const autoAllocateRuntimePort = (candidateId: string, portId: string) => {
    const claimed = claimedRuntimePorts(
      workspaces,
      runtimeServiceDrafts,
      candidateId,
      portId,
    );
    const candidateService = runtimeAnalysis?.services.find(
      (service) => service.candidateId === candidateId,
    );
    const candidatePort = candidateService?.ports.find(
      (port) => port.portId === portId,
    );
    const preferred =
      candidatePort?.preferredPort !== undefined &&
      candidatePort.preferredPort >= 1024
        ? candidatePort.preferredPort
        : undefined;
    const allocated = allocateFreeRuntimePort(preferred, claimed);
    updateRuntimePort(candidateId, portId, {
      preferredPort: String(allocated),
    });
  };

  const selectedRuntimeServices =
    runtimeAnalysis?.services.filter(
      (service) => runtimeServiceDrafts.get(service.candidateId)?.included,
    ) ?? [];
  const runtimeAnalysisNotices = runtimeAnalysis?.warnings.filter(
    (warning) =>
      runtimeAnalysis.services.length > 0 ||
      warning !== "No runnable services were inferred from the selected commits.",
  ) ?? [];
  const runtimePortErrors = selectedRuntimeServices.flatMap((service) => {
    const draft = runtimeServiceDrafts.get(service.candidateId);
    return (
      draft?.ports
        .filter((port) => validRuntimePort(port.preferredPort) === null)
        .map((port) => `${service.displayName} · ${port.portId}`) ?? []
    );
  });
  const runtimeSelection: RuntimePlanSelection | undefined =
    runtimeAnalysisState === "ready" &&
    runtimeAnalysis &&
    runtimeAnalysisFingerprint === currentRuntimeFingerprint &&
    selectedRuntimeServices.length > 0 &&
    runtimePortErrors.length === 0
      ? {
          analysisDigest: runtimeAnalysis.analysisDigest,
          services: selectedRuntimeServices.map((service) => {
            const draft = runtimeServiceDrafts.get(service.candidateId)!;
            return {
              candidateId: service.candidateId,
              ports: draft.ports.map((port) => ({
                portId: port.portId,
                preferredPort: validRuntimePort(port.preferredPort)!,
                policy: port.policy,
              })),
            };
          }),
        }
      : undefined;

  const createRequest = (): CreateWorkspaceRequest => ({
    intent:
      isRevisionMode && templateWorkspace
        ? templateWorkspace.intent
        : sourceMode === "issue" && issueProvider === "jira"
          ? { type: "jira", issueKey: draftKey }
          : sourceMode === "issue" && openProjectImport !== null
            ? {
                type: "openProject",
                workPackageId: openProjectImport.workPackageId,
                displayId: openProjectImport.displayId,
              }
            : { type: "repositorySet", label: draftKey },
    title: draftTitle,
    preferredProvider: providerToRequest[provider],
    repositories:
      runtimeAnalysisPreparation.request?.repositories.map((repository) => ({
        repositoryId: repository.repositoryId,
        label: repository.label,
        baseRef: repository.baseRef,
      })) ??
      included.map((repository) => ({
        ...(repository.repositoryId === undefined
          ? {}
          : { repositoryId: repository.repositoryId }),
        label: repository.id,
        baseRef: repository.base,
      })),
    ...(runtimeSelection === undefined ? {} : { runtime: runtimeSelection }),
    ...(planningEnabled
      ? {
          planning: {
            folder: planningFolder,
            format: planningFormat,
          },
        }
      : {}),
  });

  const canSavePlan =
    included.length > 0 &&
    codeWorkspaceCloneState !== "loading" &&
    runtimeAnalysisFingerprint === currentRuntimeFingerprint &&
    (runtimeAnalysisState === "ready" || runtimeAnalysisState === "error");

  const savePlan = async () => {
    if (!canSavePlan) return;
    const request = createRequest();
    const requestFingerprint = JSON.stringify(request);
    if (
      !idempotencyKeyRef.current ||
      idempotencyRequestRef.current !== requestFingerprint
    ) {
      idempotencyKeyRef.current = newIdempotencyKey();
      idempotencyRequestRef.current = requestFingerprint;
    }
    const requestGeneration = ++saveGenerationRef.current;
    const sessionGeneration = dialogSessionGenerationRef.current;
    const requestClient = client;
    activeSaveRef.current = true;
    setSaveError("");
    setSaveWarning("");
    setStep("saving");
    try {
      const result = await requestClient.createWorkspace(
        request,
        idempotencyKeyRef.current,
      );
      if (
        requestGeneration !== saveGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      if (
        isRevisionMode &&
        templateWorkspace &&
        (result.workspace.workspaceId === templateWorkspace.id ||
          !workspaceIntentMatches(result.workspace.intent, request.intent))
      ) {
        throw new Error(
          "WTS did not return a separate revised workspace. The original plan remains unchanged; review the request and retry.",
        );
      }
      activeSaveRef.current = false;
      setSavedWorkspace(result.workspace);
      setStep("saved");
    } catch (error) {
      if (
        requestGeneration !== saveGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      activeSaveRef.current = false;
      setSaveError(
        error instanceof Error
          ? error.message
          : "The local workspace registry could not save this plan.",
      );
    }
  };

  const stopWaitingForSave = () => {
    if (!activeSaveRef.current) return;
    saveGenerationRef.current += 1;
    activeSaveRef.current = false;
    setSaveError("");
    setSaveWarning(
      "WTS stopped waiting, but the original save may still complete. Retry from this dialog to reconcile it with the same request identity.",
    );
    setStep("manifest");
  };

  const saveIsPending = step === "saving" && !saveError;
  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && activeSaveRef.current) return;
    if (!nextOpen) {
      dialogSessionGenerationRef.current += 1;
      sourceImportGenerationRef.current += 1;
      codeWorkspaceImportIdRef.current = null;
      repositoryBaseOpenGenerationRef.current += 1;
      saveGenerationRef.current += 1;
      activeSaveRef.current = false;
    }
    onOpenChange(nextOpen);
  };

  const dialogHeading =
    step === "saved"
      ? isRevisionMode
        ? "Revised plan saved"
        : "Workspace plan saved"
      : step === "saving"
        ? saveError
          ? "Save needs attention"
          : isRevisionMode
            ? "Saving revised plan"
            : "Saving workspace plan"
        : isRevisionMode
          ? `Revise ${templateWorkspace?.key ?? "workspace"}`
          : "New workspace";
  const dialogStepDescription =
    step === "source"
      ? isRevisionMode
        ? `Create a separate plan from ${templateWorkspace?.key ?? "this workspace"}. The original workspace is retained.`
        : "Start from an issue, a saved workspace, or repositories you already know. Saved workspaces are WTS plans, and you can also import a VS Code workspace file."
      : step === "evidence"
        ? isRevisionMode
          ? "Adjust the copied repository requests and base branches for the revised plan."
          : "Confirm the repository requests and their base branches."
        : step === "services"
          ? "Choose optional services for this workspace."
          : step === "manifest"
            ? isRevisionMode
              ? "Review the separate revised plan. The original workspace remains unchanged."
              : "Review the durable plan. No Git or process effects happen yet."
            : step === "saving"
              ? saveError
                ? "WTS could not confirm the registry write. Retry safely with the same request identity, or go back and review the plan."
                : isRevisionMode
                  ? "Saving a separate revised plan to your local workspace registry."
                  : "Saving the plan to your local workspace registry."
              : isRevisionMode
                ? `The revised plan is saved separately at ${savedWorkspace?.workspaceDisplayPath}.`
                : `The plan is saved at ${savedWorkspace?.workspaceDisplayPath}.`;
  const progressLabels = isRevisionMode
    ? ["Original", "Repositories", "Services", "Revised plan", "Save"]
    : ["Source", "Repositories", "Services", "Plan", "Save"];
  const sourceReviewIsCurrent =
    repos.length > 0 &&
    reviewedSourceRepositoriesFingerprintRef.current ===
      sourceRepositoriesFingerprint;
  const runtimeReviewIsCurrent =
    runtimeAnalysisState === "ready" &&
    runtimeAnalysisFingerprint === currentRuntimeFingerprint &&
    runtimePortErrors.length === 0;
  const canRevisitProgressStep = (index: number) => {
    if (index === 0) return true;
    if (index === 1) return sourceReviewIsCurrent;
    if (index === 2) return sourceReviewIsCurrent && included.length > 0;
    return (
      sourceReviewIsCurrent &&
      included.length > 0 &&
      (runtimeReviewIsCurrent || runtimeAnalysisState === "error")
    );
  };
  const revisitProgressStep = (index: number) => {
    const target = (["source", "evidence", "services", "manifest"] as const)[
      index
    ];
    if (!target || !canRevisitProgressStep(index)) return;
    setStep(target);
    if (target === "services" && runtimeAnalysisState === "idle") {
      void analyzeRuntime();
    }
  };
  const handleSourceChoiceKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ) => {
    const grid = event.currentTarget.closest<HTMLElement>(
      "[data-source-choice-grid]",
    );
    if (grid) {
      moveCompositeFocus(grid, event, "input[type='radio']", 2, true);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleDialogOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.dialogOverlay} />
        <Dialog.Content
          {...dialogFocusReturn}
          className={`${styles.portalSurface} ${styles.createDialog}`}
          data-ui="workspace-create.dialog"
          data-ui-label="New workspace dialog"
          aria-describedby="new-workspace-description"
          onEscapeKeyDown={(event) => {
            if (saveIsPending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (saveIsPending) event.preventDefault();
          }}
        >
          <div
            className={styles.dialogHeader}
            data-ui="workspace-create.header"
            data-ui-label="New workspace heading"
          >
            <div>
              <span className={styles.dialogEyebrow}>
                {isRevisionMode ? "REVISED WORKSPACE PLAN" : "LOCAL WORKSPACE"}
              </span>
              <Dialog.Title
                className={styles.dialogTitle}
                ref={stepHeadingRef}
                tabIndex={-1}
              >
                {dialogHeading}
              </Dialog.Title>
              <Dialog.Description
                className={styles.dialogDescription}
                id="new-workspace-description"
              >
                {dialogStepDescription}
              </Dialog.Description>
            </div>
            <Dialog.Close
              className={styles.iconButton}
              aria-label="Close new workspace"
              disabled={saveIsPending}
            >
              <Glyph name="close" />
            </Dialog.Close>
          </div>

          <ol
            className={styles.stepper}
            data-ui="workspace-create.progress"
            data-ui-label="Workspace setup steps"
            aria-label="Workspace creation progress"
            onKeyDownCapture={(event) =>
              moveCompositeFocus(event.currentTarget, event, `.${styles.stepButton}`, 5)
            }
          >
            {progressLabels.map((label, index) => (
              <li
                key={label}
                data-active={index + 1 === stepNumber}
                data-complete={index + 1 < stepNumber}
                aria-current={index + 1 === stepNumber ? "step" : undefined}
              >
                {index + 1 <= furthestReviewStepNumber &&
                index + 1 !== stepNumber &&
                step !== "saving" &&
                step !== "saved" &&
                index < 4 ? (
                  <button
                    className={styles.stepButton}
                    disabled={!canRevisitProgressStep(index)}
                    onClick={() => revisitProgressStep(index)}
                    type="button"
                  >
                    <span className={styles.stepMarker}>
                      <Glyph name="check" size={13} />
                    </span>
                    <span className={styles.stepLabel}>{label}</span>
                  </button>
                ) : (
                  <span className={styles.stepItem}>
                    <span className={styles.stepMarker}>
                      {index + 1 < stepNumber ? (
                        <Glyph name="check" size={13} />
                      ) : (
                        index + 1
                      )}
                    </span>
                    <span className={styles.stepLabel}>{label}</span>
                  </span>
                )}
              </li>
            ))}
          </ol>

          <div
            className={styles.dialogBody}
            data-ui="workspace-create.content"
            data-ui-label="Workspace setup content"
            data-workspace-dialog-body
            key={step}
          >
            {step === "source" && (
              <form
                className={styles.sourceForm}
                data-ui="workspace-create.source"
                data-ui-label="Workspace source"
                onSubmit={continueFromSource}
              >
                {!isRevisionMode && (
                  <RadioGroup
                    className={styles.sourceChoices}
                    data-source-choice-grid
                    value={sourceMode}
                    onChange={(value) => {
                      const next = value as SourceMode;
                      sourceImportGenerationRef.current += 1;
                      repositoryCloneGenerationRef.current += 1;
                      activeRepositoryCloneIdRef.current = "";
                      runtimeDraftSnapshotRef.current = null;
                      repositoryEditRevisionRef.current += 1;
                      autoSuggestedRepositoriesRef.current = null;
                      setSourceMode(next);
                      setSourceValue("");
                      setTemplateWorkspaceId("");
                      setIssueRepositories("");
                      setIssueRepositoryLocalMatches({});
                      setIssueRepositoryShowAllRemotes({});
                      setJiraImport(null);
                      setOpenProjectImport(null);
                      setSourceImportState("idle");
                      setSourceImportMessage("");
                      setCodeWorkspaceImport(null);
                      codeWorkspaceImportIdRef.current = null;
                      setCodeWorkspaceImportState("idle");
                      setCodeWorkspaceImportMessage("");
                      setCodeWorkspaceTitle("");
                      setCodeWorkspaceAddedRepositoryIds([]);
                      setCodeWorkspaceClonedBaseRefs({});
                      setCodeWorkspaceRepositoryToAdd("");
                      setCodeWorkspaceRepositoryAddMode("existing");
                      setCodeWorkspaceCloneUrl("");
                      setCodeWorkspaceCloneBranch("");
                      setCodeWorkspaceCloneShallow(true);
                      setCodeWorkspaceCloneState("idle");
                      setCodeWorkspaceCloneMessage("");
                      setIssueRepositoryCloneKey("");
                      setIssueRepositoryCloneNotice(null);
                      setCodeWorkspaceExportState("idle");
                      setCodeWorkspaceDiagnosticsCopyState("idle");
                      setRepos([]);
                      setRepositoryBaseNotice(null);
                      setProvider(
                        next === "codeWorkspace" ? "VS Code" : "Codex",
                      );
                    }}
                    aria-label="Workspace source"
                  >
                    <Radio
                      value="issue"
                      className={styles.sourceChoice}
                      onKeyDown={handleSourceChoiceKeyDown}
                    >
                      <span className={styles.radioIndicator} />
                      <span className={styles.sourceIcon} data-source="issue">
                        <Glyph name="issue" size={18} />
                      </span>
                      <span>
                        <strong>Issue</strong>
                        <small>Import context and infer repository scope</small>
                      </span>
                    </Radio>
                    <Radio
                      value="workspace"
                      className={styles.sourceChoice}
                      onKeyDown={handleSourceChoiceKeyDown}
                    >
                      <span className={styles.radioIndicator} />
                      <span
                        className={styles.sourceIcon}
                        data-source="workspace"
                      >
                        <Glyph name="copy" size={18} />
                      </span>
                      <span>
                        <strong>Saved WTS plan</strong>
                        <small>Copy repository and base-ref requests</small>
                      </span>
                    </Radio>
                    <Radio
                      value="set"
                      className={styles.sourceChoice}
                      onKeyDown={handleSourceChoiceKeyDown}
                    >
                      <span className={styles.radioIndicator} />
                      <span className={styles.sourceIcon}>
                        <Glyph name="folder" size={18} />
                      </span>
                      <span>
                        <strong>Repositories</strong>
                        <small>Choose local repositories directly</small>
                      </span>
                    </Radio>
                    <Radio
                      value="codeWorkspace"
                      className={styles.sourceChoice}
                      onKeyDown={handleSourceChoiceKeyDown}
                    >
                      <span className={styles.radioIndicator} />
                      <span
                        className={styles.sourceIcon}
                        data-source="codeWorkspace"
                      >
                        <Glyph name="file" size={18} />
                      </span>
                      <span>
                        <strong>VS Code workspace file</strong>
                        <small>Import folders from .code-workspace</small>
                      </span>
                    </Radio>
                  </RadioGroup>
                )}
                {isIssueSource && (
                  <div className={styles.issueProviderField}>
                    <span>Issue provider</span>
                    <div
                      className={styles.issueProviderSelector}
                      role="radiogroup"
                      aria-label="Issue provider"
                      onKeyDownCapture={(event) =>
                        moveCompositeFocus(event.currentTarget, event, "[role='radio']", 2, true)
                      }
                    >
                      {(
                        [
                          ["jira", "Jira", "jira"],
                          ["openProject", "OpenProject", "openProject"],
                        ] as const
                      ).map(([id, label, glyph]) => (
                        <button
                          aria-checked={issueProvider === id}
                          data-selected={issueProvider === id || undefined}
                          key={id}
                          role="radio"
                          tabIndex={issueProvider === id ? 0 : -1}
                          onClick={() => {
                            if (issueProvider === id) return;
                            sourceImportGenerationRef.current += 1;
                            repositoryEditRevisionRef.current += 1;
                            autoSuggestedRepositoriesRef.current = null;
                            setIssueProvider(id);
                            setSourceValue("");
                            setIssueRepositories("");
                            setJiraImport(null);
                            setOpenProjectImport(null);
                            setSourceImportState("idle");
                            setSourceImportMessage("");
                            setRepos([]);
                            setRepositoryBaseNotice(null);
                          }}
                          type="button"
                        >
                          <Glyph name={glyph} size={14} />
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {isWorkspaceSource ? (
                  <div className={styles.field}>
                    <Label>
                      {isRevisionMode
                        ? "Original workspace"
                        : "Saved plan to copy"}
                    </Label>
                    {!isRevisionMode && (
                      <div className={styles.inputWithIcon}>
                        <Glyph name="copy" size={17} />
                        <SelectMenu
                          aria-label="Saved plan to copy"
                          disabled={!workspaces.length}
                          value={templateWorkspaceId}
                          onChange={(workspaceId) => {
                            const template = workspaces.find(
                              (workspace) => workspace.id === workspaceId,
                            );
                            setTemplateWorkspaceId(workspaceId);
                            setProvider(template?.provider ?? "Codex");
                            setPlanningEnabled(
                              template?.planning !== undefined,
                            );
                            setPlanningFolder(
                              template?.planning?.folder ?? "plansAndKanban",
                            );
                            setPlanningFormat(
                              template?.planning?.format ?? "kanban",
                            );
                            setRepos([]);
                          }}
                        >
                          <option value="">Choose a saved WTS plan…</option>
                          {workspaces.map((workspace) => (
                            <option key={workspace.id} value={workspace.id}>
                              {workspace.key} · {workspace.title}
                            </option>
                          ))}
                        </SelectMenu>
                      </div>
                    )}
                    <small>
                      {isRevisionMode
                        ? "This fixed source supplies the intent, repository requests, base refs, and preferred provider for a separate revised plan."
                        : "Copy the saved repository requests, base refs, and preferred provider into a fresh plan. This is a WTS plan, not a VS Code file."}
                    </small>
                    {!isRevisionMode && !workspaces.length && (
                      <p className={styles.templateEmpty}>
                        No saved WTS plans yet. Start from an issue, a
                        repositories, or a VS Code workspace file first.
                      </p>
                    )}
                    {isRevisionMode && !templateWorkspace && (
                      <p className={styles.templateEmpty} role="alert">
                        The original workspace is no longer available. Close
                        this dialog, refresh Spaces, and start the
                        revision again.
                      </p>
                    )}
                    {templateWorkspace && (
                      <>
                        <div
                          className={styles.templatePreview}
                          data-revision={isRevisionMode || undefined}
                        >
                          <span className={styles.templateIdentity}>
                            <span className={styles.providerMark}>
                              {providerMarks[templateWorkspace.provider]}
                            </span>
                            <span>
                              <b>{templateWorkspace.key}</b>
                              <strong>{templateWorkspace.title}</strong>
                            </span>
                          </span>
                          <span className={styles.templateFacts}>
                            <span>
                              {templateWorkspace.repos}{" "}
                              {templateWorkspace.repos === 1 ? "repo" : "repos"}
                            </span>
                            <span>{templateWorkspace.provider}</span>
                            <code>{templateWorkspace.path}</code>
                          </span>
                          <span className={styles.templateRepositories}>
                            {templateWorkspace.repositoryPlans.map(
                              (repository) => (
                                <code
                                  key={repositoryEvidenceKey(
                                    repository.repositoryId,
                                    repository.label,
                                  )}
                                >
                                  {repository.label} ← {repository.baseRef}
                                </code>
                              ),
                            )}
                          </span>
                        </div>
                        <p
                          className={styles.templateNote}
                          data-revision={isRevisionMode || undefined}
                        >
                          <Glyph name="copy" size={14} />
                          <span>
                            {isRevisionMode && <b>Original retained</b>}
                            {isRevisionMode
                              ? `${templateWorkspace.key} and its existing worktrees, branches, changes, and sessions remain untouched. WTS will save a separate plan with its own path.`
                              : "This copies the plan—not branches, uncommitted changes, agent history, or running processes."}
                          </span>
                        </p>
                        {isRevisionMode && (
                          <div className={styles.revisionTitleField}>
                            <Label>New plan title</Label>
                            <div className={styles.inputWithIcon}>
                              <Glyph name="file" size={17} />
                              <Input
                                aria-label="New plan title"
                                data-dialog-initial-focus
                                maxLength={240}
                                required
                                value={revisionTitle}
                                onChange={(event) =>
                                  setRevisionTitle(event.target.value)
                                }
                              />
                            </div>
                            <small>
                              Required · up to 240 characters. The original
                              title remains unchanged.
                            </small>
                          </div>
                        )}
                        <section
                          aria-labelledby="copied-plan-repositories-title"
                          className={styles.workspaceFolderEditor}
                          data-ui="workspace-create.copy-repositories"
                          data-ui-label="Copied plan repositories"
                        >
                          <header>
                            <span><Glyph name="folder" size={15} /></span>
                            <div>
                              <h4 id="copied-plan-repositories-title">
                                Add repositories
                              </h4>
                              <small>
                                Extend this copied plan before WTS saves it.
                              </small>
                            </div>
                            <b>
                              {templateWorkspace.repositoryPlans.length +
                                addedCodeWorkspaceRepositories.length}{" "}
                              IN PLAN
                            </b>
                          </header>
                          <Tabs.Root
                            onValueChange={(value) => {
                              setCodeWorkspaceRepositoryAddMode(
                                value as CodeWorkspaceRepositoryAddMode,
                              );
                              setCodeWorkspaceCloneState("idle");
                              setCodeWorkspaceCloneMessage("");
                            }}
                            value={codeWorkspaceRepositoryAddMode}
                          >
                            <Tabs.List
                              aria-label="Additional repository source"
                              className={styles.repositoryAddModes}
                            >
                              <Tabs.Trigger
                                disabled={codeWorkspaceCloneState === "loading"}
                                value="existing"
                              >
                                Existing local
                              </Tabs.Trigger>
                              <Tabs.Trigger
                                disabled={codeWorkspaceCloneState === "loading"}
                                value="clone"
                              >
                                Clone Git URL
                              </Tabs.Trigger>
                            </Tabs.List>
                            <Tabs.Content value="existing">
                              <div className={styles.repositoryClonePanel}>
                                <div className={styles.workspaceFolderPicker}>
                                  <label>
                                    <span>Local repository</span>
                                    <SelectMenu
                                      aria-label="Repository to add to copied plan"
                                      disabled={
                                        availableCodeWorkspaceRepositories.length ===
                                        0
                                      }
                                      onChange={setCodeWorkspaceRepositoryToAdd}
                                      value={codeWorkspaceRepositoryToAdd}
                                    >
                                      <option value="">
                                        {availableCodeWorkspaceRepositories.length
                                          ? "Choose a discovered repository…"
                                          : "No more discovered repositories"}
                                      </option>
                                      {availableCodeWorkspaceRepositories.map(
                                        (repository) => (
                                          <option
                                            key={repository.id}
                                            value={repository.id}
                                          >
                                            {repository.label} ·{" "}
                                            {repository.displayPath}
                                          </option>
                                        ),
                                      )}
                                    </SelectMenu>
                                  </label>
                                  <button
                                    className={styles.addWorkspaceFolderButton}
                                    disabled={!codeWorkspaceRepositoryToAdd}
                                    onClick={addCodeWorkspaceRepository}
                                    type="button"
                                  >
                                    <Glyph name="plus" size={13} />
                                    Add repository
                                  </button>
                                </div>
                              </div>
                            </Tabs.Content>
                            <Tabs.Content value="clone">
                              <div className={styles.repositoryClonePanel}>
                                <div className={styles.workspaceFolderPicker}>
                                  <label>
                                    <span>Git repository URL</span>
                                    <input
                                      aria-describedby="copied-plan-clone-help"
                                      autoComplete="off"
                                      onChange={(event) => {
                                        setCodeWorkspaceCloneUrl(
                                          event.target.value,
                                        );
                                        setCodeWorkspaceCloneState("idle");
                                        setCodeWorkspaceCloneMessage("");
                                      }}
                                      placeholder="https://host/team/repo.git or git@host:team/repo.git"
                                      spellCheck={false}
                                      type="text"
                                      value={codeWorkspaceCloneUrl}
                                    />
                                  </label>
                                  <button
                                    className={styles.addWorkspaceFolderButton}
                                    disabled={
                                      !codeWorkspaceCloneLeaf ||
                                      codeWorkspaceCloneState === "loading"
                                    }
                                    onClick={() =>
                                      void cloneCodeWorkspaceRepository()
                                    }
                                    type="button"
                                  >
                                    <Glyph
                                      name={
                                        codeWorkspaceCloneState === "loading"
                                          ? "refresh"
                                          : "plus"
                                      }
                                      size={13}
                                    />
                                    {codeWorkspaceCloneState === "loading"
                                      ? "Cloning…"
                                      : "Clone and add"}
                                  </button>
                                </div>
                                <RepositoryClonePreferences
                                  branch={codeWorkspaceCloneBranch}
                                  disabled={codeWorkspaceCloneState === "loading"}
                                  onBranchChange={(branch) => {
                                    setCodeWorkspaceCloneBranch(branch);
                                    setCodeWorkspaceCloneState("idle");
                                    setCodeWorkspaceCloneMessage("");
                                  }}
                                  onShallowChange={(shallow) => {
                                    setCodeWorkspaceCloneShallow(shallow);
                                    setCodeWorkspaceCloneState("idle");
                                    setCodeWorkspaceCloneMessage("");
                                  }}
                                  shallow={codeWorkspaceCloneShallow}
                                />
                                <div
                                  className={styles.repositoryCloneHelp}
                                  id="copied-plan-clone-help"
                                >
                                  <span>
                                    {codeWorkspaceCloneTarget ? (
                                      <>Clone target <code>{codeWorkspaceCloneTarget}</code></>
                                    ) : (
                                      "Paste an HTTPS or SSH Git URL to preview its local destination."
                                    )}
                                  </span>
                                  <small>
                                    Git uses your credential helper or SSH agent.
                                    WTS does not store credentials.
                                  </small>
                                </div>
                                {codeWorkspaceCloneMessage && (
                                  <p
                                    className={styles.repositoryCloneStatus}
                                    data-error={
                                      codeWorkspaceCloneState === "error" ||
                                      undefined
                                    }
                                    role={
                                      codeWorkspaceCloneState === "error"
                                        ? "alert"
                                        : "status"
                                    }
                                  >
                                    {codeWorkspaceCloneMessage}
                                  </p>
                                )}
                              </div>
                            </Tabs.Content>
                          </Tabs.Root>
                          {addedCodeWorkspaceRepositories.length > 0 && (
                            <div
                              aria-label="Additional repositories in copied plan"
                              className={styles.addedWorkspaceFolders}
                              role="list"
                            >
                              {addedCodeWorkspaceRepositories.map(
                                (repository) => (
                                  <div key={repository.id} role="listitem">
                                    <span>
                                      <b>{repository.label}</b>
                                      <code>{repository.displayPath}</code>
                                    </span>
                                    <small>
                                      Base {repository.defaultBranch.name}
                                    </small>
                                    <button
                                      aria-label={`Remove ${repository.label} from copied plan`}
                                      onClick={() =>
                                        removeCodeWorkspaceRepository(
                                          repository.id,
                                        )
                                      }
                                      type="button"
                                    >
                                      <Glyph name="close" size={12} />
                                    </button>
                                  </div>
                                ),
                              )}
                            </div>
                          )}
                        </section>
                      </>
                    )}
                  </div>
                ) : isCodeWorkspaceSource ? (
                  <div className={styles.fileImportField}>
                    <div className={styles.fileImportHeading}>
                      <span>
                        <b>Bring in an existing VS Code workspace</b>
                        <small>
                          WTS finds local Git sources under your trusted
                          repository roots, including nested checkouts.
                        </small>
                      </span>
                      <span className={styles.fileLimitBadge}>MAX 48 KiB</span>
                    </div>
                    <label htmlFor="code-workspace-file-input">
                      VS Code workspace file
                    </label>
                    <input
                      accept=".code-workspace,application/json"
                      aria-describedby="code-workspace-file-help code-workspace-file-status"
                      className={styles.fileInput}
                      id="code-workspace-file-input"
                      onChange={(event) =>
                        void importCodeWorkspaceFile(event.currentTarget)
                      }
                      type="file"
                    />
                    <p
                      className={styles.fileImportHelp}
                      id="code-workspace-file-help"
                    >
                      Choose one <code>.code-workspace</code> file, up to 48
                      KiB. WTS reads it once and treats its folder paths as
                      lookup hints for a bounded search under your trusted
                      repository roots. The file and existing checkouts are
                      never changed.
                    </p>
                    <div
                      aria-live={
                        codeWorkspaceImportState === "error"
                          ? "assertive"
                          : "polite"
                      }
                      className={styles.fileImportStatus}
                      data-state={codeWorkspaceImportState}
                      data-warning={
                        codeWorkspaceImportState === "ready" &&
                        codeWorkspaceImport?.repositories.length === 0
                          ? true
                          : undefined
                      }
                      id="code-workspace-file-status"
                      role={
                        codeWorkspaceImportState === "error"
                          ? "alert"
                          : "status"
                      }
                    >
                      <Glyph
                        name={
                          codeWorkspaceImportState === "error" ||
                          (codeWorkspaceImportState === "ready" &&
                            codeWorkspaceImport?.repositories.length === 0)
                            ? "warning"
                            : codeWorkspaceImportState === "loading"
                              ? "refresh"
                              : codeWorkspaceImportState === "ready"
                                ? "check"
                                : "file"
                        }
                        size={15}
                      />
                      <span>
                        {codeWorkspaceImportMessage ||
                          "No file selected. Your VS Code configuration remains untouched."}
                      </span>
                    </div>

                    {codeWorkspaceImport && (
                      <section
                        aria-label={`Import preview for ${codeWorkspaceImport.fileName}`}
                        className={styles.fileImportPreview}
                        data-ui="workspace-create.import-preview"
                        data-ui-label="Workspace import preview"
                      >
                        <header>
                          <span>
                            <Glyph name="file" size={17} />
                          </span>
                          <div>
                            <b>{codeWorkspaceImport.fileName}</b>
                            <small>
                              {codeWorkspaceImport.repositories.length} matched{" "}
                              {codeWorkspaceImport.repositories.length === 1
                                ? "repository"
                                : "repositories"}{" "}
                              · {codeWorkspaceImport.folders.length}{" "}
                              {codeWorkspaceImport.folders.length === 1
                                ? "folder"
                                : "folders"}{" "}
                              inspected
                            </small>
                          </div>
                          <span className={styles.fileReadyBadge}>
                            READ ONCE
                          </span>
                        </header>

                        <div className={styles.fileTitleField}>
                          <Label>Workspace plan title</Label>
                          <div className={styles.inputWithIcon}>
                            <Glyph name="file" size={17} />
                            <Input
                              aria-label="Workspace plan title"
                              maxLength={240}
                              onChange={(event) =>
                                setCodeWorkspaceTitle(event.target.value)
                              }
                              required
                              value={codeWorkspaceTitle}
                            />
                          </div>
                          <small>
                            Suggested from the file name. You can change it
                            before saving.
                          </small>
                        </div>

                        <div
                          aria-label="Imported workspace folders"
                          className={styles.importFolderList}
                          role="list"
                        >
                          {codeWorkspaceImport.folders.map((folder, index) => (
                            <div
                              className={styles.importFolderRow}
                              data-status={folder.status}
                              key={`${folder.rawPath}-${index}`}
                              role="listitem"
                            >
                              <span className={styles.importFolderGlyph}>
                                <Glyph
                                  name={
                                    folder.status === "matched"
                                      ? "check"
                                      : "warning"
                                  }
                                  size={14}
                                />
                              </span>
                              <span className={styles.importFolderIdentity}>
                                <b>{folder.name}</b>
                                <code>{folder.rawPath}</code>
                                {folder.message && (
                                  <small>{folder.message}</small>
                                )}
                              </span>
                              <span className={styles.importFolderMatch}>
                                <b>
                                  {folder.status === "matched"
                                    ? folder.repositoryLabel
                                    : folder.status}
                                </b>
                                {folder.status === "matched" &&
                                  folder.repositoryDisplayPath && (
                                    <InfoTooltip
                                      content={`Local Git source: ${folder.repositoryDisplayPath}`}
                                    >
                                      <code tabIndex={0}>
                                        {folder.repositoryDisplayPath}
                                      </code>
                                    </InfoTooltip>
                                  )}
                                <small>
                                  {folder.status === "matched"
                                    ? folder.baseRef
                                      ? `Base ${folder.baseRef}`
                                      : "Matched locally"
                                    : "Not added to the plan"}
                                </small>
                              </span>
                            </div>
                          ))}
                        </div>

                        <section
                          aria-labelledby="workspace-folder-editor-title"
                          className={styles.workspaceFolderEditor}
                          data-ui="workspace-create.import-repositories"
                          data-ui-label="Imported repositories"
                        >
                          <header>
                            <span>
                              <Glyph name="folder" size={15} />
                            </span>
                            <div>
                              <h4 id="workspace-folder-editor-title">
                                Add repository folders
                              </h4>
                              <small>
                                Extend this WTS plan before creating its
                                isolated worktrees.
                              </small>
                            </div>
                            <b>
                              {codeWorkspaceImport.repositories.length +
                                addedCodeWorkspaceRepositories.length}{" "}
                              IN PLAN
                            </b>
                          </header>
                          <Tabs.Root
                            onValueChange={(value) => {
                              const mode =
                                value as CodeWorkspaceRepositoryAddMode;
                              setCodeWorkspaceRepositoryAddMode(mode);
                              if (mode === "clone") {
                                setCodeWorkspaceCloneState("idle");
                                setCodeWorkspaceCloneMessage("");
                              }
                            }}
                            value={codeWorkspaceRepositoryAddMode}
                          >
                            <Tabs.List
                              aria-label="Repository folder source"
                              className={styles.repositoryAddModes}
                            >
                              <Tabs.Trigger
                                disabled={codeWorkspaceCloneState === "loading"}
                                value="existing"
                              >
                                Existing local
                              </Tabs.Trigger>
                              <Tabs.Trigger
                                disabled={codeWorkspaceCloneState === "loading"}
                                value="clone"
                              >
                                Clone from URL
                              </Tabs.Trigger>
                            </Tabs.List>
                            <Tabs.Content value="existing">
                              <div className={styles.workspaceFolderPicker}>
                                <label>
                                  <span>Local repository</span>
                                  <SelectMenu
                                    aria-label="Add local repository folder"
                                    disabled={
                                      availableCodeWorkspaceRepositories.length ===
                                      0
                                    }
                                    value={codeWorkspaceRepositoryToAdd}
                                    onChange={(value) => {
                                      setCodeWorkspaceRepositoryToAdd(value);
                                      setCodeWorkspaceExportState("idle");
                                    }}
                                  >
                                    <option value="">
                                      {availableCodeWorkspaceRepositories.length
                                        ? "Choose a discovered repository…"
                                        : "No more discovered repositories"}
                                    </option>
                                    {availableCodeWorkspaceRepositories.map(
                                      (repository) => (
                                        <option
                                          key={repository.id}
                                          value={repository.id}
                                        >
                                          {repository.label} ·{" "}
                                          {repository.checkoutLeaf}
                                        </option>
                                      ),
                                    )}
                                  </SelectMenu>
                                </label>
                                <button
                                  className={styles.addWorkspaceFolderButton}
                                  disabled={!codeWorkspaceRepositoryToAdd}
                                  onClick={addCodeWorkspaceRepository}
                                  type="button"
                                >
                                  <Glyph name="plus" size={13} />
                                  Add folder
                                </button>
                              </div>
                            </Tabs.Content>
                            <Tabs.Content value="clone">
                              <div className={styles.repositoryClonePanel}>
                                <div className={styles.workspaceFolderPicker}>
                                  <label>
                                    <span>Git repository URL</span>
                                    <input
                                      aria-describedby="repository-clone-help"
                                      autoComplete="off"
                                      onChange={(event) => {
                                        setCodeWorkspaceCloneUrl(
                                          event.target.value,
                                        );
                                        setCodeWorkspaceCloneState("idle");
                                        setCodeWorkspaceCloneMessage("");
                                      }}
                                      placeholder="https://host/team/repo.git or git@host:team/repo.git"
                                      spellCheck={false}
                                      type="url"
                                      value={codeWorkspaceCloneUrl}
                                    />
                                  </label>
                                  <button
                                    className={styles.addWorkspaceFolderButton}
                                    disabled={
                                      !codeWorkspaceCloneLeaf ||
                                      codeWorkspaceCloneState === "loading"
                                    }
                                    onClick={() => {
                                      void cloneCodeWorkspaceRepository();
                                    }}
                                    type="button"
                                  >
                                    <Glyph
                                      name={
                                        codeWorkspaceCloneState === "loading"
                                          ? "refresh"
                                          : "plus"
                                      }
                                      size={13}
                                    />
                                    {codeWorkspaceCloneState === "loading"
                                      ? "Cloning…"
                                      : "Clone and add"}
                                  </button>
                                </div>
                                <RepositoryClonePreferences
                                  branch={codeWorkspaceCloneBranch}
                                  disabled={codeWorkspaceCloneState === "loading"}
                                  onBranchChange={(branch) => {
                                    setCodeWorkspaceCloneBranch(branch);
                                    setCodeWorkspaceCloneState("idle");
                                    setCodeWorkspaceCloneMessage("");
                                  }}
                                  onShallowChange={(shallow) => {
                                    setCodeWorkspaceCloneShallow(shallow);
                                    setCodeWorkspaceCloneState("idle");
                                    setCodeWorkspaceCloneMessage("");
                                  }}
                                  shallow={codeWorkspaceCloneShallow}
                                />
                                <div
                                  className={styles.repositoryCloneHelp}
                                  id="repository-clone-help"
                                >
                                  <span>
                                    {codeWorkspaceCloneTarget ? (
                                      <>
                                        Clone target{" "}
                                        <code>{codeWorkspaceCloneTarget}</code>
                                      </>
                                    ) : (
                                      "Paste an HTTPS or SSH Git URL to preview its local destination."
                                    )}
                                  </span>
                                  <small>
                                    Uses your Git credential helper or SSH
                                    agent. WTS does not store credentials.
                                  </small>
                                </div>
                                {codeWorkspaceCloneMessage && (
                                  <p
                                    className={styles.repositoryCloneStatus}
                                    data-error={
                                      codeWorkspaceCloneState === "error" ||
                                      undefined
                                    }
                                    role={
                                      codeWorkspaceCloneState === "error"
                                        ? "alert"
                                        : "status"
                                    }
                                  >
                                    {codeWorkspaceCloneMessage}
                                  </p>
                                )}
                              </div>
                            </Tabs.Content>
                          </Tabs.Root>
                          {addedCodeWorkspaceRepositories.length > 0 && (
                            <div
                              aria-label="Additional repository folders"
                              className={styles.addedWorkspaceFolders}
                              role="list"
                            >
                              {addedCodeWorkspaceRepositories.map(
                                (repository) => (
                                  <div key={repository.id} role="listitem">
                                    <span>
                                      <b>{repository.label}</b>
                                      <code>{repository.displayPath}</code>
                                    </span>
                                    <small>
                                      Base {repository.defaultBranch.name}
                                    </small>
                                    <button
                                      aria-label={`Remove added folder ${repository.label}`}
                                      onClick={() =>
                                        removeCodeWorkspaceRepository(
                                          repository.id,
                                        )
                                      }
                                      type="button"
                                    >
                                      <Glyph name="close" size={12} />
                                    </button>
                                  </div>
                                ),
                              )}
                            </div>
                          )}
                          <footer>
                            <span>
                              <b>Edit the VS Code file too?</b>
                              <small>
                                Download a folder-only copy with these
                                additions. Settings, tasks, comments, and the
                                original file stay untouched.
                              </small>
                            </span>
                            <button
                              className={styles.downloadWorkspaceCopyButton}
                              disabled={
                                addedCodeWorkspaceRepositories.length === 0
                              }
                              onClick={downloadEditedCodeWorkspace}
                              type="button"
                            >
                              <Glyph name="file" size={13} />
                              Download edited copy
                            </button>
                          </footer>
                          {codeWorkspaceExportState !== "idle" && (
                            <p
                              className={styles.workspaceFolderExportStatus}
                              data-error={
                                codeWorkspaceExportState === "error" ||
                                undefined
                              }
                              role={
                                codeWorkspaceExportState === "error"
                                  ? "alert"
                                  : "status"
                              }
                            >
                              {codeWorkspaceExportState === "downloaded"
                                ? `Downloaded ${codeWorkspaceImport.fileName.replace(
                                    /\.code-workspace$/i,
                                    "",
                                  )}.edited.code-workspace.`
                                : "The edited workspace copy could not be downloaded."}
                            </p>
                          )}
                        </section>

                        {codeWorkspaceImport.warnings.length > 0 && (
                          <div className={styles.fileWarnings}>
                            <b>Import notes</b>
                            <ul>
                              {codeWorkspaceImport.warnings.map(
                                (warning, index) => (
                                  <li
                                    key={`${warning.code}-${warning.folderName ?? "general"}-${index}`}
                                  >
                                    <Glyph name="warning" size={13} />
                                    <span>{warning.message}</span>
                                  </li>
                                ),
                              )}
                            </ul>
                          </div>
                        )}
                        <CodeWorkspaceDiagnosticsPanel
                          copyState={codeWorkspaceDiagnosticsCopyState}
                          imported={codeWorkspaceImport}
                          onCopy={() => void copyCodeWorkspaceDiagnostics()}
                        />
                        <section
                          aria-labelledby="code-workspace-worktree-boundary"
                          className={styles.fileBoundaryNote}
                        >
                          <Glyph name="check" size={14} />
                          <span>
                            <h4 id="code-workspace-worktree-boundary">
                              Local source → managed worktree
                            </h4>
                            <small>
                              A matched checkout is used as the local Git
                              source. When you later create this workspace, WTS
                              adds a separate worktree under{" "}
                              <code>{workspaceRootDisplayPath}</code>. Import
                              and preflight do not fetch or edit any source
                              checkout; cloning happens only when you explicitly
                              choose Clone from URL.
                            </small>
                          </span>
                        </section>
                      </section>
                    )}
                  </div>
                ) : sourceMode === "set" ? (
                  <section
                    aria-labelledby="repository-source-title"
                    className={`${styles.workspaceFolderEditor} ${styles.repositoryWorkspaceEditor}`}
                    data-has-clone-task={
                      Boolean(codeWorkspaceCloneMessage) || undefined
                    }
                    data-ui="workspace-create.repositories"
                    data-ui-label="Repository selection"
                  >
                    <header>
                      <span><Glyph name="folder" size={15} /></span>
                      <div>
                        <h4 id="repository-source-title">Choose repositories</h4>
                        <small>
                          Use a discovered checkout or clone any Git repository
                          into the trusted repository root.
                        </small>
                      </div>
                      <b>{addedCodeWorkspaceRepositories.length} IN PLAN</b>
                    </header>
                    <Tabs.Root
                      className={styles.repositorySelectionMain}
                      data-repository-selector="true"
                      onValueChange={(value) => {
                        setCodeWorkspaceRepositoryAddMode(
                          value as CodeWorkspaceRepositoryAddMode,
                        );
                        if (codeWorkspaceCloneState !== "loading") {
                          setCodeWorkspaceCloneState("idle");
                          setCodeWorkspaceCloneMessage("");
                        }
                      }}
                      value={codeWorkspaceRepositoryAddMode}
                    >
                      <Tabs.List
                        aria-label="Repository source"
                        className={styles.repositoryAddModes}
                      >
                        <Tabs.Trigger value="existing">
                          Existing local
                        </Tabs.Trigger>
                        <Tabs.Trigger value="clone">
                          Clone Git URL
                        </Tabs.Trigger>
                      </Tabs.List>
                      <Tabs.Content value="existing">
                        <div className={styles.repositoryClonePanel}>
                          <div className={styles.workspaceFolderPicker}>
                            <label>
                              <span>Local repository</span>
                              <SelectMenu
                                aria-label="Repository to add"
                                disabled={
                                  availableCodeWorkspaceRepositories.length ===
                                  0
                                }
                                onChange={setCodeWorkspaceRepositoryToAdd}
                                value={codeWorkspaceRepositoryToAdd}
                              >
                                <option value="">
                                  {availableCodeWorkspaceRepositories.length
                                    ? "Choose a discovered repository…"
                                    : "No more discovered repositories"}
                                </option>
                                {availableCodeWorkspaceRepositories.map(
                                  (repository) => (
                                    <option
                                      key={repository.id}
                                      value={repository.id}
                                    >
                                      {repository.label} ·{" "}
                                      {repository.displayPath}
                                    </option>
                                  ),
                                )}
                              </SelectMenu>
                            </label>
                            <button
                              className={styles.addWorkspaceFolderButton}
                              disabled={!codeWorkspaceRepositoryToAdd}
                              onClick={addCodeWorkspaceRepository}
                              type="button"
                            >
                              <Glyph name="plus" size={13} /> Add repository
                            </button>
                          </div>
                          <div className={styles.repositoryCloneHelp}>
                            <span>
                              WTS lists only repositories discovered under your
                              trusted repository roots.
                            </span>
                            <small>
                              A typed local path cannot expand this access. Use
                              Clone Git URL to add another repository safely.
                            </small>
                          </div>
                        </div>
                      </Tabs.Content>
                      <Tabs.Content value="clone">
                        <div className={styles.repositoryClonePanel}>
                          <div className={styles.workspaceFolderPicker}>
                            <label>
                              <span>Git repository URL</span>
                              <input
                                aria-describedby="new-workspace-repository-clone-help"
                                autoComplete="off"
                                disabled={codeWorkspaceCloneState === "loading"}
                                onChange={(event) => {
                                  setCodeWorkspaceCloneUrl(event.target.value);
                                  setCodeWorkspaceCloneState("idle");
                                  setCodeWorkspaceCloneMessage("");
                                }}
                                placeholder="https://host/team/repo.git or git@host:team/repo.git"
                                spellCheck={false}
                                type="text"
                                value={codeWorkspaceCloneUrl}
                              />
                            </label>
                            <button
                              className={styles.addWorkspaceFolderButton}
                              disabled={
                                !codeWorkspaceCloneLeaf ||
                                codeWorkspaceCloneState === "loading"
                              }
                              onClick={() => void cloneCodeWorkspaceRepository()}
                              type="button"
                            >
                              <Glyph
                                name={
                                  codeWorkspaceCloneState === "loading"
                                    ? "refresh"
                                    : "plus"
                                }
                                size={13}
                              />
                              {codeWorkspaceCloneState === "loading"
                                ? "Cloning…"
                                : "Clone and add"}
                            </button>
                          </div>
                          <RepositoryClonePreferences
                            branch={codeWorkspaceCloneBranch}
                            disabled={codeWorkspaceCloneState === "loading"}
                            onBranchChange={(branch) => {
                              setCodeWorkspaceCloneBranch(branch);
                              setCodeWorkspaceCloneState("idle");
                              setCodeWorkspaceCloneMessage("");
                            }}
                            onShallowChange={(shallow) => {
                              setCodeWorkspaceCloneShallow(shallow);
                              setCodeWorkspaceCloneState("idle");
                              setCodeWorkspaceCloneMessage("");
                            }}
                            shallow={codeWorkspaceCloneShallow}
                          />
                          <div
                            className={styles.repositoryCloneHelp}
                            id="new-workspace-repository-clone-help"
                          >
                            <span>
                              {codeWorkspaceCloneTarget ? (
                                <>Clone target <code>{codeWorkspaceCloneTarget}</code></>
                              ) : (
                                "Paste an HTTPS or SSH Git URL to preview its local destination."
                              )}
                            </span>
                            <small>
                              Git uses your credential helper or SSH agent. WTS
                              does not store credentials.
                            </small>
                          </div>
                        </div>
                      </Tabs.Content>
                    </Tabs.Root>
                    {codeWorkspaceCloneMessage && (
                      <RepositoryCloneTask
                        message={codeWorkspaceCloneMessage}
                        onMoveToKanban={moveActiveCloneToKanban}
                        state={codeWorkspaceCloneState}
                      />
                    )}
                    {addedCodeWorkspaceRepositories.length > 0 && (
                      <div
                        aria-label="Repositories in this workspace plan"
                        className={styles.addedWorkspaceFolders}
                        role="list"
                      >
                        {addedCodeWorkspaceRepositories.map((repository) => (
                          <div key={repository.id} role="listitem">
                            <span>
                              <b>{repository.label}</b>
                              <code>{repository.displayPath}</code>
                            </span>
                            <small>Base {repository.defaultBranch.name}</small>
                            <button
                              aria-label={`Remove ${repository.label} from plan`}
                              onClick={() =>
                                removeCodeWorkspaceRepository(repository.id)
                              }
                              type="button"
                            >
                              <Glyph name="close" size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <footer>
                      <span>
                        <b>Branch selection comes next</b>
                        <small>
                          Add every repository now. You can choose a branch for
                          each repository on the next step and return here at
                          any time.
                        </small>
                      </span>
                    </footer>
                  </section>
                ) : (
                  <div className={styles.field}>
                    <Label>
                      {isIssueSource
                        ? issueProvider === "jira"
                          ? "Jira issue key or URL"
                          : "OpenProject work package"
                        : "Repositories"}
                    </Label>
                    <div className={styles.inputWithIcon}>
                      <Glyph
                        name={
                          isIssueSource
                            ? issueProvider === "jira"
                              ? "jira"
                              : "openProject"
                            : "folder"
                        }
                        size={17}
                      />
                      <Input
                        data-dialog-initial-focus
                        value={sourceValue}
                        onChange={(event) => {
                          sourceImportGenerationRef.current += 1;
                          setSourceValue(event.target.value);
                          setRepositoryBaseNotice(null);
                          if (
                            autoSuggestedRepositoriesRef.current !== null &&
                            issueRepositories ===
                              autoSuggestedRepositoriesRef.current
                          ) {
                            setIssueRepositories("");
                          }
                          autoSuggestedRepositoriesRef.current = null;
                          setJiraImport(null);
                          setOpenProjectImport(null);
                          setSourceImportState("idle");
                          setSourceImportMessage("");
                        }}
                        aria-label={
                          isIssueSource
                            ? issueProvider === "jira"
                              ? "Jira issue key or URL"
                              : "OpenProject work package"
                            : "Repositories"
                        }
                        placeholder={
                          isIssueSource
                            ? issueProvider === "jira"
                              ? "e.g. PLATFORM-42"
                              : "e.g. APP-42, #42, or a work package URL"
                            : "repo-a, repo-b"
                        }
                      />
                      {isIssueSource && (
                        <button
                          className={styles.inlineImportButton}
                          disabled={
                            (issueProvider === "jira"
                              ? !jiraKeyIsValid
                              : !openProjectReferenceIsValid) ||
                            sourceImportState === "loading"
                          }
                          onClick={() =>
                            void (issueProvider === "jira"
                              ? importJira()
                              : importOpenProject())
                          }
                          type="button"
                        >
                          {sourceImportState === "loading"
                            ? "Importing…"
                            : sourceImportState === "ready"
                              ? "Re-import"
                              : "Import"}
                        </button>
                      )}
                    </div>
                    <small>
                      {isIssueSource
                        ? issueProvider === "jira"
                          ? jiraKeyIsValid || !sourceValue.trim()
                            ? "Import through your connected Jira account, or continue with repositories you enter manually."
                            : "Enter a Jira key such as PLATFORM-42."
                          : openProjectReferenceIsValid || !sourceValue.trim()
                            ? openProjectImport
                              ? "Imported from OpenProject. Review the repository scope before continuing."
                              : "Import through WTS before reviewing the repository scope."
                            : "Enter APP-42, #42, or a work package URL."
                        : "These labels are matched against repositories discovered in your configured local folder."}
                    </small>
                    {sourceImportMessage && (
                      <small
                        className={styles.sourceImportMessage}
                        data-error={sourceImportState === "error" || undefined}
                        role={
                          sourceImportState === "error" ? "alert" : "status"
                        }
                      >
                        {sourceImportMessage}
                      </small>
                    )}
                  </div>
                )}
                {isIssueSource && importedIssue && (
                  <section
                    aria-labelledby="imported-issue-title"
                    className={styles.importedIssueCard}
                    data-ui="workspace-create.issue-preview"
                    data-ui-label="Issue preview"
                  >
                    <header>
                      <span>
                        <Glyph name="check" size={15} />
                        <span>
                          <h4 id="imported-issue-title">
                            Imported {importedIssue.reference}
                          </h4>
                          <small>{importedIssue.title}</small>
                        </span>
                      </span>
                      {importedIssue.status && <b>{importedIssue.status}</b>}
                    </header>
                    <div className={styles.importedIssueBody}>
                      {importedIssue.project && (
                        <small>
                          Project <b>{importedIssue.project}</b>
                        </small>
                      )}
                      <p>
                        {importedIssueContent(
                          importedIssue.content,
                          importedIssue.title,
                        )}
                      </p>
                      <section aria-label="Recommended repositories">
                        <h4>Recommended repositories</h4>
                        {importedIssue.recommendations.length > 0 ? (
                          <div role="list">
                            {importedIssue.recommendations.map(
                              (recommendation) => (
                                <div
                                  className={styles.importedRecommendation}
                                  key={recommendation.repositoryId}
                                  role="listitem"
                                >
                                  <span>
                                    <b>{recommendation.label}</b>
                                    <small>{recommendation.reason}</small>
                                  </span>
                                  <b>
                                    {recommendation.confidence >= 96
                                      ? "Strong match"
                                      : recommendation.confidence >= 90
                                        ? "Good match"
                                        : "Possible match"}
                                  </b>
                                </div>
                              ),
                            )}
                          </div>
                        ) : (
                          <p>
                            No trusted repository metadata matched this issue.
                            Choose the scope manually below.
                          </p>
                        )}
                        <small>
                          Based on local repository identity metadata. Review
                          these suggestions before continuing; no LLM was used.
                        </small>
                      </section>
                    </div>
                  </section>
                )}
                {isIssueSource && (
                  <div className={styles.field}>
                    <Label>Repositories for this plan</Label>
                    <div className={styles.inputWithIcon}>
                      <Glyph name="folder" size={17} />
                      <Input
                        value={issueRepositories}
                        onChange={(event) => {
                          repositoryEditRevisionRef.current += 1;
                          autoSuggestedRepositoriesRef.current = null;
                          setIssueRepositories(event.target.value);
                          setIssueRepositoryLocalMatches({});
                          setIssueRepositoryShowAllRemotes({});
                          setRepositoryBaseNotice(null);
                        }}
                        aria-label="Repositories for this plan"
                        placeholder="repo-a, repo-b"
                      />
                    </div>
                    <small>
                      {(
                        issueProvider === "jira"
                          ? jiraImport?.suggestedRepositories.length
                          : openProjectImport?.suggestedRepositories.length
                      )
                        ? "Suggested from the imported issue context. Review before continuing."
                        : "Choose the local repositories that belong in this issue workspace."}
                    </small>
                  </div>
                )}
                {sourceRepositoryReview.length > 0 && (
                  <section
                    aria-labelledby="source-repository-review-title"
                    className={styles.sourceRepositoryReview}
                    data-ui="workspace-create.repository-matches"
                    data-ui-label="Repository matches"
                  >
                    <header>
                      <span>
                        <Glyph name="branch" size={15} />
                        <span>
                          <h4 id="source-repository-review-title">
                            Repository identity
                          </h4>
                          <small>
                            Confirm the name and trusted remote before
                            continuing.
                          </small>
                        </span>
                      </span>
                      <b>
                        {sourceRepositoryReview.length}{" "}
                        {sourceRepositoryReview.length === 1
                          ? "REPOSITORY"
                          : "REPOSITORIES"}
                      </b>
                    </header>
                    <div
                      aria-label="Repository identity list"
                      className={styles.sourceRepositoryList}
                      role="list"
                    >
                      {sourceRepositoryReview.map(
                        ({
                          repository,
                          catalogRepository,
                          upstreamRepository,
                        }) => {
                          const remoteMatchKey =
                            repository.label.toLocaleLowerCase();
                          const allLocalRemoteChoices = (
                            effectiveRepositoryCatalog?.repositories ?? []
                          ).filter((candidate) => Boolean(candidate.originUrl));
                          const scopedLocalRemoteChoices =
                            allLocalRemoteChoices.filter((candidate) =>
                              remoteMatchesRepositoryLabel(
                                repository.label,
                                candidate,
                              ),
                            );
                          const localRemoteChoices =
                            issueRepositoryShowAllRemotes[remoteMatchKey]
                              ? allLocalRemoteChoices
                              : scopedLocalRemoteChoices;
                          const forgeTarget = repositoryForgeTarget(
                            catalogRepository?.originUrl,
                          );
                          const openingKey = repositoryEvidenceKey(
                            repository.repositoryId,
                            repository.label,
                          );
                          const opening =
                            openingRepositoryBaseKey === openingKey;
                          const defaultBase =
                            catalogRepository?.defaultBranch.name ??
                            repository.baseRef;

                          return (
                            <div
                              className={styles.sourceRepositoryRow}
                              data-resolved={
                                catalogRepository ? "true" : "false"
                              }
                              data-upstream={
                                !catalogRepository && upstreamRepository
                                  ? "true"
                                  : undefined
                              }
                              key={openingKey}
                              role="listitem"
                            >
                              <span className={styles.sourceRepositoryIdentity}>
                                <b>{repository.label}</b>
                                <InfoTooltip
                                  content={
                                    catalogRepository?.originUrl ??
                                    upstreamRepository?.remoteUrl ??
                                    "No unique repository match in the local catalog"
                                  }
                                >
                                  <code tabIndex={0}>
                                    {catalogRepository?.originUrl ??
                                      upstreamRepository?.remoteUrl ??
                                      "No unique local repository match"}
                                  </code>
                                </InfoTooltip>
                              </span>
                              <InfoTooltip content={catalogRepository?.displayPath}>
                                <span
                                  className={styles.sourceRepositoryStatus}
                                  data-resolved={
                                    catalogRepository ? "true" : "false"
                                  }
                                  data-upstream={
                                    !catalogRepository && upstreamRepository
                                      ? "true"
                                      : undefined
                                  }
                                  tabIndex={0}
                                >
                                  <Glyph
                                    name={catalogRepository ? "check" : "warning"}
                                    size={11}
                                  />
                                  {catalogRepository
                                    ? `Base ${defaultBase}`
                                    : upstreamRepository
                                      ? "Upstream found"
                                    : "Needs match"}
                                </span>
                              </InfoTooltip>
                              {!catalogRepository && localRemoteChoices.length > 0 ? (
                                <SelectMenu
                                  aria-label={`Select local remote for ${repository.label}`}
                                  className={styles.sourceRepositorySelect}
                                  onChange={(repositoryId) => {
                                    repositoryEditRevisionRef.current += 1;
                                    setIssueRepositoryLocalMatches((current) => {
                                      const key = repository.label.toLocaleLowerCase();
                                      if (!repositoryId) {
                                        const { [key]: _removed, ...remaining } = current;
                                        return remaining;
                                      }
                                      return { ...current, [key]: repositoryId };
                                    });
                                  }}
                                  value=""
                                >
                                  <option value="">Select remote</option>
                                  {localRemoteChoices.map((candidate) => (
                                    <option key={candidate.id} value={candidate.id}>
                                      {candidate.label} — {candidate.originUrl}
                                    </option>
                                  ))}
                                </SelectMenu>
                              ) : !catalogRepository &&
                                allLocalRemoteChoices.length > 0 ? (
                                <Button
                                  aria-label={`Show all local remotes for ${repository.label}`}
                                  className={styles.sourceRepositoryLink}
                                  onPress={() =>
                                    setIssueRepositoryShowAllRemotes((current) => ({
                                      ...current,
                                      [remoteMatchKey]: true,
                                    }))
                                  }
                                >
                                  Show all
                                </Button>
                              ) : !catalogRepository && upstreamRepository ? (
                                <InfoTooltip
                                  content="Clone this upstream into the trusted repository root."
                                >
                                  <Button
                                    aria-label={`Clone ${repository.label} from its Jira upstream`}
                                    className={styles.sourceRepositoryLink}
                                    isDisabled={Boolean(issueRepositoryCloneKey)}
                                    onPress={() =>
                                      void cloneIssueRepository(
                                        upstreamRepository,
                                      )
                                    }
                                  >
                                    {issueRepositoryCloneKey ===
                                    upstreamRepository.label.toLocaleLowerCase()
                                      ? "Cloning…"
                                      : "Clone"}
                                    <Glyph
                                      name={
                                        issueRepositoryCloneKey ===
                                        upstreamRepository.label.toLocaleLowerCase()
                                          ? "refresh"
                                          : "plus"
                                      }
                                      size={11}
                                    />
                                  </Button>
                                </InfoTooltip>
                              ) : catalogRepository && forgeTarget ? (
                                <InfoTooltip
                                  content={
                                    openingRepositoryBaseKey
                                      ? "Opening repository base in browser"
                                      : undefined
                                  }
                                >
                                  <Button
                                    aria-label={`${opening ? "Opening" : "Open"} ${repository.label} default base ${defaultBase} on ${forgeDisplayName(forgeTarget.forge)} (${forgeTarget.host}) in browser`}
                                    className={styles.sourceRepositoryLink}
                                    data-forge={forgeTarget.forge}
                                    isDisabled={Boolean(openingRepositoryBaseKey)}
                                    onPress={() =>
                                      void openRepositoryBase(
                                        {
                                          key: openingKey,
                                          id: repository.label,
                                          repositoryId: catalogRepository.id,
                                          reason:
                                            "Selected in the workspace source",
                                          confidence: 100,
                                          included: true,
                                          base: defaultBase,
                                        },
                                        forgeTarget,
                                      )
                                    }
                                  >
                                    {opening
                                      ? "Opening"
                                      : forgeDisplayName(forgeTarget.forge)}
                                    <Glyph name="external" size={11} />
                                  </Button>
                                </InfoTooltip>
                              ) : (
                                <InfoTooltip
                                  content={
                                    catalogRepository
                                      ? "The origin is visible, but it is not a supported GitHub or GitLab URL."
                                      : "Match this name to a discovered local repository to inspect its remote."
                                  }
                                >
                                  <span
                                    className={styles.sourceRepositoryNoLink}
                                    tabIndex={0}
                                  >
                                    {catalogRepository?.originUrl
                                      ? "Origin only"
                                      : "No remote"}
                                  </span>
                                </InfoTooltip>
                              )}
                            </div>
                          );
                        },
                      )}
                    </div>
                    {issueRepositoryCloneNotice && (
                      <p
                        className={styles.sourceRepositoryNotice}
                        data-error={
                          issueRepositoryCloneNotice.kind === "error" ||
                          undefined
                        }
                        role={
                          issueRepositoryCloneNotice.kind === "error"
                            ? "alert"
                            : "status"
                        }
                      >
                        <Glyph
                          name={
                            issueRepositoryCloneNotice.kind === "error"
                              ? "warning"
                              : "check"
                          }
                          size={12}
                        />
                        {issueRepositoryCloneNotice.message}
                      </p>
                    )}
                    {repositoryBaseNotice && (
                      <p
                        className={styles.sourceRepositoryNotice}
                        data-error={
                          repositoryBaseNotice.kind === "error" || undefined
                        }
                        role={
                          repositoryBaseNotice.kind === "error"
                            ? "alert"
                            : "status"
                        }
                      >
                        <Glyph
                          name={
                            repositoryBaseNotice.kind === "error"
                              ? "warning"
                              : repositoryBaseNotice.kind === "opening"
                                ? "refresh"
                                : "check"
                          }
                          size={12}
                        />
                        {repositoryBaseNotice.message}
                      </p>
                    )}
                  </section>
                )}
                <div className={styles.sourcePreview}>
                  <Glyph name="folder" />
                  <span>
                    <strong>Managed workspace root</strong>
                    <code>{workspaceRootDisplayPath}</code>
                  </span>
                  <span className={styles.localPill}>On this Mac</span>
                </div>
              </form>
            )}

            {step === "evidence" && (
              <div
                className={styles.evidencePanel}
                data-ui="workspace-create.repository-review"
                data-ui-label="Repository review"
              >
                <div className={styles.issueContext}>
                  <span className={styles.jiraTile}>
                    <Glyph
                      name={
                        isIssueSource
                          ? issueProvider === "jira"
                            ? "jira"
                            : "openProject"
                          : isWorkspaceSource
                            ? "copy"
                            : isCodeWorkspaceSource
                              ? "file"
                              : "folder"
                      }
                      size={18}
                    />
                  </span>
                  <span>
                    <b>{draftKey}</b>
                    <strong>{draftTitle}</strong>
                  </span>
                  <span className={styles.contextStatus}>
                    <Glyph name="check" size={13} />{" "}
                    {isRevisionMode
                      ? "Original retained"
                      : isWorkspaceSource
                        ? "Copied setup"
                        : isCodeWorkspaceSource
                          ? "File read · original unchanged"
                          : "Details entered"}
                  </span>
                </div>
                <div className={styles.evidenceHeading}>
                  <span>
                    <strong>Repository requests</strong>
                    <small>
                      {included.length} included · no worktrees created
                    </small>
                  </span>
                  <span className={styles.boundaryBadge}>PLAN PREVIEW</span>
                </div>
                <div className={styles.repoEvidenceList}>
                  {repos.map((repo) => {
                    const catalogRepository = repo.repositoryId
                      ? catalogRepositoriesById.get(repo.repositoryId)
                      : undefined;
                    const forgeTarget = repositoryForgeTarget(
                      catalogRepository?.originUrl,
                    );
                    const forgeName = forgeTarget
                      ? forgeDisplayName(forgeTarget.forge)
                      : "";
                    const opening = openingRepositoryBaseKey === repo.key;
                    const baseActionAvailable = Boolean(
                      repo.repositoryId && forgeTarget,
                    );
                    const baseActionLabel = baseActionAvailable
                      ? `${opening ? "Opening" : "Open"} ${repo.id} base ${repo.base} on ${forgeName} (${forgeTarget!.host}) in browser`
                      : `Cannot open ${repo.id} base in browser: no trusted GitHub or GitLab origin`;
                    const baseActionTooltip = baseActionAvailable
                      ? `Open “${repo.base}” on ${forgeName} · ${forgeTarget!.host}`
                      : repo.repositoryId
                        ? "No supported GitHub or GitLab origin is available."
                        : "This repository has no trusted catalog identity.";
                    const knownBranches =
                      catalogRepository?.availableBranches ?? [];
                    const selectedBaseAvailable = knownBranches.some(
                      (branch) => branch.name === repo.base,
                    );
                    const baseOptions = selectedBaseAvailable
                      ? knownBranches
                      : [
                          {
                            name: repo.base,
                            fullRef: "",
                            commitOid: "",
                            remote: false,
                          },
                          ...knownBranches,
                        ];
                    const refreshing =
                      refreshingRepositoryId === repo.repositoryId;

                    return (
                      <div
                        className={styles.repoEvidenceRow}
                        data-included={repo.included}
                        key={repo.key}
                      >
                        <Checkbox
                          className={styles.checkbox}
                          isSelected={repo.included}
                          onChange={(included) =>
                            updateRepo(repo.key, { included })
                          }
                          aria-label={`Include ${repo.id}${
                            repo.repositoryId ? ` [${repo.repositoryId}]` : ""
                          }`}
                        >
                          <span>
                            <Glyph name="check" size={12} />
                          </span>
                        </Checkbox>
                        <span className={styles.repoEvidenceMeta}>
                          <span className={styles.repoIdentity}>
                            {baseActionAvailable && forgeTarget ? (
                              <InfoTooltip content={baseActionTooltip}>
                                <Button
                                  aria-label={baseActionLabel}
                                  className={styles.repositoryIdentityLink}
                                  data-forge={forgeTarget.forge}
                                  data-opening={opening || undefined}
                                  isDisabled={Boolean(openingRepositoryBaseKey)}
                                  onPress={() =>
                                    void openRepositoryBase(repo, forgeTarget)
                                  }
                                >
                                  <b>{repo.id}</b>
                                  <Glyph name="external" size={11} />
                                </Button>
                              </InfoTooltip>
                            ) : (
                              <b>{repo.id}</b>
                            )}
                            <small>{repo.reason}</small>
                          </span>
                          <span className={styles.confidence} data-level="high">
                            {isRevisionMode
                              ? "Revised from plan"
                              : isWorkspaceSource
                                ? "Copied from plan"
                                : isCodeWorkspaceSource
                                  ? codeWorkspaceAddedRepositoryIds.includes(
                                      repo.repositoryId ?? "",
                                    )
                                    ? clonedCodeWorkspaceRepositoryIds.has(
                                        repo.repositoryId ?? "",
                                      )
                                      ? "Cloned from URL"
                                      : "Added from catalog"
                                    : "Matched locally"
                                  : repo.repositoryId
                                    ? "Matched locally"
                                    : "Selected manually"}
                          </span>
                        </span>
                        <div className={styles.baseReviewControl}>
                          <label className={styles.compactSelect}>
                            <span>Base branch</span>
                            <InfoTooltip content={!repo.included ? "Include repository to choose a base branch" : repo.base}>
                              <SelectMenu
                                value={repo.base}
                                onChange={(value) =>
                                  updateRepo(repo.key, {
                                    base: value,
                                  })
                                }
                                disabled={!repo.included || opening}
                                aria-label={`Base branch for ${repo.id}${
                                  repo.repositoryId
                                    ? ` [${repo.repositoryId}]`
                                    : ""
                                }`}
                              >
                                {baseOptions.map((branch) => (
                                  <option
                                    key={`${branch.fullRef}:${branch.name}`}
                                    value={branch.name}
                                  >
                                    {branch.name}
                                    {!selectedBaseAvailable &&
                                    branch.name === repo.base
                                      ? " · unavailable"
                                      : branch.remote
                                        ? " · origin"
                                        : catalogRepository?.originUrl
                                          ? " · local"
                                          : ""}
                                  </option>
                                ))}
                              </SelectMenu>
                            </InfoTooltip>
                          </label>
                          <div className={styles.baseReviewActions}>
                            <InfoTooltip
                              content={
                                refreshingRepositoryId === repo.repositoryId
                                  ? "Refreshing branches from origin"
                                  : !repo.repositoryId
                                    ? "This repository is not matched to the local catalog"
                                    : !catalogRepository?.originUrl
                                      ? "This repository has no configured origin URL"
                                      : "Fetch current branches from origin"
                              }
                            >
                              <Button
                                aria-label={`Fetch current branches for ${repo.id} from origin`}
                                className={styles.repositoryBaseLink}
                                data-opening={refreshing || undefined}
                                isDisabled={
                                  !repo.repositoryId ||
                                  !catalogRepository?.originUrl ||
                                  Boolean(refreshingRepositoryId)
                                }
                                onPress={() =>
                                  void refreshRepositoryBranches(repo)
                                }
                              >
                                <Glyph name="refresh" size={12} />
                                <b>{refreshing ? "Fetching" : "Refresh"}</b>
                              </Button>
                            </InfoTooltip>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {repositoryBaseNotice && (
                  <p
                    className={styles.repositoryBaseNotice}
                    data-error={
                      repositoryBaseNotice.kind === "error" || undefined
                    }
                    data-opening={
                      repositoryBaseNotice.kind === "opening" || undefined
                    }
                    role={
                      repositoryBaseNotice.kind === "error" ? "alert" : "status"
                    }
                  >
                    <Glyph
                      name={
                        repositoryBaseNotice.kind === "error"
                          ? "warning"
                          : repositoryBaseNotice.kind === "opening"
                            ? "refresh"
                            : "check"
                      }
                      size={13}
                    />
                    <span>{repositoryBaseNotice.message}</span>
                  </p>
                )}
                <p className={styles.evidenceNote}>
                  <Glyph name="warning" size={14} />
                  <span>
                    {isCodeWorkspaceSource
                      ? `Read-only preflight verifies each trusted source, base commit, branch conflict, and target path. Creating the workspace later adds separate managed worktrees under ${workspaceRootDisplayPath}; preflight does not fetch or edit the source checkouts.`
                      : "WTS resolves these labels against the local catalog and verifies base commits, branch conflicts, and safe target paths during the read-only preflight."}
                  </span>
                </p>
              </div>
            )}

            {step === "services" && (
              <div
                className={styles.runtimeAnalysisPanel}
                data-ui="workspace-create.runtime"
                data-ui-label="Runtime setup"
              >
                <header className={styles.runtimeAnalysisHeader}>
                  <span className={styles.runtimeAnalysisIcon}>
                    <Glyph name="command" size={18} />
                  </span>
                  <div>
                    <small>SERVICES</small>
                    <h3>
                      {runtimeAnalysisState === "ready" && runtimeAnalysis?.services.length === 0
                        ? "No services to configure"
                        : "Choose what this workspace should run"}
                    </h3>
                    <p>
                      {runtimeAnalysisState === "ready" && runtimeAnalysis?.services.length === 0
                        ? "WTS found no services at the selected commits. Select Review plan to continue without services."
                        : "Select the services that this task needs. You can also continue without services."}
                    </p>
                  </div>
                  <span
                    className={styles.runtimeAnalysisState}
                    data-state={runtimeAnalysisState}
                  >
                    {runtimeAnalysisState === "loading"
                      ? "Analyzing…"
                      : runtimeAnalysisState === "ready"
                        ? "Analysis ready"
                        : runtimeAnalysisState === "error"
                          ? "Needs attention"
                          : "Not started"}
                  </span>
                </header>

                {runtimeAnalysisState === "loading" && (
                  <div
                    aria-live="polite"
                    className={styles.runtimeAnalysisLoading}
                    role="status"
                  >
                    <span aria-hidden="true">
                      <Glyph name="refresh" size={18} />
                    </span>
                    <div>
                      <b>
                        Analyzing {included.length} selected base{" "}
                        {included.length === 1 ? "commit" : "commits"} ·{" "}
                        {runtimeAnalysisElapsedSeconds}s
                      </b>
                      <small>
                        WTS checks the selected files for service commands and ports.
                      </small>
                    </div>
                  </div>
                )}

                {runtimeAnalysisState === "idle" && (
                  <div className={styles.runtimeAnalysisEmpty}>
                    <span>
                      <Glyph name="refresh" size={17} />
                    </span>
                    <div>
                      <b>Repository selection changed</b>
                      <p>
                        Analyze the selected base commits again before adding
                        services or port preferences to this plan.
                      </p>
                    </div>
                  </div>
                )}

                {runtimeAnalysisState === "error" && (
                  <div className={styles.runtimeAnalysisError} role="alert">
                    <Glyph name="warning" size={17} />
                    <div>
                      <b>Service analysis could not finish</b>
                      <p>{runtimeAnalysisError}</p>
                    </div>
                    <span className={styles.runtimeAnalysisErrorActions}>
                      <button
                        className={styles.secondaryAction}
                        onClick={() => setStep("manifest")}
                        type="button"
                      >
                        Continue without services
                      </button>
                      <button
                        className={styles.primaryButton}
                        onClick={() => void analyzeRuntime(true)}
                        type="button"
                      >
                        <Glyph name="refresh" size={13} /> Retry
                      </button>
                    </span>
                  </div>
                )}

                {runtimeAnalysisState === "ready" && runtimeAnalysis && (
                  <>
                    {runtimeAnalysis.services.length > 0 && <div
                      className={styles.runtimeAnalysisSummary}
                      role="group"
                      aria-label="Service selection summary"
                    >
                      <span>
                        <b>{runtimeAnalysis.services.length}</b>
                        <small>
                          {runtimeAnalysis.services.length === 1
                            ? "service found"
                            : "services found"}
                        </small>
                      </span>
                      <span>
                        <b>{selectedRuntimeServices.length}</b>
                        <small>selected</small>
                      </span>
                      <span>
                        <b>
                          {selectedRuntimeServices.reduce(
                            (total, service) => total + service.ports.length,
                            0,
                          )}
                        </b>
                        <small>preferred ports</small>
                      </span>
                    </div>}

                    {runtimeAnalysisNotices.length > 0 && (
                      <div
                        aria-label="Runtime analysis warnings"
                        className={styles.runtimeAnalysisWarnings}
                      >
                        {runtimeAnalysisNotices.map((warning, index) => (
                          <p key={`${warning}-${index}`}>
                            <Glyph name="warning" size={13} />
                            <span>{warning}</span>
                          </p>
                        ))}
                      </div>
                    )}

                    {runtimeAnalysis.services.length > 0 && (
                      <div
                        aria-label="Detected services"
                        className={styles.runtimeServiceList}
                        role="list"
                      >
                        {runtimeAnalysis.services.map((service) => {
                          const draft = runtimeServiceDrafts.get(
                            service.candidateId,
                          );
                          if (!draft) return null;
                          const evidence = [
                            ...service.evidence,
                            ...service.ports.flatMap((port) => port.evidence),
                          ];
                          return (
                            <article
                              className={styles.runtimeServiceCard}
                              data-included={draft.included}
                              key={service.candidateId}
                              role="listitem"
                            >
                              <header>
                                <Checkbox
                                  aria-label={`Include ${service.displayName} in runtime plan`}
                                  className={styles.checkbox}
                                  isSelected={draft.included}
                                  onChange={(included) =>
                                    setRuntimeServiceIncluded(
                                      service.candidateId,
                                      included,
                                    )
                                  }
                                >
                                  <span>
                                    <Glyph name="check" size={12} />
                                  </span>
                                </Checkbox>
                                <span className={styles.runtimeServiceIdentity}>
                                  <b>{service.displayName}</b>
                                  <small>
                                    {service.repositoryLabel} ·{" "}
                                    <code>
                                      {service.commitOid.slice(0, 12)}
                                    </code>
                                  </small>
                                </span>
                                <span className={styles.runtimeInclusionLabel}>
                                  {draft.included
                                    ? "Included in this plan"
                                    : "Not included"}
                                </span>
                                <span
                                  className={styles.runtimeConfidence}
                                  data-confidence={service.confidence}
                                >
                                  {runtimeConfidenceLabels[service.confidence]}
                                </span>
                              </header>

                              <div className={styles.runtimeServiceFacts}>
                                <span>
                                  <small>RUNS</small>
                                  <InfoTooltip content={service.command.join(" ")}>
                                    <code tabIndex={0}>
                                      {service.command.join(" ")}
                                    </code>
                                  </InfoTooltip>
                                </span>
                                <span>
                                  <small>FROM</small>
                                  <InfoTooltip content={service.workingDirectory}>
                                    <code tabIndex={0}>
                                      {service.workingDirectory}
                                    </code>
                                  </InfoTooltip>
                                </span>
                                <span>
                                  <small>START ORDER</small>
                                  <code>
                                    {service.dependencies.length
                                      ? `After ${service.dependencies.join(", ")}`
                                      : "Can start immediately"}
                                  </code>
                                </span>
                              </div>

                              {service.ports.length > 0 && (
                                <fieldset
                                  className={styles.runtimePortSet}
                                  disabled={!draft.included}
                                >
                                  <legend>Ports this service expects</legend>
                                  {service.ports.map((port) => {
                                    const portDraft = draft.ports.find(
                                      (item) => item.portId === port.portId,
                                    );
                                    if (!portDraft) return null;
                                    const invalid =
                                      validRuntimePort(
                                        portDraft.preferredPort,
                                      ) === null;
                                    const errorId = runtimePortErrorId(
                                      service.candidateId,
                                      port.portId,
                                    );
                                    return (
                                      <div
                                        className={styles.runtimePortRow}
                                        key={port.portId}
                                      >
                                        <span
                                          className={styles.runtimePortIdentity}
                                        >
                                          <b>{port.portId}</b>
                                          <small>
                                            {port.environment ??
                                              "WTS_PORT / PORT"}
                                          </small>
                                        </span>
                                        <label>
                                          <span
                                            className={
                                              styles.runtimePortHeader
                                            }
                                          >
                                            <span>Preferred port</span>
                                            <button
                                              aria-label={`Auto-allocate free port for ${service.displayName} ${port.portId}`}
                                              className={
                                                styles.runtimePortAutoButton
                                              }
                                              onClick={() =>
                                                autoAllocateRuntimePort(
                                                  service.candidateId,
                                                  port.portId,
                                                )
                                              }
                                              type="button"
                                            >
                                              Auto
                                            </button>
                                          </span>
                                          <input
                                            aria-invalid={invalid || undefined}
                                            aria-describedby={
                                              invalid && draft.included
                                                ? errorId
                                                : undefined
                                            }
                                            aria-label={`Preferred port for ${service.displayName} ${port.portId}`}
                                            inputMode="numeric"
                                            max={65_535}
                                            min={1_024}
                                            onChange={(event) =>
                                              updateRuntimePort(
                                                service.candidateId,
                                                port.portId,
                                                {
                                                  preferredPort:
                                                    event.currentTarget.value,
                                                },
                                              )
                                            }
                                            type="number"
                                            value={portDraft.preferredPort}
                                          />
                                        </label>
                                        <label>
                                          <span>Allocation</span>
                                          <SelectMenu
                                            aria-label={`Port allocation policy for ${service.displayName} ${port.portId}`}
                                            onChange={(value) =>
                                              updateRuntimePort(
                                                service.candidateId,
                                                port.portId,
                                                {
                                                  policy: value as RuntimePortPolicy,
                                                },
                                              )
                                            }
                                            value={portDraft.policy}
                                          >
                                            <option value="prefer">
                                              Prefer; move if occupied
                                            </option>
                                            <option value="fixed">
                                              Fixed; block if occupied
                                            </option>
                                          </SelectMenu>
                                        </label>
                                        <span
                                          className={
                                            styles.runtimePortConfidence
                                          }
                                          data-confidence={port.confidence}
                                        >
                                          {
                                            runtimeConfidenceLabels[
                                              port.confidence
                                            ]
                                          }
                                        </span>
                                        {invalid && draft.included && (
                                          <small
                                            className={styles.runtimePortError}
                                            id={errorId}
                                            role="alert"
                                          >
                                            Enter a port from 1024 to 65535.
                                          </small>
                                        )}
                                      </div>
                                    );
                                  })}
                                </fieldset>
                              )}

                              <details className={styles.runtimeEvidence}>
                                <summary>
                                  <Glyph name="file" size={13} />
                                  Evidence · {evidence.length}{" "}
                                  {evidence.length === 1
                                    ? "finding"
                                    : "findings"}
                                </summary>
                                {evidence.length ? (
                                  <ul>
                                    {evidence.map((item, index) => (
                                      <li
                                        key={`${item.repositoryId}-${item.path}-${item.detector}-${index}`}
                                      >
                                        <code>{item.path}</code>
                                        <span>{item.detail}</span>
                                        <small>
                                          {item.detector} ·{" "}
                                          {item.commitOid.slice(0, 12)}
                                        </small>
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p>
                                    No additional file evidence was returned.
                                  </p>
                                )}
                              </details>
                            </article>
                          );
                        })}
                      </div>
                    )}

                    <details className={styles.runtimeEvidence}>
                      <summary>Analysis details</summary>
                      <p>Graph status: {runtimeAnalysis.graph.status}</p>
                      <p>{runtimeAnalysis.graph.detail}</p>
                    </details>

                    {runtimeAnalysis.services.length > 0 && <p className={styles.runtimeAssignmentNote}>
                      <Glyph name="check" size={14} />
                      <span>
                        This plan stores preferred ports. WTS assigns the actual
                        local ports when you start the runtime.
                      </span>
                    </p>}
                  </>
                )}
              </div>
            )}

            {step === "manifest" && (
              <div
                className={styles.manifestPanel}
                data-ui="workspace-create.plan-review"
                data-ui-label="Workspace plan review"
              >
                {saveWarning && (
                  <p className={styles.evidenceNote} role="alert">
                    <Glyph name="warning" size={14} />
                    <span>{saveWarning}</span>
                  </p>
                )}
                {isRevisionMode && templateWorkspace && (
                  <div className={styles.revisionContinuity}>
                    <span>
                      <Glyph name="copy" size={16} />
                    </span>
                    <div>
                      <b>Original retained</b>
                      <p>
                        {templateWorkspace.key} remains unchanged. Saving adds a
                        separate durable plan titled “{draftTitle}” with its own
                        workspace path.
                      </p>
                    </div>
                  </div>
                )}
                <div className={styles.manifestSummary}>
                  <span>
                    <small>
                      {isRevisionMode
                        ? "ORIGINAL"
                        : isIssueSource
                          ? issueProvider === "jira"
                            ? "ISSUE"
                            : "WORK PACKAGE"
                          : isWorkspaceSource
                            ? "TEMPLATE"
                            : isCodeWorkspaceSource
                              ? "VS CODE FILE"
                              : "DIRECT"}
                    </small>
                    <b>
                      {isCodeWorkspaceSource
                        ? codeWorkspaceImport?.fileName
                        : draftKey}
                    </b>
                  </span>
                  <span>
                    <small>REPOSITORIES</small>
                    <b>{included.length}</b>
                  </span>
                  <span>
                    <small>SERVICES</small>
                    <b>{selectedRuntimeServices.length}</b>
                  </span>
                  <span>
                    <small>OPEN WITH</small>
                    <b>{provider}</b>
                  </span>
                </div>
                <div className={styles.reviewDecisionIntro}>
                  <span>
                    <small>FINAL REVIEW</small>
                    <h3>Does this plan match the task?</h3>
                    <p>
                      Check repository branches and runnable services before
                      saving. You can edit either choice without starting over.
                    </p>
                  </span>
                  <span className={styles.reviewDecisionState}>
                    <Glyph name="check" size={14} />
                    No Git or processes yet
                  </span>
                </div>
                <div className={styles.manifestGrid}>
                  <section className={styles.planningHomeSection}>
                    <div className={styles.planningHomeIntro}>
                      <span className={styles.planningHomeIcon}>
                        <Glyph name="file" size={17} />
                      </span>
                      <div>
                        <h3>Planning home</h3>
                        <p>
                          Give agents a durable place for plans, findings, and
                          handoffs.
                        </p>
                      </div>
                    </div>
                    <RadioGroup
                      aria-label="Planning home"
                      className={styles.planningChoices}
                      value={planningEnabled ? "starter" : "existing"}
                      onChange={(value) =>
                        setPlanningEnabled(value === "starter")
                      }
                    >
                      <Radio value="existing" className={styles.planningChoice}>
                        <span className={styles.radioIndicator} />
                        <span>
                          <strong>Use repositories as-is</strong>
                          <small>
                            Planning files already exist, or are not needed.
                          </small>
                        </span>
                      </Radio>
                      <Radio value="starter" className={styles.planningChoice}>
                        <span className={styles.radioIndicator} />
                        <span>
                          <strong>Create a starter kit</strong>
                          <small>
                            Add editable planning files when provisioning.
                          </small>
                        </span>
                      </Radio>
                    </RadioGroup>
                    {planningEnabled && (
                      <div className={styles.planningSettings}>
                        <label>
                          <span>Folder</span>
                          <SelectMenu
                            aria-label="Planning folder"
                            value={planningFolder}
                            onChange={(value) =>
                              setPlanningFolder(
                                value as WorkspacePlanningSelection["folder"],
                              )
                            }
                          >
                            <option value="plansAndKanban">
                              plans-and-kanban
                            </option>
                            <option value="plans">plans</option>
                          </SelectMenu>
                        </label>
                        <label>
                          <span>Starter</span>
                          <SelectMenu
                            aria-label="Planning starter"
                            value={planningFormat}
                            onChange={(value) =>
                              setPlanningFormat(
                                value as WorkspacePlanningSelection["format"],
                              )
                            }
                          >
                            <option value="kanban">
                              Plan, findings &amp; Kanban
                            </option>
                            <option value="notes">Plan &amp; findings</option>
                          </SelectMenu>
                        </label>
                        <p>
                          WTS creates these files once. They remain editable
                          user content and are never silently removed.
                        </p>
                      </div>
                    )}
                  </section>
                  <section className={styles.planDecisionSection}>
                    <header className={styles.planDecisionHeader}>
                      <span>
                        <h3>Repositories and branches</h3>
                        <small>
                          {included.length} selected for separate worktrees
                        </small>
                      </span>
                      <button
                        className={styles.planEditButton}
                        onClick={() => setStep("evidence")}
                        type="button"
                      >
                        Edit repositories
                      </button>
                    </header>
                    <dl className={styles.manifestList}>
                      <div>
                        <dt>Root</dt>
                        <dd>
                          <code>{workspaceRootDisplayPath}</code>
                          <small>WTS assigns the final folder on save</small>
                        </dd>
                      </div>
                      <div>
                        <dt>Base refs</dt>
                        <dd>
                          {included.map((repo) => (
                            <code key={repo.key}>
                              {repo.id} ← {repo.base}
                            </code>
                          ))}
                        </dd>
                      </div>
                      <div>
                        <dt>Worktrees</dt>
                        <dd>
                          <code>Created only after saved-plan review</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Planning</dt>
                        <dd>
                          <code>
                            {planningEnabled
                              ? `${planningFolder === "plans" ? "plans" : "plans-and-kanban"}/ · ${
                                  planningFormat === "kanban"
                                    ? "Kanban kit"
                                    : "notes kit"
                                }`
                              : "Use repository planning files as-is"}
                          </code>
                          <small>
                            {planningEnabled
                              ? "Included as a folder in the generated VS Code workspace"
                              : "No extra planning folder will be created"}
                          </small>
                        </dd>
                      </div>
                      <div>
                        <dt>Graph scope</dt>
                        <dd>
                          <code>Built on demand after workspace creation</code>
                        </dd>
                      </div>
                    </dl>
                  </section>
                  <section className={styles.planDecisionSection}>
                    <header className={styles.planDecisionHeader}>
                      <span>
                        <h3>Runtime services</h3>
                        <small>
                          {selectedRuntimeServices.length
                            ? `${selectedRuntimeServices.length} selected`
                            : "No services selected"}
                        </small>
                      </span>
                      <button
                        className={styles.planEditButton}
                        onClick={() => setStep("services")}
                        type="button"
                      >
                        Edit services
                      </button>
                    </header>
                    <div className={styles.planServiceReview}>
                      {selectedRuntimeServices.length ? (
                        selectedRuntimeServices.map((service) => {
                          const draft = runtimeServiceDrafts.get(
                            service.candidateId,
                          );
                          const ports =
                            draft?.ports
                              .map(
                                (port) =>
                                  `${port.portId}: ${port.preferredPort} · ${port.policy}`,
                              )
                              .join(", ") || "No ports";
                          return (
                            <span key={service.candidateId}>
                              <b>{service.displayName}</b>
                              <code>{ports}</code>
                            </span>
                          );
                        })
                      ) : (
                        <p>
                          This workspace will not start any runtime services.
                        </p>
                      )}
                      <small>
                        Actual loopback ports are assigned only when you
                        explicitly start the runtime.
                      </small>
                    </div>
                  </section>
                  <section>
                    <h3>Open with</h3>
                    <div className={styles.providerCompactGrid}>
                      {providers.map((item) => (
                        <Button
                          key={item.id}
                          className={styles.providerCompact}
                          data-selected={provider === item.id}
                          onPress={() => setProvider(item.id)}
                          aria-pressed={provider === item.id}
                        >
                          <span>{providerMarks[item.id]}</span>
                          <b>{item.id}</b>
                          {provider === item.id && (
                            <Glyph name="check" size={14} />
                          )}
                        </Button>
                      ))}
                    </div>
                    <div className={styles.safetyNote}>
                      <Glyph name="check" />
                      <span>
                        <b>
                          {isRevisionMode
                            ? "This action saves a separate revised plan."
                            : isCodeWorkspaceSource
                              ? "This action only saves a local plan from the matched folders."
                              : "This action only saves a local plan."}
                        </b>
                        {isRevisionMode
                          ? ` The original ${templateWorkspace?.key ?? "workspace"}, its worktrees, branches, changes, and sessions remain untouched.`
                          : isCodeWorkspaceSource
                            ? " The source file and trusted checkouts—including their settings, branches, changes, and existing worktrees—remain untouched. Saving performs no Git operation; provisioning later creates separate managed worktrees."
                            : " No repository, worktree, port, process, editor, graph, or agent side effect is started by this step."}
                      </span>
                    </div>
                  </section>
                </div>
              </div>
            )}

            {step === "saving" && (
              <div
                className={styles.provisionPanel}
                data-ui="workspace-create.saving"
                data-ui-label="Workspace save progress"
                role={saveError ? "alert" : "status"}
                aria-live={saveError ? "assertive" : "polite"}
                aria-busy={!saveError}
              >
                <div
                  className={styles.savingGlyph}
                  data-error={Boolean(saveError)}
                  aria-hidden="true"
                >
                  <Glyph name={saveError ? "warning" : "refresh"} size={24} />
                </div>
                <div className={styles.provisionDetails}>
                  <h3>
                    {saveError ? "Save needs attention" : `Saving ${draftKey}`}
                  </h3>
                  <p>
                    {saveError
                      ? saveError
                      : "Writing the workspace and idempotency record in one local transaction…"}
                  </p>
                  {saveError && (
                    <small>
                      Retrying uses the same request identity so WTS can safely
                      reconcile an uncertain result.
                    </small>
                  )}
                  {!saveError && (
                    <ul>
                      <li data-complete>
                        <span>
                          <Glyph name="check" size={13} />
                        </span>
                        Validate the structured plan
                      </li>
                      <li data-active>
                        <span>2</span>
                        Commit to the local registry
                      </li>
                      <li>
                        <span>3</span>
                        Return the saved workspace identity
                      </li>
                    </ul>
                  )}
                </div>
              </div>
            )}

            {step === "saved" && savedWorkspace && (
              <div
                className={styles.readyPanel}
                data-ui="workspace-create.saved"
                data-ui-label="Saved workspace"
                role="status"
                aria-live="polite"
              >
                <span className={styles.readyGlyph}>
                  <Glyph name="check" size={28} />
                </span>
                <h3>
                  {isRevisionMode
                    ? `Revised ${draftKey} plan is saved`
                    : `${draftKey} is saved`}
                </h3>
                <p>
                  {isRevisionMode
                    ? `Original retained: ${templateWorkspace?.key ?? "the source workspace"} remains unchanged. This separate plan is ready for Git preflight at its new reserved path.`
                    : "The durable workspace plan is ready for Git preflight in its workbench. No worktrees or processes were created."}
                </p>
                <div className={styles.readyFacts}>
                  <span>
                    <Glyph name="folder" />
                    <b>{savedWorkspace.workspaceDisplayPath}</b>
                    <small>Reserved display path</small>
                  </span>
                  <span>
                    <span className={styles.providerMark}>
                      {providerMarks[provider]}
                    </span>
                    <b>{provider}</b>
                    <small>Default provider</small>
                  </span>
                </div>
              </div>
            )}
            {step !== "source" && codeWorkspaceCloneMessage && (
              <RepositoryCloneTask
                floating
                message={codeWorkspaceCloneMessage}
                state={codeWorkspaceCloneState}
              />
            )}
          </div>

          <div
            className={styles.dialogFooter}
            data-ui="workspace-create.actions"
            data-ui-label="Workspace setup actions"
          >
            <span
              className={styles.dialogFootnote}
              data-attention={
                step === "source" && Boolean(sourceBlockingMessage)
              }
            >
              <Glyph
                name={
                  step === "source" && sourceBlockingMessage
                    ? "warning"
                    : isRevisionMode
                      ? "copy"
                      : isCodeWorkspaceSource
                        ? "file"
                        : "folder"
                }
                size={14}
              />{" "}
              {step === "source" && sourceBlockingMessage
                ? sourceBlockingMessage
                : isRevisionMode
                  ? `${templateWorkspace?.key ?? "Original workspace"} stays unchanged`
                  : isCodeWorkspaceSource
                    ? `${codeWorkspaceImport?.fileName ?? "Source file"} stays unchanged`
                    : `Workspace roots stay under ${workspaceRootDisplayPath}`}
            </span>
            <span className={styles.dialogActions}>
              {step === "evidence" && (
                <Button
                  className={styles.secondaryButton}
                  onPress={() => setStep("source")}
                >
                  Back
                </Button>
              )}
              {step === "services" && (
                <Button
                  className={styles.secondaryButton}
                  onPress={() => setStep("evidence")}
                >
                  Back
                </Button>
              )}
              {step === "manifest" && (
                <Button
                  className={styles.secondaryButton}
                  onPress={() => setStep("services")}
                >
                  Back
                </Button>
              )}
              {step === "source" && (
                <Button
                  className={styles.primaryButton}
                  onPress={analyzeSource}
                  isDisabled={!canAnalyze}
                >
                  {isWorkspaceSource
                    ? isRevisionMode
                      ? "Review revised setup"
                      : "Review copied setup"
                    : isCodeWorkspaceSource
                      ? "Review imported repositories"
                      : "Review repositories"}{" "}
                  <Glyph name="arrow" />
                </Button>
              )}
              {step === "evidence" && (
                <Button
                  className={styles.primaryButton}
                  onPress={() => {
                    reviewedSourceRepositoriesFingerprintRef.current =
                      sourceRepositoriesFingerprint;
                    setStep("services");
                    void analyzeRuntime();
                  }}
                  isDisabled={included.length === 0}
                >
                  Analyze services <Glyph name="arrow" />
                </Button>
              )}
              {step === "services" && (
                <Button
                  className={styles.primaryButton}
                  onPress={() => {
                    if (runtimeAnalysisState === "idle") {
                      void analyzeRuntime();
                      return;
                    }
                    setStep("manifest");
                  }}
                  isDisabled={
                    runtimeAnalysisState === "loading" ||
                    runtimeAnalysisState === "error" ||
                    (runtimeAnalysisState === "ready" &&
                      (runtimeAnalysisFingerprint !==
                        currentRuntimeFingerprint ||
                        runtimePortErrors.length > 0))
                  }
                >
                  {runtimeAnalysisState === "loading"
                    ? "Analyzing services…"
                    : runtimeAnalysisState === "idle"
                      ? "Analyze services"
                      : isRevisionMode
                        ? "Review revised plan"
                        : "Review plan"}{" "}
                  <Glyph name="arrow" />
                </Button>
              )}
              {step === "manifest" && (
                <Button
                  className={styles.primaryButton}
                  isDisabled={!canSavePlan}
                  onPress={() => void savePlan()}
                >
                  {isRevisionMode ? "Save revised plan" : "Save workspace plan"}{" "}
                  <Glyph name="arrow" />
                </Button>
              )}
              {step === "saving" && saveError && (
                <>
                  <Button
                    className={styles.secondaryButton}
                    onPress={() => setStep("manifest")}
                  >
                    Back
                  </Button>
                  <Button
                    className={styles.primaryButton}
                    onPress={() => void savePlan()}
                  >
                    Retry save <Glyph name="refresh" />
                  </Button>
                </>
              )}
              {step === "saving" && !saveError && (
                <Button
                  className={styles.secondaryButton}
                  onPress={stopWaitingForSave}
                >
                  <Glyph name="stop" /> Stop waiting
                </Button>
              )}
              {step === "saved" && savedWorkspace && (
                <Button
                  className={styles.primaryButton}
                  onPress={() => {
                    handleDialogOpenChange(false);
                    onComplete(savedWorkspace);
                  }}
                >
                  {isRevisionMode ? "Open revised plan" : "Open saved plan"}{" "}
                  <Glyph name="arrow" />
                </Button>
              )}
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
