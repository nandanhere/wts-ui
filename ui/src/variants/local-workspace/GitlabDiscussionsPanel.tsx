import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type {
  GitlabReviewDiscussion,
  GitlabReviewDiscussionComment,
  WorkspaceClient,
} from "../../lib/wtsClient";
import { SelectMenu } from "../../components/SelectMenu";
import type { GitlabConversationsController } from "./gitlabDiscussions";
import { GitlabDiscussionBody } from "./GitlabDiscussionBody";
import { Glyph } from "./Glyph";
import { gitlabDiscussionDrafts } from "./gitlabDiscussionDrafts";
import styles from "./GitlabDiscussionsPanel.module.css";
import { buildGitlabDiscussionFixContext, type GitlabDiscussionFixContext } from "./gitlabDiscussionFixContext";

type ConversationFilter = "all" | "open" | "resolved";
interface DisplayedConversation {
  comments: GitlabReviewDiscussionComment[];
}
interface ReplyState {
  pending: boolean;
  error: string;
  published: boolean;
}

function discussionLabel(discussion: GitlabReviewDiscussion) {
  if (!discussion.filePath) return "General discussion";
  return discussion.line
    ? `${discussion.filePath}:${discussion.side === "deletions" ? "−" : "+"}${discussion.line}`
    : discussion.filePath;
}

function commentDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function automatedPreview(body: string) {
  const text = body.replace(/<[^>]+>/g, " ").replace(/[#*_`>|]+/g, " ").split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 3).join(" ");
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

function longAutomatedComment(discussion: GitlabReviewDiscussion, comment: GitlabReviewDiscussionComment) {
  return discussion.automated && discussion.comments[0]?.id === comment.id &&
    (comment.body.length > 600 || comment.body.split("\n").length > 8);
}

export function GitlabDiscussionsPanel({
  active,
  client,
  controller,
  repositoryId,
  selectedTargetKey,
  selectedDiscussionId,
  onTargetChange,
  filePath,
  compact = false,
  hideTargetSelector = false,
  renderContext,
  onSelectConversation,
  onClose,
  onOpenIntegrations,
  revealConversation,
  workspaceId,
  onAskAgentToFix,
}: {
  active: boolean;
  client: WorkspaceClient;
  controller: GitlabConversationsController;
  repositoryId: string;
  selectedTargetKey?: string;
  selectedDiscussionId?: string;
  onTargetChange?: (key: string) => void;
  filePath?: string;
  compact?: boolean;
  hideTargetSelector?: boolean;
  renderContext?: (discussion: GitlabReviewDiscussion) => ReactNode;
  onSelectConversation?: (discussion: GitlabReviewDiscussion) => void;
  onClose?: () => void;
  onOpenIntegrations?: () => void;
  revealConversation?: { requestId: number; targetKey: string; scopeId: string; discussionId: string };
  workspaceId?: string;
  onAskAgentToFix?: (context: GitlabDiscussionFixContext) => void;
}) {
  const entries = useMemo(
    () => controller.entries.filter((entry) => entry.target.worktreeRepositoryId === repositoryId),
    [controller.entries, repositoryId],
  );
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<ConversationFilter>("all");
  const revealedRequestRef = useRef<number | null>(null);
  const revealFocusRef = useRef<string | null>(null);
  const threadButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const replyInputRef = useRef<HTMLTextAreaElement>(null);
  const replyFocusRef = useRef<string | null>(null);
  useSyncExternalStore(gitlabDiscussionDrafts.subscribe, gitlabDiscussionDrafts.getSnapshot);
  const [displayed, setDisplayed] = useState<Record<string, DisplayedConversation>>({});
  const [expandedComments, setExpandedComments] = useState<Record<string, boolean>>({});
  const [replies, setReplies] = useState<Record<string, ReplyState>>({});
  const [openErrors, setOpenErrors] = useState<Record<string, string>>({});
  const mountedRef = useRef(true);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const entry = entries.find((candidate) => candidate.target.key === (selectedTargetKey ?? targets[repositoryId])) ?? entries[0];
  const snapshot = entry?.snapshot;
  const targetKey = entry?.target.key ?? "";
  const scopeId = snapshot?.scopeId ?? "";
  const selectionKey = JSON.stringify([targetKey, scopeId]);
  const discussions = snapshot?.discussions ?? [];
  const fileDiscussions = discussions.filter((discussion) => !filePath || discussion.filePath === filePath);
  // Human review threads come first. Bot notes stay at the end.
  const visibleDiscussions = fileDiscussions
    .filter((discussion) =>
      filter === "all" || (filter === "resolved" ? discussion.resolved : !discussion.resolved),
    )
    .map((discussion, index) => ({ discussion, index }))
    .sort((left, right) => Number(left.discussion.automated) - Number(right.discussion.automated) || left.index - right.index)
    .map(({ discussion }) => discussion);
  const selected = visibleDiscussions.find((discussion) => discussion.id === (selectedDiscussionId ?? selections[selectionKey]));
  const draftKey = JSON.stringify([targetKey, scopeId, selected?.id ?? ""]);
  const selectedDisplay = selected ? displayed[draftKey] : undefined;
  const replyState = replies[draftKey];
  const replyError = replyState?.error || gitlabDiscussionDrafts.error(draftKey);
  const body = gitlabDiscussionDrafts.read(draftKey);
  const replyPending = gitlabDiscussionDrafts.isPending(draftKey);
  const fresh = entry?.state === "ready" && snapshot && !snapshot.fromCache;
  const unreadIds = new Set(entry?.unreadCommentIds ?? []);
  const unreadCount = fileDiscussions.reduce((count, discussion) => count + discussion.comments.filter((comment) => unreadIds.has(comment.id)).length, 0);
  const refreshing = entry?.state === "loading" || controller.loading;
  const freshness = snapshot?.fromCache
    ? refreshing ? "Saved comments · Check in progress" : "Saved comments · Refresh before reply"
    : refreshing ? "WTS checks GitLab for new replies." : snapshot ? `Checked ${new Date(snapshot.fetchedAtUnixMs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : "";
  const error = entry?.error || controller.error;
  const agentWorkspaceId = entry?.target.workspaceId ?? workspaceId;
  const agentContextAvailable = Boolean(agentWorkspaceId?.trim() && entry && snapshot &&
    snapshot.repositoryId === entry.target.repositoryId && snapshot.iid === entry.target.iid);
  const askAgentToFix = () => {
    if (!active || !onAskAgentToFix || !agentContextAvailable || !entry || !snapshot || !selected) return;
    const context = buildGitlabDiscussionFixContext({
      workspaceId: agentWorkspaceId,
      repositoryId: entry.target.worktreeRepositoryId,
      providerRepositoryId: entry.target.repositoryId,
      iid: entry.target.iid,
      scopeId: snapshot.scopeId,
      mergeRequestLabel: entry.target.label,
      title: entry.target.title,
      sourceBranch: entry.target.sourceBranch,
      targetBranch: entry.target.targetBranch,
      discussion: selected,
      fetchedAtUnixMs: snapshot.fetchedAtUnixMs,
      fromCache: snapshot.fromCache,
      truncated: snapshot.truncated,
    });
    if (context) onAskAgentToFix(context);
  };
  const openMergeRequest = async () => {
    if (!entry) return;
    const key = selectionKey;
    setOpenErrors((current) => ({ ...current, [key]: "" }));
    try {
      const result = await client.openGitlabMergeRequest(entry.target.repositoryId, entry.target.iid);
      if (!result.accepted || result.repositoryId !== entry.target.repositoryId || result.iid !== entry.target.iid) throw new Error("WTS could not open this merge request.");
    } catch (cause) {
      if (mountedRef.current) setOpenErrors((current) => ({ ...current, [key]: `${cause instanceof Error ? cause.message : "WTS could not open GitLab."} Open GitLab in your browser and check this merge request.` }));
    }
  };

  useEffect(() => {
    const acknowledge = () => {
      if (!active || !fresh || !selectedDisplay || document.visibilityState !== "visible") return;
      controller.markRead(targetKey, scopeId, selectedDisplay.comments);
    };
    acknowledge();
    document.addEventListener("visibilitychange", acknowledge);
    return () => document.removeEventListener("visibilitychange", acknowledge);
  }, [active, controller.markRead, fresh, scopeId, selectedDisplay, targetKey]);

  useEffect(() => {
    if (!snapshot) return;
    setDisplayed((current) => {
      let next = current;
      for (const discussion of snapshot.discussions) {
        const key = JSON.stringify([targetKey, scopeId, discussion.id]);
        if (next[key]) continue;
        next = { ...next, [key]: { comments: discussion.comments.map((comment) => ({ ...comment })) } };
      }
      return next;
    });
  }, [snapshot, targetKey, scopeId]);

  const selectConversation = useCallback((discussion: GitlabReviewDiscussion, focusReply = false) => {
    onSelectConversation?.(discussion);
    setSelections((current) => ({ ...current, [selectionKey]: discussion.id }));
    const key = JSON.stringify([targetKey, scopeId, discussion.id]);
    replyFocusRef.current = focusReply ? key : null;
    setDisplayed((current) => ({
      ...current,
      [key]: { comments: discussion.comments.map((comment) => ({ ...comment })) },
    }));
    const automatedComment = discussion.comments.find((comment) => longAutomatedComment(discussion, comment));
    if (automatedComment) {
      setExpandedComments((current) => ({ ...current, [`${key}:${automatedComment.id}`]: true }));
    }
  }, [onSelectConversation, scopeId, selectionKey, targetKey]);

  useEffect(() => {
    if (!active || !selected || replyFocusRef.current !== draftKey) return;
    replyInputRef.current?.focus();
    replyFocusRef.current = null;
  }, [active, draftKey, selected]);

  useEffect(() => {
    if (!active || !revealConversation || revealedRequestRef.current === revealConversation.requestId ||
      revealConversation.targetKey !== targetKey || revealConversation.scopeId !== scopeId) return;
    const discussion = snapshot?.discussions.find((candidate) => candidate.id === revealConversation.discussionId && (!filePath || candidate.filePath === filePath));
    if (!discussion) return;
    revealedRequestRef.current = revealConversation.requestId;
    revealFocusRef.current = JSON.stringify([targetKey, scopeId, discussion.id]);
    setFilter("all");
    selectConversation(discussion);
  }, [active, filePath, revealConversation, scopeId, selectConversation, snapshot, targetKey]);

  useEffect(() => {
    if (!active || filter !== "all" || !selected || revealFocusRef.current !== draftKey) return;
    const button = threadButtonsRef.current.get(draftKey);
    if (!button) return;
    button.focus();
    revealFocusRef.current = null;
  }, [active, draftKey, filter, selected, selectedDisplay]);

  const reply = async () => {
    if (!active || !fresh || !entry || !selected || !body.trim() || !gitlabDiscussionDrafts.beginReply(draftKey)) return;
    const key = draftKey;
    const target = entry.target;
    const discussionId = selected.id;
    const requestBody = body.trim();
    let published = false;
    setReplies((current) => ({ ...current, [key]: { pending: true, error: "", published: false } }));
    try {
      const result = await client.replyGitlabDiscussion(target.repositoryId, target.iid, {
        discussionId,
        body: requestBody,
        ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
      });
      if (result.repositoryId !== target.repositoryId || result.iid !== target.iid || result.discussionId !== discussionId) {
        throw new Error("WTS received a reply for a different conversation.");
      }
      published = true;
      const currentEntry = controllerRef.current.entries.find((candidate) => candidate.target.key === target.key);
      if (currentEntry?.snapshot?.scopeId !== scopeId) return;
      controllerRef.current.acceptReply(target.key, result, scopeId);
      if (!mountedRef.current) return;
      setDisplayed((current) => {
        const previous = current[key];
        if (!previous) return current;
        return {
          ...current,
          [key]: { comments: [...previous.comments.filter((comment) => comment.id !== result.comment.id), result.comment] },
        };
      });
      setReplies((current) => ({ ...current, [key]: { pending: false, error: "", published: true } }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "WTS could not publish this reply. Your draft is saved here.";
      gitlabDiscussionDrafts.failReply(key, message);
      if (!mountedRef.current) return;
      setReplies((current) => ({
        ...current,
        [key]: {
          pending: false,
          error: message,
          published: false,
        },
      }));
    } finally {
      gitlabDiscussionDrafts.finishReply(key, body, published);
      if (mountedRef.current) {
        setReplies((current) => current[key]?.pending
          ? { ...current, [key]: { ...current[key]!, pending: false } }
          : current);
      }
    }
  };

  return (
    <section className={styles.panel} data-compact={compact || undefined} aria-label={compact ? "File conversations" : "GitLab conversations"} data-ui={compact ? "gitlab-file-conversations.panel" : "gitlab-conversations.panel"} data-ui-label={compact ? "File conversations" : "GitLab conversations"}>
      <header className={styles.toolbar} data-ui={compact ? "gitlab-file-conversations.toolbar" : "gitlab-conversations.toolbar"} data-ui-label={compact ? "File conversation toolbar" : "Conversation toolbar"}>
        <div className={styles.summary}>
          {compact && <h3>Conversations</h3>}
          {snapshot && <p>{fileDiscussions.length} {fileDiscussions.length === 1 ? "conversation" : "conversations"} · {unreadCount} unread {unreadCount === 1 ? "comment" : "comments"}</p>}
          {snapshot && <p className={styles.freshness} role="status" title={freshness}>{freshness}</p>}
          {!compact && <p className={styles.explainer} data-ui="gitlab-conversations.help" data-ui-label="Conversations help">Select a thread to read it and see its code. Replies go to GitLab.</p>}
        </div>
        {entry && !hideTargetSelector && <label>
          <span className={styles.srOnly}>Merge request</span>
          <SelectMenu aria-label="Merge request for conversations" value={targetKey} onChange={(key) => { onTargetChange?.(key); setTargets((current) => ({ ...current, [repositoryId]: key })); }}>
            {entries.map((candidate) => <option key={candidate.target.key} value={candidate.target.key}>{candidate.target.label}</option>)}
          </SelectMenu>
        </label>}
        {snapshot && <label>
          <span className={styles.srOnly}>Show</span>
          <SelectMenu aria-label="Conversation status" value={filter} onChange={(value) => setFilter(value as ConversationFilter)}>
            <option value="all">All conversations</option>
            <option value="open">Open conversations</option>
            <option value="resolved">Resolved conversations</option>
          </SelectMenu>
        </label>}
        <button className={styles.refresh} aria-label="Refresh conversations" disabled={entry?.state === "loading" || controller.loading} onClick={() => controller.refresh(entry?.target.key)} type="button"><span aria-hidden="true" data-pending={entry?.state === "loading" || controller.loading || undefined}><Glyph name="refresh" size={14} /></span>Refresh</button>
        {compact && onClose && <button aria-label="Close file conversations" onClick={onClose} type="button">Close</button>}
      </header>
      {error && <div className={styles.error} role="alert" data-ui="gitlab-conversations.error" data-ui-label="Conversations error"><span>{error}</span><button disabled={entry?.state === "loading" || controller.loading} onClick={() => controller.refresh(entry?.target.key)} type="button">Retry conversations</button>{onOpenIntegrations && !error.startsWith("WTS is already") && <button onClick={onOpenIntegrations} type="button">Check GitLab connection</button>}</div>}
      {openErrors[selectionKey] && <p className={styles.error} role="alert">{openErrors[selectionKey]}</p>}
      {snapshot?.truncated && <p className={styles.notice}>GitLab returned part of this conversation history.</p>}
      {!entry ? (
        !error && <p className={styles.empty} role="status">{controller.loading ? "WTS checks GitLab for merge requests." : "No GitLab merge request matches this repository."}</p>
      ) : !snapshot ? (
        !error && <p className={styles.empty} role="status">{entry.state === "loading" ? "WTS loads GitLab conversations." : "Conversations are unavailable. Select Refresh to retry."}</p>
      ) : (
        <div className={styles.feed} data-ui={compact ? "gitlab-file-conversations.list" : "gitlab-conversations.list"} data-ui-label={compact ? "File conversation list" : "Conversation list"}>
          {visibleDiscussions.length === 0 ? <p className={styles.empty}>No conversations match this view.</p> : (
            <ol aria-label="Conversations">
              {visibleDiscussions.map((discussion) => {
                const key = JSON.stringify([targetKey, scopeId, discussion.id]);
                const threadDisplay = displayed[key];
                const comments = threadDisplay?.comments ?? discussion.comments;
                const unread = discussion.comments.filter((comment) => unreadIds.has(comment.id)).length;
                const isSelected = selected?.id === discussion.id;
                const hasUpdates = threadDisplay && JSON.stringify(discussion.comments) !== JSON.stringify(threadDisplay.comments);
                return (
                  <li key={discussion.id}>
                    <section className={styles.thread} data-selected={isSelected || undefined}
                      data-ui={isSelected ? (compact ? "gitlab-file-conversations.thread" : "gitlab-conversations.thread") : undefined}
                      data-ui-label={isSelected ? (compact ? "Selected file conversation" : "Selected conversation") : undefined}>
                      <header className={styles.threadHeading}>
                        <h4><button ref={(button) => { if (button) threadButtonsRef.current.set(key, button); else threadButtonsRef.current.delete(key); }} aria-label={`${discussionLabel(discussion)} by @${discussion.comments[0]?.authorLogin}`} aria-pressed={isSelected} onClick={() => selectConversation(discussion)} type="button">{discussionLabel(discussion)}</button></h4>
                        {discussion.resolved && <span className={styles.resolved}>Resolved</span>}
                        {unread > 0 && <span className={styles.badge}>{unread} unread</span>}
                      </header>
                      {isSelected && renderContext?.(discussion)}
                      <div className={styles.comments}>
                        {comments.map((comment) => {
                          const commentKey = `${key}:${comment.id}`;
                          const collapsible = longAutomatedComment(discussion, comment);
                          // An unread bot comment shows a short preview so the reviewer can judge it without a click.
                          const expanded = Boolean(expandedComments[commentKey]);
                          const preview = collapsible && !expanded && unreadIds.has(comment.id) ? automatedPreview(comment.body) : "";
                          return (
                            <article className={styles.comment} key={comment.id}>
                              <span className={styles.avatar} aria-hidden="true">{comment.authorLogin.slice(0, 1).toUpperCase()}</span>
                              <div className={styles.commentContent}>
                                <header>
                                  <b>@{comment.authorLogin}</b>
                                  {discussion.automated && discussion.comments[0]?.id === comment.id && <span className={styles.automated}>Automated</span>}
                                  <time dateTime={comment.createdAt}>{commentDate(comment.createdAt)}</time>
                                </header>
                                {(!collapsible || expanded) && <GitlabDiscussionBody body={comment.body} className={styles.commentBody} />}
                                {preview && <p className={styles.commentPreview}>{preview}</p>}
                                {collapsible && <button className={styles.disclosure} aria-expanded={expanded} onClick={() => {
                                  if (!expanded) selectConversation(discussion);
                                  setExpandedComments((current) => ({ ...current, [commentKey]: !expanded }));
                                }} type="button">{expanded ? "Hide automated comment" : "Show automated comment"}</button>}
                              </div>
                            </article>
                          );
                        })}
                      </div>
                      {hasUpdates && <button className={styles.newReplies} onClick={() => selectConversation(discussion)} type="button">Show new replies</button>}
                      {isSelected && selectedDisplay ? (
                        <form className={styles.composer} data-ui={compact ? "gitlab-file-conversations.composer" : "gitlab-conversations.composer"} data-ui-label={compact ? "File conversation reply" : "Conversation reply"} onSubmit={(event) => { event.preventDefault(); void reply(); }}>
                          <label><span className={styles.srOnly}>Reply</span><textarea ref={replyInputRef} aria-label="Reply" placeholder="Write a reply…" disabled={replyPending} maxLength={16_384} rows={3} value={body} onChange={(event) => {
                            if (!gitlabDiscussionDrafts.write(draftKey, event.target.value)) {
                              setReplies((current) => ({ ...current, [draftKey]: { pending: false, error: "Clear a reply draft to start another. WTS retained your drafts.", published: false } }));
                            }
                          }} /></label>
                          {replyError && <div className={styles.error} role="alert"><p>{replyError}</p><p>Check GitLab before you send this reply again. Your draft is saved here.</p><button onClick={() => void openMergeRequest()} type="button">Open MR in GitLab</button>{onOpenIntegrations && <button onClick={onOpenIntegrations} type="button">Check GitLab connection</button>}</div>}
                          {replyState?.published && <p className={styles.success} role="status">Reply published to GitLab.</p>}
                          <div className={styles.composerActions}>
                            <p>This reply goes to GitLab MR !{entry.target.iid}.</p>
                            <button disabled={!fresh || !body.trim() || replyPending} type="submit">{replyPending ? "WTS publishes reply" : "Reply to GitLab"}</button>
                            {onAskAgentToFix && agentContextAvailable && <button disabled={!active} onClick={askAgentToFix} type="button">Ask agent to fix</button>}
                          </div>
                          {onAskAgentToFix && !agentContextAvailable && <p>{agentWorkspaceId?.trim() ? "Refresh conversations before you ask an agent to fix this thread." : "Open an existing project workspace to ask an agent to fix this conversation."}</p>}
                        </form>
                      ) : <div className={styles.threadActions}><button onClick={() => selectConversation(discussion, true)} type="button">Reply</button></div>}
                    </section>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
