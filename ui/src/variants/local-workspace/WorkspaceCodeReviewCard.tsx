import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentModelCatalog,
  AgentProvider,
  AgentProviderModels,
  CodeReviewFinding,
  CodeReviewMergeRequest,
  CodeReviewTrace,
  CodeReviewTraceStep,
  CodeReviewLabel,
  CodeReviewScope,
  WorkspaceClient,
  WorkspaceCodeReviewResult,
} from "../../lib/wtsClient";
import { SelectMenu } from "../../components/SelectMenu";
import { Glyph } from "./Glyph";
import styles from "./WorkspaceCodeReviewCard.module.css";

export interface CodeReviewPatchIdentity {
  repositoryId: string;
  patchSha256: string;
}

/** The merge request that WTS reviews and that receives posted findings. */
export interface CodeReviewMergeRequestTarget {
  /** The WTS repository ID of the worktree. */
  worktreeRepositoryId: string;
  /** The GitLab repository ID that the publish API uses. */
  providerRepositoryId: string;
  iid: number;
  /** False when WTS cannot post now, for example when GitLab is offline. */
  canPost: boolean;
}

interface CodeReviewPublishValue {
  client: WorkspaceClient;
  workspaceId: string;
  target: CodeReviewMergeRequestTarget;
  review: WorkspaceCodeReviewResult | null;
}

const CodeReviewPublishContext = createContext<CodeReviewPublishValue | null>(null);

/** Lets each finding body inside it post its suggested comment to the merge request. */
export const CodeReviewPublishProvider = CodeReviewPublishContext.Provider;

/** The name that the precedent text uses, for example "Pratik said this before". */
export function reviewerName(review: WorkspaceCodeReviewResult | null | undefined): string | undefined {
  return review?.skill?.reviewer ?? (review?.mode === "raptik" ? "Pratik" : undefined);
}

/** A short badge text for the rules that shaped a review. */
export function reviewRulesLabel(review: WorkspaceCodeReviewResult | null | undefined): string {
  if (review?.skill?.label) return review.skill.label;
  return review?.mode === "raptik" ? "Raptik rules" : "General rules";
}

/** The merge request version of a finding, when the review covered one. */
export function findingMergeRequest(
  review: WorkspaceCodeReviewResult | null | undefined,
  finding: CodeReviewFinding,
  iid: number,
): CodeReviewMergeRequest | undefined {
  const repositories = review?.repositories ?? [];
  const repository = repositories.find((candidate) =>
    candidate.mergeRequest?.iid === iid && (!finding.repositoryId || candidate.repositoryId === finding.repositoryId));
  return repository?.mergeRequest;
}

// Remembers posted findings while the app runs, so a diff redraw keeps the posted state.
const postedFindings = new Set<string>();

function PostFindingButton({ finding }: { finding: CodeReviewFinding }) {
  const context = useContext(CodeReviewPublishContext);
  const key = context ? JSON.stringify([context.workspaceId, context.target.iid, context.review?.reviewedAtUnixMs, finding.findingId]) : "";
  const [state, setState] = useState<"idle" | "pending" | "posted">(() => (postedFindings.has(key) ? "posted" : "idle"));
  const [error, setError] = useState("");
  if (!context || !finding.suggestedComment) return null;
  const { client, workspaceId, target, review } = context;
  const version = findingMergeRequest(review, finding, target.iid);
  const inline = Boolean(version && finding.anchored && finding.filePath && finding.line && finding.side);
  const post = async () => {
    setState("pending");
    setError("");
    try {
      const result = await client.publishGitlabReviewComment(target.providerRepositoryId, target.iid, inline && version
        ? {
            body: finding.suggestedComment!,
            filePath: finding.filePath,
            side: finding.side!,
            line: finding.line!,
            workspaceId,
            expectedPosition: {
              baseCommitOid: version.baseCommitOid,
              startCommitOid: version.startCommitOid,
              headCommitOid: version.headCommitOid,
            },
          }
        : { body: finding.suggestedComment! });
      if (!result.accepted) throw new Error("GitLab did not accept this comment.");
      postedFindings.add(key);
      setState("posted");
    } catch (cause) {
      setState("idle");
      setError(cause instanceof Error ? cause.message : "WTS could not post this comment.");
    }
  };
  return (
    <>
      <button
        aria-label={state === "posted" ? "Posted to GitLab" : inline ? `Post to GitLab on line ${finding.line}` : "Post to GitLab as an MR comment"}
        className={styles.postButton}
        data-posted={state === "posted" || undefined}
        data-ui="verification.code-review-post"
        data-ui-label="Post to GitLab button"
        disabled={state !== "idle" || !target.canPost}
        onClick={() => void post()}
        title={!target.canPost
          ? "WTS must check this MR with GitLab first. Refresh the conversations."
          : inline ? "Post this comment on the changed line in the MR." : "Post this comment on the MR. The finding is not on a changed line of the published MR."}
        type="button"
      >
        <Glyph name={state === "posted" ? "check" : "comment"} size={12} />
        {state === "posted" ? "Posted" : state === "pending" ? "Posting" : "Post to GitLab"}
      </button>
      {error && <span className={styles.postError} role="alert">{error}</span>}
    </>
  );
}

