import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  CodeChangeReviewTarget,
  GitlabReviewDiscussion,
  WorkspaceClient,
  WorkspaceReviewThread,
} from "../../lib/wtsClient";
import styles from "./CodeReviewFeedbackPanel.module.css";

interface CodeReviewFeedbackPanelProps {
  client: WorkspaceClient;
  repositoryId: string;
  selectedTarget?: CodeChangeReviewTarget;
  workspaceId: string;
  gitlabReview?: {
    repositoryId: string;
    iid: number;
    discussions: GitlabReviewDiscussion[];
  };
}

function targetLabel(
  target: Pick<CodeChangeReviewTarget, "filePath" | "side" | "line">,
) {
  const side = target.side === "additions" ? "+" : "−";
  return `${target.filePath}:${side}${target.line}`;
}

function threadLabel(thread: WorkspaceReviewThread) {
  return thread.target.kind === "codeChange"
    ? targetLabel(thread.target)
    : "Changed code";
}

function safeDiscussionUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? url : "";
  } catch {
    return "";
  }
}

function readableDiscussionBody(body: string) {
  return body
    .replace(/<\/?(?:details|summary)(?:\s[^>]*)?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function DiscussionComment({
  comment,
}: {
  comment: GitlabReviewDiscussion["comments"][number];
}) {
  return (
    <article>
      <small>@{comment.authorLogin}</small>
      <div className={styles.discussionBody}>
        <ReactMarkdown
          components={{
            a: ({ children, href }) => {
              const safeHref = href ? safeDiscussionUrl(href) : "";
              return safeHref ? (
                <a href={safeHref} rel="noreferrer" target="_blank">
                  {children}
                </a>
              ) : (
                <span>{children}</span>
              );
            },
          }}
          remarkPlugins={[remarkGfm]}
          skipHtml
          urlTransform={safeDiscussionUrl}
        >
          {readableDiscussionBody(comment.body)}
        </ReactMarkdown>
      </div>
    </article>
  );
}

export function CodeReviewFeedbackPanel({
  client,
  repositoryId,
  selectedTarget,
  workspaceId,
  gitlabReview,
}: CodeReviewFeedbackPanelProps) {
  const [threads, setThreads] = useState<WorkspaceReviewThread[]>([]);
  const [body, setBody] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [published, setPublished] = useState(false);
  const [gitlabDiscussions, setGitlabDiscussions] = useState(
    gitlabReview?.discussions ?? [],
  );

  useEffect(() => {
    setGitlabDiscussions(gitlabReview?.discussions ?? []);
  }, [gitlabReview?.discussions]);

  useEffect(() => {
    let current = true;
    setState("loading");
    setError("");
    void client
      .listWorkspaceReviewThreads(workspaceId)
      .then((result) => {
        if (!current) return;
        setThreads(
          result.threads.filter(
            (thread) =>
              thread.target.kind === "codeChange" &&
              thread.target.repositoryId === repositoryId,
          ),
        );
        setState("ready");
      })
      .catch((cause) => {
        if (!current) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "WTS could not load review feedback.",
        );
        setState("error");
      });
    return () => {
      current = false;
    };
  }, [client, repositoryId, revision, workspaceId]);

  const orderedThreads = useMemo(
    () =>
      [...threads].sort((left, right) => {
        const leftSelected =
          selectedTarget &&
          left.target.kind === "codeChange" &&
          left.target.filePath === selectedTarget.filePath &&
          left.target.side === selectedTarget.side &&
          left.target.line === selectedTarget.line;
        const rightSelected =
          selectedTarget &&
          right.target.kind === "codeChange" &&
          right.target.filePath === selectedTarget.filePath &&
          right.target.side === selectedTarget.side &&
          right.target.line === selectedTarget.line;
        if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
        if (left.state !== right.state) return left.state === "open" ? -1 : 1;
        return right.updatedAtUnixMs - left.updatedAtUnixMs;
      }),
    [selectedTarget, threads],
  );

  const orderedGitlabDiscussions = useMemo(
    () =>
      [...gitlabDiscussions].sort((left, right) => {
        const selected = (discussion: GitlabReviewDiscussion) =>
          Boolean(
            selectedTarget &&
              discussion.filePath === selectedTarget.filePath &&
              discussion.side === selectedTarget.side &&
              discussion.line === selectedTarget.line,
          );
        if (selected(left) !== selected(right)) return selected(left) ? -1 : 1;
        if (left.automated !== right.automated) return left.automated ? 1 : -1;
        if (left.resolvable !== right.resolvable) return left.resolvable ? -1 : 1;
        if (left.resolved !== right.resolved) return left.resolved ? 1 : -1;
        return 0;
      }),
    [gitlabDiscussions, selectedTarget],
  );

  const actionableGitlabDiscussions = gitlabDiscussions.filter(
    (discussion) => discussion.resolvable,
  );
  const automatedNoteCount = gitlabDiscussions.filter(
    (discussion) => discussion.automated,
  ).length;

  const createThread = async () => {
    if (!selectedTarget || !body.trim() || pending) return;
    setPending(true);
    setError("");
    try {
      if (gitlabReview) {
        const result = await client.publishGitlabReviewComment(
          gitlabReview.repositoryId,
          gitlabReview.iid,
          {
            body,
            filePath: selectedTarget.filePath,
            side: selectedTarget.side,
            line: selectedTarget.line,
          },
        );
        if (!result.accepted) throw new Error("GitLab did not accept this comment.");
        setBody("");
        setPublished(true);
        try {
          const patch = await client.getGitlabReviewPatch(
            gitlabReview.repositoryId,
            gitlabReview.iid,
            undefined,
            true,
          );
          setGitlabDiscussions(patch.discussions);
        } catch {
          setError("Comment published. WTS could not refresh GitLab threads.");
        }
        return;
      }
      const created = await client.createWorkspaceReviewThread(
        workspaceId,
        selectedTarget,
        body,
        "user",
      );
      setThreads((current) => [created, ...current]);
      setBody("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "WTS could not save this review comment.",
      );
    } finally {
      setPending(false);
    }
  };

  const resolveThread = async (thread: WorkspaceReviewThread) => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const resolved = await client.resolveWorkspaceReviewThread(
        workspaceId,
        thread.threadId,
        thread.revision,
      );
      setThreads((current) =>
        current.map((candidate) =>
          candidate.threadId === resolved.threadId ? resolved : candidate,
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "WTS could not resolve this review thread.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className={styles.panel}
      data-ui="code-feedback.panel"
      data-ui-label="Code review feedback"
    >
      <header
        data-ui="code-feedback.target"
        data-ui-label="Review feedback target"
      >
        <small>REVIEW FEEDBACK</small>
        <b>
          {selectedTarget
            ? targetLabel(selectedTarget)
            : "Select a changed line"}
        </b>
        <p>
          {selectedTarget
            ? gitlabReview
              ? "WTS publishes this comment to the GitLab merge request."
              : "Your comment becomes agent input. WTS does not change the code."
            : "Select an added or deleted line in the diff."}
        </p>
      </header>

      {selectedTarget && (
        <form
          data-ui="code-feedback.composer"
          data-ui-label="Code feedback composer"
          onSubmit={(event) => {
            event.preventDefault();
            void createThread();
          }}
        >
          <textarea
            aria-label="Review comment"
            autoFocus
            maxLength={16_384}
            onChange={(event) => setBody(event.currentTarget.value)}
            placeholder="Ask a question or explain a concern"
            rows={4}
            value={body}
          />
          <button disabled={!body.trim() || pending} type="submit">
            {pending ? "Publishes comment" : gitlabReview ? "Publish to GitLab" : "Send to agent"}
          </button>
        </form>
      )}

      {published && <p role="status">Comment published to GitLab.</p>}

      {error && (
        <div className={styles.error} role="alert">
          <span>{error}</span>
          {state === "error" && (
            <button onClick={() => setRevision((value) => value + 1)} type="button">
              Try again
            </button>
          )}
        </div>
      )}

      <section
        aria-label="Code review threads"
        className={styles.threads}
        data-ui="code-feedback.threads"
        data-ui-label="Code review threads"
      >
        <div className={styles.threadSummary}>
          <span>
            Open {threads.filter((thread) => thread.state === "open").length +
              actionableGitlabDiscussions.filter((discussion) => !discussion.resolved).length}
          </span>
          <span>
            Resolved {threads.filter((thread) => thread.state === "resolved").length +
              actionableGitlabDiscussions.filter((discussion) => discussion.resolved).length}
          </span>
          {automatedNoteCount > 0 && (
            <span>{automatedNoteCount} automated note{automatedNoteCount === 1 ? "" : "s"}</span>
          )}
        </div>
        {state === "loading" ? (
          <p role="status">WTS loads review feedback.</p>
        ) : orderedThreads.length === 0 && gitlabDiscussions.length === 0 ? (
          <p>No code review feedback exists for this repository.</p>
        ) : (
          <ul>
            {orderedGitlabDiscussions.map((discussion) => {
              const label = discussion.filePath && discussion.side && discussion.line
                ? targetLabel({
                    filePath: discussion.filePath,
                    side: discussion.side,
                    line: discussion.line,
                  })
                : discussion.automated
                  ? "Automated note"
                  : "General discussion";
              const selected = Boolean(
                selectedTarget &&
                  discussion.filePath === selectedTarget.filePath &&
                  discussion.side === selectedTarget.side &&
                  discussion.line === selectedTarget.line,
              );
              if (discussion.automated) {
                return (
                  <li className={styles.automatedThread} key={discussion.id}>
                    <details>
                      <summary>
                        <b>{label}</b>
                        <span>@{discussion.comments[0]?.authorLogin}</span>
                        <span className={styles.disclosure}>Show</span>
                      </summary>
                      {discussion.comments.map((comment) => (
                        <DiscussionComment comment={comment} key={comment.id} />
                      ))}
                    </details>
                  </li>
                );
              }
              return (
                <li
                  className={styles.gitlabThread}
                  data-selected={selected || undefined}
                  key={discussion.id}
                >
                  <header>
                    <b>{label}</b>
                    {discussion.resolvable && (
                      <span data-anchor="current">
                        {discussion.resolved ? "Resolved" : "Open"}
                      </span>
                    )}
                  </header>
                  {discussion.comments.map((comment) => (
                    <DiscussionComment comment={comment} key={comment.id} />
                  ))}
                </li>
              );
            })}
            {orderedThreads.map((thread) => (
              <li key={thread.threadId}>
                <header>
                  <b>{threadLabel(thread)}</b>
                  <span data-anchor={thread.anchorState}>
                    {thread.anchorState === "current"
                      ? thread.state === "open"
                        ? "Open"
                        : "Resolved"
                      : thread.anchorState === "stale"
                        ? "Old patch"
                        : "Unavailable"}
                  </span>
                </header>
                <p>{thread.comments[0]?.body}</p>
                {thread.state === "open" && (
                  <button
                    disabled={pending}
                    onClick={() => void resolveThread(thread)}
                    type="button"
                  >
                    Resolve
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
