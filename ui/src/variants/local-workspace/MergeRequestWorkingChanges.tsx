import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { GitlabReviewDiscussion, GitlabReviewPatch, WorkspaceClient, WorkspaceCodeReviewResult } from "../../lib/wtsClient";
import { useTheme } from "../../theme";
import { openAgentFeedback } from "../../lib/agentFeedbackEvents";
import { Glyph } from "./Glyph";
import { SelectMenu } from "../../components/SelectMenu";
import { RepositoryPatchViewer, summarizeRepositoryPatch, type AiReviewFocusRequest } from "./RepositoryPatchViewer";
import { RepositorySourceEditor } from "./RepositorySourceEditor";
import { GitlabDiscussionsPanel } from "./GitlabDiscussionsPanel";
import type { GitlabConversationTarget, GitlabConversationsController } from "./gitlabDiscussions";
import { workingChangesStore, type WorkingComparisonView } from "./workingChangesState";
import styles from "./MergeRequestWorkingChanges.module.css";

export const LOCAL_COMPARISON_POLL_MS = 10_000;

function patchFiles(patch: string) {
  const files = new Map<string, { patch: string; previousPath?: string; binary: boolean }>();
  for (const block of patch.split(/(?=^diff --git )/m)) {
    for (const file of summarizeRepositoryPatch(block).files) {
      files.set(file.fileDiff.name, { patch: block, previousPath: file.fileDiff.prevName, binary: /^Binary files |^GIT binary patch$/m.test(block) });
    }
  }
  return files;
}

