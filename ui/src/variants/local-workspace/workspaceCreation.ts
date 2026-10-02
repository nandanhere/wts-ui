import { type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  type CodeWorkspaceDiagnosticMatchReason,
  type CodeWorkspaceDiagnosticResolutionBasis,
  type CodeWorkspaceFileImportResult,
  type CodeWorkspaceFolderDiagnostic,
  type CloneRepositoryRequest,
  type CloneRepositoryResult,
  type GitlabReview,
  type OpenProjectWorkPackageImport,
  type RepositoryCatalog,
  type RepositorySummary,
  type RuntimeAnalysisConfidence,
  type RuntimeAnalysisRequest,
  type RuntimeAnalysisResult,
  type RuntimePortPolicy,
  type WorkspacePlanningSelection,
  WorkspaceClientError,
  type WorkspaceIntent,
  type WorkspaceProvider,
} from "../../lib/wtsClient";
import { type Provider, type Workspace } from "./workspaceTypes";

export interface RepositoryCloneHandle {
  id: string;
  promise: Promise<CloneRepositoryResult>;
}

export interface DeferredWorkspaceCreation {
  id: string;
  title: string;
  repositoryLabel: string;
  remoteUrl: string;
  branch?: string;
  shallow: boolean;
  status: "cloning" | "ready" | "error";
  message: string;
  result?: CloneRepositoryResult;
  draft: RepositoryWorkspaceDraft;
}

interface RepositoryWorkspaceDraft {
  addedRepositoryIds: string[];
  clonedRepositories: RepositorySummary[];
  clonedRepositoryBaseRefs: Record<string, string>;
  refreshedRepositories: RepositorySummary[];
  repositoryRootDisplayPath: string;
  repositories: RepoEvidence[];
  provider: Provider;
  planningEnabled: boolean;
  planningFolder: WorkspacePlanningSelection["folder"];
  planningFormat: WorkspacePlanningSelection["format"];
  runtimeAnalysis: RuntimeAnalysisResult | null;
  runtimeAnalysisState: "idle" | "loading" | "ready" | "error";
  runtimeAnalysisError: string;
  runtimeAnalysisFingerprint: string;
  runtimeServiceDrafts: Map<string, RuntimeServiceDraft>;
  runtimeDraftSnapshot: RuntimeDraftSnapshot | null;
  reviewedSourceRepositoriesFingerprint: string;
}

export interface RepoEvidence {
  key: string;
  id: string;
  repositoryId?: string;
  reason: string;
  confidence: number;
  included: boolean;
  base: string;
}

export interface RuntimePortDraft {
  portId: string;
  preferredPort: string;
  policy: RuntimePortPolicy;
}

export interface RuntimeServiceDraft {
  included: boolean;
  ports: RuntimePortDraft[];
}

export interface RuntimeDraftSnapshot {
  analysis: RuntimeAnalysisResult;
  drafts: Map<string, RuntimeServiceDraft>;
}

export function readTextFile(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("The selected file could not be read as text."));
      }
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("The selected file could not be read."));
    });
    reader.readAsText(file);
  });
}

export const codeWorkspaceDiagnosticReasonLabels: Record<
  CodeWorkspaceDiagnosticMatchReason,
  string
> = {
  matchedExactPath: "Matched the exact absolute repository path",
  matchedRelativePathSuffix:
    "Matched the relative folder path to a discovered checkout",
  matchedPathBasename:
    "Matched the final folder name to a discovered checkout folder or repository label",
  matchedExplicitName:
    "Matched the VS Code folder name to a discovered repository label",
  noCatalogMatch:
    "No discovered checkout folder or repository label matched this folder",
  ambiguousExactPath:
    "Multiple discovered repositories share this absolute path",
  ambiguousRelativePathSuffix:
    "Multiple discovered checkouts matched the relative folder path",
  ambiguousPathBasename:
    "Multiple discovered checkouts or repository labels matched the final folder name",
  ambiguousExplicitName:
    "Multiple discovered repository labels matched the VS Code folder name",
  unsupportedFolder: "This folder entry cannot be matched safely",
};

