import type { GitlabReviewDiscussion, GitlabReviewDiscussionComment } from "../../lib/wtsClient";

export interface GitlabDiscussionFixContext {
  kind: "gitlabDiscussion";
  workspaceId: string;
  repositoryId: string;
  providerRepositoryId: string;
  iid: number;
  discussionId: string;
  scopeId?: string;
  mergeRequestLabel?: string;
  title?: string;
  sourceBranch?: string;
  targetBranch?: string;
  filePath?: string;
  side?: "additions" | "deletions";
  line?: number;
  position?: NonNullable<GitlabReviewDiscussion["position"]>;
  resolved: boolean;
  automated: boolean;
  comments: GitlabReviewDiscussionComment[];
  fetchedAtUnixMs?: number;
  fromCache?: boolean;
  truncated?: boolean;
}

interface DiscussionFixSource {
  workspaceId?: string;
  repositoryId: string;
  providerRepositoryId: string;
  iid: number;
  scopeId?: string;
  mergeRequestLabel?: string;
  title?: string;
  sourceBranch?: string;
  targetBranch?: string;
  discussion: GitlabReviewDiscussion;
  fetchedAtUnixMs?: number;
  fromCache?: boolean;
  truncated?: boolean;
}

export function buildGitlabDiscussionFixContext(source: DiscussionFixSource): GitlabDiscussionFixContext | undefined {
  const { workspaceId, discussion } = source;
  if (!workspaceId?.trim() || !source.repositoryId.trim() || !source.providerRepositoryId.trim() ||
    !Number.isSafeInteger(source.iid) || source.iid < 1 || !discussion.id.trim()) return undefined;
  return {
    kind: "gitlabDiscussion",
    workspaceId,
    repositoryId: source.repositoryId,
    providerRepositoryId: source.providerRepositoryId,
    iid: source.iid,
    discussionId: discussion.id,
    ...(source.scopeId !== undefined ? { scopeId: source.scopeId } : {}),
    ...(source.mergeRequestLabel !== undefined ? { mergeRequestLabel: source.mergeRequestLabel } : {}),
    ...(source.title !== undefined ? { title: source.title } : {}),
    ...(source.sourceBranch !== undefined ? { sourceBranch: source.sourceBranch } : {}),
    ...(source.targetBranch !== undefined ? { targetBranch: source.targetBranch } : {}),
    ...(discussion.filePath !== undefined ? { filePath: discussion.filePath } : {}),
    ...(discussion.side !== undefined ? { side: discussion.side } : {}),
    ...(discussion.line !== undefined ? { line: discussion.line } : {}),
    ...(discussion.position ? { position: { ...discussion.position } } : {}),
    resolved: discussion.resolved,
    automated: discussion.automated,
    comments: discussion.comments.map((comment) => ({ ...comment })),
    ...(source.fetchedAtUnixMs !== undefined ? { fetchedAtUnixMs: source.fetchedAtUnixMs } : {}),
    ...(source.fromCache !== undefined ? { fromCache: source.fromCache } : {}),
    ...(source.truncated !== undefined ? { truncated: source.truncated } : {}),
  };
}
