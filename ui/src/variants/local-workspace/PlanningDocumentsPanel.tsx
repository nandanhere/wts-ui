import { planningDocumentDisplayPath, resolvePlanningDocumentLink } from "./planningDocumentPaths";
import { isNativePreviewReadOnlyCode, nativePreviewAllowsCommand, NATIVE_PREVIEW_READ_ONLY_MESSAGE } from "../../lib/nativePreview";
import { RecoveryCopyButton } from "./RecoveryCopyButton";
import { requestAgentTask } from "../../lib/agentFeedbackEvents";
import { observePlanningSave, planningCacheFor, planningDocumentCacheKey, planningViewFor, publishPlanningSave, rememberPlanningView, type PlanningView } from "./planningWorkspaceCache";
import {
  isValidElement,
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { select } from "d3-selection";
import {
  zoom as createZoom,
  zoomIdentity,
  zoomTransform,
  type ZoomBehavior,
} from "d3-zoom";
import { Button } from "react-aria-components";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkImportedJiraDescription } from "./remarkImportedJiraDescription";
import { useTheme } from "../../theme";
import {
  type FixedWorkspacePlanningDocumentId,
  type ReviewAnchorState,
  type WorkspaceClient,
  WorkspaceClientError,
  type WorkspacePlanningDocument,
  type WorkspacePlanningDocumentDescriptor,
  type WorkspacePlanningDocumentId,
  type WorkspaceReviewThread,
} from "../../lib/wtsClient";
import { Glyph } from "./Glyph";
import styles from "./PlanningDocumentsPanel.module.css";

const DOCUMENT_ORDER: FixedWorkspacePlanningDocumentId[] = [
  "plan",
  "kanban",
  "findings",
  "programBacklog",
  "readme",
];

const DOCUMENT_LABELS: Record<FixedWorkspacePlanningDocumentId, string> = {
  findings: "FINDINGS.md",
  kanban: "KANBAN.md",
  plan: "PLAN.md",
  programBacklog: "PROGRAM-BACKLOG.md",
  readme: "README.md",
};

const DOCUMENT_DESCRIPTIONS: Record<FixedWorkspacePlanningDocumentId, string> = {
  findings: "Agent findings and evidence",
  kanban: "Current work and next tasks",
  plan: "Scope, decisions, and approach",
  programBacklog: "Longer-term work",
  readme: "Workspace planning guide",
};

type RequestState = "loading" | "ready" | "error";
type SaveState = "idle" | "saving" | "error" | "conflict";
type FeedbackCreateState = "idle" | "saving" | "error";
type DocumentView = "preview" | "source";
type DocumentFilter = "current" | "old" | "all";

const MERMAID_MAX_CHARACTERS = 50_000;
const MERMAID_MIN_ZOOM = 0.1;
const MERMAID_MAX_ZOOM = 8;
const MERMAID_ZOOM_FACTOR = 1.25;
const PLANNING_FILE_STATES_STORAGE_KEY = "wts.planning-file-states.v1";

function clampMermaidZoom(zoom: number) {
  const clamped = Math.min(
    MERMAID_MAX_ZOOM,
    Math.max(MERMAID_MIN_ZOOM, zoom),
  );
  return Math.round(clamped * 1_000) / 1_000;
}

interface SanitizedMermaidSvg {
  height: number;
  markup: string;
  width: number;
}

function oldDocumentIdsForWorkspace(workspaceId: string) {
  try {
    const value = JSON.parse(
      globalThis.localStorage?.getItem(PLANNING_FILE_STATES_STORAGE_KEY) ?? "{}",
    ) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return new Set<WorkspacePlanningDocumentId>();
    }
    const documentIds = (value as Record<string, unknown>)[workspaceId];
    return new Set(
      Array.isArray(documentIds)
        ? documentIds.filter(
            (documentId): documentId is WorkspacePlanningDocumentId =>
              typeof documentId === "string",
          )
        : [],
    );
  } catch {
    return new Set<WorkspacePlanningDocumentId>();
  }
}

function saveOldDocumentIds(
  workspaceId: string,
  documentIds: ReadonlySet<WorkspacePlanningDocumentId>,
) {
  try {
    const stored = JSON.parse(
      globalThis.localStorage?.getItem(PLANNING_FILE_STATES_STORAGE_KEY) ?? "{}",
    ) as unknown;
    const next =
      stored && typeof stored === "object" && !Array.isArray(stored)
        ? { ...stored }
        : {};
    (next as Record<string, unknown>)[workspaceId] = [...documentIds];
    globalThis.localStorage?.setItem(
      PLANNING_FILE_STATES_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch {
    // The list still works when the webview does not permit local storage.
  }
}

interface SelectionCheckboxProps {
  checked: boolean | "mixed";
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}

function SelectionCheckbox({
  checked,
  disabled = false,
  label,
  onChange,
}: SelectionCheckboxProps) {
  return (
    <input
      aria-checked={checked}
      aria-label={label}
      checked={checked === true}
      className={styles.selectionCheckbox}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.checked)}
      ref={(element) => {
        if (element) element.indeterminate = checked === "mixed";
      }}
      type="checkbox"
    />
  );
}

