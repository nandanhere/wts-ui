import { useEffect, useMemo, useRef, useState } from "react";
import type {
  WorkspaceAgentReport,
  WorkspaceClient,
  WorkspaceMaterialization,
  WorkspaceRepositoryDiff,
  WorkspaceRepositoryReviewGraph,
  GitlabReview,
  GitlabReviewCommit,
  GitlabReviewDiscussion,
  GitlabReviewTarget,
} from "../../lib/wtsClient";
import { useTheme } from "../../theme";
import { Glyph } from "./Glyph";
import { RepositoryPatchViewer } from "./RepositoryPatchViewer";
import styles from "./RepositoryReviewScreen.module.css";

interface RepositoryReviewScreenProps {
  client: WorkspaceClient;
  initialRepositoryId?: string;
  materialization: WorkspaceMaterialization;
  onOpenVerification?: () => void;
  onRepositoryChange: (repositoryId: string) => void;
  workspaceId: string;
  gitlabReview?: GitlabReviewTarget & Partial<GitlabReview>;
}

export const REVIEW_PATCH_POLL_INTERVAL_MS = 60_000;

export function RepositoryReviewScreen({
  client,
  initialRepositoryId,
  materialization,
  onOpenVerification,
  onRepositoryChange,
  workspaceId,
  gitlabReview,
}: RepositoryReviewScreenProps) {
  const { resolvedTheme } = useTheme();
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
  const [diff, setDiff] = useState<WorkspaceRepositoryDiff | null>(null);
  const [reviewGraph, setReviewGraph] =
    useState<WorkspaceRepositoryReviewGraph | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
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
    if (
      directRepositoryId &&
      displayedRequestRef.current?.workspaceId === workspaceId &&
      displayedRequestRef.current.repositoryId === directRepositoryId &&
      displayedRequestRef.current.requestRevision === requestRevision &&
      displayedRequestRef.current.providerHeadCommitOid === gitlabPatchTarget?.headCommitOid &&
      displayedRequestRef.current.selectedCommitOid === (selectedCommitOid || undefined)
    ) {
      return;
    }
    let current = true;
    const forceProviderRefresh = forceProviderRefreshRef.current;
    const preserveDisplayedReview =
      state === "ready" &&
      diff !== null &&
      (preserveDisplayedReviewRef.current ||
        (gitlabPatchTarget !== undefined &&
          diff.repositoryId === directRepositoryId));
    forceProviderRefreshRef.current = false;
    preserveDisplayedReviewRef.current = false;
    displayedRequestRef.current = null;
    if (!preserveDisplayedReview) {
      setState("loading");
      setDiff(null);
    }
    setError("");
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
                  if (!selectedCommitOid) {
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
                  setReviewPatchFromCache(patch.fromCache);
                  setReviewCommits(patch.commits);
                  setReviewDiscussions(patch.discussions);
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
            : await client.getWorkspaceRepositoryDiff(workspaceId, candidateId);
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
              onRepositoryChangeRef.current(candidateId);
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
          onRepositoryChangeRef.current(firstCleanDiff.repositoryId);
        }
        return;
      }
      if (preserveDisplayedReview) {
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
    if (!gitlabPatchTarget) return;
    const check = () => {
      forceProviderRefreshRef.current = true;
      preserveDisplayedReviewRef.current = true;
      displayedRequestRef.current = null;
      setCheckingReviewUpdates(true);
      setRequestRevision((value) => value + 1);
    };
    const interval = window.setInterval(check, REVIEW_PATCH_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [gitlabPatchTarget]);

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

  const selectRepository = (nextRepositoryId: string) => {
    setRepositoryId(nextRepositoryId);
    setRequestRevision((current) => current + 1);
    onRepositoryChange(nextRepositoryId);
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

  return (
    <section
      className={styles.screen}
      aria-label="Change review"
      data-ui="repository-review.panel"
      data-ui-label="Repository review panel"
      data-history-swipe-block
      data-testid="repository-review-screen"
    >
      <header
        className={styles.header}
        data-ui="repository-review.header"
        data-ui-label="Repository review toolbar"
        data-testid="repository-review-toolbar"
      >
        <div>
          <h2>{diff ? `${diff.repositoryLabel} changes` : "Find changed code"}</h2>
          <p>
            {gitlabReview
              ? `GitLab MR !${gitlabReview.number} · Select a changed line to comment in GitLab.`
              : diff
              ? `${diff.baseCommitOid.slice(0, 8)} to ${diff.headCommitOid.slice(0, 8)}`
              : "WTS checks repositories for local changes"}
          </p>
        </div>
        <label>
          <span>Repository</span>
          <select
            aria-label="Repository to review"
            onChange={(event) => selectRepository(event.target.value)}
            value={repositoryId || defaultRepositoryId}
          >
            {materialization.worktrees.map((worktree) => (
              <option key={worktree.repositoryId} value={worktree.repositoryId}>
                {worktree.label}
              </option>
            ))}
          </select>
        </label>
        {gitlabReview && (
          <label>
            <span>Changes</span>
            <select
              aria-label="Merge request changes"
              disabled={reviewPatchFromCache}
              onChange={(event) => {
                setSelectedCommitOid(event.currentTarget.value);
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
            </select>
          </label>
        )}
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
      </header>
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
          <p>The workspace is up to date with the target branch.</p>
        </div>
      )}
    </section>
  );
}
