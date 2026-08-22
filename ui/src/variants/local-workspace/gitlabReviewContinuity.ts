import type { GitlabReviewInbox } from "../../lib/wtsClient";

const STORAGE_KEY = "wts.gitlab-review-continuity.v1";

interface ReviewCheckpoint {
  approvedHead: string;
  requestedHead?: string;
}

type ReviewCheckpoints = Record<string, ReviewCheckpoint>;

function readCheckpoints(storage: Pick<Storage, "getItem">): ReviewCheckpoints {
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, ReviewCheckpoint] => {
        const checkpoint = entry[1] as Partial<ReviewCheckpoint> | null;
        return Boolean(
          checkpoint &&
            typeof checkpoint.approvedHead === "string" &&
            /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(checkpoint.approvedHead) &&
            (checkpoint.requestedHead === undefined ||
              (typeof checkpoint.requestedHead === "string" &&
                /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(checkpoint.requestedHead))),
        );
      }),
    );
  } catch {
    return {};
  }
}

export function reconcileGitlabReviewContinuity(
  inbox: GitlabReviewInbox,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined =
    globalThis.localStorage,
): GitlabReviewInbox {
  if (!storage || inbox.state !== "fresh") return inbox;
  const checkpoints = readCheckpoints(storage);
  let changed = false;
  const reviews = inbox.reviews.map((review) => {
    const head = review.headCommitOid;
    if (!head || review.status !== "open") return review;
    const key = review.id;
    const checkpoint = checkpoints[key];
    if (review.reviewState === "approved") {
      if (!checkpoint || checkpoint.requestedHead === head) {
        checkpoints[key] = { approvedHead: head };
        changed = true;
        return review;
      }
      if (checkpoint.approvedHead !== head) {
        return { ...review, reviewState: "changesAfterApproval" as const };
      }
      return review;
    }
    if (checkpoint && checkpoint.approvedHead !== head) {
      if (checkpoint.requestedHead !== head) {
        checkpoints[key] = { ...checkpoint, requestedHead: head };
        changed = true;
      }
      return { ...review, reviewState: "changesAfterApproval" as const };
    }
    return review;
  });
  if (changed) storage.setItem(STORAGE_KEY, JSON.stringify(checkpoints));
  return { ...inbox, reviews };
}