function normalizeMermaidSource(source: string) {
  return source.replace(
    /^(?:(?:&#x20;|&#32;|&nbsp;))+/gim,
    (indentation) => indentation.replace(/(?:&#x20;|&#32;|&nbsp;)/gi, " "),
  );
}

function mermaidCompatibilitySource(source: string) {
  return normalizeMermaidSource(source).replace(
    /\|"([^"\r\n]*)"\|/g,
    "|$1|",
  );
}

function sanitizeMermaidSvg(svg: string) {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (
    document.querySelector("parsererror") ||
    document.documentElement.localName !== "svg"
  ) {
    throw new Error("Mermaid returned invalid SVG.");
  }

  document
    .querySelectorAll("script, iframe, object, embed, link, meta")
    .forEach((element) => element.remove());
  document.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        name.startsWith("on") ||
        ((name === "href" || name === "xlink:href" || name === "src") &&
          !value.startsWith("#")) ||
        (name === "style" && /url\s*\(/i.test(value))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  const viewBox = (document.documentElement.getAttribute("viewBox") ?? "")
    .split(/[\s,]+/)
    .map(Number);
  const width =
    viewBox.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2]! > 0
      ? viewBox[2]!
      : Number.parseFloat(document.documentElement.getAttribute("width") ?? "") ||
        800;
  const height =
    viewBox.length === 4 && Number.isFinite(viewBox[3]) && viewBox[3]! > 0
      ? viewBox[3]!
      : Number.parseFloat(document.documentElement.getAttribute("height") ?? "") ||
        600;
  return {
    height,
    markup: new XMLSerializer().serializeToString(document.documentElement),
    width,
  } satisfies SanitizedMermaidSvg;
}

function displayFileName(fileName: string) {
  return fileName.split(/[\\/]/).pop() || "Planning file";
}

function documentLabel(
  document: Pick<WorkspacePlanningDocumentDescriptor, "documentId" | "fileName">,
) {
  return (
    DOCUMENT_LABELS[
      document.documentId as FixedWorkspacePlanningDocumentId
    ] ?? displayFileName(document.fileName)
  );
}

function documentPath(document: Pick<WorkspacePlanningDocumentDescriptor, "documentId" | "fileName">) {
  return DOCUMENT_LABELS[document.documentId as FixedWorkspacePlanningDocumentId] ?? planningDocumentDisplayPath(document.fileName);
}

function parentFolders(document: WorkspacePlanningDocumentDescriptor) {
  const parts = documentPath(document).split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

interface PlanningFolder {
  path: string;
  name: string;
  files: WorkspacePlanningDocumentDescriptor[];
  folders: Map<string, PlanningFolder>;
}
function planningFolders(documents: WorkspacePlanningDocumentDescriptor[]): PlanningFolder {
  const root: PlanningFolder = { path: "", name: "", files: [], folders: new Map() };
  for (const document of documents) {
    let folder = root;
    for (const path of parentFolders(document)) {
      if (!folder.folders.has(path)) folder.folders.set(path, { path, name: path.split("/").at(-1)!, files: [], folders: new Map() });
      folder = folder.folders.get(path)!;
    }
    folder.files.push(document);
  }
  return root;
}

function documentDescription(document: WorkspacePlanningDocumentDescriptor) {
  const fixed = DOCUMENT_DESCRIPTIONS[
    document.documentId as FixedWorkspacePlanningDocumentId
  ];
  if (fixed) return fixed;
  return /\.csv$/i.test(document.fileName)
    ? "Generated evidence data"
    : "Generated planning file";
}

function safeMarkdownUrl(url: string) {
  const safeUrl = defaultUrlTransform(url);
  if (!safeUrl || safeUrl.startsWith("//")) return undefined;
  if (
    /^[a-z][a-z\d+.-]*:/i.test(safeUrl) &&
    !/^https?:/i.test(safeUrl)
  ) {
    return undefined;
  }
  return safeUrl;
}

interface MermaidDiagramProps {
  source: string;
}

function MermaidDiagram({ source }: MermaidDiagramProps) {
  const { resolvedTheme } = useTheme();
  const normalizedSource = useMemo(() => normalizeMermaidSource(source), [source]);
  const reactId = useId();
  const diagramId = useMemo(
    () => `planning-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [reactId],
  );
  const [svgData, setSvgData] = useState<SanitizedMermaidSvg | null>(null);
  const [zoom, setZoom] = useState(1);
  const viewportRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const zoomBehaviorRef = useRef<ZoomBehavior<HTMLDivElement, unknown> | null>(
    null,
  );
  const fitDiagramRef = useRef<() => void>(() => undefined);
  const [renderState, setRenderState] = useState<
    "loading" | "ready" | "error" | "oversize"
  >(
    normalizedSource.length > MERMAID_MAX_CHARACTERS ? "oversize" : "loading",
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    const camera = cameraRef.current;
    if (!viewport || !camera || !svgData) return;

    const selection = select<HTMLDivElement, unknown>(viewport);
    const behavior = createZoom<HTMLDivElement, unknown>()
      .scaleExtent([MERMAID_MIN_ZOOM, MERMAID_MAX_ZOOM])
      .constrain((transform) => transform)
      .filter((event) => event.type !== "wheel" || event.ctrlKey)
      .on("zoom", (event) => {
        const transform = event.transform;
        camera.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.k})`;
        setZoom(transform.k);
      });
    zoomBehaviorRef.current = behavior;
    selection.call(behavior).on("dblclick.zoom", null);

    const fitDiagram = () => {
      if (viewport.clientWidth <= 0 || viewport.clientHeight <= 0) {
        selection.call(behavior.transform, zoomIdentity);
        return;
      }
      const padding = 32;
      const scale = clampMermaidZoom(
        Math.min(
          (viewport.clientWidth - padding * 2) / svgData.width,
          (viewport.clientHeight - padding * 2) / svgData.height,
        ),
      );
      const x = (viewport.clientWidth - svgData.width * scale) / 2;
      const y = (viewport.clientHeight - svgData.height * scale) / 2;
      selection.call(
        behavior.transform,
        zoomIdentity.translate(x, y).scale(scale),
      );
    };
    fitDiagramRef.current = fitDiagram;
    fitDiagram();

    const handleWheelPan = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const current = zoomTransform(viewport);
      selection.call(
        behavior.transform,
        zoomIdentity
          .translate(current.x - event.deltaX, current.y - event.deltaY)
          .scale(current.k),
      );
    };
    let gestureStartZoom = zoomTransform(viewport).k;
    const handleGestureStart = (event: Event) => {
      event.preventDefault();
      gestureStartZoom = zoomTransform(viewport).k;
    };
    const handleGestureChange = (event: Event) => {
      event.preventDefault();
      const scale = (event as Event & { scale?: number }).scale;
      if (!Number.isFinite(scale)) return;
      selection.call(
        behavior.scaleTo,
        clampMermaidZoom(gestureStartZoom * (scale ?? 1)),
      );
    };

    viewport.addEventListener("wheel", handleWheelPan, { passive: false });
    viewport.addEventListener("gesturestart", handleGestureStart, {
      passive: false,
    });
    viewport.addEventListener("gesturechange", handleGestureChange, {
      passive: false,
    });
    return () => {
      selection.on(".zoom", null);
      viewport.removeEventListener("wheel", handleWheelPan);
      viewport.removeEventListener("gesturestart", handleGestureStart);
      viewport.removeEventListener("gesturechange", handleGestureChange);
      zoomBehaviorRef.current = null;
      fitDiagramRef.current = () => undefined;
    };
  }, [svgData]);

  const scaleDiagram = useCallback((factor: number) => {
    const viewport = viewportRef.current;
    const behavior = zoomBehaviorRef.current;
    if (!viewport || !behavior) return;
    select<HTMLDivElement, unknown>(viewport).call(behavior.scaleBy, factor);
  }, []);

  useEffect(() => {
    if (normalizedSource.length > MERMAID_MAX_CHARACTERS) {
      setSvgData(null);
      setRenderState("oversize");
      return;
    }

    let current = true;
    setSvgData(null);
    setRenderState("loading");

    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: resolvedTheme === "dark" ? "dark" : "neutral",
        });
        let svg: string;
        try {
          ({ svg } = await mermaid.render(diagramId, normalizedSource));
        } catch (error) {
          const compatibleSource = mermaidCompatibilitySource(normalizedSource);
          if (compatibleSource === normalizedSource) throw error;
          ({ svg } = await mermaid.render(
            `${diagramId}-compatible`,
            compatibleSource,
          ));
        }
        if (!current) return;
        setSvgData(sanitizeMermaidSvg(svg));
        setRenderState("ready");
      })
      .catch(() => {
        if (!current) return;
        setRenderState("error");
      });

    return () => {
      current = false;
    };
  }, [diagramId, normalizedSource, resolvedTheme]);

  if (renderState === "ready" && svgData) {
    const zoomPercentage = Math.round(zoom * 1_000) / 10;
    return (
      <figure className={styles.mermaidDiagram}>
        <div
          aria-label="Mermaid diagram zoom"
          className={styles.mermaidToolbar}
          role="toolbar"
        >
          <button
            aria-label="Zoom out"
            disabled={zoom <= MERMAID_MIN_ZOOM}
            onClick={() => scaleDiagram(1 / MERMAID_ZOOM_FACTOR)}
            type="button"
          >
            −
          </button>
          <output aria-label="Diagram zoom">{Math.round(zoomPercentage)}%</output>
          <button
            aria-label="Zoom in"
            disabled={zoom >= MERMAID_MAX_ZOOM}
            onClick={() => scaleDiagram(MERMAID_ZOOM_FACTOR)}
            type="button"
          >
            +
          </button>
          <button
            aria-label="Reset diagram zoom"
            onClick={() => fitDiagramRef.current()}
            type="button"
          >
            Fit
          </button>
        </div>
        <div
          aria-label="Mermaid diagram canvas"
          className={styles.mermaidViewport}
          ref={viewportRef}
          role="region"
        >
          <div
            aria-label="Mermaid diagram"
            className={styles.mermaidCanvas}
            dangerouslySetInnerHTML={{ __html: svgData.markup }}
            ref={cameraRef}
            role="img"
            style={{ height: svgData.height, width: svgData.width }}
          />
        </div>
      </figure>
    );
  }

  if (renderState === "loading") {
    return (
      <div className={styles.mermaidState} role="status">
        <span className={styles.spinner} aria-hidden="true" />
        <span>WTS renders the diagram.</span>
      </div>
    );
  }

  return (
    <figure className={styles.mermaidFallback}>
      <figcaption>
        {renderState === "oversize"
          ? "This diagram is too large to render."
          : "WTS could not render this diagram."}
      </figcaption>
      <pre>
        <code>{source}</code>
      </pre>
    </figure>
  );
}

function codeText(children: ReactNode) {
  return String(children).replace(/\n$/, "");
}

export function MermaidCodeBlock({ children }: { children?: ReactNode }) {
  if (
    isValidElement<{
      children?: ReactNode;
      className?: string;
    }>(children) &&
    /^language-mermaid(?:\s|$)/.test(children.props.className ?? "")
  ) {
    return <MermaidDiagram source={codeText(children.props.children)} />;
  }
  return <pre>{children}</pre>;
}