function originalContext(discussion: GitlabReviewDiscussion, published: GitlabReviewPatch) {
  if (!discussion.filePath) return null;
  const position = discussion.position;
  const location = `${discussion.filePath}:${discussion.side === "deletions" ? "−" : "+"}${discussion.line ?? "?"}`;
  if (!position || position.baseCommitOid !== published.baseCommitOid || position.startCommitOid !== published.startCommitOid || position.headCommitOid !== published.headCommitOid) {
    return <aside className={styles.originalContext}><b>Original MR location · {location}</b><p>WTS cannot map this conversation to this MR version. Its local line is not mapped.</p></aside>;
  }
  const block = [...patchFiles(published.patch)].find(([path, file]) => path === discussion.filePath || file.previousPath === discussion.filePath)?.[1].patch;
  const lines: { text: string; old?: number; next?: number }[] = [];
  let old = 0;
  let next = 0;
  let inHunk = false;
  for (const line of (block ?? "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith("+")) lines.push({ text: line, next: next++ });
    else if (line.startsWith("-")) lines.push({ text: line, old: old++ });
    else if (line.startsWith(" ")) lines.push({ text: line, old: old++, next: next++ });
  }
  const index = lines.findIndex((line) => (discussion.side === "deletions" ? line.old : line.next) === discussion.line);
  return <aside className={styles.originalContext}><b>Original MR location · {location}</b>{index >= 0 ? <pre aria-label="Original MR lines">{lines.slice(Math.max(0, index - 3), index + 4).map((line) => line.text).join("\n")}</pre> : <p>The original lines are unavailable in this patch.</p>}<p>Local lines can differ. This conversation keeps its original MR location.</p></aside>;
}

/** The AI review of this MR, when its findings refer to this MR. */
export function mergeRequestAiReview(review: WorkspaceCodeReviewResult | null | undefined, repositoryId: string, iid: number) {
  const repository = review?.repositories?.find((candidate) => candidate.repositoryId === repositoryId && candidate.mergeRequest?.iid === iid);
  return review && repository?.mergeRequest ? { review, version: repository.mergeRequest } : undefined;
}

/** Local host limits are not GitLab problems. Do not send the user to GitLab settings for them. */
function localHostError(code?: string) {
  return Boolean(code?.endsWith("_capacity_exhausted"));
}

export function MergeRequestWorkingChanges({ client, workspaceId, repositoryId, target, controller, active, initialFile, onFileChange, selectedDiscussionId, onSelectConversation, onOpenIntegrations, aiReview, aiReviewFocus }: {
  client: WorkspaceClient;
  workspaceId: string;
  repositoryId: string;
  target: GitlabConversationTarget;
  controller: GitlabConversationsController;
  active: boolean;
  initialFile?: string;
  selectedDiscussionId?: string;
  onSelectConversation?: (discussion: GitlabReviewDiscussion) => void;
  onFileChange?: (path: string) => void;
  onOpenIntegrations?: () => void;
  aiReview?: WorkspaceCodeReviewResult | null;
  aiReviewFocus?: AiReviewFocusRequest;
}) {
  const { resolvedTheme } = useTheme();
  const conversationEntry = controller.entries.find((entry) => entry.target.key === target.key && entry.target.worktreeRepositoryId === repositoryId && entry.target.repositoryId === target.repositoryId && entry.target.iid === target.iid);
  const scopeId = conversationEntry?.snapshot?.scopeId ?? "";
  const freshConversationScope = conversationEntry?.state === "ready" && conversationEntry.snapshot && !conversationEntry.snapshot.fromCache && conversationEntry.snapshot.repositoryId === target.repositoryId && conversationEntry.snapshot.iid === target.iid;
  const key = JSON.stringify([workspaceId, repositoryId, target.key, scopeId]);
  const store = useMemo(() => workingChangesStore(client), [client]);
  useSyncExternalStore(store.subscribe, store.snapshot);
  const [fileQuery, setFileQuery] = useState("");
  const editButton = useRef<HTMLButtonElement>(null);
  const discussionButton = useRef<HTMLButtonElement>(null);
  const initialSelection = useRef({ key, file: initialFile, applied: false });
  if (initialSelection.current.key !== key || initialSelection.current.file !== initialFile) initialSelection.current = { key, file: initialFile, applied: false };
  const entry = store.entries.get(key);
  const comparison = entry?.comparison;
  const view = entry?.view ?? "latestWork";
  const refresh = useCallback((provider = false, afterSave = false): void => {
    if (store.entries.get(key)?.pending) {
      if (afterSave) store.update(key, (current) => ({ ...current, refreshQueued: true }));
      return;
    }
    const requestToken = {};
    store.update(key, (current) => ({ ...current, requestToken, pending: true, refreshQueued: false, error: "", errorCode: undefined }));
    void client.getWorkspaceGitlabComparison(workspaceId, repositoryId, target.iid, provider).then((result) => {
      if (store.entries.get(key)?.requestToken !== requestToken) return;
      if (result.workspaceId !== workspaceId || result.repositoryId !== repositoryId || result.iid !== target.iid || result.published.repositoryId !== repositoryId) throw new Error("WTS returned changes for another merge request.");
      if (store.entries.get(key)?.refreshQueued) {
        store.update(key, (current) => ({ ...current, pending: false, refreshQueued: false }));
        refresh();
        return;
      }
      // A local comparison that cannot run leaves nothing to read. Open the
      // published MR instead, unless the user already picked a view.
      store.update(key, (current) => ({ ...current, comparison: result, view: !current.viewChosen && result.status !== "ready" ? "inMr" : current.view, pending: false, error: "", revision: current.revision + 1 }));
    }).catch((error) => {
      if (store.entries.get(key)?.requestToken !== requestToken) return;
      if (store.entries.get(key)?.refreshQueued) {
        store.update(key, (current) => ({ ...current, pending: false, refreshQueued: false }));
        refresh();
        return;
      }
      store.update(key, (current) => ({ ...current, pending: false, error: error instanceof Error ? error.message : "WTS could not read these changes.", errorCode: typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : undefined }));
    });
  }, [client, key, repositoryId, store, target.iid, target.repositoryId, workspaceId]);

  useEffect(() => { if (active) refresh(); }, [active, refresh]);
  useEffect(() => {
    if (!active) return;
    const check = () => { if (document.visibilityState === "visible") refresh(); };
    const interval = window.setInterval(check, LOCAL_COMPARISON_POLL_MS);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => { window.clearInterval(interval); window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, [active, refresh]);

  const fileSets = useMemo(() => ({
    published: patchFiles(comparison?.published.patch ?? ""),
    latest: patchFiles(comparison?.latestWork?.patch ?? ""),
    since: patchFiles(comparison?.sinceMr?.patch ?? ""),
  }), [comparison]);
  const files = useMemo(() => [...new Set([...fileSets.published.keys(), ...fileSets.latest.keys(), ...fileSets.since.keys(), ...(comparison?.latestWork?.untrackedPaths ?? []), ...(comparison?.sinceMr?.untrackedPaths ?? [])])], [comparison, fileSets]);
  const selected = files.includes(entry?.selectedFile ?? "") ? entry!.selectedFile : files.includes(initialFile ?? "") ? initialFile! : files[0] ?? "";
  useEffect(() => {
    if (!initialFile || initialSelection.current.applied || !files.includes(initialFile)) return;
    initialSelection.current.applied = true;
    if (store.entries.get(key)?.selectedFile !== initialFile) store.update(key, (current) => ({ ...current, selectedFile: initialFile }));
  }, [initialFile, key, store, files]);
  const selectFile = (path: string) => { initialSelection.current.applied = true; store.update(key, (current) => ({ ...current, selectedFile: path })); onFileChange?.(path); };
  const selectedPatchFile = (view === "inMr" ? fileSets.published : view === "sinceMr" ? fileSets.since : fileSets.latest).get(selected);
  const selectedPatch = selectedPatchFile?.patch;
  const category = (path: string) => {
    const previousPath = fileSets.since.get(path)?.previousPath ?? fileSets.latest.get(path)?.previousPath;
    const inMr = fileSets.published.has(path) || Boolean(previousPath && fileSets.published.has(previousPath));
    const local = fileSets.since.has(path) || [...fileSets.since.values()].some((file) => file.previousPath === path);
    return inMr ? local ? "In MR + local" : "In MR" : "Local only";
  };
  const limited = comparison && view !== "inMr" && comparison.status !== "ready";
  const patchTruncated = view === "inMr" ? comparison?.published.patchTruncated : view === "sinceMr" ? comparison?.sinceMr?.patchTruncated : comparison?.latestWork?.patchTruncated;

  const filteredFiles = files.filter((path) => path.toLocaleLowerCase().includes(fileQuery.toLocaleLowerCase()));
  const fileConversations = conversationEntry?.snapshot?.discussions.filter((discussion) => discussion.filePath === selected) ?? [];
  const editorOpen = entry?.panel === "editor" && view !== "inMr";
  const conversationsOpen = entry?.panel === "conversations";
  const setPanel = (panel?: "editor" | "conversations") => store.update(key, (current) => ({ ...current, panel }));
  const closePanel = () => {
    const trigger = editorOpen ? editButton : discussionButton;
    setPanel(undefined);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  const fileActions = <div className={styles.fileActions}>
    {view !== "inMr" && <button ref={editButton} aria-expanded={editorOpen} className={styles.quietButton} disabled={Boolean(selectedPatchFile?.binary)} onClick={() => setPanel(editorOpen ? undefined : "editor")} type="button"><Glyph name="code" size={14} />Edit locally</button>}
    <button ref={discussionButton} aria-expanded={conversationsOpen} aria-label={`File conversations${fileConversations.length ? `, ${fileConversations.length}` : ""}`} className={styles.quietButton} onClick={() => setPanel(conversationsOpen ? undefined : "conversations")} type="button"><Glyph name="comment" size={14} />Conversations{fileConversations.length > 0 && <span className={styles.count}>{fileConversations.length}</span>}</button>
  </div>;
  const hasNewerWork = Boolean(comparison?.sinceMr?.patch || comparison?.sinceMr?.untrackedPaths.length);
  const viewFiles = view === "inMr" ? fileSets.published : view === "sinceMr" ? fileSets.since : fileSets.latest;
  const viewUntracked = view === "inMr" ? [] : (view === "sinceMr" ? comparison?.sinceMr?.untrackedPaths : comparison?.latestWork?.untrackedPaths) ?? [];
  const changedInView = new Set([...viewFiles.keys(), ...viewUntracked]).size;
  const comparisonStatus = !comparison ? "" : view === "inMr"
    ? `MR at ${comparison.published.headCommitOid.slice(0, 8)}`
    : limited ? "Local comparison unavailable"
    : view === "sinceMr"
      ? hasNewerWork ? "Local commits after the MR" : "No local changes after the MR"
      : hasNewerWork ? "MR changes and local changes" : "MR changes. No local changes after the MR";
  const mrReview = mergeRequestAiReview(aiReview, repositoryId, target.iid);
  const aiFindingCount = mrReview?.review.findings.length ?? 0;
  const aiStale = Boolean(mrReview && comparison && mrReview.version.headCommitOid !== comparison.published.headCommitOid);
  const aiFindingFiles = useMemo(() => {
    const counts = new Map<string, number>();
    for (const finding of mrReview?.review.findings ?? []) {
      if (finding.filePath) counts.set(finding.filePath, (counts.get(finding.filePath) ?? 0) + 1);
    }
    return counts;
  }, [mrReview?.review]);
  const handledFocus = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!aiReviewFocus || handledFocus.current === aiReviewFocus.requestId || !mrReview) return;
    handledFocus.current = aiReviewFocus.requestId;
    const finding = mrReview.review.findings.find((candidate) => candidate.findingId === aiReviewFocus.findingId)
      ?? mrReview.review.findings.find((candidate) => candidate.anchored);
    store.update(key, (current) => ({ ...current, view: "inMr", viewChosen: true, ...(finding?.filePath && files.includes(finding.filePath) ? { selectedFile: finding.filePath } : {}) }));
    if (finding?.filePath) onFileChange?.(finding.filePath);
  }, [aiReviewFocus, files, key, mrReview, onFileChange, store]);

  return <section className={styles.comparison} aria-label="MR and local changes" data-ui="changes.comparison" data-ui-label="Code comparison">
    <header className={styles.toolbar} data-ui="changes.comparison-toolbar" data-ui-label="Comparison toolbar">
      <label><span className={styles.srOnly}>Compare code</span><SelectMenu aria-label="Code comparison" value={view} onChange={(next) => store.update(key, (current) => ({ ...current, view: next as WorkingComparisonView, viewChosen: true }))}><option value="latestWork">Local workspace vs target</option><option value="inMr">Published MR</option><option value="sinceMr">Local work after the MR</option></SelectMenu></label>
      {comparison && <span className={styles.version} title={`MR ${comparison.published.headCommitOid} · local ${comparison.localHeadCommitOid}`}>{comparisonStatus}</span>}
      <button aria-label="Refresh changes" className={styles.quietButton} disabled={entry?.pending} onClick={() => refresh(true)} type="button"><Glyph name="refresh" size={14} />Refresh</button>
      {entry?.pending && comparison && <span className={styles.srOnly} role="status">WTS refreshes changes.</span>}
    </header>
    {entry?.error && <div className={styles.error} role="alert" data-ui="changes.comparison-error" data-ui-label="Comparison error"><span>{entry.error}{comparison ? " The displayed comparison remains available." : ""}</span><button disabled={entry.pending} onClick={() => refresh(true)} type="button">Retry changes</button>{onOpenIntegrations && !localHostError(entry.errorCode) && <button onClick={onOpenIntegrations} type="button">Check GitLab connection</button>}</div>}
    {comparison?.published.fromCache && <p className={styles.notice}>GitLab is unavailable. WTS shows the saved MR snapshot and current local files.</p>}
    {limited && <div className={styles.notice} role="alert" data-ui="changes.comparison-limited" data-ui-label="Local comparison notice"><span>{comparison.status === "missingCommits" ? "The MR commits are not in this local checkout." : "The local history differs from the published MR."} You can read the published changes.</span><button onClick={() => store.update(key, (current) => ({ ...current, view: "inMr", viewChosen: true }))} type="button">Show published changes</button></div>}
    {comparison && comparison.status !== "ready" && view === "inMr" && !entry?.viewChosen && <p className={styles.notice} data-ui="changes.comparison-published-fallback" data-ui-label="Published changes notice">{comparison.status === "missingCommits" ? "The MR commits are not in this local checkout." : "The local history differs from the published MR."} WTS shows the published changes at {comparison.published.headCommitOid.slice(0, 8)}.</p>}
    {view === "inMr" && comparison && (!freshConversationScope || comparison.published.fromCache) && <div className={styles.notice}>Line comments are unavailable until WTS checks this MR and account. <button disabled={controller.loading || conversationEntry?.state === "loading"} onClick={() => controller.refresh(target.key)} type="button">Refresh conversations</button>{onOpenIntegrations && <button onClick={onOpenIntegrations} type="button">Check GitLab connection</button>}</div>}
    {patchTruncated && <p className={styles.notice}>This patch is incomplete. Some changes are not shown.</p>}
    {mrReview && aiFindingCount > 0 && view !== "inMr" && <div className={styles.notice} data-ui="changes.comparison-ai-hint" data-ui-label="AI findings hint">The AI review of the published MR has {aiFindingCount} {aiFindingCount === 1 ? "finding" : "findings"}. The findings show on the lines of the published MR. <button onClick={() => store.update(key, (current) => ({ ...current, view: "inMr", viewChosen: true }))} type="button">Show the published MR</button></div>}
    {!comparison ? (entry?.error && !entry.pending
      ? <p className={styles.empty} role="status">No comparison to show. Retry changes to read it again.</p>
      : <div className={styles.loading} role="status" aria-busy="true" data-ui="changes.comparison-loading" data-ui-label="Comparison loading">
          <p>WTS reads MR !{target.iid} from GitLab and compares it with the local work.</p>
          <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
        </div>) : <div className={styles.layout} data-panel={editorOpen || conversationsOpen || undefined}>
      <nav className={styles.files} aria-label="MR and local files" data-ui="changes.comparison-files" data-ui-label="MR and local files">
        <div className={styles.filesHeader}><strong>Files</strong><span title={`${changedInView} changed in this view · ${files.length} in the review`}>{changedInView === files.length ? files.length : `${changedInView} of ${files.length}`}</span></div>
        <label className={styles.fileSearch}><Glyph name="search" size={14} /><input aria-label="Find file" type="search" placeholder="Find file" value={fileQuery} onChange={(event) => setFileQuery(event.currentTarget.value)} /></label>
        <div className={styles.fileList}>{filteredFiles.map((path) => {
          const previousPath = fileSets.since.get(path)?.previousPath ?? fileSets.latest.get(path)?.previousPath;
          const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
          const discussionCount = conversationEntry?.snapshot?.discussions.filter((discussion) => discussion.filePath === path).length ?? 0;
          return <button className={styles.fileRow} key={path} aria-label={`${path} ${category(path)}${previousPath ? ` Renamed from ${previousPath}` : ""}`} aria-current={selected === path ? "true" : undefined} title={previousPath ? `${path} · Renamed from ${previousPath}` : path} onClick={() => selectFile(path)} type="button"><Glyph name="file" size={15} /><span className={styles.fileName}><b>{path.split("/").at(-1)}</b>{directory && <small>{directory}</small>}</span>{view === "inMr" && (aiFindingFiles.get(path) ?? 0) > 0 && <span className={styles.fileAi} title={`${aiFindingFiles.get(path)} AI review findings`}>AI {aiFindingFiles.get(path)}</span>}{discussionCount > 0 && <span className={styles.fileComments} title={`${discussionCount} conversations`}><Glyph name="comment" size={12} />{discussionCount}</span>}{category(path) !== "In MR" && <span className={styles.fileStatus} title={category(path)}>Local</span>}</button>;
        })}{!filteredFiles.length && <p className={styles.fileEmpty}>{files.length ? "No matching files." : "No changed files."}</p>}</div>
      </nav>
      <div className={styles.fileContent}>
        <div className={styles.patch}>
          {selectedPatchFile?.binary ? <><div className={styles.emptyActions}>{fileActions}</div><p className={styles.empty}>This binary file cannot be shown as text.</p></> : selectedPatch && !limited ? <RepositoryPatchViewer patch={selectedPatch} theme={resolvedTheme} singleFile singleFileActions={fileActions} disableFullFile
            {...(view === "inMr" && mrReview ? { aiReview: mrReview.review, aiReviewFocus, aiReviewStale: aiStale } : {})}
            {...(view === "inMr" && !comparison.published.fromCache && freshConversationScope ? {
              lineCommentProvider: "GitLab" as const,
              feedback: { client, workspaceId, repositoryId, baseCommitOid: comparison.published.baseCommitOid, headCommitOid: comparison.published.headCommitOid, patchSha256: "provider",
                gitlabReview: { repositoryId: target.repositoryId, iid: target.iid, scopeId, discussions: comparison.published.discussions, expectedPosition: { baseCommitOid: comparison.published.baseCommitOid, startCommitOid: comparison.published.startCommitOid, headCommitOid: comparison.published.headCommitOid } } },
            } : {})}
          /> : <>{selected && <div className={styles.emptyActions}><span>{selected}</span>{fileActions}</div>}<p className={styles.empty}>{limited ? "WTS cannot compare this local history with the MR." : view === "sinceMr" ? "No newer changes in this file. Local work matches the published version." : view === "latestWork" && fileSets.published.has(selected) ? "This file has no local change. It remains in the published MR." : view === "inMr" ? "This file is not in the published MR." : "No local changes in this file."}</p></>}
        </div>
      </div>
      {selected && (editorOpen || conversationsOpen) && <aside className={styles.sidePanel} aria-label={editorOpen ? "Local editor" : "Conversations for this file"} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closePanel(); } }}>
        {editorOpen ? <RepositorySourceEditor key={`${workspaceId}:${repositoryId}:${selected}`} client={client} workspaceId={workspaceId} repositoryId={repositoryId} filePath={selected} active={active} refreshToken={entry?.revision ?? 0} onSaved={() => refresh(false, true)} embedded onClose={closePanel} /> : <GitlabDiscussionsPanel onOpenIntegrations={onOpenIntegrations} onClose={closePanel} active={active} client={client} controller={controller} repositoryId={repositoryId} workspaceId={workspaceId} onAskAgentToFix={openAgentFeedback} selectedTargetKey={target.key} selectedDiscussionId={selectedDiscussionId} onSelectConversation={onSelectConversation} filePath={selected} compact hideTargetSelector renderContext={(discussion) => originalContext(discussion, comparison.published)} />}
      </aside>}
    </div>}
  </section>;
}
