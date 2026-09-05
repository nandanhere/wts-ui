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
  pre: ({ children }) => {
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
  },
};

interface PlanningPreviewProps {
  document: WorkspacePlanningDocument;
}

const PlanningPreview = memo(function PlanningPreview({
  document,
}: PlanningPreviewProps) {
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
        components={planningMarkdownComponents}
        remarkPlugins={[remarkGfm]}
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
  onNotice?: (message: string, kind?: "info" | "error") => void;
  onCreatePlanningHome?: () => void;
}

export function PlanningDocumentsPanel({
  client,
  workspaceId,
  workspaceKey,
  onNotice,
  onCreatePlanningHome,
}: PlanningDocumentsPanelProps) {
  const [documents, setDocuments] = useState<
    WorkspacePlanningDocumentDescriptor[]
  >([]);
  const [listState, setListState] = useState<RequestState>("loading");
  const [listError, setListError] = useState("");
  const [listErrorCode, setListErrorCode] = useState("");
  const [listRevision, setListRevision] = useState(0);
  const [documentQuery, setDocumentQuery] = useState("");
  const [documentFilter, setDocumentFilter] =
    useState<DocumentFilter>("current");
  const [oldDocumentIds, setOldDocumentIds] = useState(() =>
    oldDocumentIdsForWorkspace(workspaceId),
  );
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<
    Set<WorkspacePlanningDocumentId>
  >(new Set());
  const [selectedId, setSelectedId] =
    useState<WorkspacePlanningDocumentId | null>(null);
  const [document, setDocument] =
    useState<WorkspacePlanningDocument | null>(null);
  const [documentState, setDocumentState] = useState<RequestState>("loading");
  const [documentError, setDocumentError] = useState("");
  const [documentRevision, setDocumentRevision] = useState(0);
  const [documentView, setDocumentView] = useState<DocumentView>("preview");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [selectionMessage, setSelectionMessage] = useState("");
  const [threads, setThreads] = useState<WorkspaceReviewThread[]>([]);
  const [feedbackState, setFeedbackState] =
    useState<RequestState>("loading");
  const [feedbackError, setFeedbackError] = useState("");
  const [feedbackRevision, setFeedbackRevision] = useState(0);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [feedbackDraft, setFeedbackDraft] = useState("");
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
  const documentButtonsRef = useRef(
    new Map<WorkspacePlanningDocumentId, HTMLButtonElement>(),
  );

  const dirty = Boolean(document && draft !== document.contents);
  const visibleDocuments = useMemo(() => {
    const query = documentQuery.trim().toLocaleLowerCase();
    return documents.filter((item) => {
      const old = oldDocumentIds.has(item.documentId);
      if (documentFilter === "current" && old) return false;
      if (documentFilter === "old" && !old) return false;
      return (
        !query ||
        documentLabel(item).toLocaleLowerCase().includes(query) ||
        documentDescription(item).toLocaleLowerCase().includes(query)
      );
    });
  }, [documentFilter, documentQuery, documents, oldDocumentIds]);
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

  useEffect(() => {
    feedbackRequestRef.current += 1;
    feedbackContextRef.current += 1;
    setThreads([]);
    setFeedbackState("loading");
    setFeedbackError("");
    setSelectedLine(null);
    setFeedbackDraft("");
    setCreateState("idle");
    setCreateError("");
    setResolvingThreadId(null);
    setResolveError("");
  }, [client, workspaceId]);

  useEffect(() => {
    let current = true;
    documentRequestRef.current += 1;
    setDocuments([]);
    setSelectedId(null);
    setDocument(null);
    setDocumentView("preview");
    setEditing(false);
    setDraft("");
    setSaveState("idle");
    setListState("loading");
    setListError("");
    setListErrorCode("");
    setDocumentQuery("");
    setDocumentFilter("current");
    setSelectedDocumentIds(new Set());
    const storedOldDocumentIds = oldDocumentIdsForWorkspace(workspaceId);
    setOldDocumentIds(storedOldDocumentIds);

    void client
      .listWorkspacePlanningDocuments(workspaceId)
      .then((result) => {
        if (!current) return;
        if (result.workspaceId !== workspaceId) {
          throw new Error("WTS returned planning files for another workspace.");
        }
        const nextDocuments = sortedDocuments(result.documents);
        setDocuments(nextDocuments);
        setSelectedId(
          nextDocuments.find(
            (item) => !storedOldDocumentIds.has(item.documentId),
          )?.documentId ?? nextDocuments[0]?.documentId ?? null,
        );
        setListState("ready");
      })
      .catch((error) => {
        if (!current) return;
        setListErrorCode(
          error instanceof WorkspaceClientError ? error.code : "",
        );
        setListError(
          errorMessage(error, "The planning files could not be loaded."),
        );
        setListState("error");
      });

    return () => {
      current = false;
    };
  }, [client, listRevision, workspaceId]);

  useEffect(() => {
    if (!selectedId || listState !== "ready") return;
    const requestId = ++documentRequestRef.current;
    setDocument(null);
    setDocumentState("loading");
    setDocumentError("");
    setDocumentView("preview");
    setEditing(false);
    setDraft("");
    setSaveState("idle");
    setSaveError("");
    setSelectedLine(null);
    setCreateState("idle");
    setCreateError("");
    setResolveError("");
    feedbackContextRef.current += 1;

    void client
      .readWorkspacePlanningDocument(workspaceId, selectedId)
      .then((result) => {
        if (requestId !== documentRequestRef.current) return;
        if (
          result.workspaceId !== workspaceId ||
          result.documentId !== selectedId
        ) {
          throw new Error("WTS returned another planning file.");
        }
        setDocument(result);
        setDraft(result.contents);
        setDocumentState("ready");
      })
      .catch((error) => {
        if (requestId !== documentRequestRef.current) return;
        setDocumentError(
          errorMessage(error, "The planning file could not be loaded."),
        );
        setDocumentState("error");
      });
  }, [client, documentRevision, listState, selectedId, workspaceId]);

  useEffect(() => {
    const requestId = ++feedbackRequestRef.current;
    setFeedbackState("loading");
    setFeedbackError("");

    void client
      .listWorkspaceReviewThreads(workspaceId)
      .then((result) => {
        if (requestId !== feedbackRequestRef.current) return;
        if (result.workspaceId !== workspaceId) {
          throw new Error("WTS returned feedback for another workspace.");
        }
        setThreads(sortedThreads(result.threads));
        setFeedbackState("ready");
      })
      .catch((error) => {
        if (requestId !== feedbackRequestRef.current) return;
        setFeedbackError(
          errorMessage(error, "The feedback could not be loaded."),
        );
        setFeedbackState("error");
      });

    return () => {
      if (feedbackRequestRef.current === requestId) {
        feedbackRequestRef.current += 1;
      }
    };
  }, [client, feedbackRevision, workspaceId]);

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
      return true;
    },
    [dirty, editing, feedbackDraft, selectedId],
  );

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
    setSelectionMessage("");
    setSelectedLine(null);
    feedbackContextRef.current += 1;
    setDocumentRevision((revision) => revision + 1);
    setFeedbackRevision((revision) => revision + 1);
  };

  const cancelEdit = () => {
    setDraft(document?.contents ?? "");
    setEditing(false);
    setDocumentView("preview");
    setSaveState("idle");
    setSaveError("");
    setSelectionMessage("");
  };

  const saveDocument = useCallback(async () => {
    if (!document || saveState === "saving" || !dirty) return;
    const requestId = documentRequestRef.current;
    setSaveState("saving");
    setSaveError("");
    try {
      const saved = await client.updateWorkspacePlanningDocument(
        workspaceId,
        document.documentId,
        document.sha256,
        draft,
      );
      if (requestId !== documentRequestRef.current) return;
      if (
        saved.workspaceId !== workspaceId ||
        saved.documentId !== document.documentId
      ) {
        throw new Error("WTS returned another planning file.");
      }
      setDocument(saved);
      setDraft(saved.contents);
      setEditing(false);
      setDocumentView("preview");
      setSaveState("idle");
      setSelectedLine(null);
      feedbackContextRef.current += 1;
      setFeedbackRevision((revision) => revision + 1);
      onNotice?.(`${documentLabel(saved)} saved`);
    } catch (error) {
      if (requestId !== documentRequestRef.current) return;
      const isConflict =
        error instanceof WorkspaceClientError &&
        error.code === "planning_document_conflict";
      setSaveState(isConflict ? "conflict" : "error");
      setSaveError(
        isConflict
          ? "This file changed after you opened it. Reload the latest version before you edit it again."
          : errorMessage(error, "The planning file could not be saved."),
      );
      onNotice?.("The planning file was not saved", "error");
    }
  }, [client, dirty, document, draft, onNotice, saveState, workspaceId]);

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
    const body = feedbackDraft.trim();
    if (
      !document ||
      !body ||
      createState === "saving" ||
      feedbackState !== "ready"
    ) {
      return;
    }
    const contextId = feedbackContextRef.current;
    const documentId = document.documentId;
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
      if (contextId !== feedbackContextRef.current) return;
      if (
        created.workspaceId !== workspaceId ||
        created.target.kind !== "planningDocument" ||
        created.target.documentId !== documentId
      ) {
        throw new Error("WTS returned feedback for another planning file.");
      }
      setThreads((current) =>
        sortedThreads([
          created,
          ...current.filter((thread) => thread.threadId !== created.threadId),
        ]),
      );
      setFeedbackDraft("");
      setCreateState("idle");
      onNotice?.("Feedback added");
    } catch (error) {
      if (contextId !== feedbackContextRef.current) return;
      setCreateState("error");
      setCreateError(errorMessage(error, "The feedback could not be added."));
      onNotice?.("The feedback was not added", "error");
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
        if (contextId !== feedbackContextRef.current) return;
        if (
          resolved.workspaceId !== workspaceId ||
          resolved.threadId !== thread.threadId
        ) {
          throw new Error("WTS returned another feedback thread.");
        }
        setThreads((current) =>
          sortedThreads(
            current.map((item) =>
              item.threadId === resolved.threadId ? resolved : item,
            ),
          ),
        );
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
    ? documentLabel(selectedDescriptor)
    : "Planning file";
  const selectedIsOld = selectedId ? oldDocumentIds.has(selectedId) : false;

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

  if (documents.length === 0) {
    return (
      <section aria-label="Plans and Kanban" className={styles.state}>
        <span className={styles.stateIcon} aria-hidden="true">
          <Glyph name="file" />
        </span>
        <strong>No planning files</strong>
        <p>This workspace does not use WTS planning files.</p>
      </section>
    );
  }

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
          {visibleDocuments.map((item) => {
            const selected = item.documentId === selectedId;
            const old = oldDocumentIds.has(item.documentId);
            return (
              <div
                className={styles.documentRow}
                data-checked={
                  selectedDocumentIds.has(item.documentId) || undefined
                }
                key={item.documentId}
              >
                <SelectionCheckbox
                  checked={selectedDocumentIds.has(item.documentId)}
                  label={`Select ${documentLabel(item)}`}
                  onChange={(checked) =>
                    setDocumentSelected(item.documentId, checked)
                  }
                />
                <button
                  aria-description={documentDescription(item)}
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
                  tabIndex={selected ? 0 : -1}
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
                  <Button
                    className={styles.primaryButton}
                    onPress={() => {
                      setEditing(true);
                      setDocumentView("source");
                      setSelectionMessage("");
                    }}
                  >
                    Edit
                  </Button>
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
                  <Button
                    className={styles.primaryButton}
                    isDisabled={!dirty || saveState === "saving"}
                    onPress={() => void saveDocument()}
                  >
                    {saveState === "saving" ? "Saving…" : "Save"}
                  </Button>
                </>
              )}
            </div>
          )}
        </header>

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
            <Button className={styles.secondaryButton} onPress={reloadDocument}>
              <Glyph name="refresh" size={15} />
              Try again
            </Button>
          </div>
        )}

        {documentState === "ready" && document && (
          <div className={styles.documentBody}>
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
            {saveState === "error" && (
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
                      autoFocus
                      className={styles.editor}
                      data-history-swipe-block
                      onChange={(event) => {
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
                    <PlanningPreview document={document} />
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
                      setFeedbackDraft(event.currentTarget.value);
                      setCreateState("idle");
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
                        createState === "saving"
                      }
                      onPress={() => void createFeedback()}
                    >
                      {createState === "saving" ? "Adding…" : "Add feedback"}
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
