import { useCallback, useEffect, useState } from "react";
import type {
  GithubReview,
  GithubReviewInbox,
  GitlabReview,
  GitlabReviewInbox,
  WorkspaceClient,
} from "../../lib/wtsClient";
import { Glyph } from "./Glyph";
import { reconcileGitlabReviewContinuity } from "./gitlabReviewContinuity";
import styles from "./MyReviewsScreen.module.css";

export type MyReviewsLoadState = "loading" | "ready" | "error";
export const REVIEW_INBOX_POLL_INTERVAL_MS = 60_000;

export function useGithubReviewInbox(client: WorkspaceClient) {
  const [state, setState] = useState<MyReviewsLoadState>("loading");
  const [inbox, setInbox] = useState<GithubReviewInbox | null>(null);
  const [gitlabInbox, setGitlabInbox] = useState<GitlabReviewInbox | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let current = true;
    let requestInFlight = false;

    const load = async (showLoading: boolean) => {
      if (requestInFlight) return;
      requestInFlight = true;
      if (showLoading) {
        setState("loading");
        setError("");
      }
      const [github, gitlab] = await Promise.allSettled([
        client.getGithubReviewInbox(),
        client.getGitlabReviewInbox(),
      ]);
      requestInFlight = false;
      if (!current) return;
      if (github.status === "fulfilled") setInbox(github.value);
      else setInbox((previous) => ({
        schemaVersion: 1, reviews: previous?.reviews ?? [], fetchedAtUnixMs: previous?.fetchedAtUnixMs ?? null,
        state: previous?.reviews.length ? "stale" : "error",
        detail: github.reason instanceof Error ? github.reason.message : "Could not load GitHub reviews.",
      }));
      if (gitlab.status === "fulfilled") {
        setGitlabInbox(reconcileGitlabReviewContinuity(gitlab.value));
      } else setGitlabInbox((previous) => ({
        schemaVersion: 1, reviews: previous?.reviews ?? [], fetchedAtUnixMs: previous?.fetchedAtUnixMs ?? null,
        state: previous?.reviews.length ? "stale" : "error",
        detail: gitlab.reason instanceof Error ? gitlab.reason.message : "Could not load GitLab reviews.",
      }));
      setError("");
      setState("ready");
    };

    void load(true);
    const interval = window.setInterval(
      () => void load(false),
      REVIEW_INBOX_POLL_INTERVAL_MS,
    );
    const handleFocus = () => void load(false);
    window.addEventListener("focus", handleFocus);
    return () => {
      current = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
    };
  }, [client, revision]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return { error, gitlabInbox, inbox, refresh, state };
}

function reviewDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export type MyReviewsTab = "open" | "archive";

/** Merged and closed merge requests need no more action, so they go to the archive. */
export function isArchivedReview(review: GithubReview | GitlabReview) {
  return "status" in review && (review.status === "merged" || review.status === "closed");
}

