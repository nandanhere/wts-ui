import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  parsePatchFiles,
  type CodeViewItem,
  type FileDiffMetadata,
} from "@pierre/diffs";
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewReactOptions,
} from "@pierre/diffs/react";
import type { ResolvedTheme } from "../../theme";
import type {
  CodeChangeReviewTarget,
  GitlabReviewDiscussion,
  WorkspaceClient,
  WorkspaceRepositoryFileReview,
  WorkspaceRepositoryReviewGraph,
} from "../../lib/wtsClient";
import { CodeReviewFeedbackPanel } from "./CodeReviewFeedbackPanel";
import { Glyph } from "./Glyph";
import styles from "./RepositoryPatchViewer.module.css";

type DiffStyle = "unified" | "split";
type FileFilter = "code" | "tests" | "all";
type ContextMode = "tests" | "references" | "feedback";

const REVIEW_LAYOUT_STORAGE_KEY = "wts.repository-review-layout.v1";
const FILE_RAIL_DEFAULT = 244;
const FILE_RAIL_MIN = 168;
const FILE_RAIL_MAX = 400;
const CONTEXT_RAIL_DEFAULT = 320;
const CONTEXT_RAIL_MIN = 240;
const CONTEXT_RAIL_MAX = 480;
const RESIZE_STEP = 24;

interface ReviewLayoutWidths {
  files: number;
  context: number;
}

function boundedWidth(value: unknown, minimum: number, maximum: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : fallback;
}

export function loadReviewLayoutWidths(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): ReviewLayoutWidths {
  try {
    const raw = JSON.parse(storage?.getItem(REVIEW_LAYOUT_STORAGE_KEY) ?? "{}");
    return {
      files: boundedWidth(raw.files, FILE_RAIL_MIN, FILE_RAIL_MAX, FILE_RAIL_DEFAULT),
      context: boundedWidth(
        raw.context,
        CONTEXT_RAIL_MIN,
        CONTEXT_RAIL_MAX,
        CONTEXT_RAIL_DEFAULT,
      ),
    };
  } catch {
    return { files: FILE_RAIL_DEFAULT, context: CONTEXT_RAIL_DEFAULT };
  }
}

function saveReviewLayoutWidths(widths: ReviewLayoutWidths) {
  try {
    globalThis.localStorage?.setItem(REVIEW_LAYOUT_STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // The review remains resizable when browser storage is unavailable.
  }
}

export interface PatchReviewFeedbackIdentity {
  baseCommitOid: string;
  client: WorkspaceClient;
  headCommitOid: string;
  patchSha256: string;
  repositoryId: string;
  workspaceId: string;
  gitlabReview?: {
    repositoryId: string;
    iid: number;
    discussions: GitlabReviewDiscussion[];
  };
}

interface PatchFile {
  additions: number;
  deletions: number;
  fileDiff: FileDiffMetadata;
  id: string;
}

interface FullFileState {
  enabled: boolean;
  error?: string;
  fileDiff?: FileDiffMetadata;
  status: "idle" | "loading" | "ready" | "error";
}

export interface PatchSearchMatch {
  fileId: string;
  fileName: string;
  lineNumber: number;
  side: "additions" | "deletions";
}

export interface PatchChangeTarget extends PatchSearchMatch {
  hunkIndex: number;
}

export interface SelectedChangedPatchLine {
  fileId: string;
  filePath: string;
  line: number;
  side: "additions" | "deletions";
}

export function patchTokenReferenceAction(
  tokenText: string,
  modifier: { ctrlKey: boolean; metaKey: boolean },
) {
  if (!(modifier.metaKey || modifier.ctrlKey)) return null;
  if (!/^[A-Za-z_$][\w$]*$/.test(tokenText)) return null;
  return { contextMode: "references" as const, contextOpen: true, symbol: tokenText };
}

function changedLinesForHunk(file: PatchFile, hunkIndex: number) {
  const hunk = file.fileDiff.hunks[hunkIndex];
  if (!hunk) return [];
  let additionLine = hunk.additionStart;
  let deletionLine = hunk.deletionStart;
  const lines: PatchSearchMatch[] = [];
  for (const content of hunk.hunkContent) {
    if (content.type === "context") {
      additionLine += content.lines;
      deletionLine += content.lines;
      continue;
    }
    for (let offset = 0; offset < content.deletions; offset += 1) {
      lines.push({
        fileId: file.id,
        fileName: file.fileDiff.name,
        lineNumber: deletionLine + offset,
        side: "deletions",
      });
    }
    for (let offset = 0; offset < content.additions; offset += 1) {
      lines.push({
        fileId: file.id,
        fileName: file.fileDiff.name,
        lineNumber: additionLine + offset,
        side: "additions",
      });
    }
    deletionLine += content.deletions;
    additionLine += content.additions;
  }
  return lines;
}

export function selectedChangedPatchLine(
  files: PatchFile[],
  selection: {
    id: string;
    range: { start: number; side?: "additions" | "deletions" };
  } | null,
): SelectedChangedPatchLine | undefined {
  if (!selection?.range.side) return undefined;
  const file = files.find((candidate) => candidate.id === selection.id);
  if (!file) return undefined;
  const line = selection.range.start;
  const side = selection.range.side;
  const isChanged = file.fileDiff.hunks.some((_, hunkIndex) =>
    changedLinesForHunk(file, hunkIndex).some(
      (changed) => changed.side === side && changed.lineNumber === line,
    ),
  );
  if (!isChanged) return undefined;
  return { fileId: file.id, filePath: file.fileDiff.name, line, side };
}

export function adjacentChangeIndex(
  currentIndex: number,
  changeCount: number,
  direction: "next" | "previous",
) {
  if (changeCount <= 0) return -1;
  if (currentIndex < 0) return direction === "next" ? 0 : changeCount - 1;
  return direction === "next"
    ? (currentIndex + 1) % changeCount
    : (currentIndex - 1 + changeCount) % changeCount;
}

export function patchSearchNavigation(match: PatchSearchMatch) {
  return {
    selection: {
      id: match.fileId,
      range: {
        start: match.lineNumber,
        end: match.lineNumber,
        side: match.side,
      },
    },
    scrollTarget: {
      type: "line" as const,
      id: match.fileId,
      lineNumber: match.lineNumber,
      side: match.side,
      align: "center" as const,
      behavior: "smooth" as const,
    },
  };
}

export function patchChangeTargets(files: PatchFile[]): PatchChangeTarget[] {
  return files.flatMap((file) =>
    file.fileDiff.hunks.flatMap((_, hunkIndex) => {
      const changed = changedLinesForHunk(file, hunkIndex);
      const target =
        changed.find((line) => line.side === "additions") ?? changed[0];
      return target ? [{ ...target, hunkIndex }] : [];
    }),
  );
}

export interface RepositoryPatchSummary {
  additions: number;
  deletions: number;
  files: PatchFile[];
}

export interface ChangedReference {
  fileId: string;
  fileName: string;
  matches: number;
}

export function isTestFile(path: string) {
  const name = path.toLowerCase();
  return (
    /(^|\/)(__tests__|tests?|specs?)(\/|$)/.test(name) ||
    /(?:^|[._-])(test|tests|spec|specs)(?:[._-]|$)/.test(name)
  );
}

function normalizedStem(path: string) {
  return (path.split("/").at(-1) ?? path)
    .toLowerCase()
    .replace(/\.(test|tests|spec|specs)(?=\.)/g, "")
    .replace(/_test(?=\.)/g, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]/g, "");
}

