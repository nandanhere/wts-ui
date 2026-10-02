import { useEffect, useState, type ReactNode } from "react";
import type { WorkspaceClient, WorkspaceCodeReviewResult } from "../../lib/wtsClient";
import type { GitlabConversationsController } from "./gitlabDiscussions";
import { Glyph } from "./Glyph";
import styles from "./ReviewHomePanel.module.css";

export interface ReviewThreadSummary {
  id: string;
  targetKey: string;
  scopeId: string;
  worktreeRepositoryId: string;
  filePath?: string;
  location: string;
  author: string;
  body: string;
  unread: number;
}

/** Human review threads with unread comments. Bot notes and resolved threads are not review work. */
export function unreadHumanThreads(controller: GitlabConversationsController | undefined): ReviewThreadSummary[] {
  if (!controller) return [];
  return controller.entries.flatMap((entry) => {
    const unread = new Set(entry.unreadCommentIds);
    return (entry.snapshot?.discussions ?? [])
      .filter((thread) => !thread.automated && !thread.resolved)
      .map((thread) => {
        const count = thread.comments.filter((comment) => unread.has(comment.id)).length;
        const last = thread.comments.at(-1);
        return {
          id: thread.id,
          targetKey: entry.target.key,
          scopeId: entry.snapshot!.scopeId,
          worktreeRepositoryId: entry.target.worktreeRepositoryId,
          ...(thread.filePath ? { filePath: thread.filePath } : {}),
          location: thread.filePath ? `${thread.filePath}${thread.line ? `:${thread.line}` : ""}` : "General discussion",
          author: last?.authorLogin ?? "",
          body: last?.body ?? "",
          unread: count,
        };
      })
      .filter((thread) => thread.unread > 0);
  });
}

/** Reads the saved AI review. A new revision reads it again, for example after a tab change. */
export function useSavedCodeReview(client: WorkspaceClient, workspaceId: string, enabled: boolean, revision: unknown = 0) {
  const [review, setReview] = useState<WorkspaceCodeReviewResult | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled || !workspaceId) return;
    if (!client.getWorkspaceCodeReview) { setReview(null); return; }
    let active = true;
    client.getWorkspaceCodeReview(workspaceId).then(
      (saved) => { if (active) setReview(saved); },
      () => { if (active) setReview(null); },
    );
    return () => { active = false; };
  }, [client, workspaceId, enabled, revision]);
  useEffect(() => { setReview(undefined); }, [workspaceId]);
  return review;
}

function severityCounts(review: WorkspaceCodeReviewResult) {
  return {
    critical: review.findings.filter((finding) => finding.severity === "critical").length,
    warning: review.findings.filter((finding) => finding.severity === "warning").length,
    suggestion: review.findings.filter((finding) => finding.severity === "suggestion").length,
  };
}

