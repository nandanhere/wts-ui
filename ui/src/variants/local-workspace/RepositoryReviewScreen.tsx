import type { FeedbackSelectionReturn } from "../../lib/agentFeedbackNavigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  WorkspaceAgentReport,
  WorkspaceClient,
  WorkspaceCodeReviewResult,
  WorkspaceMaterialization,
  WorkspaceRepositoryDiff,
  WorkspaceRepositoryReviewGraph,
  GitlabReview,
  GitlabReviewCommit,
  GitlabReviewDiscussion,
  GitlabReviewTarget,
} from "../../lib/wtsClient";
import { useTheme } from "../../theme";
import { openAgentFeedback } from "../../lib/agentFeedbackEvents";
import { Glyph } from "./Glyph";
import { SelectMenu } from "../../components/SelectMenu";
import { RepositoryPatchViewer, type AiReviewFocusRequest } from "./RepositoryPatchViewer";
import { codeReviewIsStale, CodeReviewPublishProvider, WorkspaceCodeReviewCard, type CodeReviewMergeRequestTarget } from "./WorkspaceCodeReviewCard";
import { GitlabDiscussionsPanel } from "./GitlabDiscussionsPanel";
import { mergeRequestAiReview, MergeRequestWorkingChanges } from "./MergeRequestWorkingChanges";
import { reviewSession } from "./workingChangesState";
import { getCachedRepositoryReview, loadRepositoryReview } from "./repositoryReviewCache";
import type { GitlabConversationEntry, GitlabConversationsController } from "./gitlabDiscussions";
import styles from "./RepositoryReviewScreen.module.css";

interface RepositoryReviewScreenProps {
  client: WorkspaceClient;
  initialRepositoryId?: string;
  materialization: WorkspaceMaterialization;
  onOpenVerification?: () => void;
  onRepositoryChange: (repositoryId: string, navigation?: "user" | "automatic") => void;
  workspaceId: string;
  gitlabReview?: GitlabReviewTarget & Partial<GitlabReview>;
  gitlabConversations?: GitlabConversationsController;
  feedbackSelectionReturn?: FeedbackSelectionReturn;
  workspaceKey?: string;
  onNotice?: (message: string, kind?: "info" | "error") => void;
  onOpenIntegrations?: () => void;
  onOpenWorkspaceStatus?: () => void;
  /** A node in the workspace header. The MR title, status, and selectors show there. */
  identitySlot?: HTMLElement | null;
  /** Each new value opens the AI review panel in the code view. */
  openAiReviewRequest?: number;
}

export const REVIEW_PATCH_POLL_INTERVAL_MS = 60_000;

function worktreeScope(worktree: WorkspaceMaterialization["worktrees"][number] | undefined): string {
  return worktree ? JSON.stringify([worktree.repositoryId, worktree.baseCommitOid, worktree.branchName, worktree.targetDisplayPath]) : "";
}