export function MyReviewsScreen({
  client,
  error,
  inbox,
  gitlabInbox,
  onOpenIntegrations,
  onRefresh,
  state,
  workspaceForReview,
  onOpenWorkspace,
}: {
  client: WorkspaceClient;
  error: string;
  inbox: GithubReviewInbox | null;
  gitlabInbox: GitlabReviewInbox | null;
  onOpenIntegrations: () => void;
  onRefresh: () => void;
  state: MyReviewsLoadState;
  /** Returns the saved workspace for a GitLab MR, when one exists. */
  workspaceForReview?: (review: { repository: string; number: number }) => { id: string; title: string } | undefined;
  onOpenWorkspace?: (workspaceId: string) => void;
}) {
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState("");
  const [tab, setTab] = useState<MyReviewsTab>("open");

  type AssignedReview =
    | { provider: "github"; review: GithubReview }
    | { provider: "gitlab"; review: GitlabReview };

  const assignedReviews: AssignedReview[] = [
    ...(inbox?.reviews.map((review) => ({
      provider: "github" as const,
      review,
    })) ?? []),
    ...(gitlabInbox?.reviews.map((review) => ({
      provider: "gitlab" as const,
      review,
    })) ?? []),
  ].sort((left, right) =>
    right.review.updatedAt.localeCompare(left.review.updatedAt),
  );
  const openReviews = assignedReviews.filter((item) => !isArchivedReview(item.review));
  const archivedReviews = assignedReviews.filter((item) => isArchivedReview(item.review));
  const visibleReviews = tab === "archive" ? archivedReviews : openReviews;
  const pendingCount = openReviews.filter(
    (item) =>
      item.provider === "github" ||
      (item.review.reviewState !== "approved" && item.review.status === "open"),
  ).length;
  const approvedCount = openReviews.filter(
    (item) => item.provider === "gitlab" && item.review.reviewState === "approved",
  ).length;

  const openReview = async ({ provider, review }: AssignedReview) => {
    if (opening) return;
    setOpening(review.id);
    setOpenError("");
    try {
      if (provider === "github") {
        const result = await client.openGithubReview(
          review.repositoryId,
          review.number,
        );
        if (
          result.repositoryId !== review.repositoryId ||
          result.number !== review.number ||
          !result.accepted
        ) {
          throw new Error("This review action was not accepted.");
        }
      } else {
        const result = await client.openGitlabMergeRequest(
          review.repositoryId,
          review.number,
        );
        if (
          result.repositoryId !== review.repositoryId ||
          result.iid !== review.number ||
          !result.accepted
        ) {
          throw new Error("This review action was not accepted.");
        }
      }
    } catch (cause) {
      setOpenError(
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : "Could not open this review.",
      );
    } finally {
      setOpening(null);
    }
  };

  return (
    <main
      className={styles.page}
      data-ui="reviews.page"
      data-ui-label="My reviews page"
    >
      <header
        className={styles.header}
        data-ui="reviews.header"
        data-ui-label="My reviews header"
      >
        <div>
          <span className={styles.eyebrow}>CODE REVIEW</span>
          <h1>My reviews</h1>
          <p>Track reviews that need your action and merge requests that you approved.</p>
        </div>
        <button
          className={styles.refresh}
          disabled={state === "loading"}
          onClick={onRefresh}
          type="button"
        >
          <Glyph name="refresh" size={14} />
          Refresh
        </button>
      </header>

      {state === "loading" ? (
        <section className={styles.state} role="status">
          <span className={styles.spinner}><Glyph name="refresh" size={18} /></span>
          <h2>Loading your reviews…</h2>
          <p>Checking GitHub and GitLab for direct review requests…</p>
        </section>
      ) : state === "error" ? (
        <section className={styles.state} role="alert">
          <Glyph name="warning" size={22} />
          <h2>Could not load your reviews</h2>
          <p>{error}</p>
          <button onClick={onRefresh} type="button">Try again</button>
        </section>
      ) : inbox?.state === "auth" && gitlabInbox?.state === "auth" ? (
        <section className={styles.state} role="status">
          <Glyph name="plug" size={22} />
          <h2>Connect GitHub and GitLab</h2>
          <p>{inbox.detail} {gitlabInbox.detail}</p>
          <button onClick={onOpenIntegrations} type="button">
            Open integrations
          </button>
        </section>
      ) : inbox?.state === "error" && gitlabInbox?.state === "error" ? (
        <section className={styles.state} role="alert">
          <Glyph name="warning" size={22} />
          <h2>Review providers are unavailable</h2>
          <p>{inbox.detail} {gitlabInbox.detail}</p>
          <button onClick={onRefresh} type="button">Try again</button>
          <button onClick={onOpenIntegrations} type="button">Open integrations</button>
        </section>
      ) : (
        <>
          {inbox?.state === "stale" && (
            <aside className={styles.notice} data-tone="warning" role="status">
              <Glyph name="warning" size={16} />
              <span>
                <b>Showing saved review data.</b>
                {inbox.detail}
              </span>
            </aside>
          )}
          {gitlabInbox?.state === "stale" && (
            <aside className={styles.notice} data-tone="warning" role="status">
              <Glyph name="warning" size={16} />
              <span>
                <b>Showing saved GitLab review data.</b>
                {gitlabInbox.detail}
              </span>
            </aside>
          )}
          {([{ name: "GitHub", inbox }, { name: "GitLab", inbox: gitlabInbox }] as const).map(({ name, inbox: provider }) => (provider?.state === "auth" || provider?.state === "error") && (
            <aside key={name} className={styles.notice} data-tone="warning" role={provider.state === "error" ? "alert" : "status"}>
              <Glyph name="warning" size={16} />
              <span>
                <b>{name} reviews are unavailable.</b>
                {provider.detail}
              </span>
              <button onClick={provider.state === "auth" ? onOpenIntegrations : onRefresh} type="button">{provider.state === "auth" ? `Connect ${name}` : `Refresh ${name} reviews`}</button>
              {provider.state === "error" && <button onClick={onOpenIntegrations} type="button">Open integrations</button>}
            </aside>
          ))}
          {openError && (
            <aside className={styles.notice} data-tone="error" role="alert">
              <Glyph name="warning" size={16} />
              <span><b>Could not open the review.</b>{openError}</span>
            </aside>
          )}
          {!assignedReviews.length ? (
            <section className={styles.state}>
              <span className={styles.done}><Glyph name="check" size={22} /></span>
              <h2>{inbox?.state === "fresh" && gitlabInbox?.state === "fresh" ? "No reviews to track" : "Some reviews are unavailable"}</h2>
              <p>{inbox?.state === "fresh" && gitlabInbox?.state === "fresh" ? "GitHub and GitLab found no review requests or approved merge requests." : "Connect or refresh the provider above to check its reviews."}</p>
            </section>
          ) : (
            <section
              aria-label="Assigned code reviews"
              className={styles.list}
              data-ui="reviews.list"
              data-ui-label="Assigned review list"
            >
              <div className={styles.listHeader}>
                <div className={styles.tabs} role="tablist" aria-label="Review lists"
                  data-ui="reviews.tabs" data-ui-label="Review tabs">
                  {([
                    ["open", "Open", openReviews.length],
                    ["archive", "Archive", archivedReviews.length],
                  ] as const).map(([id, label, count]) => (
                    <button key={id} type="button" role="tab" className={styles.tab}
                      aria-label={`${label} ${count}`}
                      aria-selected={tab === id} onClick={() => setTab(id)}>
                      {label}<span className={styles.tabCount}>{count}</span>
                    </button>
                  ))}
                </div>
                <span>
                  {tab === "open"
                    ? `${pendingCount} pending · ${approvedCount} approved`
                    : "Merged and closed merge requests"}
                </span>
              </div>
              {!visibleReviews.length && (
                <p className={styles.tabEmpty}>
                  {tab === "archive"
                    ? "No merged or closed merge requests."
                    : "No open reviews. Merged and closed merge requests are in Archive."}
                </p>
              )}
              {visibleReviews.map((item) => {
                const { provider, review } = item;
                const stale =
                  provider === "github"
                    ? inbox?.state === "stale"
                    : gitlabInbox?.state === "stale";
                const workspace = provider === "gitlab" ? workspaceForReview?.(review) : undefined;
                return (
                <article
                  className={styles.review}
                  data-freshness={stale ? "stale" : "fresh"}
                  key={`${provider}-${review.id}`}
                >
                  <div className={styles.provider}>
                    {provider === "github" ? "GH" : "GL"}
                  </div>
                  <div className={styles.reviewBody}>
                    <div className={styles.reviewMeta}>
                      <b>{review.repository}</b>
                      <span>{provider === "github" ? "#" : "!"}{review.number}</span>
                      {review.draft && <span className={styles.draft}>Draft</span>}
                      {provider === "gitlab" && (
                        <span
                          className={styles.reviewStatus}
                          data-status={review.status === "open" ? review.reviewState : review.status}
                        >
                          {review.status === "merged"
                            ? "Merged"
                            : review.status === "closed"
                              ? "Closed"
                              : review.reviewState === "changesAfterApproval"
                                ? "New changes after approval"
                              : review.reviewState === "approved"
                                ? "Approved"
                                : "Review requested"}
                        </span>
                      )}
                      {stale && <span className={styles.stale}>Saved</span>}
                    </div>
                    <h2>{review.title}</h2>
                    <div className={styles.reviewDetails}>
                      <span>By {review.authorLogin}</span>
                      <span>Updated {reviewDate(review.updatedAt)}</span>
                    </div>
                  </div>
                  <div className={styles.reviewActions}>
                    {workspace && onOpenWorkspace && (
                      <button
                        aria-label={`Open workspace ${workspace.title}`}
                        className={styles.reviewAction}
                        data-ui="reviews.open-workspace"
                        data-ui-label="Open review workspace"
                        onClick={() => onOpenWorkspace(workspace.id)}
                        title={workspace.title}
                        type="button"
                      >
                        <Glyph name="folder" size={13} />
                        Workspace
                      </button>
                    )}
                    <button
                      className={styles.reviewAction}
                      disabled={opening !== null}
                      onClick={() => void openReview(item)}
                      type="button"
                    >
                      {opening === review.id
                        ? "Opening…"
                        : provider === "gitlab" &&
                            (review.reviewState === "approved" || isArchivedReview(review))
                          ? "Open MR"
                          : "Review"}
                      <Glyph name="external" size={13} />
                    </button>
                  </div>
                </article>
                );
              })}
            </section>
          )}
        </>
      )}
    </main>
  );
}