const planningMarkdownComponents: Components = {
  a: ({ children, href }) => {
    const safeHref = href ? safeMarkdownUrl(href) : undefined;
    return safeHref ? (
      <a href={safeHref} rel="noreferrer" target="_blank">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  code: ({ children, className, ...props }) => (
    <code className={className} {...props}>
      {children}
    </code>
  ),
  img: ({ alt }) => (
    <span className={styles.blockedImage} role="note">
      Image not loaded{alt ? `: ${alt}` : ""}
    </span>
  ),
  pre: MermaidCodeBlock,
};

interface PlanningPreviewProps {
  document: WorkspacePlanningDocument;
  descriptor: WorkspacePlanningDocumentDescriptor;
  documents: WorkspacePlanningDocumentDescriptor[];
  onOpenDocument: (documentId: WorkspacePlanningDocumentId) => boolean;
}

const PlanningPreview = memo(function PlanningPreview({
  document, descriptor, documents, onOpenDocument,
}: PlanningPreviewProps) {
  const components = useMemo<Components>(() => ({ ...planningMarkdownComponents,
    a: ({ children, href }) => {
      const target = href ? resolvePlanningDocumentLink(documents, descriptor, href) : undefined;
      if (target) return (
        <button className={styles.documentLink} onClick={() => onOpenDocument(target.documentId)} type="button">
          {children}
        </button>
      );
      const safeHref = href ? safeMarkdownUrl(href) : undefined;
      if (safeHref?.startsWith("#")) return <a href={safeHref}>{children}</a>;
      return safeHref && /^https?:/i.test(safeHref)
        ? <a href={safeHref} rel="noreferrer" target="_blank">{children}</a> : <span>{children}</span>;
    },
  }), [descriptor, documents, onOpenDocument]);
  const label = documentLabel(document);
  if (/\.(?:mmd|mermaid)$/i.test(document.fileName)) {
    return (
      <article
        aria-label={`${label} preview`}
        className={styles.previewView}
        data-history-swipe-block
      >
        <MermaidDiagram source={document.contents} />
      </article>
    );
  }

  if (/\.(?:csv|txt)$/i.test(document.fileName)) {
    return (
      <article
        aria-label={`${label} preview`}
        className={styles.previewView}
        data-history-swipe-block
      >
        <pre><code>{document.contents}</code></pre>
      </article>
    );
  }

  return (
    <article
      aria-label={`${label} preview`}
      className={styles.previewView}
      data-history-swipe-block
    >
      <ReactMarkdown
        components={components}
        remarkPlugins={[remarkGfm, remarkImportedJiraDescription]}
        skipHtml
        urlTransform={safeMarkdownUrl}
      >
        {document.contents}
      </ReactMarkdown>
    </article>
  );
});

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

function lineTone(line: string) {
  if (/^\s{0,3}#{1,6}\s/.test(line)) return "heading";
  if (/^\s*(?:[-*+]\s+)?\[[ xX]\]\s/.test(line)) return "task";
  if (/^\s*>/.test(line)) return "quote";
  if (/^\s*```/.test(line)) return "fence";
  return "plain";
}

function sortedDocuments(
  documents: WorkspacePlanningDocumentDescriptor[],
) {
  const order = new Map(
    DOCUMENT_ORDER.map((documentId, index) => [documentId, index]),
  );
  return [...documents].sort(
    (left, right) => {
      const orderDifference =
        (order.get(left.documentId as FixedWorkspacePlanningDocumentId) ??
          DOCUMENT_ORDER.length) -
        (order.get(right.documentId as FixedWorkspacePlanningDocumentId) ??
          DOCUMENT_ORDER.length);
      return orderDifference || left.fileName.localeCompare(right.fileName);
    },
  );
}

function anchorLabel(line: number | undefined) {
  return line === undefined ? "Whole file" : `Line ${line}`;
}

function anchorWarning(anchorState: ReviewAnchorState) {
  if (anchorState === "stale") return "Stale source";
  if (anchorState === "unavailable") return "Source unavailable";
  return null;
}

function sortedThreads(threads: WorkspaceReviewThread[]) {
  return [...threads].sort((left, right) => {
    if (left.state !== right.state) return left.state === "open" ? -1 : 1;
    return right.updatedAtUnixMs - left.updatedAtUnixMs;
  });
}

interface PlanningSourceProps {
  document: WorkspacePlanningDocument;
  openThreadLines: ReadonlySet<number>;
  selectedLine: number | null;
  onSelectLine: (line: number | null) => void;
}

function PlanningSource({
  document,
  openThreadLines,
  selectedLine,
  onSelectLine,
}: PlanningSourceProps) {
  const lines = useMemo(() => document.contents.split("\n"), [document.contents]);
  const lineButtonsRef = useRef(new Map<number, HTMLButtonElement>());

  const selectFromKey = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    lineNumber: number,
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onSelectLine(null);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    let nextLine = lineNumber;
    if (event.key === "ArrowDown") {
      nextLine = Math.min(lines.length, lineNumber + 1);
    } else if (event.key === "ArrowUp") {
      nextLine = Math.max(1, lineNumber - 1);
    } else if (event.key === "Home") {
      nextLine = 1;
    } else if (event.key === "End") {
      nextLine = lines.length;
    }
    onSelectLine(nextLine);
    window.requestAnimationFrame(() =>
      lineButtonsRef.current.get(nextLine)?.focus(),
    );
  };

  return (
    <div
      aria-label={`${documentLabel(document)} contents`}
      className={styles.sourceView}
      data-history-swipe-block
      role="region"
    >
      <ol aria-label="File source. Select a line to add feedback.">
        {lines.map((line, index) => {
          const lineNumber = index + 1;
          const selected = selectedLine === lineNumber;
          return (
            <li data-tone={lineTone(line)} key={`${index}-${line}`}>
              <button
                aria-label={`Line ${lineNumber}: ${line.trim() || "Blank line"}`}
                aria-pressed={selected}
                className={styles.sourceLine}
                data-has-thread={openThreadLines.has(lineNumber) || undefined}
                data-selected={selected || undefined}
                onClick={() => onSelectLine(selected ? null : lineNumber)}
                onKeyDown={(event) => selectFromKey(event, lineNumber)}
                ref={(element) => {
                  if (element) {
                    lineButtonsRef.current.set(lineNumber, element);
                  } else {
                    lineButtonsRef.current.delete(lineNumber);
                  }
                }}
                tabIndex={
                  selectedLine === null
                    ? lineNumber === 1
                      ? 0
                      : -1
                    : selected
                      ? 0
                      : -1
                }
                type="button"
              >
                <span className={styles.lineNumber} aria-hidden="true">
                  {lineNumber}
                </span>
                <code>{line || "\u00a0"}</code>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

interface FeedbackThreadProps {
  resolving: boolean;
  thread: WorkspaceReviewThread;
  onResolve: (thread: WorkspaceReviewThread) => void;
}

function FeedbackThread({
  resolving,
  thread,
  onResolve,
}: FeedbackThreadProps) {
  if (thread.target.kind !== "planningDocument") return null;
  const warning = anchorWarning(thread.anchorState);
  const location = anchorLabel(thread.target.line);

  return (
    <article
      aria-label={`${thread.state === "open" ? "Open" : "Resolved"} feedback on ${location.toLowerCase()}`}
      className={styles.feedbackThread}
      data-resolved={thread.state === "resolved" || undefined}
    >
      <header>
        <span className={styles.anchorBadge}>{location}</span>
        {warning && (
          <span className={styles.anchorWarning} data-state={thread.anchorState}>
            {warning}
          </span>
        )}
        {thread.state === "resolved" && (
          <span className={styles.resolvedBadge}>
            <Glyph name="check" size={12} />
            Resolved
          </span>
        )}
      </header>
      <div className={styles.commentList}>
        {thread.comments.map((comment) => (
          <div className={styles.comment} key={comment.commentId}>
            <b>{comment.author === "agent" ? "Agent" : "You"}</b>
            <p>{comment.body}</p>
          </div>
        ))}
      </div>
      {thread.state === "open" && (
        <footer>
          <Button
            className={styles.resolveButton}
            isDisabled={resolving}
            onPress={() => onResolve(thread)}
          >
            <Glyph name="check" size={13} />
            {resolving ? "Resolving…" : "Resolve"}
          </Button>
        </footer>
      )}
    </article>
  );
}

export interface PlanningDocumentsPanelProps {
  client: WorkspaceClient;
  workspaceId: string;
  workspaceKey: string;
  /** The workspace title. It lets the plan starter describe the real goal. */
  workspaceTitle?: string;
  onNotice?: (message: string, kind?: "info" | "error") => void;
  onCreatePlanningHome?: () => void;
}

const TEMPLATE_MARKER = /^\s*[-*]?\s*_?TODO:/;

/** A PLAN.md that still has only template prompts gets a starter. Other files and written plans do not. */
export function planStarterNeeded(document: { fileName: string; contents: string }): boolean {
  const name = document.fileName.split("/").at(-1)?.toUpperCase();
  if (name !== "PLAN.MD") return false;
  const lines = document.contents.split("\n").map((line) => line.trim()).filter(Boolean);
  const written = lines.filter((line) => !line.startsWith("#") && !TEMPLATE_MARKER.test(line) && !/^[-*]\s*\[[ x]\]\s*Define the first bounded deliverable\.?$/i.test(line));
  return lines.some((line) => TEMPLATE_MARKER.test(line)) && written.length === 0;
}

export function planStarterPrompt(title: string, fileName: string): string {
  const review = /^Review\s/i.test(title) || /![0-9]+/.test(title);
  return review
    ? `Write a review plan for "${title}" in ${fileName}. Read the merge request changes in this workspace. State the objective, the files and risks to check first, the tests to run, and the open questions for the author. Keep the file headings. Do not change source code.`
    : `Write a first plan for "${title}" in ${fileName}. Read this workspace. State the objective, the first bounded deliverable, the non-goals, and the decisions that block progress. Keep the file headings. Do not change source code.`;
}

export function PlanningDocumentsPanel(props: PlanningDocumentsPanelProps) {
  const cache = planningCacheFor(props.client);
  return <PlanningDocumentsPanelContent key={`${cache.id}:${props.workspaceId}`} {...props} />;
}

function PlanningDocumentsPanelContent({
  client,
  workspaceId,
  workspaceKey,
  workspaceTitle,
  onNotice,
  onCreatePlanningHome,
}: PlanningDocumentsPanelProps) {
  const cache = planningCacheFor(client);
  const [initialView] = useState(() => planningViewFor(client, workspaceId));
  const initialDocuments = cache.lists.get(workspaceId) ??
    (initialView?.document && (initialView.editing || initialView.feedbackDraft.trim())
      ? [{ documentId: initialView.document.documentId, fileName: initialView.document.fileName }]
      : undefined);
  const hasRetainedDraft = Boolean(initialView?.editing || initialView?.feedbackDraft.trim());
  const initialSelectedId = hasRetainedDraft || initialDocuments?.some((item) => item.documentId === initialView?.selectedId)
    ? initialView?.selectedId ?? null
    : initialDocuments?.[0]?.documentId ?? null;
  const initialDocument = hasRetainedDraft ? initialView?.document ?? null
    : initialSelectedId ? cache.documents.get(planningDocumentCacheKey(workspaceId, initialSelectedId)) ?? null : null;
  const [documents, setDocuments] = useState<
    WorkspacePlanningDocumentDescriptor[]
  >(initialDocuments ?? []);
  const [listState, setListState] = useState<RequestState>(initialDocuments ? "ready" : "loading");
  const [listError, setListError] = useState("");
  const [listErrorCode, setListErrorCode] = useState("");
  const [listRevision, setListRevision] = useState(0);
  const [documentQuery, setDocumentQuery] = useState(initialView?.query ?? "");
  const [documentFilter, setDocumentFilter] =
    useState<DocumentFilter>(initialView?.filter ?? "current");
  const [oldDocumentIds, setOldDocumentIds] = useState(() =>
    oldDocumentIdsForWorkspace(workspaceId),
  );
  const [collapsedFolders, setCollapsedFolders] = useState(() => new Set(initialView?.collapsedFolders ?? []));
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<
    Set<WorkspacePlanningDocumentId>
  >(new Set());
  const [selectedId, setSelectedId] =
    useState<WorkspacePlanningDocumentId | null>(initialSelectedId);
  const [document, setDocument] =
    useState<WorkspacePlanningDocument | null>(initialDocument);
  const [documentState, setDocumentState] = useState<RequestState>(initialDocument ? "ready" : "loading");
  const [documentError, setDocumentError] = useState("");
  const [documentErrorCode, setDocumentErrorCode] = useState("");
  const [editorOpenState, setEditorOpenState] = useState<"idle" | "opening" | "error">("idle");
  const [editorOpenError, setEditorOpenError] = useState("");
  const editorOpenGeneration = useRef(0);
  useEffect(() => () => { editorOpenGeneration.current += 1; }, []);
  const [documentRevision, setDocumentRevision] = useState(0);
  const [documentView, setDocumentView] = useState<DocumentView>(initialView?.documentView ?? "preview");
  const [editing, setEditing] = useState(initialView?.editing ?? false);
  const [draft, setDraft] = useState(initialView?.editing ? initialView.draft : initialDocument?.contents ?? "");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [saveErrorCode, setSaveErrorCode] = useState("");
  const previewReadOnly = !nativePreviewAllowsCommand("update_workspace_planning_document") || isNativePreviewReadOnlyCode(saveErrorCode);
  const [selectionMessage, setSelectionMessage] = useState("");
  const [threads, setThreads] = useState<WorkspaceReviewThread[]>(cache.threads.get(workspaceId) ?? []);
  const [feedbackState, setFeedbackState] =
    useState<RequestState>(cache.threads.has(workspaceId) ? "ready" : "loading");
  const [feedbackError, setFeedbackError] = useState("");
  const [feedbackRevision, setFeedbackRevision] = useState(0);
  const [selectedLine, setSelectedLine] = useState<number | null>(initialView?.selectedLine ?? null);
  const [feedbackDraft, setFeedbackDraft] = useState(initialView?.feedbackDraft ?? "");
  const [createState, setCreateState] =
    useState<FeedbackCreateState>("idle");
  const [createError, setCreateError] = useState("");
  const [resolvingThreadId, setResolvingThreadId] = useState<string | null>(
    null,
  );
  const [resolveError, setResolveError] = useState("");
  const documentRequestRef = useRef(0);
  const feedbackRequestRef = useRef(0);
  const feedbackContextRef = useRef(0);
  const feedbackCreatePendingRef = useRef(false);
  const [feedbackCreatePending, setFeedbackCreatePending] = useState(false);
  const documentButtonsRef = useRef(
    new Map<WorkspacePlanningDocumentId, HTMLButtonElement>(),
  );

  const dirty = Boolean(document && draft !== document.contents);
  const filteredDocuments = useMemo(() => {
    const query = documentQuery.trim().toLocaleLowerCase();
    return documents.filter((item) => {
      const old = oldDocumentIds.has(item.documentId);
      if (documentFilter === "current" && old) return false;
      if (documentFilter === "old" && !old) return false;
      return (
        !query ||
        documentPath(item).toLocaleLowerCase().includes(query) ||
        documentDescription(item).toLocaleLowerCase().includes(query)
      );
    });
  }, [documentFilter, documentQuery, documents, oldDocumentIds]);
  const folderTree = useMemo(() => planningFolders(filteredDocuments), [filteredDocuments]);
  const searchExpanded = Boolean(documentQuery.trim());
  const visibleDocuments = useMemo(() => {
    const visible: WorkspacePlanningDocumentDescriptor[] = [];
    const visit = (folder: PlanningFolder) => {
      visible.push(...folder.files);
      for (const child of folder.folders.values()) {
        if (searchExpanded || !collapsedFolders.has(child.path)) visit(child);
      }
    };
    visit(folderTree);
    return visible;
  }, [folderTree, collapsedFolders, searchExpanded]);
  const selectedDocuments = useMemo(
    () => documents.filter((item) => selectedDocumentIds.has(item.documentId)),
    [documents, selectedDocumentIds],
  );
  const selectedVisibleCount = visibleDocuments.filter((item) =>
    selectedDocumentIds.has(item.documentId),
  ).length;
  const allVisibleSelected =
    visibleDocuments.length > 0 &&
    selectedVisibleCount === visibleDocuments.length;
  const visibleSelectionState: boolean | "mixed" = allVisibleSelected
    ? true
    : selectedVisibleCount > 0
      ? "mixed"
      : false;
  const selectedHasOld = selectedDocuments.some((item) =>
    oldDocumentIds.has(item.documentId),
  );
  const selectedHasCurrent = selectedDocuments.some(
    (item) => !oldDocumentIds.has(item.documentId),
  );

  const editStateRef = useRef({ editing, document, draft, feedbackDraft });
  editStateRef.current = { editing, document, draft, feedbackDraft };

  const currentView: PlanningView = {
    selectedId, document, documentView, editing, draft,
    query: documentQuery, filter: documentFilter, feedbackDraft, selectedLine, collapsedFolders: [...collapsedFolders],
  };
  const retainDraft = (next: Partial<PlanningView>): boolean => {
    if (rememberPlanningView(client, workspaceId, { ...currentView, ...next })) return true;
    setSelectionMessage("WTS has 24 unfinished planning drafts. Save or clear one before you edit another workspace.");
    return false;
  };

  useEffect(() => {
    rememberPlanningView(client, workspaceId, currentView);
  });

  useEffect(() => () => {
    documentRequestRef.current += 1;
    feedbackRequestRef.current += 1;
    feedbackContextRef.current += 1;
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    return observePlanningSave(client, workspaceId, selectedId, (event) => {
      if (event.state === "saving") {
        setSaveState("saving");
        setSaveError("");
      } else if (event.state === "saved") {
        const current = editStateRef.current;
        if (current.document?.documentId !== event.document.documentId || current.document.sha256 !== event.previousSha256) {
          setSaveState("idle");
          return;
        }
        const hasNewerDraft = current.editing && current.draft !== event.submittedContents;
        setDocument(event.document);
        if (!hasNewerDraft) {
          setDraft(event.document.contents);
          setEditing(false);
          setDocumentView("preview");
        }
        setSaveState("idle");
        setSelectedLine(null);
        feedbackContextRef.current += 1;
        setFeedbackRevision((revision) => revision + 1);
        onNotice?.(`${documentLabel(event.document)} saved`);
      } else {
        setSaveErrorCode(event.error instanceof WorkspaceClientError ? event.error.code : "");
        const isConflict = event.error instanceof WorkspaceClientError && event.error.code === "planning_document_conflict";
        setSaveState(isConflict ? "conflict" : "error");
        setSaveError(isConflict
          ? "This file changed after you opened it. Reload the latest version before you edit it again."
          : errorMessage(event.error, "The planning file could not be saved."));
        onNotice?.("The planning file was not saved", "error");
      }
    });
  }, [client, onNotice, selectedId, workspaceId]);

  useEffect(() => {
    let current = true;
    setListState(cache.lists.has(workspaceId) || editStateRef.current.editing || editStateRef.current.feedbackDraft.trim() ? "ready" : "loading");
    setListError("");
    setListErrorCode("");
    void cache.lists.load(workspaceId, async () => {
      const result = await client.listWorkspacePlanningDocuments(workspaceId);
      if (result.workspaceId !== workspaceId) {
        throw new Error("WTS returned planning files for another workspace.");
      }
      const nextDocuments = sortedDocuments(result.documents);
      for (const previous of cache.lists.get(workspaceId) ?? []) {
        if (!nextDocuments.some((item) => item.documentId === previous.documentId)) {
          cache.documents.delete(planningDocumentCacheKey(workspaceId, previous.documentId));
        }
      }
      return nextDocuments;
    }).then((nextDocuments) => {
      if (!current) return;
      setDocuments(nextDocuments);
      setSelectedId((selected) => {
        if (nextDocuments.some((item) => item.documentId === selected)) return selected;
        // Keep an unfinished edit if its file was removed outside WTS.
        const edit = editStateRef.current;
        if ((edit.editing || edit.feedbackDraft.trim()) && edit.document?.documentId === selected) return selected;
        return nextDocuments.find((item) => !oldDocumentIdsForWorkspace(workspaceId).has(item.documentId))?.documentId
          ?? nextDocuments[0]?.documentId ?? null;
      });
      setListState("ready");
    }).catch((error: unknown) => {
      if (!current) return;
      setListErrorCode(error instanceof WorkspaceClientError ? error.code : "");
      setListError(errorMessage(error, "The planning files could not be loaded."));
      setListState(cache.lists.has(workspaceId) || editStateRef.current.editing || editStateRef.current.feedbackDraft.trim() ? "ready" : "error");
    });
    return () => { current = false; };
  }, [cache, client, listRevision, workspaceId]);

  useEffect(() => {
    if (!selectedId || listState !== "ready") return;
    const requestId = ++documentRequestRef.current;
    const key = planningDocumentCacheKey(workspaceId, selectedId);
    const edit = editStateRef.current;
    const retainedEdit = (edit.editing || Boolean(edit.feedbackDraft.trim())) && edit.document?.documentId === selectedId;
    const cachedDocument = retainedEdit ? edit.document : cache.documents.get(key) ?? null;
    setDocument(cachedDocument);
    setDocumentState(cachedDocument ? "ready" : "loading");
    setDocumentError("");
    setDocumentErrorCode("");
    if (!retainedEdit) {
      setEditing(false);
      setDraft(cachedDocument?.contents ?? "");
      setSaveState("idle");
      setSaveError("");
    }
    void cache.documents.load(key, async () => {
      const result = await client.readWorkspacePlanningDocument(workspaceId, selectedId);
      if (result.workspaceId !== workspaceId || result.documentId !== selectedId) {
        throw new Error("WTS returned another planning file.");
      }
      return result;
    }).then((result) => {
      if (requestId !== documentRequestRef.current) return;
      // An edit keeps its original digest until a save or explicit reload.
      if (!editStateRef.current.editing && !editStateRef.current.feedbackDraft.trim()) {
        setDocument(result);
        setDraft(result.contents);
      }
      setDocumentState("ready");
    }).catch((error: unknown) => {
      if (requestId !== documentRequestRef.current) return;
      setDocumentError(errorMessage(error, "The planning file could not be loaded."));
      setDocumentErrorCode(error instanceof WorkspaceClientError ? error.code : "");
      setDocumentState(cachedDocument ? "ready" : "error");
    });
    return () => { if (documentRequestRef.current === requestId) documentRequestRef.current += 1; };
  }, [cache, client, documentRevision, listState, selectedId, workspaceId]);

  useEffect(() => {
    const requestId = ++feedbackRequestRef.current;
    setFeedbackState(cache.threads.has(workspaceId) ? "ready" : "loading");
    setFeedbackError("");
    void cache.threads.load(workspaceId, async () => {
      const result = await client.listWorkspaceReviewThreads(workspaceId);
      if (result.workspaceId !== workspaceId) throw new Error("WTS returned feedback for another workspace.");
      return sortedThreads(result.threads);
    }).then((result) => {
      if (requestId !== feedbackRequestRef.current) return;
      setThreads(result);
      setFeedbackState("ready");
    }).catch((error: unknown) => {
      if (requestId !== feedbackRequestRef.current) return;
      setFeedbackError(errorMessage(error, "The feedback could not be loaded."));
      setFeedbackState(cache.threads.has(workspaceId) ? "ready" : "error");
    });
    return () => { if (feedbackRequestRef.current === requestId) feedbackRequestRef.current += 1; };
  }, [cache, client, feedbackRevision, workspaceId]);

  const chooseDocument = useCallback(
    (documentId: WorkspacePlanningDocumentId) => {
      if (documentId === selectedId) return true;
      if (editing && dirty) {
        setSelectionMessage(
          "Save or cancel your edits before you open another file.",
        );
        return false;
      }
      if (feedbackDraft.trim()) {
        setSelectionMessage(
          "Add or clear your feedback before you open another file.",
        );
        return false;
      }
      setSelectionMessage("");
      setSelectedLine(null);
      setFeedbackDraft("");
      setCreateState("idle");
      setCreateError("");
      setResolveError("");
      feedbackContextRef.current += 1;
      setSelectedId(documentId);
      const target = documents.find(item => item.documentId === documentId);
      if (target) setCollapsedFolders(current => {
        const next = new Set(current); parentFolders(target).forEach(path => next.delete(path)); return next;
      });
      return true;
    },
    [dirty, documents, editing, feedbackDraft, selectedId],
  );

  const openLinkedDocument = useCallback((documentId: WorkspacePlanningDocumentId) => {
    if (!chooseDocument(documentId)) return false;
    if (!filteredDocuments.some(item => item.documentId === documentId)) {
      setDocumentQuery("");
      const old = oldDocumentIds.has(documentId);
      if ((documentFilter === "current" && old) || (documentFilter === "old" && !old)) setDocumentFilter("all");
    }
    const target = documents.find(item => item.documentId === documentId);
    if (target) setCollapsedFolders(current => {
      const next = new Set(current); parentFolders(target).forEach(path => next.delete(path)); return next;
    });
    return true;
  }, [chooseDocument, documents, filteredDocuments, oldDocumentIds, documentFilter]);

  const handleDocumentKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    documentId: WorkspacePlanningDocumentId,
  ) => {
    if (
      ![
        "ArrowDown",
        "ArrowUp",
        "ArrowRight",
        "ArrowLeft",
        "Home",
        "End",
      ].includes(event.key) ||
      visibleDocuments.length === 0
    ) {
      return;
    }
    const currentIndex = visibleDocuments.findIndex(
      (item) => item.documentId === documentId,
    );
    if (currentIndex < 0) return;
    let nextIndex = currentIndex;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % visibleDocuments.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex =
        (currentIndex - 1 + visibleDocuments.length) % visibleDocuments.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = visibleDocuments.length - 1;
    }
    event.preventDefault();
    const nextId = visibleDocuments[nextIndex]!.documentId;
    if (chooseDocument(nextId)) {
      window.requestAnimationFrame(() =>
        documentButtonsRef.current.get(nextId)?.focus(),
      );
    }
  };

  const toggleSelectedOld = () => {
    if (!selectedId) return;
    setOldDocumentIds((current) => {
      const next = new Set(current);
      if (next.has(selectedId)) {
        next.delete(selectedId);
      } else {
        next.add(selectedId);
      }
      saveOldDocumentIds(workspaceId, next);
      return next;
    });
    setSelectedDocumentIds((current) => {
      const next = new Set(current);
      next.delete(selectedId);
      return next;
    });
  };

  const toggleVisibleSelection = () => {
    setSelectedDocumentIds((current) => {
      const next = new Set(current);
      for (const item of visibleDocuments) {
        if (allVisibleSelected) {
          next.delete(item.documentId);
        } else {
          next.add(item.documentId);
        }
      }
      return next;
    });
  };

  const setDocumentSelected = (
    documentId: WorkspacePlanningDocumentId,
    selected: boolean,
  ) => {
    setSelectedDocumentIds((current) => {
      const next = new Set(current);
      if (selected) {
        next.add(documentId);
      } else {
        next.delete(documentId);
      }
      return next;
    });
  };

  const setSelectedDocumentsOld = (old: boolean) => {
    if (selectedDocuments.length === 0) return;
    setOldDocumentIds((current) => {
      const next = new Set(current);
      for (const item of selectedDocuments) {
        if (old) {
          next.add(item.documentId);
        } else {
          next.delete(item.documentId);
        }
      }
      saveOldDocumentIds(workspaceId, next);
      return next;
    });
    const count = selectedDocuments.length;
    setSelectedDocumentIds(new Set());
    onNotice?.(
      `${count} planning ${count === 1 ? "file" : "files"} marked ${old ? "old" : "current"}`,
    );
  };

  const reloadDocument = () => {
    setEditing(false);
    setDocumentView("preview");
    setSelectionMessage("");
    setSelectedLine(null);
    feedbackContextRef.current += 1;
    setDocumentRevision((revision) => revision + 1);
    setFeedbackRevision((revision) => revision + 1);
  };

  const cancelEdit = () => {
    const latest = selectedId
      ? cache.documents.get(planningDocumentCacheKey(workspaceId, selectedId)) ?? document
      : document;
    setDocument(latest);
    setDraft(latest?.contents ?? "");
    setEditing(false);
    setDocumentView("preview");
    setSaveState("idle");
    setSaveError("");
    setSelectionMessage("");
  };

  const saveDocument = useCallback(async () => {
    if (previewReadOnly || !nativePreviewAllowsCommand("update_workspace_planning_document")) return;
    if (!document || saveState === "saving" || !dirty || cache.saves.has(planningDocumentCacheKey(workspaceId, document.documentId))) return;
    publishPlanningSave(client, workspaceId, document.documentId, { state: "saving" });
    try {
      const saved = await client.updateWorkspacePlanningDocument(
        workspaceId,
        document.documentId,
        document.sha256,
        draft,
      );
      if (
        saved.workspaceId !== workspaceId ||
        saved.documentId !== document.documentId
      ) {
        throw new Error("WTS returned another planning file.");
      }
      cache.documents.set(planningDocumentCacheKey(workspaceId, saved.documentId), saved);
      const savedView = planningViewFor(client, workspaceId);
      if (savedView?.selectedId === saved.documentId && savedView.document?.sha256 === document.sha256) {
        const hasNewerDraft = savedView.editing && savedView.draft !== draft;
        rememberPlanningView(client, workspaceId, { ...savedView, document: saved,
          draft: hasNewerDraft ? savedView.draft : saved.contents,
          editing: hasNewerDraft, documentView: hasNewerDraft ? savedView.documentView : "preview" });
      }
      publishPlanningSave(client, workspaceId, document.documentId, {
        state: "saved", document: saved, previousSha256: document.sha256, submittedContents: draft,
      });
    } catch (error) {
      publishPlanningSave(client, workspaceId, document.documentId, { state: "error", error });
    }
  }, [cache, client, dirty, document, draft, previewReadOnly, saveState, workspaceId]);

  const documentThreads = useMemo(() => {
    if (!document) return [];
    return threads.filter(
      (thread) =>
        thread.target.kind === "planningDocument" &&
        thread.target.documentId === document.documentId,
    );
  }, [document, threads]);
  const openThreads = useMemo(
    () => documentThreads.filter((thread) => thread.state === "open"),
    [documentThreads],
  );
  const resolvedThreads = useMemo(
    () => documentThreads.filter((thread) => thread.state === "resolved"),
    [documentThreads],
  );
  const openThreadLines = useMemo(
    () =>
      new Set(
        openThreads.flatMap((thread) =>
          thread.target.kind === "planningDocument" &&
          thread.anchorState === "current" &&
          thread.target.line !== undefined
            ? [thread.target.line]
            : [],
        ),
      ),
    [openThreads],
  );

  const reloadFeedback = useCallback(() => {
    feedbackRequestRef.current += 1;
    feedbackContextRef.current += 1;
    setCreateState("idle");
    setCreateError("");
    setResolvingThreadId(null);
    setResolveError("");
    setFeedbackRevision((revision) => revision + 1);
  }, []);

  const createFeedback = useCallback(async () => {
    const submittedDraft = feedbackDraft;
    const body = submittedDraft.trim();
    if (
      !document ||
      !body ||
      feedbackCreatePendingRef.current ||
      createState === "saving" ||
      feedbackState !== "ready"
    ) {
      return;
    }
    const contextId = feedbackContextRef.current;
    const documentId = document.documentId;
    feedbackCreatePendingRef.current = true;
    setFeedbackCreatePending(true);
    setCreateState("saving");
    setCreateError("");
    try {
      const created = await client.createWorkspaceReviewThread(
        workspaceId,
        {
          kind: "planningDocument",
          documentId,
          documentSha256: document.sha256,
          ...(selectedLine === null ? {} : { line: selectedLine }),
        },
        body,
        "user",
      );
      if (
        created.workspaceId !== workspaceId ||
        created.target.kind !== "planningDocument" ||
        created.target.documentId !== documentId
      ) {
        throw new Error("WTS returned feedback for another planning file.");
      }
      const nextThreads = sortedThreads([created, ...(cache.threads.get(workspaceId) ?? []).filter((thread) => thread.threadId !== created.threadId)]);
      cache.threads.set(workspaceId, nextThreads);
      const savedView = planningViewFor(client, workspaceId);
      if (savedView?.selectedId === documentId && savedView.feedbackDraft === submittedDraft) {
        rememberPlanningView(client, workspaceId, { ...savedView, feedbackDraft: "" });
      }
      if (contextId !== feedbackContextRef.current) return;
      setThreads(nextThreads);
      setFeedbackDraft(current => current === submittedDraft ? "" : current);
      setCreateState("idle");
      onNotice?.("Feedback added");
    } catch (error) {
      if (contextId !== feedbackContextRef.current) return;
      setCreateState("error");
      setCreateError(errorMessage(error, "The feedback could not be added."));
      onNotice?.("The feedback was not added", "error");
    } finally {
      feedbackCreatePendingRef.current = false;
      setFeedbackCreatePending(false);
    }
  }, [
    client,
    createState,
    document,
    feedbackDraft,
    feedbackState,
    onNotice,
    selectedLine,
    workspaceId,
  ]);

  const resolveFeedback = useCallback(
    async (thread: WorkspaceReviewThread) => {
      if (resolvingThreadId || thread.state !== "open") return;
      const contextId = feedbackContextRef.current;
      setResolvingThreadId(thread.threadId);
      setResolveError("");
      try {
        const resolved = await client.resolveWorkspaceReviewThread(
          workspaceId,
          thread.threadId,
          thread.revision,
        );
        if (
          resolved.workspaceId !== workspaceId ||
          resolved.threadId !== thread.threadId
        ) {
          throw new Error("WTS returned another feedback thread.");
        }
        const nextThreads = sortedThreads((cache.threads.get(workspaceId) ?? []).map((item) => item.threadId === resolved.threadId ? resolved : item));
        cache.threads.set(workspaceId, nextThreads);
        if (contextId !== feedbackContextRef.current) return;
        setThreads(nextThreads);
        setResolvingThreadId(null);
        onNotice?.("Feedback resolved");
      } catch (error) {
        if (contextId !== feedbackContextRef.current) return;
        const isConflict =
          error instanceof WorkspaceClientError &&
          error.code === "review_thread_conflict";
        setResolveError(
          isConflict
            ? "This feedback changed after you opened it. Reload the feedback and try again."
            : errorMessage(error, "The feedback could not be resolved."),
        );
        setResolvingThreadId(null);
        onNotice?.("The feedback was not resolved", "error");
      }
    },
    [client, onNotice, resolvingThreadId, workspaceId],
  );

  const selectedDescriptor = documents.find(
    (item) => item.documentId === selectedId,
  );
  const selectedLabel = selectedDescriptor
    ? documentPath(selectedDescriptor)
    : document ? documentLabel(document) : "Planning file";
  const selectedIsOld = selectedId ? oldDocumentIds.has(selectedId) : false;
  const documentNeedsEditor = ["planning_document_too_large", "invalid_planning_document"].includes(documentErrorCode);
  const openPlanningWorkspace = async () => {
    if (editorOpenState === "opening") return;
    const generation = editorOpenGeneration.current;
    setEditorOpenState("opening");
    setEditorOpenError("");
    try {
      const result = await client.openWorkspaceInVscode(workspaceId);
      if (!result.accepted || result.workspaceId !== workspaceId) throw new Error("VS Code did not open this workspace.");
      if (generation === editorOpenGeneration.current) setEditorOpenState("idle");
    } catch (cause) {
      if (generation !== editorOpenGeneration.current) return;
      setEditorOpenState("error");
      setEditorOpenError(errorMessage(cause, "VS Code did not open this workspace."));
    }
  };
  const documentRecovery = documentNeedsEditor ? <>
    <p>Edit this file in VS Code, then refresh the planning files.</p>
    <Button className={styles.secondaryButton} isDisabled={editorOpenState === "opening"} onPress={() => void openPlanningWorkspace()}>Open workspace in VS Code</Button>
    <Button className={styles.secondaryButton} onPress={() => { setListRevision((revision) => revision + 1); setDocumentRevision((revision) => revision + 1); }}>Refresh planning files</Button>
    {editorOpenError && <p role="alert">{editorOpenError} Open VS Code manually, then open this workspace.</p>}
  </> : <Button className={styles.secondaryButton} onPress={documentErrorCode === "planning_document_unavailable" ? () => setListRevision((revision) => revision + 1) : () => setDocumentRevision((revision) => revision + 1)}>
    <Glyph name="refresh" size={15} />
    {documentErrorCode === "planning_document_unavailable" ? "Refresh planning files" : documentState === "ready" ? "Retry file" : "Try again"}
  </Button>;

  if (listState === "loading") {
    return (
      <section
        aria-label="Plans and Kanban"
        className={styles.state}
        role="status"
      >
        <span className={styles.spinner} aria-hidden="true" />
        <strong>Loading planning files…</strong>
        <p>WTS is reading the trusted files for {workspaceKey}.</p>
      </section>
    );
  }

  if (listState === "error" && listErrorCode === "planning_not_configured" && onCreatePlanningHome) {
    // A missing planning home is a setup step, not a failure.
    return (
      <section aria-label="Plans and Kanban" className={styles.state} data-ui="plans.setup" data-ui-label="Plan setup">
        <span className={styles.stateIcon} aria-hidden="true">
          <Glyph name="file" />
        </span>
        <strong>No plan for this workspace yet</strong>
        <p>{listError} Add one to let the agent write a review plan and track findings.</p>
        <Button className={styles.primaryButton} onPress={onCreatePlanningHome}>
          <Glyph name="file" size={15} />
          Create planning home
        </Button>
      </section>
    );
  }

  if (listState === "error") {
    return (
      <section aria-label="Plans and Kanban" className={styles.state}>
        <span className={styles.stateIcon} data-error aria-hidden="true">
          <Glyph name="warning" />
        </span>
        <strong>Planning files are unavailable</strong>
        <p role="alert">{listError}</p>
        {listErrorCode === "planning_not_configured" && onCreatePlanningHome ? (
          <Button
            className={styles.secondaryButton}
            onPress={onCreatePlanningHome}
          >
            <Glyph name="file" size={15} />
            Create planning home
          </Button>
        ) : (
          <Button
            className={styles.secondaryButton}
            onPress={() => setListRevision((revision) => revision + 1)}
          >
            <Glyph name="refresh" size={15} />
            Try again
          </Button>
        )}
      </section>
    );
  }

  if (documents.length === 0 && !editing && !feedbackDraft.trim()) {
    return (
      <section aria-label="Plans and Kanban" className={styles.state}>
        <span className={styles.stateIcon} aria-hidden="true">
          <Glyph name="file" />
        </span>
        <strong>No planning files</strong>
        <p>No planning files are available in this workspace. Refresh the list after you add a file.</p>
        <Button onPress={() => setListRevision((revision) => revision + 1)}>Refresh planning files</Button>
        {onCreatePlanningHome && <Button onPress={onCreatePlanningHome}>Create planning workspace</Button>}
      </section>
    );
  }

  const renderFolder = (folder: PlanningFolder, depth = 0): ReactNode => <>
    {folder.files.map(item => {
      const selected = item.documentId === selectedId;
      const old = oldDocumentIds.has(item.documentId);
      return (
        <div
          className={styles.documentRow}
          data-checked={
            selectedDocumentIds.has(item.documentId) || undefined
          }
          key={item.documentId}
          style={{ paddingInlineStart: depth * 12 }}
        >
          <SelectionCheckbox
            checked={selectedDocumentIds.has(item.documentId)}
            label={`Select ${documentPath(item)}`}
            onChange={(checked) =>
              setDocumentSelected(item.documentId, checked)
            }
          />
          <button
            aria-description={documentDescription(item)}
            aria-label={documentPath(item)}
            title={documentPath(item)}
            aria-current={selected ? "page" : undefined}
            className={styles.documentButton}
            data-old={old || undefined}
            data-selected={selected || undefined}
            onClick={() => chooseDocument(item.documentId)}
            onKeyDown={(event) =>
              handleDocumentKeyDown(event, item.documentId)
            }
            ref={(element) => {
              if (element) {
                documentButtonsRef.current.set(item.documentId, element);
              } else {
                documentButtonsRef.current.delete(item.documentId);
              }
            }}
            tabIndex={selected || (!visibleDocuments.some(file => file.documentId === selectedId) && item.documentId === visibleDocuments[0]?.documentId) ? 0 : -1}
            type="button"
          >
            <span className={styles.documentIcon} aria-hidden="true">
              <Glyph name="file" size={14} />
            </span>
            <b>{documentLabel(item)}</b>
            {old && <small>Old</small>}
          </button>
        </div>
      );

    })}
    {[...folder.folders.values()].map(child => {
      const expanded = searchExpanded || !collapsedFolders.has(child.path);
      return <div key={child.path} role="group" aria-label={`${child.path} folder`}>
        {searchExpanded ? <div className={styles.folderLabel} style={{ paddingInlineStart: 25 + depth * 12 }}>
          <Glyph name="folder" size={14} /><span>{child.name}</span>
        </div> : <button type="button" className={styles.folderButton} style={{ paddingInlineStart: 8 + depth * 12 }}
          aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} ${child.path} folder`}
          onClick={() => setCollapsedFolders(current => {
            const next = new Set(current); if (expanded) next.add(child.path); else next.delete(child.path); return next;
          })}>
          <Glyph name="chevron" size={12} /><Glyph name="folder" size={14} /><span>{child.name}</span>
        </button>}
        {expanded && renderFolder(child, depth + 1)}
      </div>;
    })}
  </>;

  return (
    <section
      aria-label="Plans and Kanban"
      className={styles.panel}
      data-ui="planning.panel"
      data-ui-label="Plans and Kanban view"
    >
      <aside
        className={styles.sidebar}
        data-ui="planning.files"
        data-ui-label="Planning file explorer"
      >
        <header>
          <span>
            <Glyph name="chevron" size={12} />
            Planning files
          </span>
          <span className={styles.fileHeaderActions}>
            <small>{visibleDocuments.length}</small>
            <SelectionCheckbox
              checked={visibleSelectionState}
              disabled={visibleDocuments.length === 0}
              label="Select all visible planning files"
              onChange={toggleVisibleSelection}
            />
          </span>
        </header>
        <div
          className={styles.fileTools}
          data-ui="planning.file-tools"
          data-ui-label="Planning file search and filters"
        >
          <label className={styles.fileSearch}>
            <Glyph name="search" size={13} />
            <input
              aria-label="Search planning files"
              onChange={(event) => {
                setDocumentQuery(event.target.value);
                setSelectedDocumentIds(new Set());
              }}
              placeholder="Search files"
              type="search"
              value={documentQuery}
            />
          </label>
          <div
            aria-label="Planning file state"
            className={styles.fileFilters}
            role="group"
          >
            {(["current", "old", "all"] as const).map((filter) => (
              <button
                aria-pressed={documentFilter === filter}
                key={filter}
                onClick={() => {
                  setDocumentFilter(filter);
                  setSelectedDocumentIds(new Set());
                }}
                type="button"
              >
                {filter === "current"
                  ? "Current"
                  : filter === "old"
                    ? "Old"
                    : "All"}
              </button>
            ))}
          </div>
        </div>
        {selectedDocuments.length > 0 && (
          <div
            aria-label="Planning file selection actions"
            className={styles.bulkActions}
            data-ui="planning.file-selection-actions"
            data-ui-label="Planning file selection actions"
            onKeyDown={(event) => {
              if (event.key === "Escape") setSelectedDocumentIds(new Set());
            }}
            role="toolbar"
          >
            <span>{selectedDocuments.length} selected</span>
            {selectedHasCurrent && (
              <Button
                className={styles.bulkActionButton}
                onPress={() => setSelectedDocumentsOld(true)}
              >
                Mark old
              </Button>
            )}
            {selectedHasOld && (
              <Button
                className={styles.bulkActionButton}
                data-action="current"
                onPress={() => setSelectedDocumentsOld(false)}
              >
                Mark current
              </Button>
            )}
            <button
              aria-label="Clear planning file selection"
              className={styles.clearSelectionButton}
              onClick={() => setSelectedDocumentIds(new Set())}
              type="button"
            >
              <Glyph name="close" size={12} />
            </button>
          </div>
        )}
        <nav aria-label="Planning files" className={styles.documentList}>
          {renderFolder(folderTree)}
          {visibleDocuments.length === 0 && (
            <p className={styles.noFiles}>No files match this view.</p>
          )}
        </nav>
        <p className={styles.keyboardHint}>
          Use the arrow keys to move through the files.
        </p>
      </aside>

      <div
        className={styles.documentPane}
        data-ui="planning.document"
        data-ui-label="Planning document viewer"
      >
        <header
          className={styles.documentHeader}
          data-ui="planning.document-toolbar"
          data-ui-label="Planning document toolbar"
        >
          <div className={styles.documentIdentity}>
            <span className={styles.documentIcon} aria-hidden="true">
              <Glyph name="file" size={16} />
            </span>
            <div>
              <strong>{selectedLabel}</strong>
              <span data-mode={editing ? "edit" : "read"}>
                {editing ? "Editing" : "Read only"}
              </span>
            </div>
          </div>
          {documentState === "ready" && document && (
            <div className={styles.documentActions}>
              {!editing ? (
                <>
                  <Button
                    aria-label={`Mark ${selectedLabel} as ${selectedIsOld ? "current" : "old"}`}
                    className={styles.secondaryButton}
                    onPress={toggleSelectedOld}
                  >
                    {selectedIsOld ? "Mark current" : "Mark old"}
                  </Button>
                  <div
                    aria-label="Document view"
                    className={styles.viewSwitch}
                    role="group"
                  >
                    <Button
                      aria-pressed={documentView === "preview"}
                      className={styles.viewSwitchButton}
                      onPress={() => {
                        setDocumentView("preview");
                        setSelectedLine(null);
                      }}
                    >
                      Preview
                    </Button>
                    <Button
                      aria-pressed={documentView === "source"}
                      className={styles.viewSwitchButton}
                      onPress={() => setDocumentView("source")}
                    >
                      Source
                    </Button>
                  </div>
                  <Button
                    aria-label={`Reload ${selectedLabel}`}
                    className={styles.iconButton}
                    onPress={reloadDocument}
                  >
                    <Glyph name="refresh" size={15} />
                  </Button>
                  {!previewReadOnly && <Button
                    className={styles.primaryButton}
                    onPress={() => {
                      if (!nativePreviewAllowsCommand("update_workspace_planning_document") || !retainDraft({ editing: true })) return;
                      setEditing(true);
                      setDocumentView("source");
                      setSelectionMessage("");
                    }}
                  >
                    Edit
                  </Button>}
                </>
              ) : (
                <>
                  <Button
                    className={styles.secondaryButton}
                    isDisabled={saveState === "saving"}
                    onPress={cancelEdit}
                  >
                    Cancel
                  </Button>
                  {!previewReadOnly && <Button
                    className={styles.primaryButton}
                    isDisabled={!dirty || saveState === "saving"}
                    onPress={() => void saveDocument()}
                  >
                    {saveState === "saving" ? "Saving…" : "Save"}
                  </Button>}
                </>
              )}
            </div>
          )}
        </header>

        {listError && listState === "ready" && (
          <div className={styles.notice} role="alert">
            <span>{listError} WTS shows the last loaded files.</span>
            <Button onPress={() => setListRevision((revision) => revision + 1)}>Retry file list</Button>
          </div>
        )}
        {documentError && documentState === "ready" && (
          <div className={styles.notice} role="alert">
            <span>{documentError} WTS shows the last loaded content.</span>
            {documentRecovery}
          </div>
        )}
        {feedbackError && feedbackState === "ready" && (
          <div className={styles.notice} role="alert">
            <span>{feedbackError} WTS shows the last loaded feedback.</span>
            <Button onPress={reloadFeedback}>Retry feedback</Button>
          </div>
        )}

        {selectionMessage && (
          <div className={styles.notice} role="status">
            <Glyph name="warning" size={15} />
            <span>{selectionMessage}</span>
          </div>
        )}

        {documentState === "loading" && (
          <div className={styles.documentState} role="status">
            <span className={styles.spinner} aria-hidden="true" />
            <strong>Loading {selectedLabel}…</strong>
          </div>
        )}

        {documentState === "error" && (
          <div className={styles.documentState}>
            <span className={styles.stateIcon} data-error aria-hidden="true">
              <Glyph name="warning" />
            </span>
            <strong>This file could not be opened</strong>
            <p role="alert">{documentError}</p>
            {documentRecovery}
          </div>
        )}

        {documentState === "ready" && document && (
          <div className={styles.documentBody}>
            {previewReadOnly && <div className={styles.notice} role={saveState === "error" ? "alert" : "status"}>
              <p>{NATIVE_PREVIEW_READ_ONLY_MESSAGE}</p>
              {editing && dirty && <RecoveryCopyButton label="Copy draft" text={draft} />}
            </div>}
            {saveState === "conflict" && (
              <div className={styles.saveError} data-conflict role="alert">
                <span aria-hidden="true"><Glyph name="warning" size={16} /></span>
                <div>
                  <strong>Newer file available</strong>
                  <p>{saveError}</p>
                </div>
                <Button className={styles.secondaryButton} onPress={reloadDocument}>
                  Reload latest
                </Button>
              </div>
            )}
            {saveState === "error" && !previewReadOnly && (
              <div className={styles.saveError} role="alert">
                <span aria-hidden="true"><Glyph name="warning" size={16} /></span>
                <div>
                  <strong>File not saved</strong>
                  <p>{saveError}</p>
                </div>
                <Button
                  className={styles.secondaryButton}
                  onPress={() => void saveDocument()}
                >
                  Try save again
                </Button>
              </div>
            )}

            {!editing && document && planStarterNeeded(document) && (
              <section
                aria-label="Plan starter"
                className={styles.planStarter}
                data-ui="planning.plan-starter"
                data-ui-label="Plan starter"
              >
                <span aria-hidden="true"><Glyph name="play" size={14} /></span>
                <div>
                  <strong>This plan is still a template</strong>
                  <p>The agent can read the workspace and write a first draft. You review the draft before you keep it.</p>
                </div>
                <Button
                  className={styles.primaryButton}
                  onPress={() => requestAgentTask({
                    calloutId: "planning.plan-starter",
                    label: `Plan · ${workspaceTitle ?? workspaceKey}`,
                    body: planStarterPrompt(workspaceTitle ?? workspaceKey, document.fileName),
                  })}
                >
                  Ask agent to draft the plan
                </Button>
              </section>
            )}
            <div className={styles.reviewLayout}>
              <div
                className={styles.documentCanvas}
                data-ui="planning.document-content"
                data-ui-label="Planning document content area"
              >
                {editing ? (
                  <div className={styles.editorShell}>
                    <textarea
                      aria-label={`Edit ${selectedLabel}`}
                      readOnly={previewReadOnly}
                      autoFocus
                      className={styles.editor}
                      data-history-swipe-block
                      onChange={(event) => {
                        if (previewReadOnly || !retainDraft({ draft: event.currentTarget.value })) return;
                        setDraft(event.currentTarget.value);
                        if (saveState !== "saving") {
                          setSaveState("idle");
                          setSaveError("");
                        }
                      }}
                      onKeyDown={(event) => {
                        if (
                          (event.metaKey || event.ctrlKey) &&
                          event.key.toLowerCase() === "s"
                        ) {
                          event.preventDefault();
                          void saveDocument();
                        }
                      }}
                      spellCheck={false}
                      value={draft}
                    />
                    <footer>
                      <span>{dirty ? "Unsaved changes" : "No changes"}</span>
                      <span>{draft.split("\n").length} lines</span>
                    </footer>
                  </div>
                ) : (
                  documentView === "preview" ? (
                    <PlanningPreview document={document} descriptor={selectedDescriptor ?? document} documents={documents} onOpenDocument={openLinkedDocument} />
                  ) : (
                    <PlanningSource
                      document={document}
                      onSelectLine={(line) => {
                        setSelectedLine(line);
                        setCreateError("");
                      }}
                      openThreadLines={openThreadLines}
                      selectedLine={selectedLine}
                    />
                  )
                )}
              </div>

              <aside
                aria-label={`Feedback for ${selectedLabel}`}
                className={styles.feedbackRail}
                data-ui="planning.feedback"
                data-ui-label="Planning feedback sidebar"
              >
                <header className={styles.feedbackHeader}>
                  <div>
                    <strong>Feedback</strong>
                    <span>{selectedLabel}</span>
                  </div>
                  <span className={styles.feedbackCount}>
                    {openThreads.length} open
                  </span>
                </header>

                <div
                  className={styles.feedbackComposer}
                  data-ui="planning.feedback-composer"
                  data-ui-label="Planning feedback composer"
                >
                  <div className={styles.feedbackTarget}>
                    <span>Target</span>
                    <strong>{anchorLabel(selectedLine ?? undefined)}</strong>
                    {selectedLine !== null && !editing && (
                      <button
                        onClick={() => setSelectedLine(null)}
                        type="button"
                      >
                        Use whole file
                      </button>
                    )}
                  </div>
                  <textarea
                    aria-label={`Feedback for ${selectedLabel}`}
                    disabled={editing || feedbackState !== "ready"}
                    onChange={(event) => {
                      if (!retainDraft({ feedbackDraft: event.currentTarget.value })) return;
                      setFeedbackDraft(event.currentTarget.value);
                      if (!feedbackCreatePendingRef.current) setCreateState("idle");
                      setCreateError("");
                    }}
                    onKeyDown={(event) => {
                      if (
                        (event.metaKey || event.ctrlKey) &&
                        event.key === "Enter"
                      ) {
                        event.preventDefault();
                        void createFeedback();
                      }
                    }}
                    placeholder="Write a question or an idea."
                    rows={4}
                    value={feedbackDraft}
                  />
                  <div className={styles.composerFooter}>
                    <span>
                      {editing
                        ? "Save or cancel the file edit first."
                        : documentView === "preview"
                          ? "Use Source to add feedback to a line."
                        : "Feedback does not change the file."}
                    </span>
                    <Button
                      className={styles.primaryButton}
                      isDisabled={
                        editing ||
                        feedbackState !== "ready" ||
                        !feedbackDraft.trim() ||
                        feedbackCreatePending ||
                        createState === "saving"
                      }
                      onPress={() => void createFeedback()}
                    >
                      {feedbackCreatePending ? "Adding…" : "Add feedback"}
                    </Button>
                  </div>
                  {createState === "error" && (
                    <p className={styles.feedbackActionError} role="alert">
                      {createError}
                    </p>
                  )}
                </div>

                {feedbackState === "loading" && (
                  <div className={styles.feedbackState} role="status">
                    <span className={styles.spinner} aria-hidden="true" />
                    <span>WTS loads the feedback.</span>
                  </div>
                )}

                {feedbackState === "error" && (
                  <div className={styles.feedbackState}>
                    <p role="alert">{feedbackError}</p>
                    <Button
                      className={styles.secondaryButton}
                      onPress={reloadFeedback}
                    >
                      <Glyph name="refresh" size={14} />
                      Try again
                    </Button>
                  </div>
                )}

                {feedbackState === "ready" && (
                  <div
                    className={styles.threadSections}
                    data-ui="planning.feedback-threads"
                    data-ui-label="Planning feedback list"
                  >
                    {resolveError && (
                      <div className={styles.resolveError} role="alert">
                        <p>{resolveError}</p>
                        <Button
                          className={styles.secondaryButton}
                          onPress={reloadFeedback}
                        >
                          Reload feedback
                        </Button>
                      </div>
                    )}
                    <section aria-labelledby="open-planning-feedback">
                      <header className={styles.threadSectionHeader}>
                        <h3 id="open-planning-feedback">Open</h3>
                        <span>{openThreads.length}</span>
                      </header>
                      {openThreads.length === 0 ? (
                        <p className={styles.emptyThreads}>No open feedback.</p>
                      ) : (
                        <div className={styles.threadList}>
                          {openThreads.map((thread) => (
                            <FeedbackThread
                              key={thread.threadId}
                              onResolve={(item) => void resolveFeedback(item)}
                              resolving={resolvingThreadId === thread.threadId}
                              thread={thread}
                            />
                          ))}
                        </div>
                      )}
                    </section>

                    <section aria-labelledby="resolved-planning-feedback">
                      <header className={styles.threadSectionHeader}>
                        <h3 id="resolved-planning-feedback">Resolved</h3>
                        <span>{resolvedThreads.length}</span>
                      </header>
                      {resolvedThreads.length === 0 ? (
                        <p className={styles.emptyThreads}>
                          No resolved feedback.
                        </p>
                      ) : (
                        <div className={styles.threadList}>
                          {resolvedThreads.map((thread) => (
                            <FeedbackThread
                              key={thread.threadId}
                              onResolve={(item) => void resolveFeedback(item)}
                              resolving={false}
                              thread={thread}
                            />
                          ))}
                        </div>
                      )}
                    </section>
                  </div>
                )}
              </aside>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