export function RepositoryReviewScreen({
  client,
  initialRepositoryId,
  materialization,
  onOpenVerification,
  onRepositoryChange,
  workspaceId,
  gitlabReview,
  gitlabConversations,
  feedbackSelectionReturn,
  workspaceKey,
  onNotice,
  onOpenIntegrations,
  onOpenWorkspaceStatus,
  identitySlot,
  openAiReviewRequest,
}: RepositoryReviewScreenProps) {
  const { resolvedTheme } = useTheme();
  const [showAiReview, setShowAiReview] = useState(Boolean(openAiReviewRequest));
  useEffect(() => {
    if (openAiReviewRequest) setShowAiReview(true);
  }, [openAiReviewRequest]);
  const [aiReview, setAiReview] = useState<WorkspaceCodeReviewResult | null>(null);
  const [aiReviewFocus, setAiReviewFocus] = useState<AiReviewFocusRequest>();
  const aiReviewFocusId = useRef(0);
  const focusAiReview = (findingId?: string) => {
    aiReviewFocusId.current += 1;
    setAiReviewFocus({ requestId: aiReviewFocusId.current, ...(findingId ? { findingId } : {}) });
  };
  useEffect(() => {
    setAiReview(null);
    if (!client.getWorkspaceCodeReview) return;
    let active = true;
    client.getWorkspaceCodeReview(workspaceId).then(
      (saved) => { if (active) setAiReview(saved); },
      () => undefined,
    );
    return () => { active = false; };
  }, [client, workspaceId]);
  const changeViewId = useId();
  const session = reviewSession(client, workspaceId);
  const [, setSessionRevision] = useState(0);
  const [changeView, setChangeView] = useState({ workspaceId, mode: session.mode });
  const [revealConversation, setRevealConversation] = useState<{
    requestId: number;
    targetKey: string;
    scopeId: string;
    discussionId: string;
  }>();
  const revealRequestId = useRef(0);
  const handledFeedbackReturn = useRef<string | undefined>(undefined);
  const changeMode = gitlabConversations ? changeView.workspaceId === workspaceId ? changeView.mode : session.mode : "code";
  const defaultRepositoryId = useMemo(
    () =>
      materialization.worktrees.find(
        (worktree) =>
          (worktree.activity?.changedFileCount ?? 0) > 0 ||
          (worktree.activity?.commitsAhead ?? 0) > 0,
      )?.repositoryId ?? materialization.worktrees[0]?.repositoryId ?? "",
    [materialization.worktrees],
  );
  const gitlabPatchTarget = useMemo(
    () =>
      gitlabReview
        ? {
            headCommitOid: gitlabReview.headCommitOid,
            number: gitlabReview.number,
            repository: gitlabReview.repository,
            repositoryId: gitlabReview.repositoryId,
          }
        : undefined,
    [
      gitlabReview?.headCommitOid,
      gitlabReview?.number,
      gitlabReview?.repository,
      gitlabReview?.repositoryId,
    ],
  );
  const gitlabReviewRepositoryId = useMemo(() => {
    if (!gitlabPatchTarget) return "";
    const repositoryLabel = gitlabPatchTarget.repository.split("/").at(-1);
    return (
      materialization.worktrees.find(
        (worktree) => worktree.repositoryId === gitlabPatchTarget.repositoryId,
      )?.repositoryId ??
      materialization.worktrees.find(
        (worktree) => worktree.label === repositoryLabel,
      )?.repositoryId ??
      ""
    );
  }, [gitlabPatchTarget, materialization.worktrees]);
  const [repositoryId, setRepositoryId] = useState(initialRepositoryId || "");
  const currentRepositoryId = repositoryId || defaultRepositoryId;
  const conversationEntries = gitlabConversations?.entries.filter(
    (entry) => entry.target.worktreeRepositoryId === currentRepositoryId,
  ) ?? [];
  const selectedConversation = conversationEntries.find((entry) => entry.target.key === session.targets[currentRepositoryId]) ?? conversationEntries[0];
  const managedTarget = selectedConversation?.target;
  const managedTargetKey = managedTarget?.key;
  const selectedConversationScope = JSON.stringify([managedTargetKey, selectedConversation?.snapshot?.scopeId]);
  const selectConversationTarget = (key: string) => {
    session.targets[currentRepositoryId] = key;
    setSessionRevision((value) => value + 1);
  };
  const initialWorktree = materialization.worktrees.find((worktree) => worktree.repositoryId === (initialRepositoryId || defaultRepositoryId));
  const initialCachedDiff = !gitlabReview && initialWorktree ? getCachedRepositoryReview(client, workspaceId, initialWorktree) : undefined;
  const [diffRecord, setDiffRecord] = useState({ value: initialCachedDiff ?? null as WorkspaceRepositoryDiff | null, client, scope: worktreeScope(initialWorktree) });
  const diffWorktree = materialization.worktrees.find((worktree) => worktree.repositoryId === diffRecord.value?.repositoryId);
  const diff = diffRecord.client === client && diffRecord.value?.workspaceId === workspaceId && diffRecord.scope === worktreeScope(diffWorktree) ? diffRecord.value : null;
  const setDiff = (value: WorkspaceRepositoryDiff | null) => setDiffRecord({ value, client, scope: worktreeScope(materialization.worktrees.find((worktree) => worktree.repositoryId === value?.repositoryId)) });
  const [reviewGraph, setReviewGraph] =
    useState<WorkspaceRepositoryReviewGraph | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">(initialCachedDiff ? "ready" : "loading");
  const [error, setError] = useState("");
  const [requestRevision, setRequestRevision] = useState(0);
  const [reviewCommits, setReviewCommits] = useState<GitlabReviewCommit[]>([]);
  const [reviewDiscussions, setReviewDiscussions] = useState<GitlabReviewDiscussion[]>([]);
  const [selectedCommitOid, setSelectedCommitOid] = useState("");
  const [checkingReviewUpdates, setCheckingReviewUpdates] = useState(false);
  const [reviewUpdateMessage, setReviewUpdateMessage] = useState("");
  const [reviewPatchFromCache, setReviewPatchFromCache] = useState(false);
  const forceProviderRefreshRef = useRef(false);
  const preserveDisplayedReviewRef = useRef(false);
  const providerHeadCommitRef = useRef("");
  const [report, setReport] = useState<WorkspaceAgentReport | null>(null);
  const [reportState, setReportState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [reportRevision, setReportRevision] = useState(0);
  const onRepositoryChangeRef = useRef(onRepositoryChange);
  const displayedRequestRef = useRef<{
    client: WorkspaceClient;
    worktreeScope: string;
    repositoryId: string;
    requestRevision: number;
    workspaceId: string;
    providerHeadCommitOid?: string;
    selectedCommitOid?: string;
  } | null>(null);

  useEffect(() => {
    onRepositoryChangeRef.current = onRepositoryChange;
  }, [onRepositoryChange]);

  useEffect(() => {
    if (
      initialRepositoryId &&
      materialization.worktrees.some(
        (worktree) => worktree.repositoryId === initialRepositoryId,
      )
    ) {
      setRepositoryId(initialRepositoryId);
    }
  }, [initialRepositoryId, materialization.worktrees]);

  useEffect(() => {
    if (managedTargetKey) return;
    const hasRepository = (candidate: string) =>
      materialization.worktrees.some(
        (worktree) => worktree.repositoryId === candidate,
      );
    const explicitRepositoryId =
      initialRepositoryId && hasRepository(initialRepositoryId)
        ? initialRepositoryId
        : "";
    const selectedRepositoryId = hasRepository(repositoryId)
      ? repositoryId
      : "";
    const directRepositoryId = explicitRepositoryId || selectedRepositoryId;
    const changedRepositoryIds = materialization.worktrees
      .filter(
        (worktree) =>
          (worktree.activity?.changedFileCount ?? 0) > 0 ||
          (worktree.activity?.commitsAhead ?? 0) > 0,
      )
      .map((worktree) => worktree.repositoryId);
    const unobservedRepositoryIds = materialization.worktrees
      .filter((worktree) => worktree.activity === undefined)
      .map((worktree) => worktree.repositoryId);
    const cleanRepositoryIds = materialization.worktrees
      .filter(
        (worktree) =>
          worktree.activity !== undefined &&
          worktree.activity.changedFileCount === 0 &&
          worktree.activity.commitsAhead === 0,
      )
      .map((worktree) => worktree.repositoryId);
    const candidateIds = directRepositoryId
      ? [directRepositoryId]
      : [
          ...changedRepositoryIds,
          ...unobservedRepositoryIds,
          ...cleanRepositoryIds,
        ];
    if (!candidateIds.length) {
      displayedRequestRef.current = null;
      setDiff(null);
      setState("ready");
      return;
    }
    const directWorktree = materialization.worktrees.find((worktree) => worktree.repositoryId === directRepositoryId);
    if (
      directRepositoryId &&
      displayedRequestRef.current?.client === client &&
      displayedRequestRef.current.worktreeScope === worktreeScope(directWorktree) &&
      displayedRequestRef.current.workspaceId === workspaceId &&
      displayedRequestRef.current.repositoryId === directRepositoryId &&
      displayedRequestRef.current.requestRevision === requestRevision &&
      displayedRequestRef.current.providerHeadCommitOid === gitlabPatchTarget?.headCommitOid &&
      displayedRequestRef.current.selectedCommitOid === (selectedCommitOid || undefined)
    ) {
      return;
    }
    let current = true;
    const forceProviderRefresh = forceProviderRefreshRef.current;
    const cachedDiff = !gitlabPatchTarget && directWorktree ? getCachedRepositoryReview(client, workspaceId, directWorktree) : undefined;
    const preserveDisplayedReview = Boolean(cachedDiff) ||
      state === "ready" &&
      diff !== null && diff.workspaceId === workspaceId && diff.repositoryId === directRepositoryId &&
      (preserveDisplayedReviewRef.current ||
        (gitlabPatchTarget !== undefined &&
          diff.repositoryId === directRepositoryId));
    forceProviderRefreshRef.current = false;
    preserveDisplayedReviewRef.current = false;
    displayedRequestRef.current = null;
    if (cachedDiff) {
      setDiff(cachedDiff);
      setState("ready");
    } else if (!preserveDisplayedReview) {
      setState("loading");
      setDiff(null);
    }
    setError("");
    if (!gitlabPatchTarget) setCheckingReviewUpdates(true);
    void (async () => {
      let firstCleanDiff: WorkspaceRepositoryDiff | null = null;
      let firstError: unknown = null;
      for (const candidateId of candidateIds) {
        try {
          const result = gitlabPatchTarget && candidateId === gitlabReviewRepositoryId
            ? await (selectedCommitOid
                ? forceProviderRefresh
                  ? client.getGitlabReviewPatch(
                      gitlabPatchTarget.repositoryId,
                      gitlabPatchTarget.number,
                      selectedCommitOid,
                      true,
                    )
                  : client.getGitlabReviewPatch(
                      gitlabPatchTarget.repositoryId,
                      gitlabPatchTarget.number,
                      selectedCommitOid,
                    )
                : forceProviderRefresh
                  ? client.getGitlabReviewPatch(
                      gitlabPatchTarget.repositoryId,
                      gitlabPatchTarget.number,
                      undefined,
                      true,
                    )
                  : client.getGitlabReviewPatch(
                      gitlabPatchTarget.repositoryId,
                      gitlabPatchTarget.number,
                    ))
                .then((patch) => {
                  if (
                    patch.repositoryId !== gitlabPatchTarget.repositoryId ||
                    patch.iid !== gitlabPatchTarget.number
                  ) {
                    throw new Error(
                      "WTS returned changes for a different GitLab review.",
                    );
                  }
                  if (current && !selectedCommitOid) {
                    const previousHead = providerHeadCommitRef.current;
                    if (patch.fromCache) {
                      setReviewUpdateMessage(
                        "GitLab is unavailable. WTS shows the saved merge request changes.",
                      );
                    } else if (previousHead && previousHead !== patch.headCommitOid) {
                      setReviewUpdateMessage(
                        `New changes loaded at ${patch.headCommitOid.slice(0, 8)}.`,
                      );
                    } else if (forceProviderRefresh) {
                      setReviewUpdateMessage("No new changes. WTS checked GitLab now.");
                    }
                    providerHeadCommitRef.current = patch.headCommitOid;
                  }
                  if (current) {
                    setReviewPatchFromCache(patch.fromCache);
                    setReviewCommits(patch.commits);
                    setReviewDiscussions(patch.discussions);
                  }
                  return {
                    schemaVersion: 1 as const,
                    workspaceId,
                    repositoryId: candidateId,
                    repositoryLabel: gitlabPatchTarget.repository,
                    baseCommitOid: patch.baseCommitOid,
                    headCommitOid: patch.headCommitOid,
                    patchSha256: "provider",
                    patch: patch.patch,
                    patchTruncated: patch.patchTruncated,
                    untrackedPaths: [],
                    untrackedPathsTruncated: false,
                  };
                })
            : await loadRepositoryReview(client, workspaceId, materialization.worktrees.find((worktree) => worktree.repositoryId === candidateId)!);
          if (!current) return;
          if (
            result.workspaceId !== workspaceId ||
            result.repositoryId !== candidateId
          ) {
            throw new Error("WTS returned changes for a different repository.");
          }
          firstCleanDiff ??= result;
          if (result.patch || result.untrackedPaths.length) {
            displayedRequestRef.current = {
              client,
              worktreeScope: worktreeScope(materialization.worktrees.find((worktree) => worktree.repositoryId === candidateId)),
              repositoryId: candidateId,
              requestRevision,
              workspaceId,
              providerHeadCommitOid: gitlabPatchTarget?.headCommitOid,
              selectedCommitOid: selectedCommitOid || undefined,
            };
            setRepositoryId(candidateId);
            setDiff(result);
            setState("ready");
            if (!explicitRepositoryId && candidateId !== repositoryId) {
              onRepositoryChangeRef.current(candidateId, "automatic");
            }
            return;
          }
          if (explicitRepositoryId || repositoryId) break;
        } catch (cause) {
          if (!current) return;
          firstError ??= cause;
          if (explicitRepositoryId || repositoryId) break;
        }
      }
      if (!current) return;
      if (firstCleanDiff) {
        displayedRequestRef.current = {
          client,
          worktreeScope: worktreeScope(materialization.worktrees.find((worktree) => worktree.repositoryId === firstCleanDiff.repositoryId)),
          repositoryId: firstCleanDiff.repositoryId,
          requestRevision,
          workspaceId,
          providerHeadCommitOid: gitlabPatchTarget?.headCommitOid,
          selectedCommitOid: selectedCommitOid || undefined,
        };
        setRepositoryId(firstCleanDiff.repositoryId);
        setDiff(firstCleanDiff);
        setState("ready");
        if (
          !explicitRepositoryId &&
          firstCleanDiff.repositoryId !== repositoryId
        ) {
          onRepositoryChangeRef.current(firstCleanDiff.repositoryId, "automatic");
        }
        return;
      }
      if (preserveDisplayedReview) {
        if (!gitlabPatchTarget) {
          setError(firstError instanceof Error ? firstError.message : "WTS could not refresh the local changes.");
          return;
        }
        setReviewUpdateMessage(
          firstError instanceof Error && firstError.message.trim()
            ? `WTS could not check GitLab: ${firstError.message}`
            : "WTS could not check GitLab. The loaded changes remain available.",
        );
        return;
      }
      setError(
        firstError instanceof Error
          ? firstError.message
          : "WTS could not read the repository changes.",
      );
      setState("error");
    })().finally(() => {
      if (current) setCheckingReviewUpdates(false);
    });
    return () => {
      current = false;
    };
  }, [
    client,
    managedTargetKey,
    initialRepositoryId,
    materialization.worktrees,
    repositoryId,
    requestRevision,
    workspaceId,
    gitlabPatchTarget,
    gitlabReviewRepositoryId,
    selectedCommitOid,
  ]);

  useEffect(() => {
    if (!gitlabPatchTarget || managedTargetKey) return;
    const check = () => {
      forceProviderRefreshRef.current = true;
      preserveDisplayedReviewRef.current = true;
      displayedRequestRef.current = null;
      setCheckingReviewUpdates(true);
      setRequestRevision((value) => value + 1);
    };
    const interval = window.setInterval(check, REVIEW_PATCH_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [gitlabPatchTarget, managedTargetKey]);

  useEffect(() => {
    if (gitlabPatchTarget || managedTargetKey || changeMode !== "code") return;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      displayedRequestRef.current = null;
      setRequestRevision((value) => value + 1);
    };
    const interval = window.setInterval(check, 10_000);
    window.addEventListener("focus", check);
    return () => { window.clearInterval(interval); window.removeEventListener("focus", check); };
  }, [changeMode, gitlabPatchTarget, managedTargetKey]);

  useEffect(() => {
    setReviewGraph(diff?.reviewGraph ?? null);
    if (
      state !== "ready" ||
      !diff?.patch ||
      diff.reviewGraph ||
      materialization.graph.status !== "ready"
    ) {
      return;
    }
    let current = true;
    void client
      .getWorkspaceRepositoryReviewGraph(workspaceId, diff.repositoryId)
      .then((graph) => {
        if (current) setReviewGraph(graph);
      })
      .catch(() => {
        if (current) setReviewGraph(null);
      });
    return () => {
      current = false;
    };
  }, [
    client,
    diff?.patch,
    diff?.repositoryId,
    diff?.reviewGraph,
    materialization.graph.status,
    state,
    workspaceId,
  ]);

  useEffect(() => {
    if (
      state !== "ready" ||
      !diff ||
      (!diff.patch && diff.untrackedPaths.length === 0)
    ) {
      setReport(null);
      setReportState("idle");
      return;
    }
    let current = true;
    setReportState("loading");
    void client
      .getWorkspaceEvidence(workspaceId)
      .then((evidence) => {
        if (!current) return;
        setReport(evidence?.agentReport ?? null);
        setReportState("ready");
      })
      .catch(() => {
        if (!current) return;
        setReport(null);
        setReportState("error");
      });
    return () => {
      current = false;
    };
  }, [client, diff, reportRevision, state, workspaceId]);

  const reviewRiskCount = useMemo(() => {
    if (!report || report.status !== "ready" || !diff) return null;
    const relatedFlows = report.flows.filter((flow) =>
      flow.steps.some((step) => step.repositoryId === diff.repositoryId),
    );
    const risks = Array.from(
      new Set([
        ...report.findings
          .filter(
            (finding) =>
              !finding.repositoryId ||
              finding.repositoryId === diff.repositoryId,
          )
          .map((finding) => finding.title),
        ...relatedFlows.flatMap((flow) => flow.risks),
      ]),
    );
    return risks.length;
  }, [diff, report]);

  useEffect(() => {
    const request = feedbackSelectionReturn;
    const source = request?.source;
    if (!request || source?.kind !== "gitlabDiscussion" || source.workspaceId !== workspaceId ||
      handledFeedbackReturn.current === request.requestId || !gitlabConversations) return;
    const matches = gitlabConversations.entries.filter(entry =>
      entry.target.worktreeRepositoryId === source.repositoryId && entry.target.iid === source.iid &&
      (!source.providerRepositoryId || entry.target.repositoryId === source.providerRepositoryId));
    if (gitlabConversations.loading || matches.some(entry => entry.state === "loading" && !entry.snapshot)) return;
    handledFeedbackReturn.current = request.requestId;
    const entry = matches.length === 1 ? matches[0] : undefined;
    const snapshot = entry?.snapshot;
    const discussion = snapshot?.discussions.find(item => item.id === source.discussionId);
    if (!entry || !snapshot || !discussion || (source.scopeId && source.scopeId !== snapshot.scopeId)) {
      onNotice?.("The saved conversation is not available in the current GitLab context. Its original context remains in Agent feedback.", "error");
      return;
    }
    session.targets[source.repositoryId] = entry.target.key;
    session.mode = "conversations";
    session.discussions[JSON.stringify([entry.target.key, snapshot.scopeId])] = discussion.id;
    if (discussion.filePath) session.files[`${source.repositoryId}:${entry.target.key}`] = discussion.filePath;
    setRepositoryId(source.repositoryId);
    setChangeView({ workspaceId, mode: "conversations" });
    setRevealConversation({ requestId: ++revealRequestId.current, targetKey: entry.target.key, scopeId: snapshot.scopeId, discussionId: discussion.id });
    setSessionRevision(value => value + 1);
    onRepositoryChangeRef.current(source.repositoryId, "automatic");
  }, [feedbackSelectionReturn, gitlabConversations, onNotice, session, workspaceId]);

  const selectRepository = (nextRepositoryId: string) => {
    setRepositoryId(nextRepositoryId);
    setRequestRevision((current) => current + 1);
    onRepositoryChange(nextRepositoryId, "user");
  };

  const retryRepositoryRequest = () => {
    displayedRequestRef.current = null;
    setRequestRevision((current) => current + 1);
  };

  const checkReviewUpdates = () => {
    forceProviderRefreshRef.current = true;
    preserveDisplayedReviewRef.current = true;
    displayedRequestRef.current = null;
    setCheckingReviewUpdates(true);
    setReviewUpdateMessage("");
    setRequestRevision((value) => value + 1);
  };
  const unreadEntries = gitlabConversations?.entries.filter((entry) => entry.unreadCommentIds.length > 0) ?? [];
  const repositoryUnreadCount = (id: string) => unreadEntries
    .filter((entry) => entry.target.worktreeRepositoryId === id)
    .reduce((total, entry) => total + entry.unreadCommentIds.length, 0);
  const unreadConversations = selectedConversation?.unreadCommentIds.length ?? 0;
  const conversationCount = selectedConversation?.snapshot?.discussions.length ?? 0;
  const conversationsKnown = Boolean(selectedConversation?.snapshot);
  const matchingReview = gitlabReview?.number === managedTarget?.iid ? gitlabReview : undefined;
  const mrTitle = managedTarget?.title || matchingReview?.title || (managedTarget ? `Merge request !${managedTarget.iid}` : "");
  const mrStatus = managedTarget?.status ?? matchingReview?.status;
  const sourceBranch = managedTarget?.sourceBranch ?? matchingReview?.sourceBranch;
  const targetBranch = managedTarget?.targetBranch ?? matchingReview?.targetBranch;

  const unreadLabel = (entry: GitlabConversationEntry) =>
    materialization.worktrees.find((tree) => tree.repositoryId === entry.target.worktreeRepositoryId)?.label ?? entry.target.label;
  // The next unread thread: the current MR first, then the other MRs in list order.
  const nextUnread = unreadEntries.find((entry) => entry.target.key === managedTarget?.key) ?? unreadEntries[0];
  const nextUnreadIsHere = Boolean(nextUnread && managedTarget && nextUnread.target.key === managedTarget.key);
  const mrCanPost = selectedConversation?.state === "ready" && !selectedConversation.snapshot?.fromCache;
  const mrReviewTarget = useMemo<CodeReviewMergeRequestTarget | undefined>(() => managedTarget
    ? {
        worktreeRepositoryId: managedTarget.worktreeRepositoryId,
        providerRepositoryId: managedTarget.repositoryId,
        iid: managedTarget.iid,
        canPost: mrCanPost,
      }
    : undefined, [managedTarget?.worktreeRepositoryId, managedTarget?.repositoryId, managedTarget?.iid, mrCanPost]);
  const mrPublishValue = useMemo(
    () => (mrReviewTarget ? { client, workspaceId, target: mrReviewTarget, review: aiReview } : null),
    [aiReview, client, mrReviewTarget, workspaceId],
  );
  const mrAiFindingCount = managedTarget
    ? mergeRequestAiReview(aiReview, managedTarget.worktreeRepositoryId, managedTarget.iid)?.review.findings.length ?? 0
    : 0;
  const mrIdentityContent = managedTarget ? (
    <div
      className={styles.mrIdentity}
      data-testid="repository-review-toolbar"
      data-ui="repository-review.mr-identity"
      data-ui-label="Merge request identity"
    >
      <h2 title={mrTitle}>{mrTitle}</h2>
      <div className={styles.mrMetadata}>
        {mrStatus && <span className={styles.mrStatus} data-status={mrStatus}>{mrStatus === "open" ? "Open" : mrStatus === "merged" ? "Merged" : "Closed"}</span>}
        <span className={styles.mrLabel} title={managedTarget.label}>{managedTarget.label}</span>
        {sourceBranch && targetBranch && <span className={styles.branches} title={`${sourceBranch} into ${targetBranch}`}><code>{sourceBranch}</code><Glyph name="arrow" size={11} /><code>{targetBranch}</code></span>}
        <label className={styles.identitySelect}>
          <span className={styles.srOnly}>Repository</span>
          <SelectMenu aria-label="Repository to review" onChange={selectRepository} value={repositoryId || defaultRepositoryId}>
            {materialization.worktrees.map((worktree) => (
              <option key={worktree.repositoryId} value={worktree.repositoryId}>
                {worktree.label}{repositoryUnreadCount(worktree.repositoryId) > 0 ? ` · ${repositoryUnreadCount(worktree.repositoryId)} unread` : ""}
              </option>
            ))}
          </SelectMenu>
        </label>
        {conversationEntries.length > 1 && (
          <label className={styles.identitySelect}>
            <span className={styles.srOnly}>Merge request</span>
            <SelectMenu aria-label="Merge request" value={managedTarget.key} onChange={selectConversationTarget}>
              {conversationEntries.map((entry) => <option key={entry.target.key} value={entry.target.key}>{entry.target.label}{entry.unreadCommentIds.length > 0 ? ` · ${entry.unreadCommentIds.length} unread` : ""}</option>)}
            </SelectMenu>
          </label>
        )}
      </div>
    </div>
  ) : null;
  const mrIdentity = mrIdentityContent && (identitySlot ? createPortal(mrIdentityContent, identitySlot) : <div className={styles.mrIdentityFallback}>{mrIdentityContent}</div>);

  const selectChangeMode = (mode: "code" | "conversations") => {
    if (mode === "conversations" && !repositoryId) setRepositoryId(currentRepositoryId);
    session.mode = mode;
    setChangeView({ workspaceId, mode });
  };

  const openUnreadConversation = (entry: GitlabConversationEntry) => {
    const nextRepositoryId = entry.target.worktreeRepositoryId;
    session.targets[nextRepositoryId] = entry.target.key;
    const unread = new Set(entry.unreadCommentIds);
    const discussion = entry.snapshot?.discussions.find((item) => item.comments.some((comment) => unread.has(comment.id)));
    if (discussion && entry.snapshot) {
      const scope = JSON.stringify([entry.target.key, entry.snapshot.scopeId]);
      session.discussions[scope] = discussion.id;
      if (discussion.filePath) session.files[`${nextRepositoryId}:${entry.target.key}`] = discussion.filePath;
      setRevealConversation({ requestId: ++revealRequestId.current, targetKey: entry.target.key, scopeId: entry.snapshot.scopeId, discussionId: discussion.id });
    }
    selectRepository(nextRepositoryId);
    session.mode = "conversations";
    setChangeView({ workspaceId, mode: "conversations" });
  };

  return (
    <section
      className={styles.screen}
      aria-label="Change review"
      data-ui="repository-review.panel"
      data-ui-label="Repository review panel"
      data-history-swipe-block
      data-testid="repository-review-screen"
    >
      {managedTarget && mrIdentity}
      {!managedTarget && <header
        className={styles.header}
        data-ui="repository-review.header"
        data-ui-label="Repository review toolbar"
        data-testid="repository-review-toolbar"
      >
        <div>
          <h2>{changeMode === "conversations" ? "Repository conversations" : diff ? `${diff.repositoryLabel} changes` : "Find changed code"}</h2>
          <p>
            {changeMode === "conversations"
              ? "Read and reply to GitLab conversations."
              : gitlabReview
              ? `GitLab MR !${gitlabReview.number} · Select a changed line to comment in GitLab.`
              : diff
              ? `${diff.baseCommitOid.slice(0, 8)} to ${diff.headCommitOid.slice(0, 8)}`
              : "WTS checks repositories for local changes"}
          </p>
        </div>
        <label>
          <span>Repository</span>
          <SelectMenu
            aria-label="Repository to review"
            onChange={selectRepository}
            value={repositoryId || defaultRepositoryId}
          >
            {materialization.worktrees.map((worktree) => (
              <option key={worktree.repositoryId} value={worktree.repositoryId}>
                {worktree.label}{repositoryUnreadCount(worktree.repositoryId) > 0 ? ` · ${repositoryUnreadCount(worktree.repositoryId)} unread` : ""}
              </option>
            ))}
          </SelectMenu>
        </label>
        {changeMode === "code" && gitlabReview && (
          <label>
            <span>Changes</span>
            <SelectMenu
              aria-label="Merge request changes"
              disabled={reviewPatchFromCache}
              onChange={(value) => {
                setSelectedCommitOid(value);
                displayedRequestRef.current = null;
                setRequestRevision((value) => value + 1);
              }}
              value={selectedCommitOid}
            >
              <option value="">
                {reviewCommits.length
                  ? `All changes · ${reviewCommits.length} commits`
                  : "All merge request changes"}
              </option>
              {reviewCommits.map((commit, index) => (
                <option key={commit.oid} value={commit.oid}>
                  {index + 1}/{reviewCommits.length} · {commit.shortId} · {commit.title}
                </option>
              ))}
            </SelectMenu>
          </label>
        )}
        {changeMode === "code" && !gitlabReview && <button className={styles.toolbarAction} disabled={checkingReviewUpdates} onClick={retryRepositoryRequest} type="button">Refresh changes</button>}
        {changeMode === "code" && <>
        <span
          className={styles.graphStatus}
          data-ready={materialization.graph.status === "ready" || undefined}
          title={materialization.graph.detail}
        >
          <i />
          {materialization.graph.status === "ready"
            ? "Graph ready"
            : "Graph needed"}
        </span>
        {reportState === "loading" && (
          <span className={styles.reviewSignal} role="status">
            <i aria-hidden="true" />
            WTS checks review context
          </span>
        )}
        {reportState === "ready" &&
          reviewRiskCount !== null &&
          reviewRiskCount > 0 && (
            <span
              aria-label={`${reviewRiskCount} reported ${reviewRiskCount === 1 ? "risk" : "risks"}`}
              className={styles.reviewSignal}
              title={report?.summary || undefined}
            >
              {reviewRiskCount} {reviewRiskCount === 1 ? "risk" : "risks"}
            </span>
          )}
        {reportState === "error" && (
          <button
            className={styles.toolbarAction}
            onClick={() => setReportRevision((value) => value + 1)}
            type="button"
          >
            Retry context
          </button>
        )}
        {reportState === "ready" && !report && onOpenVerification && (
          <button
            className={styles.toolbarAction}
            onClick={onOpenVerification}
            type="button"
          >
            Verification
          </button>
        )}
        {workspaceKey && (
          <button
            aria-expanded={showAiReview}
            className={styles.toolbarAction}
            data-ui="repository-review.ai-review-toggle"
            data-ui-label="AI review button"
            onClick={() => setShowAiReview((prev) => !prev)}
            type="button"
          >
            {showAiReview ? "Hide AI review" : "AI review"}
            {!showAiReview && aiReview && aiReview.findings.length > 0 && (
              <span className={styles.aiReviewCount} aria-label={`${aiReview.findings.length} findings`}>{aiReview.findings.length}</span>
            )}
          </button>
        )}
        </>}
      </header>}
      {gitlabConversations && (
        <div
          className={styles.reviewBar}
          data-ui="repository-review.views"
          data-ui-label="Change views"
        >
          <div className={styles.changeViews} role="tablist" aria-label="Change views">
            {(["code", "conversations"] as const).map((mode) => (
              <button
                aria-controls={`${changeViewId}-${mode}-panel`}
                aria-selected={changeMode === mode}
                aria-label={mode === "code" ? "Code" : `Conversations${unreadConversations ? `, ${unreadConversations} unread comments` : ""}`}
                data-view={mode}
                id={`${changeViewId}-${mode}-tab`}
                key={mode}
                onClick={() => selectChangeMode(mode)}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const next = event.key === "Home" ? "code" : event.key === "End" ? "conversations" : mode === "code" ? "conversations" : "code";
                  selectChangeMode(next);
                  event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus();
                }}
                role="tab"
                tabIndex={changeMode === mode ? 0 : -1}
                type="button"
              >
                {mode === "code" ? "Code" : <>Conversations{conversationsKnown && <span className={styles.conversationCount}>{conversationCount}</span>}{unreadConversations > 0 && <span className={styles.unreadBadge}>{unreadConversations} new</span>}</>}
              </button>
            ))}
          </div>
          {managedTarget && workspaceKey && (
            <button
              aria-expanded={showAiReview}
              className={styles.barAction}
              data-active={showAiReview || undefined}
              data-ui="repository-review.mr-ai-review-toggle"
              data-ui-label="MR AI review button"
              onClick={() => setShowAiReview((prev) => !prev)}
              type="button"
            >
              <Glyph name="play" size={11} />
              {showAiReview ? "Hide AI review" : "AI review"}
              {!showAiReview && mrAiFindingCount > 0 && (
                <span className={styles.aiReviewCount} aria-label={`${mrAiFindingCount} findings`}>{mrAiFindingCount}</span>
              )}
            </button>
          )}
          {unreadEntries.length > 0 && (
            <nav className={styles.unreadInbox} aria-label="Unread MR comments" data-ui="repository-review.unread" data-ui-label="Unread comment links">
              <span className={styles.unreadSummary}>
                <Glyph name="comment" size={13} />
                <strong>{gitlabConversations.unreadCount} unread {gitlabConversations.unreadCount === 1 ? "comment" : "comments"}</strong>
              </span>
              {nextUnread && unreadEntries.length > 1 && (
                <button
                  className={styles.nextUnread}
                  data-ui="repository-review.next-unread"
                  data-ui-label="Next unread button"
                  onClick={() => openUnreadConversation(nextUnread)}
                  title="Open the first unread thread. WTS marks a thread as read when you open it."
                  type="button"
                >
                  {nextUnreadIsHere ? "Open next unread" : `Next unread in ${unreadLabel(nextUnread)}`}
                  <Glyph name="arrow" size={12} />
                </button>
              )}
              <div className={styles.unreadTargets}>
                {unreadEntries.map((entry) => {
                    const label = unreadLabel(entry);
                    const count = entry.unreadCommentIds.length;
                    const single = unreadEntries.length === 1;
                    return <button className={single ? styles.nextUnread : undefined} data-ui={single ? "repository-review.next-unread" : undefined} data-ui-label={single ? "Next unread button" : undefined} key={entry.target.key} type="button" onClick={() => openUnreadConversation(entry)} aria-label={`Open ${count} unread ${count === 1 ? "comment" : "comments"} in ${label} !${entry.target.iid}`} title="Open the first unread thread. WTS marks a thread as read when you open it.">
                      {single ? <span>Open next unread</span> : <><span>{label} <span className={styles.unreadMr}>!{entry.target.iid}</span></span><b>{count}</b></>}
                      {entry.snapshot?.fromCache && <small>Saved</small>}
                      {single && <Glyph name="arrow" size={12} />}
                    </button>;
                })}
              </div>
            </nav>
          )}
        </div>
      )}
      <div className={styles.codeContent} hidden={changeMode !== "code"} role={gitlabConversations ? "tabpanel" : undefined} id={`${changeViewId}-code-panel`} aria-labelledby={gitlabConversations ? `${changeViewId}-code-tab` : undefined}>
      {managedTarget && gitlabConversations ? <CodeReviewPublishProvider value={mrPublishValue}>
      {showAiReview && workspaceKey && (
        <div className={styles.aiReviewSlot}>
          <WorkspaceCodeReviewCard
            client={client}
            compact
            findingsInDiff={mrAiFindingCount > 0}
            mergeRequest={mrReviewTarget}
            onNotice={onNotice}
            onReviewChange={(next, source) => {
              setAiReview(next);
              if (source === "run" && next && next.findings.length > 0) focusAiReview();
            }}
            onRevealFinding={(finding) => focusAiReview(finding.findingId)}
            repositoryId={currentRepositoryId || undefined}
            review={aiReview}
            workspaceId={workspaceId}
            workspaceKey={workspaceKey}
          />
        </div>
      )}
      <MergeRequestWorkingChanges
        key={`${workspaceId}:${currentRepositoryId}:${managedTarget.key}`}
        client={client} workspaceId={workspaceId} repositoryId={currentRepositoryId}
        target={managedTarget} controller={gitlabConversations} active={changeMode === "code"}
        onOpenIntegrations={onOpenIntegrations}
        initialFile={session.files[`${currentRepositoryId}:${managedTarget.key}`]}
        selectedDiscussionId={session.discussions[selectedConversationScope]}
        onSelectConversation={(discussion) => { session.discussions[selectedConversationScope] = discussion.id; setSessionRevision((value) => value + 1); }}
        onFileChange={(path) => { session.files[`${currentRepositoryId}:${managedTarget.key}`] = path; setSessionRevision((value) => value + 1); }}
        aiReview={aiReview}
        aiReviewFocus={aiReviewFocus}
      /></CodeReviewPublishProvider> : <>
      {showAiReview && workspaceKey && (
        <div className={styles.aiReviewSlot}>
          <WorkspaceCodeReviewCard
            client={client}
            currentPatch={diff?.patchSha256 ? { repositoryId: diff.repositoryId, patchSha256: diff.patchSha256 } : undefined}
            findingsInDiff={Boolean(diff?.patch)}
            onNotice={onNotice}
            onReviewChange={(next, source) => {
              setAiReview(next);
              if (source === "run" && next && next.findings.length > 0) focusAiReview();
            }}
            onRevealFinding={(finding) => focusAiReview(finding.findingId)}
            repositoryId={currentRepositoryId || undefined}
            review={aiReview}
            workspaceId={workspaceId}
            workspaceKey={workspaceKey}
          />
        </div>
      )}
      {gitlabReview && (
        <div
          className={styles.reviewPrompt}
          data-ui="repository-review.actions"
          data-ui-label="Merge request review actions"
          role="note"
        >
          <span className={styles.reviewPromptCopy}>
            <Glyph name="comment" size={14} />
            <span><b>Comment on a changed line.</b> Point to a green or red line, then select the comment button.</span>
          </span>
          <span
            className={styles.reviewTracking}
            data-cached={reviewPatchFromCache || undefined}
          >
            {reviewPatchFromCache
              ? "Saved for offline review"
              : reviewCommits.length
              ? `${reviewCommits.length} ${reviewCommits.length === 1 ? "commit" : "commits"}`
              : "Commit history loads with the changes"}
          </span>
          <button
            disabled={checkingReviewUpdates}
            onClick={checkReviewUpdates}
            type="button"
          >
            <Glyph name="refresh" size={13} />
            {checkingReviewUpdates ? "Checking GitLab" : "Check for new commits"}
          </button>
        </div>
      )}
      {error && state === "ready" && <div className={styles.warning} role="alert">{error} The displayed changes remain available. <button onClick={retryRepositoryRequest} type="button">Retry changes</button>{onOpenWorkspaceStatus && <button onClick={onOpenWorkspaceStatus} type="button">Open workspace status</button>}{gitlabReview && onOpenIntegrations && <button onClick={onOpenIntegrations} type="button">Check GitLab connection</button>}</div>}
      {reviewUpdateMessage && (
        <div className={styles.reviewUpdate} role="status">
          {reviewUpdateMessage}
        </div>
      )}
      {state === "loading" ? (
        <div className={styles.loading} role="status">
          <span />
          <span />
          <span />
        </div>
      ) : state === "error" ? (
        <div className={styles.empty} role="alert">
          <b>WTS could not read these changes</b>
          <p>{error}</p>
          <button onClick={retryRepositoryRequest} type="button">
            Try again
          </button>
          {onOpenWorkspaceStatus && <button onClick={onOpenWorkspaceStatus} type="button">Open workspace status</button>}
          {gitlabReview && onOpenIntegrations && <button onClick={onOpenIntegrations} type="button">Check GitLab connection</button>}
        </div>
      ) : diff && (diff.patch || diff.untrackedPaths.length > 0) ? (
        <>
          {diff.patch ? (
            <RepositoryPatchViewer
              {...(diff.patchSha256
                ? {
                    feedback: {
                      baseCommitOid: diff.baseCommitOid,
                      client,
                      headCommitOid: diff.headCommitOid,
                      patchSha256: diff.patchSha256,
                      repositoryId: diff.repositoryId,
                      workspaceId,
                      ...(gitlabReview
                        ? {
                            gitlabReview: {
                              repositoryId: gitlabReview.repositoryId,
                              iid: gitlabReview.number,
                              discussions: reviewDiscussions,
                            },
                          }
                        : {}),
                    },
                  }
                : {})}
              aiReview={aiReview}
              aiReviewFocus={aiReviewFocus}
              aiReviewStale={codeReviewIsStale(aiReview, diff.patchSha256 ? { repositoryId: diff.repositoryId, patchSha256: diff.patchSha256 } : undefined)}
              graphReady={Boolean(reviewGraph)}
              lineCommentProvider={gitlabReview ? "GitLab" : undefined}
              patch={diff.patch}
              reviewGraph={reviewGraph ?? undefined}
              theme={resolvedTheme}
            />
          ) : (
            <section
              className={styles.untrackedReview}
              aria-label="Untracked files"
              data-ui="repository-review.untracked-files"
              data-ui-label="Untracked files"
            >
              <header>
                <span className={styles.untrackedIcon} aria-hidden="true">
                  <Glyph name="file" size={17} />
                </span>
                <span>
                  <b>Untracked files need review</b>
                  <small>
                    These files are local changes. Git did not return readable
                    text for this review.
                  </small>
                </span>
              </header>
              <ul>
                {diff.untrackedPaths.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </section>
          )}
          {(diff.patchTruncated || diff.untrackedPathsTruncated) && (
            <footer className={styles.warning}>
              {diff.patchTruncated && "The patch is limited to 1 MB. "}
              {diff.untrackedPathsTruncated &&
                "Some untracked files are not included."}
            </footer>
          )}
        </>
      ) : (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <Glyph name="check" size={20} />
          </div>
          <b>No local changes</b>
          <p>
            {materialization.worktrees.find((worktree) => worktree.repositoryId === currentRepositoryId)?.label ?? "This repository"} has no change from its base commit
            {diff?.baseCommitOid ? <> <code>{diff.baseCommitOid.slice(0, 8)}</code></> : null}.
          </p>
          {(() => {
            const changed = materialization.worktrees.filter(
              (worktree) =>
                worktree.repositoryId !== currentRepositoryId &&
                ((worktree.activity?.changedFileCount ?? 0) > 0 || (worktree.activity?.commitsAhead ?? 0) > 0),
            );
            return changed.length > 0 ? (
              <div className={styles.emptyJump} data-ui="repository-review.changed-repositories" data-ui-label="Repositories with changes">
                <span>Changes are in:</span>
                {changed.map((worktree) => (
                  <button key={worktree.repositoryId} onClick={() => selectRepository(worktree.repositoryId)} type="button">
                    {worktree.label}
                    <small>{worktree.activity?.changedFileCount ?? 0} files</small>
                  </button>
                ))}
              </div>
            ) : null;
          })()}
        </div>
      )}
      </>}
      </div>
      {gitlabConversations && (
        <div className={styles.conversationsContent} hidden={changeMode !== "conversations"} role="tabpanel" id={`${changeViewId}-conversations-panel`} aria-labelledby={`${changeViewId}-conversations-tab`}>
          <GitlabDiscussionsPanel active={changeMode === "conversations"} client={client} controller={gitlabConversations} repositoryId={currentRepositoryId}
            workspaceId={workspaceId} onAskAgentToFix={openAgentFeedback}
            revealConversation={revealConversation}
            onOpenIntegrations={onOpenIntegrations}
            selectedDiscussionId={managedTarget ? session.discussions[selectedConversationScope] : undefined}
            selectedTargetKey={managedTarget?.key} onTargetChange={selectConversationTarget} hideTargetSelector={Boolean(managedTarget)}
            onSelectConversation={(discussion) => { if (managedTarget) { session.discussions[selectedConversationScope] = discussion.id; if (discussion.filePath) session.files[`${currentRepositoryId}:${managedTarget.key}`] = discussion.filePath; setSessionRevision((value) => value + 1); } }}
          />
        </div>
      )}
    </section>
  );
}