export const codeWorkspaceDiagnosticBasisLabels: Record<
  CodeWorkspaceDiagnosticResolutionBasis,
  string
> = {
  absolutePath: "Absolute path",
  relativePathSuffix: "Relative path suffix",
  pathBasename: "Final folder name",
  explicitName: "VS Code name",
};

const interactiveDevLogging =
  import.meta.env.DEV && import.meta.env.MODE !== "test";

export const unsupportedUriDiagnosticValue = "<unsupported-uri>";

export const unsupportedDiagnosticValue = "<unsupported-value>";

export const missingDiagnosticPathValue = "<missing-path>";

const uriSchemePattern = /^[a-z][a-z0-9+.-]*:/i;

const windowsAbsolutePathPattern = /^[a-z]:[\\/]/i;

function isUriShapedDiagnosticValue(value: unknown) {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  return (
    !windowsAbsolutePathPattern.test(candidate) &&
    uriSchemePattern.test(candidate)
  );
}

function sanitizedFolderDiagnosticName(name: unknown, rawPathIsUri: boolean) {
  if (rawPathIsUri || isUriShapedDiagnosticValue(name)) {
    return unsupportedUriDiagnosticValue;
  }
  return typeof name === "string" && name.trim()
    ? name
    : unsupportedDiagnosticValue;
}

function sanitizedFolderDiagnosticPath(rawPath: unknown) {
  if (typeof rawPath !== "string") return unsupportedDiagnosticValue;
  if (!rawPath.trim()) return missingDiagnosticPathValue;
  return isUriShapedDiagnosticValue(rawPath)
    ? unsupportedUriDiagnosticValue
    : rawPath;
}

function sanitizedMatchAttemptValue(
  rawPath: unknown,
  folderName: unknown,
  value: unknown,
) {
  return isUriShapedDiagnosticValue(rawPath) ||
    isUriShapedDiagnosticValue(folderName) ||
    isUriShapedDiagnosticValue(value)
    ? unsupportedUriDiagnosticValue
    : typeof value === "string"
      ? value
      : unsupportedDiagnosticValue;
}

export function codeWorkspaceFolderStatusLabel(
  status: CodeWorkspaceFolderDiagnostic["status"],
) {
  switch (status) {
    case "matched":
      return "Matched";
    case "missing":
      return "No match";
    case "ambiguous":
      return "Ambiguous";
    case "unsupported":
      return "Unsupported";
  }
}

export function codeWorkspaceDiagnosticsPayload(
  imported: CodeWorkspaceFileImportResult,
) {
  const folderDiagnostics = new Map<number, CodeWorkspaceFolderDiagnostic>(
    imported.diagnostics?.folders.map((folder) => [folder.folderIndex, folder]),
  );
  return {
    schemaVersion: 1,
    event: "codeWorkspaceImport",
    fileName: imported.fileName,
    importId: imported.importId,
    result: {
      folderCount: imported.folders.length,
      matchedRepositoryCount: imported.repositories.length,
      warningCodes: imported.warnings.map((warning) => warning.code),
    },
    catalog: imported.diagnostics
      ? {
          repositoryRootDisplayPath:
            imported.diagnostics.catalog.repositoryRootDisplayPath,
          repositoryCount: imported.diagnostics.catalog.repositoryCount,
          skippedEntries: imported.diagnostics.catalog.skippedEntries,
          repositories: imported.diagnostics.catalog.repositories.map(
            (repository) => ({
              label: repository.label,
              displayPath: repository.displayPath,
            }),
          ),
          repositoriesTruncated:
            imported.diagnostics.catalog.repositoriesTruncated,
        }
      : null,
    folders: imported.folders.map((folder, folderIndex) => {
      const diagnostic = folderDiagnostics.get(folderIndex);
      const rawPathIsUri = isUriShapedDiagnosticValue(folder.rawPath);
      const folderNameIsUri = isUriShapedDiagnosticValue(folder.name);
      return {
        folderIndex,
        name: sanitizedFolderDiagnosticName(folder.name, rawPathIsUri),
        path: sanitizedFolderDiagnosticPath(folder.rawPath),
        status: folder.status,
        repository:
          !rawPathIsUri &&
          !folderNameIsUri &&
          folder.repositoryLabel &&
          folder.repositoryDisplayPath
            ? {
                ...(folder.repositoryId === undefined
                  ? {}
                  : { repositoryId: folder.repositoryId }),
                label: folder.repositoryLabel,
                displayPath: folder.repositoryDisplayPath,
                baseRef: folder.baseRef,
              }
            : null,
        resolution: diagnostic
          ? {
              reason: diagnostic.reason,
              resolutionBasis: diagnostic.resolutionBasis,
              attempts: diagnostic.attempts.map((attempt) => ({
                basis: attempt.basis,
                value: sanitizedMatchAttemptValue(
                  folder.rawPath,
                  folder.name,
                  attempt.value,
                ),
                candidateCount: attempt.candidateCount,
              })),
              candidates:
                rawPathIsUri || folderNameIsUri
                  ? []
                  : diagnostic.candidates.map((candidate) => ({
                      label: candidate.label,
                      displayPath: candidate.displayPath,
                    })),
              candidatesTruncated: diagnostic.candidatesTruncated,
              duplicateRepository: diagnostic.duplicateRepository,
            }
          : null,
      };
    }),
  };
}