export function relatedTestFiles(files: PatchFile[], sourcePath: string) {
  const sourceStem = normalizedStem(sourcePath);
  const sourceDirectory = sourcePath.split("/").slice(0, -1).join("/");
  return files
    .filter((file) => isTestFile(file.fileDiff.name))
    .map((file) => {
      const testPath = file.fileDiff.name;
      const testStem = normalizedStem(testPath);
      const score =
        (testStem === sourceStem ? 4 : 0) +
        (testStem.includes(sourceStem) || sourceStem.includes(testStem) ? 2 : 0) +
        (sourceDirectory && testPath.startsWith(sourceDirectory) ? 1 : 0);
      return { file, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .map(({ file }) => file);
}

export function findChangedReferences(
  files: PatchFile[],
  symbol: string,
): ChangedReference[] {
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) return [];
  const pattern = new RegExp(`\\b${symbol.replace(/[$]/g, "\\$")}\\b`, "g");
  return files.flatMap((file) => {
    const matches = [
      ...file.fileDiff.additionLines,
      ...file.fileDiff.deletionLines,
    ].reduce((count, line) => count + (line.match(pattern)?.length ?? 0), 0);
    return matches
      ? [{ fileId: file.id, fileName: file.fileDiff.name, matches }]
      : [];
  });
}

export function findGraphReferenceFiles(
  graph: WorkspaceRepositoryReviewGraph | undefined,
  symbol: string,
) {
  if (!graph || !/^[A-Za-z_$][\w$]*$/.test(symbol)) return [];
  const matchingIds = new Set(
    graph.nodes
      .filter((node) => node.label.toLowerCase() === symbol.toLowerCase())
      .map((node) => node.id),
  );
  const connectedIds = new Set(matchingIds);
  for (const link of graph.links) {
    if (matchingIds.has(link.source)) connectedIds.add(link.target);
    if (matchingIds.has(link.target)) connectedIds.add(link.source);
  }
  return Array.from(
    new Set(
      graph.nodes
        .filter((node) => connectedIds.has(node.id))
        .map((node) => node.sourceFile),
    ),
  ).sort();
}

export function findGraphTestFiles(
  graph: WorkspaceRepositoryReviewGraph | undefined,
  sourcePath: string,
) {
  if (!graph) return [];
  const sourceIds = new Set(
    graph.nodes
      .filter((node) => node.sourceFile === sourcePath)
      .map((node) => node.id),
  );
  const connectedIds = new Set<string>();
  for (const link of graph.links) {
    if (sourceIds.has(link.source)) connectedIds.add(link.target);
    if (sourceIds.has(link.target)) connectedIds.add(link.source);
  }
  const sourceStem = normalizedStem(sourcePath);
  return Array.from(
    new Set(
      graph.nodes
        .filter(
          (node) =>
            isTestFile(node.sourceFile) &&
            (connectedIds.has(node.id) ||
              normalizedStem(node.sourceFile).includes(sourceStem)),
        )
        .map((node) => node.sourceFile),
    ),
  ).sort();
}

export function summarizeRepositoryPatch(patch: string): RepositoryPatchSummary {
  let parsedPatches: ReturnType<typeof parsePatchFiles>;
  try {
    parsedPatches = parsePatchFiles(patch);
  } catch {
    return { additions: 0, deletions: 0, files: [] };
  }

  const files = parsedPatches
    .flatMap((parsedPatch) => parsedPatch.files)
    .map((fileDiff, index) => {
      const additions = fileDiff.hunks.reduce(
        (total, hunk) => total + hunk.additionLines,
        0,
      );
      const deletions = fileDiff.hunks.reduce(
        (total, hunk) => total + hunk.deletionLines,
        0,
      );
      return {
        additions,
        deletions,
        fileDiff,
        id: `${index}:${fileDiff.prevName ?? ""}:${fileDiff.name}`,
      };
    });

  return {
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    files,
  };
}

export function findPatchSearchMatches(
  files: PatchFile[],
  query: string,
): PatchSearchMatch[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [];
  const matches: PatchSearchMatch[] = [];
  for (const file of files) {
    for (const hunk of file.fileDiff.hunks) {
      for (let offset = 0; offset < hunk.additionCount; offset += 1) {
        const lineNumber = hunk.additionStart + offset;
        const line = file.fileDiff.additionLines[hunk.additionLineIndex + offset];
        if (line?.toLocaleLowerCase().includes(normalizedQuery)) {
          matches.push({
            fileId: file.id,
            fileName: file.fileDiff.name,
            lineNumber,
            side: "additions",
          });
        }
      }
      for (let offset = 0; offset < hunk.deletionCount; offset += 1) {
        const lineNumber = hunk.deletionStart + offset;
        const line = file.fileDiff.deletionLines[hunk.deletionLineIndex + offset];
        if (
          line?.toLocaleLowerCase().includes(normalizedQuery) &&
          !matches.some(
            (match) =>
              match.fileId === file.id &&
              match.lineNumber === lineNumber &&
              match.side === "additions",
          )
        ) {
          matches.push({
            fileId: file.id,
            fileName: file.fileDiff.name,
            lineNumber,
            side: "deletions",
          });
        }
      }
    }
  }
  return matches;
}

function changeLabel(file: PatchFile) {
  switch (file.fileDiff.type) {
    case "new":
      return { code: "A", label: "Added" };
    case "deleted":
      return { code: "D", label: "Deleted" };
    case "rename-pure":
    case "rename-changed":
      return { code: "R", label: "Renamed" };
    default:
      return { code: "M", label: "Modified" };
  }
}

function lineCountLabel(count: number, kind: "addition" | "deletion") {
  return `${count} ${kind}${count === 1 ? "" : "s"}`;
}

export function RepositoryPatchViewer({
  feedback,
  patch,
  theme,
  graphReady = false,
  reviewGraph,
  lineCommentProvider,
}: {
  feedback?: PatchReviewFeedbackIdentity;
  patch: string;
  theme: ResolvedTheme;
  graphReady?: boolean;
  reviewGraph?: WorkspaceRepositoryReviewGraph;
  lineCommentProvider?: "GitLab";
}) {
  const gitlabLineComments = Boolean(
    feedback?.gitlabReview && lineCommentProvider,
  );
  const viewRefs = useRef(new Map<string, CodeViewHandle<undefined>>());
  const fileBlockRefs = useRef(new Map<string, HTMLDivElement>());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const summary = useMemo(() => summarizeRepositoryPatch(patch), [patch]);
  const productionCount = summary.files.filter(
    (file) => !isTestFile(file.fileDiff.name),
  ).length;
  const testCount = summary.files.length - productionCount;
  const initialFileFilter: FileFilter = productionCount
    ? "code"
    : testCount
      ? "tests"
      : "all";
  const initialSelectedFileId =
    summary.files.find((file) => !isTestFile(file.fileDiff.name))?.id ??
    summary.files[0]?.id;
  const [fileFilter, setFileFilter] = useState<FileFilter>(
    initialFileFilter,
  );
  const [selectedFileId, setSelectedFileId] = useState(initialSelectedFileId);
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
  const [wrapLines, setWrapLines] = useState(false);
  const [contextOpen, setContextOpen] = useState(gitlabLineComments);
  const [contextMode, setContextMode] = useState<ContextMode>(
    gitlabLineComments ? "feedback" : "tests",
  );
  const [layoutWidths, setLayoutWidths] = useState(loadReviewLayoutWidths);
  const [referenceSymbol, setReferenceSymbol] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchMatch, setActiveSearchMatch] = useState(0);
  const [activeChangeIndex, setActiveChangeIndex] = useState(-1);
  const [selectedFeedbackLine, setSelectedFeedbackLine] =
    useState<SelectedChangedPatchLine>();
  const [fullFiles, setFullFiles] = useState<Record<string, FullFileState>>({});
  const fullFileIdentityRef = useRef("");
  const [expandedFileIds, setExpandedFileIds] = useState<Set<string>>(() => {
    return initialSelectedFileId
      ? new Set<string>([initialSelectedFileId])
      : new Set<string>();
  });

  useEffect(() => {
    const identity = feedback
      ? [
          feedback.workspaceId,
          feedback.repositoryId,
          feedback.baseCommitOid,
          feedback.headCommitOid,
          feedback.patchSha256,
        ].join(":")
      : "";
    fullFileIdentityRef.current = identity;
    setFullFiles({});
  }, [
    feedback?.baseCommitOid,
    feedback?.headCommitOid,
    feedback?.patchSha256,
    feedback?.repositoryId,
    feedback?.workspaceId,
  ]);

  const reviewFiles = useMemo(
    () =>
      summary.files.map((file) => {
        const state = fullFiles[file.fileDiff.name];
        return state?.enabled && state.fileDiff
          ? { ...file, fileDiff: state.fileDiff }
          : file;
      }),
    [fullFiles, summary.files],
  );

  useEffect(() => {
    setFileFilter(initialFileFilter);
    setSelectedFileId(initialSelectedFileId);
    setContextOpen(gitlabLineComments);
    setContextMode(gitlabLineComments ? "feedback" : "tests");
    setReferenceSymbol("");
    setSearchQuery("");
    setActiveSearchMatch(0);
    setActiveChangeIndex(-1);
    setSelectedFeedbackLine(undefined);
    setExpandedFileIds(
      initialSelectedFileId
        ? new Set<string>([initialSelectedFileId])
        : new Set<string>(),
    );
    scrollContainerRef.current?.scrollTo?.({ behavior: "auto", top: 0 });
  }, [gitlabLineComments, initialFileFilter, initialSelectedFileId, summary]);

  useEffect(() => {
    saveReviewLayoutWidths(layoutWidths);
  }, [layoutWidths]);

  const setBoundedLayoutWidth = (panel: keyof ReviewLayoutWidths, value: number) => {
    setLayoutWidths((current) => ({
      ...current,
      [panel]: panel === "files"
        ? boundedWidth(value, FILE_RAIL_MIN, FILE_RAIL_MAX, current.files)
        : boundedWidth(value, CONTEXT_RAIL_MIN, CONTEXT_RAIL_MAX, current.context),
    }));
  };

  const startPanelResize = (
    panel: keyof ReviewLayoutWidths,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const bounds = viewerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const pointerId = event.pointerId;
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      setBoundedLayoutWidth(
        panel,
        panel === "files"
          ? moveEvent.clientX - bounds.left
          : bounds.right - moveEvent.clientX,
      );
    };
    const stop = (stopEvent: PointerEvent) => {
      if (stopEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const resizePanelWithKeyboard = (
    panel: keyof ReviewLayoutWidths,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const direction = panel === "files" ? 1 : -1;
    if (event.key === "Home") {
      setBoundedLayoutWidth(panel, panel === "files" ? FILE_RAIL_MIN : CONTEXT_RAIL_MIN);
      return;
    }
    if (event.key === "End") {
      setBoundedLayoutWidth(panel, panel === "files" ? FILE_RAIL_MAX : CONTEXT_RAIL_MAX);
      return;
    }
    const delta = event.key === "ArrowRight" ? RESIZE_STEP : -RESIZE_STEP;
    setBoundedLayoutWidth(panel, layoutWidths[panel] + delta * direction);
  };

  const toggleFileExpanded = (fileId: string) => {
    setExpandedFileIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }
      return next;
    });
  };

  const handleExpandAll = () => {
    setExpandedFileIds(new Set(summary.files.map((file) => file.id)));
  };

  const handleCollapseAll = () => {
    setExpandedFileIds(new Set());
  };

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") {
        return;
      }
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  const changeTargets = useMemo(
    () => patchChangeTargets(summary.files),
    [summary.files],
  );
  const searchMatches = useMemo(
    () => findPatchSearchMatches(reviewFiles, searchQuery),
    [reviewFiles, searchQuery],
  );

  const visibleFiles = useMemo(
    () =>
      reviewFiles.filter((file) => {
        const matchesFilter =
          fileFilter === "all"
            ? true
            : fileFilter === "tests"
              ? isTestFile(file.fileDiff.name)
              : !isTestFile(file.fileDiff.name);
        if (!matchesFilter || !normalizedSearchQuery) return matchesFilter;
        return [
          file.fileDiff.name,
          ...file.fileDiff.additionLines,
          ...file.fileDiff.deletionLines,
        ].some((value) => value.toLocaleLowerCase().includes(normalizedSearchQuery));
      }),
    [fileFilter, normalizedSearchQuery, reviewFiles],
  );
  const selectedFile =
    reviewFiles.find((file) => file.id === selectedFileId) ?? visibleFiles[0];
  const tests = selectedFile
    ? relatedTestFiles(summary.files, selectedFile.fileDiff.name)
    : [];
  const graphTests = selectedFile
    ? findGraphTestFiles(reviewGraph, selectedFile.fileDiff.name).filter(
        (path) => !tests.some((test) => test.fileDiff.name === path),
      )
    : [];
  const references = referenceSymbol
    ? findChangedReferences(summary.files, referenceSymbol)
    : [];
  const graphReferences = referenceSymbol
    ? findGraphReferenceFiles(reviewGraph, referenceSymbol).filter(
        (path) => !references.some((reference) => reference.fileName === path),
      )
    : [];
  const selectedFeedbackTarget = useMemo<CodeChangeReviewTarget | undefined>(
    () =>
      feedback && selectedFeedbackLine
        ? {
            kind: "codeChange",
            repositoryId: feedback.repositoryId,
            baseCommitOid: feedback.baseCommitOid,
            headCommitOid: feedback.headCommitOid,
            patchSha256: feedback.patchSha256,
            filePath: selectedFeedbackLine.filePath,
            side: selectedFeedbackLine.side,
            line: selectedFeedbackLine.line,
          }
        : undefined,
    [feedback, selectedFeedbackLine],
  );
  const selectedFullFileState = selectedFile
    ? fullFiles[selectedFile.fileDiff.name]
    : undefined;

  const validateFullFileResponse = (
    response: WorkspaceRepositoryFileReview,
    filePath: string,
    identity: PatchReviewFeedbackIdentity,
  ) =>
    response.workspaceId === identity.workspaceId &&
    response.repositoryId === identity.repositoryId &&
    response.baseCommitOid === identity.baseCommitOid &&
    response.headCommitOid === identity.headCommitOid &&
    response.patchSha256 === identity.patchSha256 &&
    response.filePath === filePath;

  const toggleFullFile = () => {
    if (!feedback || !selectedFile) return;
    const filePath = selectedFile.fileDiff.name;
    const current = fullFiles[filePath];
    if (current?.enabled) {
      setFullFiles((files) => ({
        ...files,
        [filePath]: { ...current, enabled: false },
      }));
      return;
    }
    if (current?.fileDiff) {
      setFullFiles((files) => ({
        ...files,
        [filePath]: { ...current, enabled: true },
      }));
      return;
    }
    const identityKey = [
      feedback.workspaceId,
      feedback.repositoryId,
      feedback.baseCommitOid,
      feedback.headCommitOid,
      feedback.patchSha256,
    ].join(":");
    setFullFiles((files) => ({
      ...files,
      [filePath]: { enabled: true, status: "loading" },
    }));
    void feedback.client
      .getWorkspaceRepositoryFileReview(
        feedback.workspaceId,
        feedback.repositoryId,
        filePath,
        feedback.patchSha256,
      )
      .then((response) => {
        if (fullFileIdentityRef.current !== identityKey) return;
        if (!validateFullFileResponse(response, filePath, feedback)) {
          throw new Error("The repository changed. Reload the changes and try again.");
        }
        const completeFile = summarizeRepositoryPatch(response.fullPatch).files.find(
          (file) => file.fileDiff.name === filePath,
        );
        if (!completeFile) {
          throw new Error("WTS could not display the complete file.");
        }
        setFullFiles((files) => ({
          ...files,
          [filePath]: {
            enabled: files[filePath]?.enabled ?? true,
            fileDiff: completeFile.fileDiff,
            status: "ready",
          },
        }));
      })
      .catch((cause) => {
        if (fullFileIdentityRef.current !== identityKey) return;
        setFullFiles((files) => ({
          ...files,
          [filePath]: {
            enabled: true,
            error:
              cause instanceof Error
                ? cause.message
                : "WTS could not read the complete file.",
            status: "error",
          },
        }));
      });
  };

  const scrollFileIntoReview = (
    fileId: string,
    behavior: ScrollBehavior = "smooth",
  ) => {
    const container = scrollContainerRef.current;
    const file = fileBlockRefs.current.get(fileId);
    if (!container || !file) return;
    const top =
      file.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop;
    container.scrollTo?.({ behavior, top });
  };

  const revealFile = (fileId: string, toggleSelected = false) => {
    const file = summary.files.find((candidate) => candidate.id === fileId);
    if (!file) return;
    setActiveChangeIndex(-1);
    const wasSelected = selectedFileId === fileId;
    setSelectedFileId(fileId);
    setExpandedFileIds((prev) => {
      const next = new Set(prev);
      if (toggleSelected && wasSelected && next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }
      return next;
    });
    if (!visibleFiles.some((candidate) => candidate.id === fileId)) {
      setFileFilter("all");
    }
    window.requestAnimationFrame(() => {
      scrollFileIntoReview(fileId);
    });
  };

  const revealSearchMatch = (index: number) => {
    if (!searchMatches.length) return;
    const normalizedIndex = (index + searchMatches.length) % searchMatches.length;
    const match = searchMatches[normalizedIndex];
    setActiveSearchMatch(normalizedIndex);
    revealFile(match.fileId);
    window.requestAnimationFrame(() => {
      const view = viewRefs.current.get(match.fileId);
      const navigation = patchSearchNavigation(match);
      view?.setSelectedLines(navigation.selection);
      view?.scrollTo(navigation.scrollTarget);
    });
  };

  const revealChange = (index: number) => {
    if (!changeTargets.length) return;
    const normalizedIndex =
      (index + changeTargets.length) % changeTargets.length;
    const target = changeTargets[normalizedIndex];
    setActiveChangeIndex(normalizedIndex);
    setSearchQuery("");
    setFileFilter("all");
    setSelectedFileId(target.fileId);
    setExpandedFileIds((current) => new Set(current).add(target.fileId));
    window.requestAnimationFrame(() => {
      scrollFileIntoReview(target.fileId, "auto");
      window.requestAnimationFrame(() => {
        const view = viewRefs.current.get(target.fileId);
        const navigation = patchSearchNavigation(target);
        view?.setSelectedLines(navigation.selection);
        view?.scrollTo(navigation.scrollTarget);
      });
    });
  };

  const moveChange = (direction: "next" | "previous") => {
    revealChange(
      adjacentChangeIndex(
        activeChangeIndex,
        changeTargets.length,
        direction,
      ),
    );
  };

  useEffect(() => {
    const navigateChanges = (event: KeyboardEvent) => {
      if (
        !event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        (event.key !== "ArrowDown" && event.key !== "ArrowUp")
      ) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.matches("input, textarea, select, [contenteditable='true']") ||
          target.closest("[role='dialog']"))
      ) {
        return;
      }
      event.preventDefault();
      moveChange(event.key === "ArrowDown" ? "next" : "previous");
    };
    window.addEventListener("keydown", navigateChanges);
    return () => window.removeEventListener("keydown", navigateChanges);
  }, [activeChangeIndex, changeTargets]);

  useEffect(() => {
    setActiveSearchMatch(0);
    if (!normalizedSearchQuery || !searchMatches.length) return;
    revealSearchMatch(0);
  }, [normalizedSearchQuery]);

  const options = useMemo<CodeViewReactOptions>(
    () => ({
      diffIndicators: "bars" as const,
      diffStyle,
      enableGutterUtility: Boolean(lineCommentProvider),
      enableLineSelection: true,
      hunkSeparators: "line-info" as const,
      layout: { paddingTop: 10, paddingBottom: 24, gap: 10 },
      lineDiffType: "word-alt" as const,
      lineHoverHighlight: "line" as const,
      overflow: wrapLines ? ("wrap" as const) : ("scroll" as const),
      stickyHeaders: true,
      themeType: theme,
      onTokenEnter: (token, event) => {
        if (/^[A-Za-z_$][\w$]*$/.test(token.tokenText)) {
          token.tokenElement.title = `${navigator.platform.includes("Mac") ? "Command" : "Control"}-click to find changed references`;
          token.tokenElement.dataset.reference = "true";
          if (event.metaKey || event.ctrlKey) token.tokenElement.dataset.modifier = "true";
        }
      },
      onTokenLeave: (token) => {
        delete token.tokenElement.dataset.modifier;
      },
      onTokenClick: (token, event) => {
        const action = patchTokenReferenceAction(token.tokenText, event);
        if (!action) return;
        event.preventDefault();
        setReferenceSymbol(action.symbol);
        setContextOpen(action.contextOpen);
        setContextMode(action.contextMode);
      },
    }),
    [diffStyle, lineCommentProvider, theme, wrapLines],
  );

  if (summary.files.length === 0) {
    return (
      <div className={styles.parseError} role="alert">
        <b>WTS could not display this patch</b>
        <p>The repository returned a patch with no readable file changes.</p>
      </div>
    );
  }

  return (
    <div
      className={styles.viewer}
      data-context-open={contextOpen || undefined}
      data-line-comments={lineCommentProvider || undefined}
      data-ui="changes.viewer"
      data-ui-label="Code changes viewer"
      ref={viewerRef}
      style={
        {
          "--files-width": `${layoutWidths.files}px`,
          "--context-width": `${layoutWidths.context}px`,
        } as CSSProperties
      }
    >
      <aside
        className={styles.fileRail}
        aria-label="Changed files"
        data-ui="changes.files"
        data-ui-label="Changed files"
      >
        <header>
          <span>{summary.files.length} changed</span>
          <span className={styles.totalStats}>
            <b>+{summary.additions}</b>
            <i>-{summary.deletions}</i>
          </span>
        </header>
        <div className={styles.fileFilters} aria-label="Changed file filters">
          {(
            [
              ["code", "Code", productionCount],
              ["tests", "Tests", testCount],
              ["all", "All", summary.files.length],
            ] as Array<[FileFilter, string, number]>
          ).map(([value, label, count]) => (
            <button
              aria-label={`Show ${label.toLowerCase()}: ${count} changed ${count === 1 ? "file" : "files"}`}
              aria-pressed={fileFilter === value}
              disabled={count === 0}
              key={value}
              onClick={() => setFileFilter(value)}
              type="button"
            >
              {label}<span>{count}</span>
            </button>
          ))}
        </div>
        <nav>
          {visibleFiles.length === 0 && normalizedSearchQuery && (
            <p className={styles.noSearchResults}>No changed files match.</p>
          )}
          {visibleFiles.map((file) => {
            const change = changeLabel(file);
            const fileName = file.fileDiff.name.split("/").at(-1);
            return (
              <button
                aria-current={selectedFile?.id === file.id ? "true" : undefined}
                aria-label={`${file.fileDiff.name}, ${change.label.toLowerCase()}, ${lineCountLabel(file.additions, "addition")}, ${lineCountLabel(file.deletions, "deletion")}`}
                key={file.id}
                onClick={() => revealFile(file.id, true)}
                type="button"
              >
                <span
                  className={styles.changeType}
                  data-change={file.fileDiff.type}
                  title={change.label}
                >
                  {change.code}
                </span>
                <span className={styles.fileName}>
                  {fileName}
                  {fileName !== file.fileDiff.name && (
                    <small>{file.fileDiff.name}</small>
                  )}
                </span>
                <span className={styles.fileStats}>
                  <b>+{file.additions}</b>
                  <i>-{file.deletions}</i>
                </span>
              </button>
            );
          })}
        </nav>
      </aside>
      <div
        aria-label="Resize changed files"
        aria-keyshortcuts="ArrowLeft ArrowRight Home End"
        aria-orientation="vertical"
        aria-valuemax={FILE_RAIL_MAX}
        aria-valuemin={FILE_RAIL_MIN}
        aria-valuenow={layoutWidths.files}
        className={`${styles.resizeHandle} ${styles.filesResizeHandle}`}
        data-ui="changes.files-resizer"
        data-ui-label="Changed files resize handle"
        onDoubleClick={() => setBoundedLayoutWidth("files", FILE_RAIL_DEFAULT)}
        onKeyDown={(event) => resizePanelWithKeyboard("files", event)}
        onPointerDown={(event) => startPanelResize("files", event)}
        role="separator"
        tabIndex={0}
      >
        <span aria-hidden="true" />
      </div>
      <section
        className={styles.reviewPane}
        aria-label="Code changes"
        data-ui="changes.diff"
        data-ui-label="Code diff"
      >
        <div
          className={styles.toolbar}
          data-ui="changes.toolbar"
          data-ui-label="Code review toolbar"
        >
          <div
            className={styles.changeNavigator}
            aria-label="Navigate changes"
          >
            <button
              aria-label="Previous change"
              disabled={!changeTargets.length}
              onClick={() => moveChange("previous")}
              title="Previous change · Option-Up"
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 16 16">
                <path d="m4.5 9.5 3.5-3 3.5 3" />
              </svg>
            </button>
            <output aria-live="polite">
              {activeChangeIndex < 0
                ? `${changeTargets.length} ${changeTargets.length === 1 ? "change" : "changes"}`
                : `${activeChangeIndex + 1}/${changeTargets.length}`}
            </output>
            <button
              aria-label="Next change"
              disabled={!changeTargets.length}
              onClick={() => moveChange("next")}
              title="Next change · Option-Down"
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 16 16">
                <path d="m4.5 6.5 3.5 3 3.5-3" />
              </svg>
            </button>
          </div>
          <label className={styles.changeSearch}>
            <span>Find</span>
            <input
              aria-label="Search changed code"
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && searchMatches.length) {
                  event.preventDefault();
                  revealSearchMatch(
                    activeSearchMatch + (event.shiftKey ? -1 : 1),
                  );
                }
                if (event.key === "Escape" && searchQuery) {
                  event.preventDefault();
                  setSearchQuery("");
                }
              }}
              placeholder="Search changes"
              ref={searchInputRef}
              type="search"
              value={searchQuery}
            />
            {normalizedSearchQuery ? (
              <output aria-live="polite">
                {searchMatches.length
                  ? `${activeSearchMatch + 1}/${searchMatches.length}`
                  : "0/0"}
              </output>
            ) : (
              <kbd>⌘F</kbd>
            )}
          </label>
          <span
            className={styles.contextLegend}
            title="Lines without a plus or minus are not part of the change"
          >
            <i aria-hidden="true" /> Unchanged context
          </span>
          <button
            aria-controls="repository-review-context"
            aria-expanded={contextOpen}
            aria-label={contextOpen ? "Hide review context" : "Show review context"}
            className={styles.contextToggle}
            data-ui="changes.context-toggle"
            data-ui-label="Review context toggle"
            onClick={() => setContextOpen((current) => !current)}
            type="button"
          >
            Context
          </button>
          {feedback && selectedFile && (
            <label className={styles.fullFileToggle}>
              <input
                checked={Boolean(selectedFullFileState?.enabled)}
                disabled={selectedFullFileState?.status === "loading"}
                onChange={toggleFullFile}
                type="checkbox"
              />
              <span>Full file</span>
            </label>
          )}
          <div className={styles.segmented} aria-label="Expand or collapse files">
            <button aria-label="Expand all" onClick={handleExpandAll} type="button">
              Expand
            </button>
            <button aria-label="Collapse all" onClick={handleCollapseAll} type="button">
              Collapse
            </button>
          </div>
          <div className={styles.segmented} aria-label="Diff layout">
            <button
              aria-pressed={diffStyle === "unified"}
              onClick={() => setDiffStyle("unified")}
              type="button"
            >
              Unified
            </button>
            <button
              aria-pressed={diffStyle === "split"}
              onClick={() => setDiffStyle("split")}
              type="button"
            >
              Split
            </button>
          </div>
          <button
            aria-label="Wrap lines"
            aria-pressed={wrapLines}
            className={styles.wrapButton}
            onClick={() => setWrapLines((current) => !current)}
            type="button"
          >
            Wrap
          </button>
        </div>
        <div
          className={styles.codeView}
          data-ui="changes.code"
          data-ui-label="Changed code"
        >
          {selectedFullFileState?.status === "loading" && (
            <div className={styles.fullFileStatus} role="status">
              Loading the complete file…
            </div>
          )}
          {selectedFullFileState?.status === "error" && (
            <div className={styles.fullFileError} role="alert">
              {selectedFullFileState.error}
            </div>
          )}
          {visibleFiles.length === 0 && normalizedSearchQuery ? (
            <div className={styles.noCodeResults} role="status">
              No changed code matches “{searchQuery}”.
            </div>
          ) : (
            <div
              className={styles.scrollContainer}
              data-testid="patch-review-scroll"
              ref={scrollContainerRef}
              tabIndex={-1}
            >
              {visibleFiles.map((file) => {
                const isExpanded = expandedFileIds.has(file.id);
                const change = changeLabel(file);
                const isRenamed =
                  file.fileDiff.prevName &&
                  file.fileDiff.prevName !== file.fileDiff.name;
                return (
                  <div
                    className={styles.fileBlock}
                    data-full-file={
                      fullFiles[file.fileDiff.name]?.enabled &&
                      fullFiles[file.fileDiff.name]?.status === "ready"
                        ? "true"
                        : undefined
                    }
                    data-active-change={
                      changeTargets[activeChangeIndex]?.fileId === file.id ||
                      undefined
                    }
                    id={`file-block-${file.id}`}
                    key={file.id}
                    ref={(element) => {
                      if (element) fileBlockRefs.current.set(file.id, element);
                      else fileBlockRefs.current.delete(file.id);
                    }}
                  >
                    <button
                      aria-controls={`diff-body-${file.id}`}
                      aria-expanded={isExpanded}
                      className={styles.fileHeader}
                      onClick={() => toggleFileExpanded(file.id)}
                      type="button"
                    >
                      <svg
                        aria-hidden="true"
                        className={`${styles.chevron} ${
                          isExpanded ? styles.chevronExpanded : ""
                        }`}
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        viewBox="0 0 16 16"
                      >
                        <polyline points="6 4 10 8 6 12" />
                      </svg>
                      <span
                        className={styles.changeType}
                        data-change={file.fileDiff.type}
                        title={change.label}
                      >
                        {change.code}
                      </span>
                      <span className={styles.filePath}>
                        {isRenamed ? (
                          <>
                            <span className={styles.filePathRenamed}>
                              {file.fileDiff.prevName} →{" "}
                            </span>
                            {file.fileDiff.name}
                          </>
                        ) : (
                          file.fileDiff.name
                        )}
                      </span>
                      <span className={styles.fileStats}>
                        {fullFiles[file.fileDiff.name]?.enabled &&
                          fullFiles[file.fileDiff.name]?.status === "ready" && (
                            <em>Full file · neutral lines are unchanged</em>
                          )}
                        <b>+{file.additions}</b>
                        <i>-{file.deletions}</i>
                      </span>
                    </button>
                    {isExpanded && (
                      <div className={styles.diffBody} id={`diff-body-${file.id}`}>
                        <CodeView
                          ref={(handle) => {
                            if (handle) viewRefs.current.set(file.id, handle);
                            else viewRefs.current.delete(file.id);
                          }}
                          items={[{ id: file.id, type: "diff", fileDiff: file.fileDiff }]}
                          renderGutterUtility={(getHoveredLine, item) => {
                            const line = getHoveredLine();
                            if (
                              !lineCommentProvider ||
                              !line ||
                              !("side" in line) ||
                              (line.side !== "additions" && line.side !== "deletions")
                            ) return null;
                            return (
                              <button
                                aria-label={`Comment on ${line.side === "additions" ? "added" : "deleted"} line ${line.lineNumber}`}
                                className={styles.lineCommentButton}
                                onClick={() => {
                                  const currentLine = getHoveredLine();
                                  if (
                                    !currentLine ||
                                    !("side" in currentLine) ||
                                    (currentLine.side !== "additions" &&
                                      currentLine.side !== "deletions")
                                  ) return;
                                  const selected = selectedChangedPatchLine(summary.files, {
                                    id: item.id,
                                    range: {
                                      start: currentLine.lineNumber,
                                      side: currentLine.side,
                                    },
                                  });
                                  setSelectedFeedbackLine(selected);
                                  if (selected && feedback) {
                                    setContextOpen(true);
                                    setContextMode("feedback");
                                  }
                                }}
                                title="Comment on this line"
                                type="button"
                              >
                                <Glyph name="comment" size={13} />
                              </button>
                            );
                          }}
                          onSelectedLinesChange={(selection) => {
                            const selected = selectedChangedPatchLine(
                              summary.files,
                              selection,
                            );
                            setSelectedFeedbackLine(selected);
                            if (selected && feedback) {
                              setContextOpen(true);
                              setContextMode("feedback");
                            }
                          }}
                          options={options}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
      {contextOpen && (
        <>
          <div
            aria-label="Resize code review feedback"
            aria-keyshortcuts="ArrowLeft ArrowRight Home End"
            aria-orientation="vertical"
            aria-valuemax={CONTEXT_RAIL_MAX}
            aria-valuemin={CONTEXT_RAIL_MIN}
            aria-valuenow={layoutWidths.context}
            className={`${styles.resizeHandle} ${styles.contextResizeHandle}`}
            data-ui="changes.context-resizer"
            data-ui-label="Review feedback resize handle"
            onDoubleClick={() =>
              setBoundedLayoutWidth("context", CONTEXT_RAIL_DEFAULT)
            }
            onKeyDown={(event) => resizePanelWithKeyboard("context", event)}
            onPointerDown={(event) => startPanelResize("context", event)}
            role="separator"
            tabIndex={0}
          >
            <span aria-hidden="true" />
          </div>
          <aside
            className={styles.contextRail}
            aria-label="Review context"
            data-ui="changes.context"
            data-ui-label="Review context"
            id="repository-review-context"
          >
          <div
            className={styles.contextTabs}
            data-ui="changes.context-tabs"
            data-ui-label="Review context tabs"
          >
            <button
              aria-pressed={contextMode === "tests"}
              onClick={() => setContextMode("tests")}
              type="button"
            >
              Related tests
            </button>
            <button
              aria-pressed={contextMode === "references"}
              onClick={() => setContextMode("references")}
              type="button"
            >
              References
            </button>
            {feedback && (
              <button
                aria-pressed={contextMode === "feedback"}
                onClick={() => setContextMode("feedback")}
                type="button"
              >
                Feedback
              </button>
            )}
            <button
              aria-label="Close review context"
              className={styles.contextClose}
              onClick={() => setContextOpen(false)}
              type="button"
            >
              Close
            </button>
          </div>
          {contextMode === "feedback" && feedback ? (
            <CodeReviewFeedbackPanel
              client={feedback.client}
              repositoryId={feedback.repositoryId}
              selectedTarget={selectedFeedbackTarget}
              workspaceId={feedback.workspaceId}
              gitlabReview={feedback.gitlabReview}
            />
          ) : contextMode === "tests" ? (
            <div className={styles.contextBody}>
              <small>SELECTED FILE</small>
              <b>{selectedFile?.fileDiff.name.split("/").at(-1)}</b>
              {tests.length || graphTests.length ? (
                <ul>
                  {tests.map((test) => (
                    <li key={test.id}>
                      <button onClick={() => revealFile(test.id)} type="button">
                        <span>{test.fileDiff.name.split("/").at(-1)}</span>
                        <small>{test.fileDiff.name}</small>
                      </button>
                    </li>
                  ))}
                  {graphTests.map((path) => (
                    <li key={path}>
                      <div className={styles.graphResult}>
                        <span>{path.split("/").at(-1)}</span>
                        <small>Graph relationship · {path}</small>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No changed tests match this file.</p>
              )}
              <footer data-ready={graphReady || undefined}>
                <span />
                {reviewGraph
                  ? `Graphify context loaded${reviewGraph.truncated ? " with bounded results" : ""}.`
                  : "Build the workspace graph to discover tests outside this patch."}
              </footer>
            </div>
          ) : (
            <div className={styles.contextBody}>
            <small>SYMBOL</small>
            <b>{referenceSymbol || "Command-click a symbol"}</b>
            {references.length || graphReferences.length ? (
              <ul>
                {references.map((reference) => (
                  <li key={reference.fileId}>
                    <button onClick={() => revealFile(reference.fileId)} type="button">
                      <span>{reference.fileName.split("/").at(-1)}</span>
                      <small>{reference.matches} changed references · {reference.fileName}</small>
                    </button>
                  </li>
                ))}
                {graphReferences.map((path) => (
                  <li key={path}>
                    <div className={styles.graphResult}>
                      <span>{path.split("/").at(-1)}</span>
                      <small>Graph relationship · {path}</small>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                {referenceSymbol
                  ? "No other changed references were found."
                  : "Use Command-click on an identifier in the diff."}
              </p>
            )}
            <footer data-ready={graphReady || undefined}>
              <span />
              {reviewGraph
                ? `Graphify context loaded${reviewGraph.truncated ? " with bounded results" : ""}.`
                : "Build the workspace graph for repository-wide references."}
            </footer>
            </div>
          )}
          </aside>
        </>
      )}
    </div>
  );
}