interface WorkspaceCodeReviewCardProps {
  client: WorkspaceClient;
  workspaceId: string;
  workspaceKey: string;
  onNotice?: (message: string, kind?: "info" | "error") => void;
  /** Limits each run to one repository. */
  repositoryId?: string;
  /** The patch on screen. The card marks a review as old when this patch changed. */
  currentPatch?: CodeReviewPatchIdentity;
  /** Controlled review. Give this with onReviewChange to share the review with a diff. */
  review?: WorkspaceCodeReviewResult | null;
  onReviewChange?: (review: WorkspaceCodeReviewResult | null, source: "run" | "saved") => void;
  /** Shows a short summary, because the diff shows each finding. */
  findingsInDiff?: boolean;
  onRevealFinding?: (finding: CodeReviewFinding) => void;
  /** Reviews the published code of this merge request. Findings can then be posted to it. */
  mergeRequest?: CodeReviewMergeRequestTarget;
  /** Hides the title row, because the page shows its own title. */
  compact?: boolean;
}

const PROVIDER_ORDER: readonly AgentProvider[] = ["codex", "copilot", "openCode", "hermes"];
const LABEL_ORDER: readonly CodeReviewLabel[] = ["blocking", "issue", "question", "suggestion", "nit", "praise"];
const DEFAULT_MODEL = "__default__";
const NO_SKILL = "none";

export function providerLabel(provider: AgentProvider): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "openCode":
      return "OpenCode";
    case "hermes":
      return "Hermes";
    case "copilot":
      return "Copilot";
  }
}

export function codeReviewLabelText(label: CodeReviewLabel): string {
  switch (label) {
    case "blocking":
      return "Blocking";
    case "issue":
      return "Issue";
    case "question":
      return "Question";
    case "suggestion":
      return "Suggestion";
    case "nit":
      return "Nit";
    case "praise":
      return "Praise";
  }
}

export function findingLabel(finding: CodeReviewFinding): CodeReviewLabel {
  if (finding.label) return finding.label;
  return finding.severity === "critical" ? "blocking" : finding.severity === "warning" ? "issue" : "suggestion";
}

export function labelClass(label: CodeReviewLabel): string {
  return styles[`label_${label}`] ?? "";
}

/** True when a repository in the review has a different patch than the one on screen. */
export function codeReviewIsStale(
  review: WorkspaceCodeReviewResult | null | undefined,
  currentPatch: CodeReviewPatchIdentity | undefined,
): boolean {
  if (!review || !currentPatch) return false;
  const reviewed = review.repositories?.find((repository) => repository.repositoryId === currentPatch.repositoryId);
  return Boolean(reviewed && reviewed.patchSha256 !== currentPatch.patchSha256);
}