function reviewedAt(unixMs: number) {
  if (!unixMs) return "";
  return new Date(unixMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The next review step, from the most urgent signal to the least urgent. */
export function reviewNextStep(review: WorkspaceCodeReviewResult | null | undefined, threads: ReviewThreadSummary[], finished = false) {
  if (finished) return { label: "Read the final changes", target: "code" as const };
  if (threads.length > 0) return { label: `Reply to ${threads.length} ${threads.length === 1 ? "thread" : "threads"}`, target: "conversations" as const };
  if (!review) return { label: "Run the agent review", target: "agent" as const };
  if (review.findings.length > 0) return { label: `Check ${review.findings.length} agent ${review.findings.length === 1 ? "finding" : "findings"}`, target: "agent" as const };
  return { label: "Read the changes", target: "code" as const };
}

export function ReviewAttentionStrip({
  review,
  threads,
  threadsLoading = false,
  finished = false,
  onOpenAgentReview,
  onOpenConversations,
  onOpenCode,
}: {
  review: WorkspaceCodeReviewResult | null | undefined;
  threads: ReviewThreadSummary[];
  /** True until GitLab returns the MR conversations. */
  threadsLoading?: boolean;
  /** True when GitLab merged or closed the MR. No review action remains. */
  finished?: boolean;
  onOpenAgentReview: () => void;
  onOpenConversations: () => void;
  onOpenCode: () => void;
}) {
  const next = reviewNextStep(review, threads, finished);
  const counts = review ? severityCounts(review) : null;
  const open = next.target === "conversations" ? onOpenConversations : next.target === "agent" ? onOpenAgentReview : onOpenCode;
  return (
    <section aria-label="Review attention" className={styles.strip} data-ui="workspace-overview.review-attention" data-ui-label="Review attention">
      <button className={styles.stat} onClick={onOpenConversations} type="button">
        <small>Threads to answer</small>
        {threadsLoading ? <strong data-zero>Checking…</strong> : <strong data-zero={threads.length === 0 || undefined}>{threads.length}</strong>}
      </button>
      <button className={styles.stat} onClick={onOpenAgentReview} type="button">
        <small>Agent findings</small>
        {review === undefined ? <strong data-zero>…</strong> : counts ? (
          <strong data-zero={review!.findings.length === 0 || undefined}>
            {review!.findings.length}
            {counts.critical > 0 && <em data-severity="critical">{counts.critical} critical</em>}
          </strong>
        ) : <strong data-zero>Not run</strong>}
      </button>
      <span className={styles.next}>
        <small>Next step</small>
        <button className={finished ? styles.secondary : styles.primary} onClick={open} type="button">
          {next.label}
          <Glyph name="arrow" size={12} />
        </button>
      </span>
    </section>
  );
}

export function ReviewHomePanel({
  review,
  threads,
  onRunReview,
  onOpenFindings,
  onOpenThread,
  planning,
  finished = false,
}: {
  review: WorkspaceCodeReviewResult | null | undefined;
  threads: ReviewThreadSummary[];
  onRunReview: () => void;
  onOpenFindings: () => void;
  onOpenThread: (thread: ReviewThreadSummary) => void;
  planning: ReactNode;
  /** True when GitLab merged or closed the MR. A new review is then optional. */
  finished?: boolean;
}) {
  const counts = review ? severityCounts(review) : null;
  return (
    <div className={styles.home} data-ui="agent-review.home" data-ui-label="Agent review home">
      <section aria-labelledby="agent-review-state" className={styles.card}>
        <header className={styles.cardHeader}>
          <span>
            <small>Agent review</small>
            <h2 id="agent-review-state">
              {review === undefined ? "Reading the saved review…" : review ? (review.findings.length ? `${review.findings.length} ${review.findings.length === 1 ? "finding" : "findings"}` : "No findings") : "No agent review yet"}
            </h2>
            <p>
              {review
                ? `${review.skill?.label ?? (review.mode === "raptik" ? "Raptik rules" : "General rules")}${review.model ? ` · ${review.model}` : ""} · ${reviewedAt(review.reviewedAtUnixMs)}`
                : finished
                  ? "GitLab closed this MR. No review action remains. You can still run a review to learn from the change."
                  : "The agent reads the MR changes with your review skill. It does not change files or post to GitLab."}
            </p>
          </span>
          <span className={styles.actions}>
            {review && review.findings.length > 0 && (
              <button className={styles.secondary} onClick={onOpenFindings} type="button">Show in code</button>
            )}
            {finished ? (
              <details className={styles.followUp} data-ui="agent-review.follow-up" data-ui-label="Follow-up review">
                <summary>Review for follow-up</summary>
                <button className={styles.secondary} onClick={onRunReview} type="button">
                  <Glyph name="play" size={12} />
                  {review ? "Run again" : "Run review"}
                </button>
              </details>
            ) : (
              <button className={styles.primary} onClick={onRunReview} type="button">
                <Glyph name="play" size={12} />
                {review ? "Run again" : "Run review"}
              </button>
            )}
          </span>
        </header>
        {review && counts && review.findings.length > 0 && (
          <div className={styles.severities} role="list" aria-label="Findings by severity">
            <span role="listitem" data-severity="critical"><b>{counts.critical}</b> critical</span>
            <span role="listitem" data-severity="warning"><b>{counts.warning}</b> warnings</span>
            <span role="listitem" data-severity="suggestion"><b>{counts.suggestion}</b> suggestions</span>
          </div>
        )}
        {review && review.summary && <p className={styles.summary}>{review.summary}</p>}
        {review && review.findings.length > 0 && (
          <ol className={styles.findings} aria-label="Agent findings">
            {review.findings.slice(0, 6).map((finding) => (
              <li key={finding.findingId}>
                <button onClick={onOpenFindings} type="button">
                  <i data-severity={finding.severity} aria-hidden="true" />
                  <span>
                    <b>{finding.title}</b>
                    <code>{finding.filePath}{finding.line ? `:${finding.line}` : ""}</code>
                  </span>
                </button>
              </li>
            ))}
            {review.findings.length > 6 && <li className={styles.more}>{review.findings.length - 6} more in the code view</li>}
          </ol>
        )}
        {review?.suggestedTests && review.suggestedTests.length > 0 && (
          <div className={styles.tests}>
            <small>Tests to add</small>
            <ul>{review.suggestedTests.slice(0, 4).map((test) => <li key={test}>{test}</li>)}</ul>
          </div>
        )}
      </section>
      <section aria-labelledby="agent-review-threads" className={styles.card}>
        <header className={styles.cardHeader}>
          <span>
            <small>GitLab</small>
            <h2 id="agent-review-threads">{threads.length ? `${threads.length} ${threads.length === 1 ? "thread needs" : "threads need"} a reply` : "No threads need a reply"}</h2>
          </span>
        </header>
        {threads.length > 0 && (
          <ol className={styles.findings} aria-label="Threads that need a reply">
            {threads.map((thread) => (
              <li key={thread.id}>
                <button onClick={() => onOpenThread(thread)} type="button">
                  <Glyph name="comment" size={13} />
                  <span>
                    <b>@{thread.author}: {thread.body.length > 120 ? `${thread.body.slice(0, 117)}…` : thread.body}</b>
                    <code>{thread.location}</code>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
      <details className={styles.planning}>
        <summary>Review notes and plan</summary>
        {planning}
      </details>
    </div>
  );
}