export function logCodeWorkspaceImportCompletion(
  imported: CodeWorkspaceFileImportResult,
) {
  if (!imported.diagnostics && !interactiveDevLogging) return;
  console.debug(
    "[WTS] VS Code workspace import completed",
    codeWorkspaceDiagnosticsPayload(imported),
  );
}

export function logCodeWorkspaceImportFailure(fileName: string, error: unknown) {
  if (!interactiveDevLogging) return;
  const clientError = error instanceof WorkspaceClientError ? error : undefined;
  console.debug("[WTS] VS Code workspace import failed", {
    schemaVersion: 1,
    event: "codeWorkspaceImportFailed",
    fileName,
    error: {
      name: error instanceof Error ? error.name : "UnknownError",
      message:
        error instanceof Error
          ? error.message
          : "The VS Code workspace file could not be imported.",
      code: clientError?.code,
      status: clientError?.status,
      retryable: clientError?.retryable,
    },
  });
}

export function issueKeyFrom(value: string) {
  const match = value.toUpperCase().match(/[A-Z][A-Z0-9]+-\d+/);
  return (
    match?.[0] ??
    value
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, "")
  );
}

export function openProjectReferenceFrom(value: string) {
  const reference = value.trim();
  const direct = reference.match(/^#?([1-9][0-9]{0,14})$/);
  const fromUrl = reference.match(
    /(?:^|\/)work_packages\/([1-9][0-9]{0,14})(?:[/?#]|$)/i,
  );
  const numericReference = direct?.[1] ?? fromUrl?.[1];
  if (numericReference) return numericReference;

  const semanticReference = reference.toUpperCase();
  return /^[A-Z0-9][A-Z0-9._-]{0,127}$/.test(semanticReference) &&
    !/^0+$/.test(semanticReference)
    ? semanticReference
    : null;
}

export function openProjectImportMatchesReference(
  imported: OpenProjectWorkPackageImport,
  reference: string,
) {
  return /^[1-9][0-9]{0,14}$/.test(reference)
    ? imported.workPackageId === Number(reference)
    : imported.displayId.trim().toUpperCase() === reference.toUpperCase();
}

export function importedIssueContent(content: string, title: string) {
  let readable = content;
  try {
    const parsed = JSON.parse(content) as unknown;
    const record =
      parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    const fields =
      record?.fields !== null && typeof record?.fields === "object"
        ? (record.fields as Record<string, unknown>)
        : null;
    const description = fields?.description ?? record?.description;
    if (typeof description === "string") {
      readable = description;
    } else if (description !== undefined) {
      const text: string[] = [];
      const pending: unknown[] = [description];
      while (pending.length > 0 && text.length < 200) {
        const value = pending.pop();
        if (value === null || value === undefined) continue;
        if (typeof value === "string") {
          text.push(value);
        } else if (Array.isArray(value)) {
          pending.push(...value.slice().reverse());
        } else if (typeof value === "object") {
          const object = value as Record<string, unknown>;
          if (typeof object.text === "string") text.push(object.text);
          if (Array.isArray(object.content)) {
            pending.push(...object.content.slice().reverse());
          }
        }
      }
      if (text.length > 0) readable = text.join(" ");
    }
  } catch {
    // OpenProject content and some Jira MCP implementations return plain text.
  }
  readable = readable.replace(/\s+/g, " ").trim();
  if (readable.toLowerCase().startsWith(title.trim().toLowerCase())) {
    readable = readable.slice(title.trim().length).trim();
  }
  if (!readable) return "No description was provided by the issue tracker.";
  return readable.length > 1_200
    ? `${readable.slice(0, 1_197).trimEnd()}…`
    : readable;
}

export function workspaceIntentMatches(left: WorkspaceIntent, right: WorkspaceIntent) {
  if (left.type !== right.type) return false;
  if (left.type === "jira" && right.type === "jira") {
    return left.issueKey === right.issueKey;
  }
  if (left.type === "openProject" && right.type === "openProject") {
    return (
      left.workPackageId === right.workPackageId &&
      left.displayId === right.displayId
    );
  }
  return (
    left.type === "repositorySet" &&
    right.type === "repositorySet" &&
    left.label === right.label
  );
}

export function repositoryNamesFrom(value: string) {
  const seen = new Set<string>();
  return value
    .split(/[\n,]+/)
    .map((name) => name.trim())
    .filter((name) => {
      if (!name) return false;
      const normalized = name.toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}

export function repositoryLeafFromRemoteUrl(value: string) {
  const remote = value.trim();
  if (
    !remote ||
    remote.length > 2_048 ||
    /\s|[\u0000-\u001f\u007f\\%?#]/.test(remote) ||
    remote.startsWith("--")
  ) {
    return null;
  }

  let path = "";
  try {
    const parsed = new URL(remote);
    if (!["https:", "ssh:"].includes(parsed.protocol)) return null;
    if (
      !parsed.hostname ||
      parsed.password ||
      (parsed.protocol === "https:" && parsed.username)
    ) {
      return null;
    }
    path = parsed.pathname;
  } catch {
    const scpRemote = remote.match(
      /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:([A-Za-z0-9._/-]+)$/,
    );
    if (!scpRemote) return null;
    path = scpRemote[1];
  }

  const leaf = path
    .replace(/\/+$/, "")
    .split("/")
    .at(-1)
    ?.replace(/\.git$/i, "");
  return leaf && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(leaf) ? leaf : null;
}

export interface IssueRepositoryUpstream {
  label: string;
  remoteUrl: string;
}

function isIssueGitRemoteUrl(remoteUrl: string) {
  try {
    const parsed = new URL(remoteUrl);
    if (!['https:', 'ssh:'].includes(parsed.protocol)) return false;

    // An issue page is context, not a Git clone target.
    if (/\/browse\//i.test(parsed.pathname)) return false;
    return (
      /\.git$/i.test(parsed.pathname) ||
      /(?:^|\.)(github\.com|gitlab\.com|bitbucket\.org)$/i.test(
        parsed.hostname,
      )
    );
  } catch {
    return /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:[A-Za-z0-9._/+-]+(?:\.git)?$/i.test(
      remoteUrl,
    );
  }
}

export function repositoryUpstreamsFromIssueContent(
  content: string,
): IssueRepositoryUpstream[] {
  const candidates =
    content.match(
      /(?:https|ssh):\/\/[^\s<>"'`]+|(?:[A-Za-z0-9._-]+@)[A-Za-z0-9.-]+:[A-Za-z0-9._/+\-]+/g,
    ) ?? [];
  const upstreams = new Map<string, IssueRepositoryUpstream>();

  for (const candidate of candidates) {
    const remoteUrl = candidate.replace(/[),.;\]}]+$/, "");
    if (!isIssueGitRemoteUrl(remoteUrl)) continue;
    const label = repositoryLeafFromRemoteUrl(remoteUrl);
    if (!label) continue;
    upstreams.set(label.toLocaleLowerCase(), { label, remoteUrl });
  }

  return Array.from(upstreams.values());
}

export function joinDisplayPath(root: string, leaf: string) {
  if (!root) return leaf;
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${leaf}`;
}

export function repositoryEvidenceKey(
  repositoryId: string | undefined,
  label: string,
) {
  return repositoryId ?? label.trim().toLowerCase();
}

export function moveCompositeFocus(
  root: HTMLElement,
  event: Pick<ReactKeyboardEvent<HTMLElement>, "key" | "target" | "preventDefault" | "stopPropagation">,
  selector: string,
  columns: number,
  activate = false,
) {
  const key = event.key;
  if (
    !["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(
      key,
    )
  ) {
    return;
  }

  const items = Array.from(
    root.querySelectorAll<HTMLElement>(selector),
  ).filter((item) => !item.matches(":disabled, [aria-disabled='true']"));
  const focusedItem = event.target instanceof HTMLElement
    ? event.target.closest<HTMLElement>(selector)
    : null;
  const currentIndex = focusedItem ? items.indexOf(focusedItem) : -1;
  if (currentIndex < 0 || items.length === 0) return;

  const rowStart = Math.floor(currentIndex / columns) * columns;
  const rowEnd = Math.min(rowStart + columns - 1, items.length - 1);
  let nextIndex = currentIndex;
  if (key === "Home") nextIndex = 0;
  else if (key === "End") nextIndex = items.length - 1;
  else if (key === "ArrowLeft") nextIndex = Math.max(rowStart, currentIndex - 1);
  else if (key === "ArrowRight") nextIndex = Math.min(rowEnd, currentIndex + 1);
  else if (key === "ArrowUp") nextIndex = Math.max(0, currentIndex - columns);
  else if (key === "ArrowDown") {
    nextIndex = Math.min(items.length - 1, currentIndex + columns);
  }

  if (nextIndex === currentIndex) return;
  event.preventDefault();
  const next = items[nextIndex]!;
  next.focus();
  if (activate) next.click();
}

export function catalogRepositoryFor(
  repositoryId: string | undefined,
  label: string,
  repositoryCatalog: RepositoryCatalog | undefined,
): RepositorySummary | undefined {
  const repositories = repositoryCatalog?.repositories ?? [];
  if (repositoryId) {
    return repositories.find((repository) => repository.id === repositoryId);
  }

  const labelMatches = repositories.filter(
    (repository) =>
      repository.label.localeCompare(label, undefined, {
        sensitivity: "accent",
      }) === 0,
  );
  if (labelMatches.length === 1) return labelMatches[0];
  if (labelMatches.length > 1) return undefined;

  const checkoutMatches = repositories.filter(
    (repository) =>
      repository.checkoutLeaf.localeCompare(label, undefined, {
        sensitivity: "accent",
      }) === 0,
  );
  return checkoutMatches.length === 1 ? checkoutMatches[0] : undefined;
}

export function remoteMatchesRepositoryLabel(
  label: string,
  repository: RepositorySummary,
) {
  const normalize = (value: string) =>
    value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
  const target = normalize(label);
  if (!target) return false;

  return [repository.label, repository.checkoutLeaf, repository.originUrl]
    .filter((value): value is string => Boolean(value))
    .map(normalize)
    .some((value) => value.includes(target) || target.includes(value));
}

export const runtimeConfidenceLabels: Record<RuntimeAnalysisConfidence, string> = {
  declared: "Declared",
  corroborated: "Corroborated",
  inferred: "Inferred",
  suggested: "Suggested",
};

export function runtimeAnalysisPreparationFor(
  repositories: RepoEvidence[],
  repositoryCatalog: RepositoryCatalog | undefined,
): {
  request: RuntimeAnalysisRequest | null;
  fingerprint: string;
  unresolvedLabels: string[];
} {
  const prepared = repositories.map((repository) => {
    const catalogRepository = catalogRepositoryFor(
      repository.repositoryId,
      repository.id,
      repositoryCatalog,
    );
    return {
      repositoryId: repository.repositoryId ?? catalogRepository?.id,
      label: repository.id.trim(),
      baseRef: repository.base.trim(),
    };
  });
  const resolvedIdCounts = new Map<string, number>();
  for (const repository of prepared) {
    if (!repository.repositoryId) continue;
    resolvedIdCounts.set(
      repository.repositoryId,
      (resolvedIdCounts.get(repository.repositoryId) ?? 0) + 1,
    );
  }
  const unresolvedLabels = prepared
    .filter(
      (repository) =>
        !repository.repositoryId ||
        resolvedIdCounts.get(repository.repositoryId) !== 1,
    )
    .map((repository) => repository.label);
  const fingerprint = JSON.stringify(
    prepared
      .map((repository) => ({
        repositoryId: repository.repositoryId ?? "",
        label: repository.label,
        baseRef: repository.baseRef,
      }))
      .sort(
        (left, right) =>
          left.repositoryId.localeCompare(right.repositoryId) ||
          left.label.localeCompare(right.label) ||
          left.baseRef.localeCompare(right.baseRef),
      ),
  );

  return {
    request:
      unresolvedLabels.length === 0
        ? {
            repositories: prepared.map((repository) => ({
              repositoryId: repository.repositoryId!,
              label: repository.label,
              baseRef: repository.baseRef,
            })),
          }
        : null,
    fingerprint,
    unresolvedLabels,
  };
}

export function claimedRuntimePorts(
  workspaces: readonly Workspace[] = [],
  serviceDrafts: Map<string, RuntimeServiceDraft> = new Map(),
  excludeCandidateId?: string,
  excludePortId?: string,
): Set<number> {
  const claimed = new Set<number>();
  for (const workspace of workspaces) {
    if (workspace.runtime?.services) {
      for (const service of workspace.runtime.services) {
        for (const port of service.ports) {
          if (
            port.preferredPort &&
            port.preferredPort >= 1024 &&
            port.preferredPort <= 65535
          ) {
            claimed.add(port.preferredPort);
          }
        }
      }
    }
  }
  for (const [candidateId, draft] of serviceDrafts) {
    if (!draft.included) continue;
    for (const port of draft.ports) {
      if (candidateId === excludeCandidateId && port.portId === excludePortId) {
        continue;
      }
      const valid = validRuntimePort(port.preferredPort);
      if (valid !== null) {
        claimed.add(valid);
      }
    }
  }
  return claimed;
}

export function allocateFreeRuntimePort(
  preferred: number | undefined,
  claimed: Set<number>,
  basePort = 48000,
): number {
  if (
    preferred !== undefined &&
    preferred >= 1024 &&
    preferred <= 65535 &&
    !claimed.has(preferred)
  ) {
    return preferred;
  }
  let candidate =
    preferred !== undefined && preferred >= 1024 && preferred <= 65535
      ? preferred
      : basePort;
  while (claimed.has(candidate) && candidate < 65535) {
    candidate += 1;
  }
  if (claimed.has(candidate)) {
    candidate = 1024;
    while (claimed.has(candidate) && candidate < basePort) {
      candidate += 1;
    }
  }
  return candidate;
}

export function runtimeDraftsFromAnalysis(
  analysis: RuntimeAnalysisResult,
  workspaces: readonly Workspace[] = [],
  previous: RuntimeDraftSnapshot | null = null,
): Map<string, RuntimeServiceDraft> {
  const claimed = claimedRuntimePorts(workspaces);
  const result = new Map<string, RuntimeServiceDraft>();
  const previousServices = new Map(
    previous?.analysis.services.map((service) => [service.candidateId, service]),
  );
  const matchingDrafts = new Map<string, RuntimeServiceDraft>();

  for (const service of analysis.services) {
    const previousService = previousServices.get(service.candidateId);
    const draft = previous?.drafts.get(service.candidateId);
    if (
      !draft ||
      !previousService ||
      previousService.repositoryId !== service.repositoryId ||
      previousService.commitOid !== service.commitOid
    ) continue;
    matchingDrafts.set(service.candidateId, draft);
    for (const port of draft.ports) {
      const selectedPort = validRuntimePort(port.preferredPort);
      if (selectedPort !== null) claimed.add(selectedPort);
    }
  }

  for (const service of analysis.services) {
    const previousDraft = matchingDrafts.get(service.candidateId);
    const ports: RuntimePortDraft[] = [];
    for (const port of service.ports) {
      const previousPort = previousDraft?.ports.find(
        (candidate) => candidate.portId === port.portId,
      );
      if (previousPort) {
        ports.push(previousPort);
        continue;
      }
      const preferred =
        port.preferredPort !== undefined && port.preferredPort >= 1024
          ? port.preferredPort
          : undefined;
      const allocated = allocateFreeRuntimePort(preferred, claimed);
      claimed.add(allocated);
      ports.push({
        portId: port.portId,
        preferredPort: String(allocated),
        policy: port.policy,
      });
    }
    result.set(service.candidateId, {
      included: previousDraft?.included ?? service.includedByDefault,
      ports,
    });
  }

  return result;
}

export function validRuntimePort(value: string) {
  if (!/^[0-9]+$/.test(value)) return null;
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1_024 && port <= 65_535
    ? port
    : null;
}

export function runtimePortErrorId(candidateId: string, portId: string) {
  return `runtime-port-error-${candidateId}-${portId}`.replace(
    /[^a-zA-Z0-9_-]/g,
    "-",
  );
}

export type RepositoryForgeTarget = {
  forge: "github" | "gitlab";
  host: string;
};

export function repositoryForgeTarget(
  originUrl: string | undefined,
): RepositoryForgeTarget | null {
  if (!originUrl) return null;
  const value = originUrl.trim();
  if (!value || /[?#\u0000-\u001f\u007f]/.test(value)) return null;

  let host = "";
  let repositoryPath = "";
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme) {
    if (!["https", "ssh"].includes(scheme[1]!.toLowerCase())) {
      return null;
    }
    try {
      const parsed = new URL(value);
      if (parsed.username || parsed.password || parsed.port) return null;
      host = parsed.hostname.toLowerCase();
      repositoryPath = parsed.pathname.replace(/^\/+|\/+$/g, "");
    } catch {
      return null;
    }
  } else {
    const scp = value.match(/^(?:[^@/:\\]+@)?([^/:\\]+):(.+)$/);
    if (!scp) return null;
    host = scp[1]!.toLowerCase();
    repositoryPath = scp[2]!.replace(/^\/+|\/+$/g, "");
  }

  if (
    !host ||
    !host.includes(".") ||
    !repositoryPath ||
    repositoryPath.includes("\\") ||
    repositoryPath
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }

  const firstLabel = host.split(".")[0];
  if (host === "github.com" || firstLabel === "github") {
    return { forge: "github", host };
  }
  if (host === "gitlab.com" || firstLabel === "gitlab") {
    return { forge: "gitlab", host };
  }
  return null;
}

export function forgeDisplayName(forge: RepositoryForgeTarget["forge"]) {
  return forge === "github" ? "GitHub" : "GitLab";
}

export function newIdempotencyKey() {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const providerToRequest: Record<Provider, WorkspaceProvider> = {
  Codex: "codex",
  OpenCode: "openCode",
  Hermes: "hermes",
  "VS Code": "vsCode",
  Copilot: "copilot",
};

export const providerMarks: Record<Provider, string> = {
  Codex: "CX",
  OpenCode: "OC",
  Hermes: "HM",
  "VS Code": "VS",
  Copilot: "CP",
};

export interface ReviewWorkspaceSeed {
  preparation: CloneRepositoryResult;
  review: GitlabReview;
}

export interface DeferredCloneRequest {
  cloneId: string;
  title: string;
  repositoryLabel: string;
  cloneRequest: CloneRepositoryRequest;
  draft: RepositoryWorkspaceDraft;
  replacesTaskId?: string;
}