function reviewedAtText(unixMs: number): string {
  if (!unixMs) return "";
  const elapsed = Date.now() - unixMs;
  if (elapsed >= 0 && elapsed < 60_000) return "now";
  if (elapsed >= 0 && elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)} min ago`;
  return new Date(unixMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function firstInstalledProvider(catalog: AgentModelCatalog | null): AgentProvider {
  const installed = PROVIDER_ORDER.find((provider) =>
    catalog?.providers.some((entry) => entry.provider === provider && entry.installed),
  );
  return installed ?? "codex";
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function CopyCommentButton({ value, label = "Copy comment" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1_600);
    return () => window.clearTimeout(timeout);
  }, [copied]);
  return (
    <button
      aria-label={label}
      className={styles.copyButton}
      data-copied={copied || undefined}
      onClick={() => void copyText(value).then(setCopied)}
      type="button"
    >
      <Glyph name={copied ? "check" : "copy"} size={12} />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function CodeReviewFindingBody({ finding, reviewer }: { finding: CodeReviewFinding; reviewer?: string }) {
  return (
    <>
      {finding.explanation && <p className={styles.findingExplanation}>{finding.explanation}</p>}
      {finding.suggestedComment && (
        <div className={styles.suggestedComment}>
          <div className={styles.suggestedCommentHeader}>
            <span>Suggested MR comment</span>
            <span className={styles.commentActions}>
              <CopyCommentButton value={finding.suggestedComment} />
              <PostFindingButton finding={finding} />
            </span>
          </div>
          <p>{finding.suggestedComment}</p>
        </div>
      )}
      {finding.suggestedPatch && <pre className={styles.patchBlock}>{finding.suggestedPatch}</pre>}
      {finding.precedent && (
        <div className={styles.precedent}>
          <span>{reviewer ? `${reviewer} said this before` : "A reviewer said this before"}</span>
          <q>{finding.precedent.body}</q>
          {finding.precedent.url && (
            <a href={finding.precedent.url} rel="noreferrer" target="_blank">
              Open the earlier comment <Glyph name="external" size={11} />
            </a>
          )}
        </div>
      )}
    </>
  );
}

const TRACE_POLL_MS = 900;

function traceKindLabel(kind: CodeReviewTraceStep["kind"]): string {
  switch (kind) {
    case "thinking": return "Thinks";
    case "message": return "Says";
    case "command": return "Runs";
    case "tool": return "Uses tool";
    case "search": return "Searches";
    case "error": return "Error";
    case "status": return "Status";
  }
}

function elapsedText(fromMs: number, toMs: number): string {
  const seconds = Math.max(0, Math.round((toMs - fromMs) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

/** Polls the live steps of the review run and merges them by sequence number. */
function useCodeReviewTrace(client: WorkspaceClient, workspaceId: string, active: boolean, startedAtMs: number) {
  const [trace, setTrace] = useState<CodeReviewTrace | null>(null);
  useEffect(() => {
    if (!active || !client.getWorkspaceCodeReviewTrace) return;
    let stopped = false;
    let timer: number | undefined;
    let runId: string | undefined;
    let after: number | undefined;
    setTrace(null);
    const poll = async () => {
      try {
        const next = await client.getWorkspaceCodeReviewTrace!(workspaceId, after);
        if (stopped) return;
        // Skip the trace of an earlier run until the new run starts.
        if (next && next.startedAtUnixMs >= startedAtMs - 2_000) {
          if (next.runId !== runId) {
            runId = next.runId;
            after = undefined;
            setTrace(next);
          } else {
            setTrace((current) => {
              if (!current || current.runId !== next.runId) return next;
              const bySequence = new Map(current.steps.map((step) => [step.sequence, step]));
              for (const step of next.steps) bySequence.set(step.sequence, step);
              return { ...next, steps: [...bySequence.values()].sort((left, right) => left.sequence - right.sequence) };
            });
          }
          const settled = next.steps.filter((step) => !step.running);
          const lastSettled = settled.at(-1)?.sequence;
          if (lastSettled !== undefined) after = lastSettled;
        }
      } catch {
        // The trace is a preview. The review result still arrives.
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), TRACE_POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      // Read the last steps once, so the log shows the end of the run.
      client.getWorkspaceCodeReviewTrace!(workspaceId).then(
        (last) => { if (last && last.runId === runId) setTrace(last); },
        () => undefined,
      );
    };
  }, [active, client, startedAtMs, workspaceId]);
  return trace;
}

export function CodeReviewTraceView({
  trace,
  running,
  providerName,
  startedAtMs,
}: {
  trace: CodeReviewTrace | null;
  running: boolean;
  providerName: string;
  startedAtMs: number;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const [follow, setFollow] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  const steps = trace?.steps ?? [];
  useEffect(() => {
    const list = listRef.current;
    if (follow && list) list.scrollTop = list.scrollHeight;
  }, [follow, steps.length, steps.at(-1)?.running]);
  const current = [...steps].reverse().find((step) => step.running) ?? steps.at(-1);
  const commands = steps.filter((step) => step.kind === "command" || step.kind === "tool" || step.kind === "search").length;
  return (
    <div
      className={styles.trace}
      data-running={running || undefined}
      data-ui="verification.code-review-trace"
      data-ui-label="Agent activity"
    >
      <div className={styles.traceHeader}>
        {running ? <span aria-hidden="true" className={styles.pulse} /> : <Glyph name={trace?.state === "failed" ? "warning" : "check"} size={12} />}
        <b>{running ? `${providerName} reviews the changes` : "Agent activity"}</b>
        <span className={styles.traceMeta}>
          {elapsedText(trace?.startedAtUnixMs || startedAtMs, running ? now : (steps.at(-1)?.atUnixMs ?? now))}
          {commands ? ` · ${commands} ${commands === 1 ? "command" : "commands"}` : ""}
          {trace?.model ? ` · ${trace.model}` : ""}
        </span>
      </div>
      {running && current && (
        <p aria-live="polite" className={styles.traceNow}>
          <span>{traceKindLabel(current.kind)}</span>
          <span className={current.kind === "command" ? styles.traceCode : undefined}>{current.text}</span>
        </p>
      )}
      {steps.length > 0 ? (
        <ol
          aria-label="Agent steps"
          className={styles.traceList}
          onScroll={(event) => {
            const list = event.currentTarget;
            setFollow(list.scrollHeight - list.scrollTop - list.clientHeight < 24);
          }}
          ref={listRef}
        >
          {(trace?.droppedSteps ?? 0) > 0 && (
            <li className={styles.traceDropped}>{trace!.droppedSteps} earlier steps are not shown.</li>
          )}
          {steps.map((step) => (
            <li data-kind={step.kind} data-running={step.running || undefined} key={step.sequence}>
              <span className={styles.traceKind}>{traceKindLabel(step.kind)}</span>
              <div className={styles.traceBody}>
                <span className={step.kind === "command" ? styles.traceCode : undefined}>{step.text}</span>
                {step.detail && <small>{step.detail}</small>}
              </div>
              <time>{elapsedText(trace?.startedAtUnixMs || startedAtMs, step.atUnixMs)}</time>
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.traceEmpty}>
          {running ? "WTS starts the agent. The steps show here when the agent reports them." : "The agent reported no steps."}
        </p>
      )}
    </div>
  );
}

function modelOptionsFor(entry: AgentProviderModels | undefined) {
  if (!entry) return [];
  const models = entry.models.filter((model) => model !== entry.defaultModel);
  return models;
}

export function WorkspaceCodeReviewCard({
  client,
  workspaceId,
  workspaceKey,
  onNotice,
  repositoryId,
  currentPatch,
  review: controlledReview,
  onReviewChange,
  findingsInDiff = false,
  onRevealFinding,
  mergeRequest,
  compact = false,
}: WorkspaceCodeReviewCardProps) {
  const controlled = controlledReview !== undefined;
  const [ownReview, setOwnReview] = useState<WorkspaceCodeReviewResult | null>(null);
  const review = controlled ? controlledReview : ownReview;
  const [scope, setScope] = useState<CodeReviewScope>("recentChanges");
  const [catalog, setCatalog] = useState<AgentModelCatalog | null>(null);
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "error">(
    client.listAgentModels ? "loading" : "error",
  );
  const [provider, setProvider] = useState<AgentProvider | null>(null);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [skill, setSkill] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState(0);
  const trace = useCodeReviewTrace(client, workspaceId, running, runStartedAt);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const onReviewChangeRef = useRef(onReviewChange);
  onReviewChangeRef.current = onReviewChange;

  const publishReview = useCallback((next: WorkspaceCodeReviewResult | null, source: "run" | "saved") => {
    if (!controlled) setOwnReview(next);
    onReviewChangeRef.current?.(next, source);
  }, [controlled]);

  const loadModels = useCallback(async (refresh: boolean) => {
    if (!client.listAgentModels) return;
    setCatalogState("loading");
    try {
      const next = await client.listAgentModels(refresh);
      setCatalog(next);
      setCatalogState("ready");
      setProvider((current) => {
        if (current && next.providers.some((entry) => entry.provider === current && entry.installed)) return current;
        return firstInstalledProvider(next);
      });
    } catch {
      setCatalogState("error");
    }
  }, [client]);

  useEffect(() => {
    void loadModels(false);
  }, [loadModels]);

  useEffect(() => {
    if (controlled || !client.getWorkspaceCodeReview) return;
    let active = true;
    client.getWorkspaceCodeReview(workspaceId).then(
      (saved) => { if (active && saved) publishReview(saved, "saved"); },
      () => undefined,
    );
    return () => { active = false; };
  }, [client, controlled, publishReview, workspaceId]);

  const selectedProvider = provider ?? firstInstalledProvider(catalog);
  const providerEntry = catalog?.providers.find((entry) => entry.provider === selectedProvider);
  const installedProviders = catalog
    ? PROVIDER_ORDER.filter((candidate) => catalog.providers.some((entry) => entry.provider === candidate && entry.installed))
    : PROVIDER_ORDER;
  const noProvider = catalogState === "ready" && installedProviders.length === 0;
  const extraModels = modelOptionsFor(providerEntry);
  const defaultModelText = providerEntry?.defaultModel
    ? `Default · ${providerEntry.defaultModel}`
    : "Default model";
  const reviewSkills = catalog?.reviewSkills ?? [];
  const selectedSkillId = skill ?? catalog?.defaultReviewSkill ?? (reviewSkills.length ? reviewSkills[0]!.id : NO_SKILL);
  const selectedSkill = reviewSkills.find((candidate) => candidate.id === selectedSkillId);
  const catalogKnowsSkills = Boolean(catalog?.reviewSkills);
  const raptikReady = catalogKnowsSkills ? selectedSkill?.id === "raptik-review" : (catalog?.raptikSkillLoaded ?? review?.mode === "raptik");
  const badgeText = catalogKnowsSkills
    ? selectedSkill?.label ?? "General rules"
    : raptikReady ? "Raptik rules" : "General rules";
  const skillDescription = selectedSkill
    ? `The review uses the ${selectedSkill.label} skill${selectedSkill.reviewer ? `: the rules and earlier comments of ${selectedSkill.reviewer}` : ""}. Source: ${selectedSkill.source}.`
    : raptikReady
      ? "The review uses the Raptik skill: Pratik's rules, playbook, and earlier comments."
      : "The review uses general rules. Add a review skill to use your team rules.";
  const scopeValue: CodeReviewScope = mergeRequest ? "recentChanges" : scope;
  const stale = codeReviewIsStale(review, currentPatch);

  const openForManualReview = async () => {
    setOpening(true);
    setError(null);
    try {
      const result = await client.openWorkspaceInVscode(workspaceId);
      if (!result.accepted || result.workspaceId !== workspaceId) throw new Error("WTS could not open this workspace.");
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : "WTS could not open VS Code."} Open VS Code, then open the saved workspace file.`);
    } finally { setOpening(false); }
  };

  const runReview = async (ignoreSizeGate = false) => {
    if (!client.runWorkspaceCodeReview) {
      setError("This client cannot run an AI code review.");
      return;
    }
    setRunning(true);
    setRunStartedAt(Date.now());
    setError(null);
    onNotice?.(`${workspaceKey} · The AI code review started.`);
    try {
      const options = {
        ...(mergeRequest ? { repositoryId: mergeRequest.worktreeRepositoryId, mergeRequestIid: mergeRequest.iid } : repositoryId ? { repositoryId } : {}),
        ...(ignoreSizeGate ? { ignoreSizeGate: true } : {}),
        ...(catalogKnowsSkills ? { skill: selectedSkillId } : {}),
      };
      const result = Object.keys(options).length
        ? await client.runWorkspaceCodeReview(workspaceId, selectedProvider, scopeValue, model === DEFAULT_MODEL ? undefined : model, options)
        : await client.runWorkspaceCodeReview(workspaceId, selectedProvider, scopeValue, model === DEFAULT_MODEL ? undefined : model);
      publishReview(result, "run");
      onNotice?.(`${workspaceKey} · The AI code review is complete.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The AI code review failed.";
      setError(message);
      onNotice?.(`${workspaceKey} · ${message}`, "error");
    } finally {
      setRunning(false);
    }
  };

  const counts = useMemo(() => {
    const result = new Map<CodeReviewLabel, number>();
    for (const finding of review?.findings ?? []) {
      const label = findingLabel(finding);
      result.set(label, (result.get(label) ?? 0) + 1);
    }
    return LABEL_ORDER.flatMap((label) => (result.get(label) ? [{ label, count: result.get(label)! }] : []));
  }, [review]);

  const findingCount = review?.findings.length ?? 0;
  const anchoredCount = review?.findings.filter((finding) => finding.anchored).length ?? 0;
  const questions = review?.findings.filter((finding) => findingLabel(finding) === "question") ?? [];
  const others = review?.findings.filter((finding) => findingLabel(finding) !== "question") ?? [];
  const renderFindings = (items: CodeReviewFinding[], listLabel: string) => (
    <ol className={styles.findingsList} aria-label={listLabel}>
      {items.map((finding) => {
        const label = findingLabel(finding);
        return (
          <li className={styles.findingCard} data-label={label} key={finding.findingId}>
            <div className={styles.findingHeader}>
              <span className={`${styles.labelChip} ${labelClass(label)}`}>{codeReviewLabelText(label)}</span>
              <span className={styles.findingTitle}>{finding.title}</span>
            </div>
            {finding.filePath && (
              <div className={styles.findingLocation}>
                {onRevealFinding && finding.anchored ? (
                  <button aria-label={`Show ${finding.filePath}${finding.line ? ` line ${finding.line}` : ""} in the diff`} onClick={() => onRevealFinding(finding)} type="button">
                    {finding.filePath}{finding.line ? `:${finding.line}` : ""}
                  </button>
                ) : (
                  <span>{finding.filePath}{finding.line ? `:${finding.line}` : ""}</span>
                )}
              </div>
            )}
            <CodeReviewFindingBody finding={finding} reviewer={reviewerName(review)} />
          </li>
        );
      })}
    </ol>
  );
  const publishValue = useMemo(
    () => (mergeRequest ? { client, workspaceId, target: mergeRequest, review: review ?? null } : null),
    [client, mergeRequest, review, workspaceId],
  );

  return (
    <CodeReviewPublishProvider value={publishValue}>
    <section
      aria-busy={running || undefined}
      aria-label="AI code review"
      className={styles.card}
      data-ui="verification.code-review"
      data-ui-label="AI code review"
    >
      <header className={styles.header} data-compact={compact || undefined}>
        <div className={styles.headerText}>
          <div className={styles.titleRow}>
            <h3>AI code review</h3>
            <span
              className={styles.modeBadge}
              data-mode={selectedSkill || raptikReady ? "raptik" : "standard"}
              data-ui="verification.code-review-mode"
              data-ui-label="Code review mode"
              title={skillDescription}
            >
              {badgeText}
            </span>
          </div>
          {!compact && <p>
            {mergeRequest
              ? `The agent reviews the published code of MR !${mergeRequest.iid}. It can read files but cannot change them. You decide which comments go to GitLab.`
              : selectedSkill?.reviewer
                ? `Review the changes with the rules that ${selectedSkill.reviewer} uses. The agent can read files but cannot change them.`
                : "Review the changes with an AI agent. The agent can read files but cannot change them."}
          </p>}
        </div>
        <button
          className={styles.reviewButton}
          data-ui="verification.code-review-run"
          data-ui-label="Review code button"
          disabled={running || !client.runWorkspaceCodeReview || noProvider}
          onClick={() => void runReview()}
          type="button"
        >
          {running ? <span aria-hidden="true" className={styles.spinner} /> : <Glyph name="play" size={12} />}
          {running ? "Review in progress" : review ? "Review again" : "Review code"}
        </button>
      </header>

      <div
        className={styles.controls}
        data-ui="verification.code-review-controls"
        data-ui-label="Code review settings"
      >
        {!mergeRequest && <div aria-label="Code review scope" className={styles.segmented} role="radiogroup">
          {(["recentChanges", "totalCode"] as const).map((value) => (
            <button
              aria-checked={scope === value}
              disabled={running}
              key={value}
              onClick={() => setScope(value)}
              role="radio"
              type="button"
            >
              {value === "recentChanges" ? "Changes" : "All code"}
            </button>
          ))}
        </div>}
        {catalogKnowsSkills && (
          <label className={styles.field}>
            <span>Skill</span>
            <SelectMenu
              aria-label="Code review skill"
              className={styles.select}
              disabled={running}
              onChange={setSkill}
              value={selectedSkillId}
            >
              {reviewSkills.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
              ))}
              <option value={NO_SKILL}>No skill · general rules</option>
            </SelectMenu>
          </label>
        )}
        <label className={styles.field}>
          <span>Agent</span>
          <SelectMenu
            aria-label="Code review provider"
            className={styles.select}
            disabled={running || noProvider}
            onChange={(value) => {
              setProvider(value as AgentProvider);
              setModel(DEFAULT_MODEL);
            }}
            value={selectedProvider}
          >
            {installedProviders.map((candidate) => (
              <option key={candidate} value={candidate}>{providerLabel(candidate)}</option>
            ))}
          </SelectMenu>
        </label>
        <label className={styles.field}>
          <span>Model</span>
          <SelectMenu
            aria-label="Code review model"
            className={`${styles.select} ${styles.modelSelect}`}
            disabled={running || noProvider || providerEntry?.modelSelectable === false}
            onChange={setModel}
            searchable={extraModels.length > 6}
            searchPlaceholder="Search models"
            value={model}
          >
            <option value={DEFAULT_MODEL}>{defaultModelText}</option>
            {extraModels.map((candidate) => (
              <option key={candidate} value={candidate}>{candidate}</option>
            ))}
          </SelectMenu>
        </label>
        <span className={styles.modelSource} data-ui="verification.code-review-model-source" data-ui-label="Model source">
          {catalogState === "loading"
            ? "WTS reads the agent settings."
            : catalogState === "error"
              ? "WTS could not read the agent settings. The agent uses its default model."
              : providerEntry?.defaultSource
                ? `From ${providerEntry.defaultSource}`
                : "The agent uses its default model."}
          {client.listAgentModels && (
            <button
              aria-label="Read the agent models again"
              className={styles.iconButton}
              disabled={catalogState === "loading" || running}
              onClick={() => void loadModels(true)}
              title="Read the agent models again"
              type="button"
            >
              <Glyph name="refresh" size={12} />
            </button>
          )}
        </span>
      </div>

      {noProvider && (
        <div className={styles.notice} role="status">
          WTS did not find Codex, Copilot, OpenCode, or Hermes. Install one agent CLI, then read the agent models again.
        </div>
      )}
      {!client.runWorkspaceCodeReview && (
        <div className={styles.errorBanner} role="status">
          <p>This client cannot run AI reviews. Open the workspace in VS Code to review its changes.</p>
          <button disabled={opening} onClick={() => void openForManualReview()} type="button">Open workspace in VS Code</button>
        </div>
      )}
      {error && <div className={styles.errorBanner} role="alert">{error}</div>}

      {running && (
        client.getWorkspaceCodeReviewTrace ? (
          <CodeReviewTraceView
            providerName={providerLabel(selectedProvider)}
            running
            startedAtMs={runStartedAt}
            trace={trace}
          />
        ) : (
          <div className={styles.progress} role="status">
            <span className={styles.progressBar} aria-hidden="true" />
            {providerLabel(selectedProvider)} reads the changes. A review can take some minutes.
          </div>
        )
      )}
      {!running && trace && trace.steps.length > 0 && (
        <details className={styles.traceDetails}>
          <summary>Show agent activity ({trace.steps.length} steps)</summary>
          <CodeReviewTraceView
            providerName={providerLabel(trace.provider)}
            running={false}
            startedAtMs={runStartedAt}
            trace={trace}
          />
        </details>
      )}

      {review && !running && (
        <div className={styles.result} data-ui="verification.code-review-result" data-ui-label="Code review result" data-outcome={review.outcome ?? "reviewed"}>
          <div className={styles.reviewMeta}>
            <span>
              {providerLabel(review.provider)}
              {review.model ? ` · ${review.model}` : ""}
              {" · "}
              {review.scope === "recentChanges" ? "Changes" : "All code"}
              {review.repositories?.length
                ? ` · ${review.repositories.map((repository) => repository.repositoryLabel).join(", ")}`
                : ""}
              {review.reviewedAtUnixMs ? ` · ${reviewedAtText(review.reviewedAtUnixMs)}` : ""}
            </span>
            {stale && (
              <span className={styles.staleBadge} data-ui="verification.code-review-stale" data-ui-label="Old review badge" role="status">
                The code changed after this review
              </span>
            )}
          </div>

          {review.outcome === "sizeGateStopped" ? (
            <div className={styles.gate} role="status">
              <div>
                <b>The change is too large for one review</b>
                <p>{review.summary}</p>
                {review.actionableSteps.length > 0 && (
                  <ul>{review.actionableSteps.map((step) => <li key={step.stepNumber}>{step.instruction}</li>)}</ul>
                )}
              </div>
              <button disabled={running} onClick={() => void runReview(true)} type="button">
                Review anyway
              </button>
            </div>
          ) : review.outcome === "noChanges" ? (
            <div className={styles.notice} role="status">{review.summary || "There are no changes to review."}</div>
          ) : (
            <>
              {review.intent && (
                <p className={styles.intent}><span>Intent</span>{review.intent}</p>
              )}
              <p className={styles.summary}>{review.summary}</p>
              {review.outcome === "unstructured" && (
                <details className={styles.rawOutput}>
                  <summary>WTS could not read findings from the agent. Show the agent output.</summary>
                  <pre>{review.rawOutput || "The agent gave no output."}</pre>
                </details>
              )}
              {counts.length > 0 && (
                <div className={styles.counts} aria-label="Findings by label">
                  {counts.map(({ label, count }) => (
                    <span className={`${styles.labelChip} ${labelClass(label)}`} key={label}>
                      {count} {codeReviewLabelText(label)}
                    </span>
                  ))}
                </div>
              )}
              {findingsInDiff && findingCount > 0 && (
                <p className={styles.diffHint}>
                  {anchoredCount === findingCount
                    ? "Each finding shows on its changed line in the diff and in the AI review panel."
                    : `${anchoredCount} of ${findingCount} findings show on changed lines. The AI review panel shows all findings.`}
                </p>
              )}
              {questions.length > 0 && (
                <section
                  aria-label="Questions for you"
                  className={styles.questions}
                  data-ui="verification.code-review-questions"
                  data-ui-label="Agent questions"
                >
                  <header>
                    <Glyph name="comment" size={13} />
                    <b>Questions for you</b>
                    <span>The agent could not confirm these from the code. Answer them yourself, or post them to the author.</span>
                  </header>
                  {renderFindings(questions, "Agent questions")}
                </section>
              )}
              {!findingsInDiff && others.length > 0 && renderFindings(others, "Code review findings")}
              {review.outcome !== "unstructured" && findingCount === 0 && (
                <div className={styles.clean} role="status"><Glyph name="check" size={13} /> The review found no problems.</div>
              )}
              {(review.suggestedTests?.length ?? 0) > 0 && (
                <div className={styles.listBlock}>
                  <b>Tests to add</b>
                  <ul>{review.suggestedTests!.map((test) => <li key={test}>{test}</li>)}</ul>
                </div>
              )}
              {review.actionableSteps.length > 0 && (
                <div className={styles.listBlock}>
                  <b>Next steps</b>
                  <ol>{review.actionableSteps.map((step) => <li key={step.stepNumber}>{step.instruction}</li>)}</ol>
                </div>
              )}
              {(review.notChecked?.length ?? 0) > 0 && (
                <div className={`${styles.listBlock} ${styles.notChecked}`}>
                  <b>Not checked</b>
                  <ul>{review.notChecked!.map((item) => <li key={item}>{item}</li>)}</ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
    </CodeReviewPublishProvider>
  );
}
