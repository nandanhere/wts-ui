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
      if (gitlab.status === "fulfilled") {
        setGitlabInbox(reconcileGitlabReviewContinuity(gitlab.value));
      }
      if (github.status === "rejected" && gitlab.status === "rejected") {
        const cause = github.reason;
        setError(
          cause instanceof Error && cause.message.trim()
            ? cause.message
            : "WTS could not load your code reviews.",
        );
        setState("error");
      } else {
        setError("");
        setState("ready");
      }
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

export function MyReviewsScreen({
  client,
  error,
  inbox,
  gitlabInbox,
  onOpenIntegrations,
  onRefresh,
  state,
}: {
  client: WorkspaceClient;
  error: string;
  inbox: GithubReviewInbox | null;
  gitlabInbox: GitlabReviewInbox | null;
  onOpenIntegrations: () => void;
  onRefresh: () => void;
  state: MyReviewsLoadState;
}) {
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState("");

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
  const pendingCount = assignedReviews.filter(
    (item) =>
      item.provider === "github" ||
      (item.review.reviewState !== "approved" && item.review.status === "open"),
  ).length;
  const approvedCount = assignedReviews.filter(
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
          throw new Error("WTS did not accept this review action.");
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
          throw new Error("WTS did not accept this review action.");
        }
      }
    } catch (cause) {
      setOpenError(
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : "WTS could not open this review.",
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
          <h2>WTS loads your reviews</h2>
          <p>WTS checks GitHub and GitLab for direct review requests.</p>
        </section>
      ) : state === "error" ? (
        <section className={styles.state} role="alert">
          <Glyph name="warning" size={22} />
          <h2>WTS could not load your reviews</h2>
          <p>{error}</p>
          <button onClick={onRefresh} type="button">Try again</button>
        </section>
      ) : inbox?.state === "auth" && gitlabInbox?.state === "auth" ? (
        <section className={styles.state} role="status">
          <Glyph name="plug" size={22} />
          <h2>Connect GitHub</h2>
          <p>{inbox.detail}</p>
          <button onClick={onOpenIntegrations} type="button">
            Open integrations
          </button>
        </section>
      ) : inbox?.state === "error" && gitlabInbox?.state === "error" ? (
        <section className={styles.state} role="alert">
          <Glyph name="warning" size={22} />
          <h2>GitHub reviews are unavailable</h2>
          <p>{inbox.detail}</p>
          <button onClick={onRefresh} type="button">Try again</button>
        </section>
      ) : (
        <>
          {inbox?.state === "stale" && (
            <aside className={styles.notice} data-tone="warning" role="status">
              <Glyph name="warning" size={16} />
              <span>
                <b>WTS shows saved review data.</b>
                {inbox.detail}
              </span>
            </aside>
          )}
          {gitlabInbox?.state === "stale" && (
            <aside className={styles.notice} data-tone="warning" role="status">
              <Glyph name="warning" size={16} />
              <span>
                <b>WTS shows saved GitLab review data.</b>
                {gitlabInbox.detail}
              </span>
            </aside>
          )}
          {(gitlabInbox?.state === "auth" ||
            gitlabInbox?.state === "error") && (
            <aside className={styles.notice} data-tone="warning" role="status">
              <Glyph name="warning" size={16} />
              <span>
                <b>GitLab reviews are unavailable.</b>
                {gitlabInbox.detail}
              </span>
            </aside>
          )}
          {openError && (
            <aside className={styles.notice} data-tone="error" role="alert">
              <Glyph name="warning" size={16} />
              <span><b>WTS could not open the review.</b>{openError}</span>
            </aside>
          )}
          {!assignedReviews.length ? (
            <section className={styles.state}>
              <span className={styles.done}><Glyph name="check" size={22} /></span>
              <h2>No reviews to track</h2>
              <p>GitHub and GitLab found no review requests or approved merge requests.</p>
            </section>
          ) : (
            <section
              aria-label="Assigned code reviews"
              className={styles.list}
              data-ui="reviews.list"
              data-ui-label="Assigned review list"
            >
              <div className={styles.listHeader}>
                <span>{pendingCount} pending · {approvedCount} approved</span>
                <span>Current provider data</span>
              </div>
              {assignedReviews.map((item) => {
                const { provider, review } = item;
                const stale =
                  provider === "github"
                    ? inbox?.state === "stale"
                    : gitlabInbox?.state === "stale";
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
                  <button
                    className={styles.reviewAction}
                    disabled={opening !== null}
                    onClick={() => void openReview(item)}
                    type="button"
                  >
                    {opening === review.id
                      ? "WTS opens…"
                      : provider === "gitlab" && review.reviewState === "approved"
                        ? "Open MR"
                        : "Review"}
                    <Glyph name="external" size={13} />
                  </button>
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
