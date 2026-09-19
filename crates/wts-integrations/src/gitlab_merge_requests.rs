use crate::{
    CommandProbe, CommandRunner, PathResolver, ProbeFailure, ProcessCommandRunner,
    SystemPathResolver,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use url::{Url, form_urlencoded};

const SCHEMA_VERSION: u8 = 1;
const GLAB_TIMEOUT: Duration = Duration::from_secs(10);
const GLAB_MAX_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_TRUSTED_REPOSITORIES: usize = 20;
const MAX_MERGE_REQUESTS: usize = 50;
const MAX_PER_REPOSITORY: usize = 20;
const MAX_TEXT_CHARS: usize = 512;
const MAX_REVIEW_COMMENT_CHARS: usize = 16_384;
const MAX_REVIEW_COMMITS: usize = 50;
const MAX_REVIEW_DISCUSSIONS: usize = 100;
const MAX_REVIEW_DISCUSSION_COMMENTS: usize = 200;
const DISCUSSIONS_PER_PAGE: usize = 50;
const MAX_SAVED_REVIEW_PATCHES: usize = 64;
const MAX_SAVED_REVIEW_CACHE_BYTES: u64 = 20 * 1024 * 1024;
const WORKSPACE_REVIEW_CACHE_TTL_MS: u64 = 30_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitlabCliState {
    Ready,
    Missing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitlabAccountState {
    SignedIn,
    SignedOut,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitlabAccountStatus {
    pub host: String,
    pub state: GitlabAccountState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitlabIntegrationStatus {
    pub schema_version: u8,
    pub cli_state: GitlabCliState,
    pub accounts: Vec<GitlabAccountStatus>,
    pub detail: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitlabMergeRequestInboxState {
    Fresh,
    Stale,
    Auth,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitlabMergeRequestDiagnosticCode {
    GlabMissing,
    AuthenticationRequired,
    ProviderTimedOut,
    ProviderOutputTooLarge,
    ProviderFailed,
    ProviderResponseInvalid,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitlabMergeRequestStatus {
    Open,
    Merged,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitlabReviewState {
    Requested,
    Approved,
    ChangesAfterApproval,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitlabMergeRequest {
    pub id: String,
    pub repository_id: String,
    pub project_path: String,
    pub web_url: String,
    pub iid: u64,
    pub title: String,
    pub author_username: String,
    pub source_branch: String,
    pub target_branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_head_commit_oid: Option<String>,
    pub updated_at: String,
    pub draft: bool,
    pub status: GitlabMergeRequestStatus,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitlabMergeRequestInbox {
    pub schema_version: u8,
    pub state: GitlabMergeRequestInboxState,
    pub merge_requests: Vec<GitlabMergeRequest>,
    pub fetched_at_unix_ms: Option<u64>,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic_code: Option<GitlabMergeRequestDiagnosticCode>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitlabReview {
    pub id: String,
    pub repository_id: String,
    pub repository: String,
    pub number: u64,
    pub title: String,
    pub author_login: String,
    pub source_branch: String,
    pub target_branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_commit_oid: Option<String>,
    pub updated_at: String,
    pub draft: bool,
    pub review_state: GitlabReviewState,
    pub status: GitlabMergeRequestStatus,
    pub comment_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discussions_resolved: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitlabReviewInbox {
    pub schema_version: u8,
    pub state: GitlabMergeRequestInboxState,
    pub reviews: Vec<GitlabReview>,
    pub fetched_at_unix_ms: Option<u64>,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic_code: Option<GitlabMergeRequestDiagnosticCode>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitlabReviewPatch {
    pub schema_version: u8,
    pub repository_id: String,
    pub iid: u64,
    pub base_commit_oid: String,
    pub start_commit_oid: String,
    pub head_commit_oid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_commit_oid: Option<String>,
    pub commits: Vec<GitlabReviewCommit>,
    #[serde(default)]
    pub discussions: Vec<GitlabReviewDiscussion>,
    pub patch: String,
    pub patch_truncated: bool,
    pub from_cache: bool,
    pub fetched_at_unix_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitlabReviewDiscussion {
    pub id: String,
    #[serde(default)]
    pub resolvable: bool,
    pub resolved: bool,
    #[serde(default)]
    pub automated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    pub comments: Vec<GitlabReviewDiscussionComment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<GitlabReviewDiscussionPosition>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitlabReviewDiscussionPosition {
    pub base_commit_oid: String,
    pub start_commit_oid: String,
    pub head_commit_oid: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitlabReviewDiscussionComment {
    pub id: u64,
    pub body: String,
    pub author_login: String,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitlabDiscussions {
    pub schema_version: u8,
    pub repository_id: String,
    pub iid: u64,
    pub scope_id: String,
    pub viewer_login: String,
    pub discussions: Vec<GitlabReviewDiscussion>,
    pub fetched_at_unix_ms: u64,
    pub from_cache: bool,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplyGitlabDiscussionResult {
    pub schema_version: u8,
    pub repository_id: String,
    pub iid: u64,
    pub discussion_id: String,
    pub comment: GitlabReviewDiscussionComment,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitlabReviewCommit {
    pub oid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_oid: Option<String>,
    pub short_id: String,
    pub title: String,
    pub author_name: String,
    pub authored_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitlabReviewCommentRequest {
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_position: Option<GitlabReviewDiscussionPosition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishGitlabReviewCommentResult {
    pub schema_version: u8,
    pub repository_id: String,
    pub iid: u64,
    pub accepted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct GitlabReviewTrustedRepository {
    repository_id: String,
    host: String,
    project_path: String,
}

impl GitlabReviewTrustedRepository {
    pub fn from_catalog(repository_id: &str, origin: &str) -> Option<Self> {
        if repository_id.is_empty()
            || repository_id.len() > 160
            || repository_id.trim() != repository_id
            || repository_id.contains(['\0', '\n', '\r', '\t'])
        {
            return None;
        }
        let (host, path) = origin_parts(origin)?;
        Some(Self {
            repository_id: repository_id.to_owned(),
            host: validated_gitlab_host(&host)?,
            project_path: validated_project_path(&path)?,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct GitlabTrustedRepository {
    repository_id: String,
    host: String,
    project_path: String,
    source_branch: String,
    head_commit_oid: String,
}

impl GitlabTrustedRepository {
    pub fn from_origin(
        repository_id: &str,
        origin: &str,
        source_branch: &str,
        head_commit_oid: &str,
    ) -> Option<Self> {
        if repository_id.is_empty()
            || repository_id.len() > 160
            || repository_id.trim() != repository_id
            || repository_id.contains(['\0', '\n', '\r', '\t'])
        {
            return None;
        }
        let (host, path) = origin_parts(origin)?;
        Some(Self {
            repository_id: repository_id.to_owned(),
            host: validated_gitlab_host(&host)?,
            project_path: validated_project_path(&path)?,
            source_branch: validated_branch(source_branch)?.to_owned(),
            head_commit_oid: validated_oid(head_commit_oid)?.to_ascii_lowercase(),
        })
    }

    pub fn repository_id(&self) -> &str {
        &self.repository_id
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn project_path(&self) -> &str {
        &self.project_path
    }

    pub fn source_branch(&self) -> &str {
        &self.source_branch
    }

    pub fn head_commit_oid(&self) -> &str {
        &self.head_commit_oid
    }
}

#[derive(Clone, Debug)]
struct CacheEntry {
    fetched_at_unix_ms: u64,
    merge_requests: Vec<GitlabMergeRequest>,
}

#[derive(Clone, Debug)]
struct ReviewCacheEntry {
    fetched_at_unix_ms: u64,
    reviews: Vec<GitlabReview>,
}

#[derive(Clone, Debug)]
struct ReviewOpenTarget {
    origin: String,
}

struct DiscussionContext {
    executable: PathBuf,
    host: String,
    project_path: String,
    user: GitlabCurrentUser,
}

impl DiscussionContext {
    fn endpoint(&self, iid: u64) -> String {
        let project =
            form_urlencoded::byte_serialize(self.project_path.as_bytes()).collect::<String>();
        format!("/projects/{project}/merge_requests/{iid}")
    }

    fn scope_id(&self, iid: u64) -> String {
        let identity = serde_json::to_vec(&(&self.host, &self.project_path, iid, self.user.id))
            .expect("primitive identity serialization");
        format!("{:x}", Sha256::digest(identity))
    }
}

type ReviewTargetKey = (String, u64);
type ReviewPatchKey = (String, u64, Option<String>);

#[derive(Default)]
struct DiscussionCache {
    generation: u64,
    entries: BTreeMap<(String, String), GitlabDiscussions>,
}

pub struct GitlabMergeRequestsAdapter<R = ProcessCommandRunner, P = SystemPathResolver> {
    runner: R,
    resolver: P,
    cache: Arc<Mutex<BTreeMap<String, CacheEntry>>>,
    review_cache: Arc<Mutex<BTreeMap<String, ReviewCacheEntry>>>,
    review_targets: Arc<Mutex<BTreeMap<ReviewTargetKey, ReviewOpenTarget>>>,
    review_patches: Arc<Mutex<BTreeMap<ReviewPatchKey, GitlabReviewPatch>>>,
    workspace_review_patches: Arc<Mutex<BTreeMap<String, GitlabReviewPatch>>>,
    discussions: Arc<Mutex<DiscussionCache>>,
    review_patch_cache_file: Option<PathBuf>,
}

impl Default for GitlabMergeRequestsAdapter<ProcessCommandRunner, SystemPathResolver> {
    fn default() -> Self {
        Self::new(
            ProcessCommandRunner::new(GLAB_TIMEOUT, GLAB_MAX_OUTPUT_BYTES),
            SystemPathResolver,
        )
    }
}

impl GitlabMergeRequestsAdapter<ProcessCommandRunner, SystemPathResolver> {
    pub fn with_review_patch_cache(cache_file: PathBuf) -> Self {
        Self::new_with_review_patch_cache(
            ProcessCommandRunner::new(GLAB_TIMEOUT, GLAB_MAX_OUTPUT_BYTES),
            SystemPathResolver,
            Some(cache_file),
        )
    }
}

impl<R, P> GitlabMergeRequestsAdapter<R, P>
where
    R: CommandRunner,
    P: PathResolver,
{
    pub fn new(runner: R, resolver: P) -> Self {
        Self::new_with_review_patch_cache(runner, resolver, None)
    }

    fn new_with_review_patch_cache(
        runner: R,
        resolver: P,
        review_patch_cache_file: Option<PathBuf>,
    ) -> Self {
        let review_patches = review_patch_cache_file
            .as_deref()
            .map(load_saved_review_patches)
            .unwrap_or_default();
        Self {
            runner,
            resolver,
            cache: Arc::new(Mutex::new(BTreeMap::new())),
            review_cache: Arc::new(Mutex::new(BTreeMap::new())),
            review_targets: Arc::new(Mutex::new(BTreeMap::new())),
            review_patches: Arc::new(Mutex::new(review_patches)),
            workspace_review_patches: Arc::new(Mutex::new(BTreeMap::new())),
            discussions: Arc::new(Mutex::new(DiscussionCache::default())),
            review_patch_cache_file,
        }
    }

    pub fn integration_status(
        &self,
        repositories: &[GitlabTrustedRepository],
    ) -> GitlabIntegrationStatus {
        let hosts = repositories
            .iter()
            .take(MAX_TRUSTED_REPOSITORIES)
            .map(|repository| repository.host.clone())
            .collect::<BTreeSet<_>>();
        let executable = match self.resolver.resolve("glab") {
            Ok(Some(path)) => path,
            _ => {
                return GitlabIntegrationStatus {
                    schema_version: SCHEMA_VERSION,
                    cli_state: GitlabCliState::Missing,
                    accounts: hosts
                        .into_iter()
                        .map(|host| GitlabAccountStatus {
                            host,
                            state: GitlabAccountState::SignedOut,
                            username: None,
                        })
                        .collect(),
                    detail: "Install and configure GitLab CLI in Terminal.".to_owned(),
                };
            }
        };
        let accounts = hosts
            .into_iter()
            .map(|host| match self.current_user(&executable, &host) {
                Ok(username) => GitlabAccountStatus {
                    host,
                    state: GitlabAccountState::SignedIn,
                    username: Some(username),
                },
                Err(Failure::Auth) => GitlabAccountStatus {
                    host,
                    state: GitlabAccountState::SignedOut,
                    username: None,
                },
                Err(_) => GitlabAccountStatus {
                    host,
                    state: GitlabAccountState::Error,
                    username: None,
                },
            })
            .collect::<Vec<_>>();
        let detail = if accounts.is_empty() {
            "Add a managed GitLab repository to check GitLab CLI."
        } else if accounts
            .iter()
            .all(|account| account.state == GitlabAccountState::SignedIn)
        {
            "GitLab CLI is ready."
        } else {
            "Configure GitLab CLI for each repository host in Terminal."
        };
        GitlabIntegrationStatus {
            schema_version: SCHEMA_VERSION,
            cli_state: GitlabCliState::Ready,
            accounts,
            detail: detail.to_owned(),
        }
    }

    pub fn list(&self, repositories: &[GitlabTrustedRepository]) -> GitlabMergeRequestInbox {
        let repositories = repositories
            .iter()
            .take(MAX_TRUSTED_REPOSITORIES)
            .cloned()
            .collect::<BTreeSet<_>>();
        if repositories.is_empty() {
            return inbox(
                GitlabMergeRequestInboxState::Fresh,
                Vec::new(),
                Some(now_ms()),
                None,
                "No managed GitLab repositories are available.",
            );
        }
        let executable = match self.resolver.resolve("glab") {
            Ok(Some(path)) => path,
            _ => return self.failure(&repositories, Failure::Missing),
        };
        let mut identities = BTreeMap::new();
        for host in repositories
            .iter()
            .map(|repository| repository.host.clone())
            .collect::<BTreeSet<_>>()
        {
            match self.current_user(&executable, &host) {
                Ok(username) => {
                    identities.insert(host, username);
                }
                Err(error) => return self.failure(&repositories, error),
            }
        }
        let mut found = Vec::new();
        for repository in &repositories {
            let Some(username) = identities.get(repository.host()) else {
                return self.failure(&repositories, Failure::Invalid);
            };
            match self.query_repository(&executable, repository, username) {
                Ok(mut merge_requests) => found.append(&mut merge_requests),
                Err(error) => return self.failure(&repositories, error),
            }
        }
        found.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.repository_id.cmp(&right.repository_id))
                .then_with(|| left.iid.cmp(&right.iid))
        });
        found.truncate(MAX_MERGE_REQUESTS);
        let fetched_at = now_ms();
        if let Ok(mut cache) = self.cache.lock() {
            for repository in &repositories {
                cache.insert(
                    cache_key(repository),
                    CacheEntry {
                        fetched_at_unix_ms: fetched_at,
                        merge_requests: found
                            .iter()
                            .filter(|merge_request| {
                                merge_request.repository_id == repository.repository_id
                            })
                            .cloned()
                            .collect(),
                    },
                );
            }
        }
        inbox(
            GitlabMergeRequestInboxState::Fresh,
            found,
            Some(fetched_at),
            None,
            "GitLab returned the current authored merge requests.",
        )
    }

    /// Re-fetch one authored, open merge request from the exact trusted project.
    ///
    /// This does not use the inbox cache. Publication callers use it as an
    /// authorization boundary immediately before they update the source branch.
    pub fn authored_open_merge_request(
        &self,
        repository: &GitlabTrustedRepository,
        iid: u64,
    ) -> Result<GitlabMergeRequest, String> {
        if iid == 0 || iid > i64::MAX as u64 {
            return Err("reviewNotFound".to_owned());
        }
        let executable = self
            .resolver
            .resolve("glab")
            .ok()
            .flatten()
            .ok_or("glabMissing")?;
        let username = self
            .current_user(&executable, repository.host())
            .map_err(|_| "providerFailed")?;
        let endpoint = publication_merge_request_endpoint(repository, iid);
        let output = self
            .runner
            .run(CommandProbe {
                executable: &executable,
                args: &["api", "--hostname", repository.host(), &endpoint],
            })
            .map_err(|_| "providerFailed")?;
        let node: MergeRequestNode =
            serde_json::from_slice(output.stdout()).map_err(|_| "providerResponseInvalid")?;
        if node.iid != iid
            || node.source_project_id.is_none()
            || node.source_project_id != node.target_project_id
        {
            return Err("reviewNotFound".to_owned());
        }
        let merge_request = validated_merge_request(node, repository, &username)
            .ok_or_else(|| "reviewNotFound".to_owned())?;
        if merge_request.status != GitlabMergeRequestStatus::Open
            || merge_request.source_head_commit_oid.is_none()
        {
            return Err("reviewNotFound".to_owned());
        }
        Ok(merge_request)
    }

    pub fn list_reviews(
        &self,
        repositories: &[GitlabReviewTrustedRepository],
    ) -> GitlabReviewInbox {
        let repositories = repositories
            .iter()
            .take(MAX_TRUSTED_REPOSITORIES)
            .cloned()
            .collect::<BTreeSet<_>>();
        if repositories.is_empty() {
            return review_inbox(
                GitlabMergeRequestInboxState::Fresh,
                Vec::new(),
                Some(now_ms()),
                None,
                "No linked GitLab repositories are available.",
            );
        }
        let executable = match self.resolver.resolve("glab") {
            Ok(Some(path)) => path,
            _ => return self.review_failure(&repositories, Failure::Missing),
        };
        let hosts = repositories
            .iter()
            .map(|repository| repository.host.clone())
            .collect::<BTreeSet<_>>();
        let mut found = Vec::new();
        let mut targets = BTreeMap::new();
        for host in &hosts {
            let user = match self.current_user_identity(&executable, host) {
                Ok(user) => user,
                Err(error) => return self.review_failure(&repositories, error),
            };
            match self.query_reviews(&executable, host, &user, &repositories) {
                Ok((mut reviews, host_targets)) => {
                    found.append(&mut reviews);
                    targets.extend(host_targets);
                }
                Err(error) => return self.review_failure(&repositories, error),
            }
        }
        found.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.repository.cmp(&right.repository))
                .then_with(|| left.number.cmp(&right.number))
        });
        found.truncate(MAX_MERGE_REQUESTS);
        let fetched_at = now_ms();
        if let Ok(mut cache) = self.review_cache.lock() {
            for host in &hosts {
                cache.insert(
                    review_cache_key(host),
                    ReviewCacheEntry {
                        fetched_at_unix_ms: fetched_at,
                        reviews: found
                            .iter()
                            .filter(|review| {
                                targets
                                    .get(&(review.repository_id.clone(), review.number))
                                    .is_some_and(|target| {
                                        target.origin.starts_with(&format!("https://{host}/"))
                                    })
                                    || repositories.iter().any(|repository| {
                                        repository.host == *host
                                            && repository
                                                .project_path
                                                .eq_ignore_ascii_case(&review.repository)
                                    })
                            })
                            .cloned()
                            .collect(),
                    },
                );
            }
        }
        if let Ok(mut open_targets) = self.review_targets.lock() {
            *open_targets = targets;
        }
        if let Ok(mut patches) = self.review_patches.lock() {
            patches.clear();
        }
        review_inbox(
            GitlabMergeRequestInboxState::Fresh,
            found,
            Some(fetched_at),
            None,
            "GitLab returned current review requests and approved merge requests.",
        )
    }

    fn query_reviews(
        &self,
        executable: &PathBuf,
        host: &str,
        user: &GitlabCurrentUser,
        repositories: &BTreeSet<GitlabReviewTrustedRepository>,
    ) -> Result<
        (
            Vec<GitlabReview>,
            BTreeMap<ReviewTargetKey, ReviewOpenTarget>,
        ),
        Failure,
    > {
        let endpoint = review_endpoint(&user.username, None);
        let output = self
            .runner
            .run(CommandProbe {
                executable,
                args: &["api", "--hostname", host, &endpoint],
            })
            .map_err(provider_failure)?;
        let nodes: Vec<MergeRequestNode> =
            serde_json::from_slice(output.stdout()).map_err(|_| Failure::Invalid)?;
        let approved_endpoint = review_endpoint(&user.username, Some(user.id));
        let approved_output = self
            .runner
            .run(CommandProbe {
                executable,
                args: &["api", "--hostname", host, &approved_endpoint],
            })
            .map_err(provider_failure)?;
        let approved_ids =
            serde_json::from_slice::<Vec<MergeRequestNode>>(approved_output.stdout())
                .map_err(|_| Failure::Invalid)?
                .into_iter()
                .map(|node| node.id)
                .collect::<BTreeSet<_>>();
        let mut reviews = Vec::new();
        let mut targets = BTreeMap::new();
        let mut continuity_checks = 0usize;
        for node in nodes.into_iter().take(MAX_MERGE_REQUESTS) {
            let review_state = if approved_ids.contains(&node.id) {
                GitlabReviewState::Approved
            } else {
                GitlabReviewState::Requested
            };
            if let Some((mut review, target)) =
                validated_review(node, host, repositories, &user.username, review_state)
            {
                if review.review_state == GitlabReviewState::Approved
                    && review.status == GitlabMergeRequestStatus::Open
                    && review.head_commit_oid.is_some()
                    && continuity_checks < 10
                {
                    continuity_checks += 1;
                    if self
                        .changes_after_approval(
                            executable,
                            host,
                            &review.repository,
                            review.number,
                            &user.username,
                        )
                        .unwrap_or(false)
                    {
                        review.review_state = GitlabReviewState::ChangesAfterApproval;
                    }
                }
                if let Some(target) = target {
                    targets.insert((review.repository_id.clone(), review.number), target);
                }
                reviews.push(review);
            }
        }
        Ok((reviews, targets))
    }

    fn changes_after_approval(
        &self,
        executable: &PathBuf,
        host: &str,
        project_path: &str,
        iid: u64,
        username: &str,
    ) -> Result<bool, Failure> {
        let project = form_urlencoded::byte_serialize(project_path.as_bytes()).collect::<String>();
        let endpoint = format!(
            "/projects/{project}/merge_requests/{iid}/notes?system=true&per_page=100&sort=desc&order_by=created_at"
        );
        let output = self
            .runner
            .run(CommandProbe {
                executable,
                args: &["api", "--hostname", host, &endpoint],
            })
            .map_err(provider_failure)?;
        let notes: Vec<ReviewSystemNote> =
            serde_json::from_slice(output.stdout()).map_err(|_| Failure::Invalid)?;
        for note in notes {
            if !note.system {
                continue;
            }
            if note.body == "approved this merge request"
                && note.author.username.eq_ignore_ascii_case(username)
            {
                return Ok(false);
            }
            let body = note.body.to_ascii_lowercase();
            if ((body.starts_with("added ") || body.starts_with("pushed "))
                && body.contains(" commit"))
                || body.contains("force-pushed")
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn cached_review_origin(&self, review_id: &str, iid: u64) -> Option<String> {
        self.review_targets
            .lock()
            .ok()?
            .get(&(review_id.to_owned(), iid))
            .map(|target| target.origin.clone())
    }

    pub fn remember_review_repository(
        &self,
        repository: &GitlabReviewTrustedRepository,
        iid: u64,
    ) -> Result<(), String> {
        if iid == 0 || iid > i64::MAX as u64 {
            return Err("reviewNotFound".to_owned());
        }
        self.review_targets
            .lock()
            .map_err(|_| "cacheUnavailable")?
            .insert(
                (repository.repository_id.clone(), iid),
                ReviewOpenTarget {
                    origin: format!(
                        "https://{}/{}.git",
                        repository.host, repository.project_path
                    ),
                },
            );
        Ok(())
    }

    pub fn review_patch(
        &self,
        repository_id: &str,
        iid: u64,
        commit_oid: Option<&str>,
        refresh: bool,
    ) -> Result<GitlabReviewPatch, String> {
        let (host, project_path) = self.review_target_parts(repository_id, iid)?;
        self.fetch_review_patch(
            repository_id,
            iid,
            &host,
            &project_path,
            commit_oid,
            refresh,
        )
    }

    /// Fetch an MR patch from a catalog-owned GitLab origin when the review is
    /// no longer present in the current user's pending-review inbox.
    pub fn review_patch_for_origin(
        &self,
        repository_id: &str,
        iid: u64,
        origin: &str,
        commit_oid: Option<&str>,
        refresh: bool,
    ) -> Result<GitlabReviewPatch, String> {
        let (host, project_path) = origin_parts(origin).ok_or("reviewNotFound")?;
        let host = validated_gitlab_host(&host).ok_or("reviewNotFound")?;
        let project_path = validated_project_path(&project_path).ok_or("reviewNotFound")?;
        if let Ok(mut targets) = self.review_targets.lock() {
            targets.insert(
                (repository_id.to_owned(), iid),
                ReviewOpenTarget {
                    origin: origin.to_owned(),
                },
            );
        }
        self.fetch_review_patch(
            repository_id,
            iid,
            &host,
            &project_path,
            commit_oid,
            refresh,
        )
    }

    fn fetch_review_patch(
        &self,
        repository_id: &str,
        iid: u64,
        host: &str,
        project_path: &str,
        commit_oid: Option<&str>,
        refresh: bool,
    ) -> Result<GitlabReviewPatch, String> {
        let selected_commit_oid = commit_oid
            .map(|value| validated_oid(value).ok_or("invalidCommit"))
            .transpose()?
            .map(str::to_ascii_lowercase);
        let key = (repository_id.to_owned(), iid, selected_commit_oid.clone());
        let cached_patch = self
            .review_patches
            .lock()
            .ok()
            .and_then(|patches| patches.get(&key).cloned());
        if !refresh && let Some(patch) = cached_patch.clone() {
            return Ok(patch);
        }
        let fetched = (|| -> Result<GitlabReviewPatch, String> {
            let executable = self
                .resolver
                .resolve("glab")
                .ok()
                .flatten()
                .ok_or("glabMissing")?;
            let project =
                form_urlencoded::byte_serialize(project_path.as_bytes()).collect::<String>();
            let commits_endpoint = format!(
                "/projects/{project}/merge_requests/{iid}/commits?per_page={MAX_REVIEW_COMMITS}"
            );
            let commits_output = self
                .runner
                .run(CommandProbe {
                    executable: &executable,
                    args: &["api", "--hostname", host, &commits_endpoint],
                })
                .map_err(|_| "providerFailed")?;
            let commits = validated_review_commits(
                serde_json::from_slice::<Vec<ReviewCommitNode>>(commits_output.stdout())
                    .map_err(|_| "providerResponseInvalid")?,
            );
            if let Some(selected) = selected_commit_oid.as_deref()
                && !commits.iter().any(|commit| commit.oid == selected)
            {
                return Err("invalidCommit".to_owned());
            }
            let endpoint = if let Some(selected) = selected_commit_oid.as_deref() {
                format!("/projects/{project}/repository/commits/{selected}/diff")
            } else {
                format!("/projects/{project}/merge_requests/{iid}/changes")
            };
            let output = self
                .runner
                .run(CommandProbe {
                    executable: &executable,
                    args: &["api", "--hostname", host, &endpoint],
                })
                .map_err(|_| "providerFailed")?;
            let discussions_endpoint = format!(
                "/projects/{project}/merge_requests/{iid}/discussions?per_page={MAX_REVIEW_DISCUSSIONS}"
            );
            let discussions = self
                .runner
                .run(CommandProbe {
                    executable: &executable,
                    args: &["api", "--hostname", host, &discussions_endpoint],
                })
                .ok()
                .and_then(|output| {
                    serde_json::from_slice::<Vec<ReviewDiscussionNode>>(output.stdout()).ok()
                })
                .map(validated_review_discussions)
                .or_else(|| cached_patch.as_ref().map(|patch| patch.discussions.clone()))
                .unwrap_or_default();
            let (base, start, head, changes) =
                if let Some(selected) = selected_commit_oid.as_deref() {
                    let changes = serde_json::from_slice::<Vec<ReviewChange>>(output.stdout())
                        .map_err(|_| "providerResponseInvalid")?;
                    let commit = commits
                        .iter()
                        .find(|commit| commit.oid == selected)
                        .ok_or("invalidCommit")?;
                    (
                        commit.parent_oid.as_deref().unwrap_or(selected).to_owned(),
                        commit.parent_oid.as_deref().unwrap_or(selected).to_owned(),
                        selected.to_owned(),
                        changes,
                    )
                } else {
                    let response: ReviewChangesResponse = serde_json::from_slice(output.stdout())
                        .map_err(|_| "providerResponseInvalid")?;
                    (
                        response.diff_refs.base_sha,
                        response.diff_refs.start_sha,
                        response.diff_refs.head_sha,
                        response.changes,
                    )
                };
            let base = validated_oid(&base).ok_or("providerResponseInvalid")?;
            let start = validated_oid(&start).ok_or("providerResponseInvalid")?;
            let head = validated_oid(&head).ok_or("providerResponseInvalid")?;
            let (patch, truncated) = review_changes_patch(changes)?;
            Ok(GitlabReviewPatch {
                schema_version: SCHEMA_VERSION,
                repository_id: repository_id.to_owned(),
                iid,
                base_commit_oid: base.to_ascii_lowercase(),
                start_commit_oid: start.to_ascii_lowercase(),
                head_commit_oid: head.to_ascii_lowercase(),
                selected_commit_oid,
                commits,
                discussions,
                patch,
                patch_truncated: truncated,
                from_cache: false,
                fetched_at_unix_ms: now_ms(),
            })
        })();
        let result = match fetched {
            Ok(result) => result,
            Err(_) if cached_patch.is_some() => {
                let mut cached = cached_patch.expect("cached patch checked");
                cached.from_cache = true;
                return Ok(cached);
            }
            Err(error) => return Err(error),
        };
        if let Ok(mut patches) = self.review_patches.lock() {
            patches.insert(key, result.clone());
            if let Some(path) = self.review_patch_cache_file.as_deref() {
                let _ = save_review_patches(path, &patches);
            }
        }
        Ok(result)
    }

    pub fn publish_review_comment(
        &self,
        repository_id: &str,
        iid: u64,
        request: GitlabReviewCommentRequest,
    ) -> Result<PublishGitlabReviewCommentResult, String> {
        let (host, project_path) = self.review_target_parts(repository_id, iid)?;
        self.publish_review_comment_to_target(
            repository_id,
            iid,
            &host,
            &project_path,
            request,
            None,
        )
    }

    pub fn publish_workspace_review_comment(
        &self,
        repository: &GitlabTrustedRepository,
        iid: u64,
        plan_base_branch: Option<&str>,
        request: GitlabReviewCommentRequest,
    ) -> Result<PublishGitlabReviewCommentResult, String> {
        let patch = self.workspace_review_patch(repository, iid, plan_base_branch, true)?;
        if patch.from_cache {
            return Err("providerFailed".to_owned());
        }
        self.publish_review_comment_to_target(
            repository.repository_id(),
            iid,
            repository.host(),
            repository.project_path(),
            request,
            Some(patch),
        )
    }

    fn publish_review_comment_to_target(
        &self,
        repository_id: &str,
        iid: u64,
        host: &str,
        project_path: &str,
        request: GitlabReviewCommentRequest,
        verified_patch: Option<GitlabReviewPatch>,
    ) -> Result<PublishGitlabReviewCommentResult, String> {
        if request.workspace_id.is_some() {
            return Err("invalidComment".to_owned());
        }
        if request.expected_position.as_ref().is_some_and(|position| {
            [
                &position.base_commit_oid,
                &position.start_commit_oid,
                &position.head_commit_oid,
            ]
            .iter()
            .any(|oid| validated_oid(oid).is_none())
        }) {
            return Err("invalidComment".to_owned());
        }
        let body = request.body.trim();
        if body.is_empty() || body.chars().count() > MAX_REVIEW_COMMENT_CHARS {
            return Err("invalidComment".to_owned());
        }
        let executable = self
            .resolver
            .resolve("glab")
            .ok()
            .flatten()
            .ok_or("glabMissing")?;
        let project = form_urlencoded::byte_serialize(project_path.as_bytes()).collect::<String>();
        match (request.file_path, request.side, request.line) {
            (Some(path), Some(side), Some(line)) => {
                let path = validated_file_path(&path).ok_or("invalidComment")?;
                // GitLab binds inline discussions to the current diff refs. The cached
                // patch can still be shown offline, but it must not authorize a write.
                let patch = match verified_patch {
                    Some(patch) => patch,
                    None => {
                        self.fetch_review_patch(repository_id, iid, host, project_path, None, true)?
                    }
                };
                if patch.from_cache {
                    return Err("providerFailed".to_owned());
                }
                if request.expected_position.as_ref().is_some_and(|position| {
                    !position
                        .base_commit_oid
                        .eq_ignore_ascii_case(&patch.base_commit_oid)
                        || !position
                            .start_commit_oid
                            .eq_ignore_ascii_case(&patch.start_commit_oid)
                        || !position
                            .head_commit_oid
                            .eq_ignore_ascii_case(&patch.head_commit_oid)
                }) {
                    return Err("reviewPositionChanged".to_owned());
                }
                let endpoint = format!("/projects/{project}/merge_requests/{iid}/discussions");
                let body_field = format!("body={body}");
                let mut position = serde_json::json!({
                    "position_type": "text",
                    "base_sha": patch.base_commit_oid,
                    "start_sha": patch.start_commit_oid,
                    "head_sha": patch.head_commit_oid,
                    "old_path": path,
                    "new_path": path,
                });
                match side.as_str() {
                    "additions" => position["new_line"] = serde_json::json!(line),
                    "deletions" => position["old_line"] = serde_json::json!(line),
                    _ => return Err("invalidComment".to_owned()),
                }
                // glab --field sends JSON. GitLab therefore needs one nested
                // position object, not literal bracketed field names.
                let position_field = format!("position={position}");
                self.runner
                    .run(CommandProbe {
                        executable: &executable,
                        args: &[
                            "api",
                            "--hostname",
                            host,
                            "--method",
                            "POST",
                            &endpoint,
                            "--raw-field",
                            &body_field,
                            "--field",
                            &position_field,
                        ],
                    })
                    .map_err(|_| "providerFailed")?;
            }
            (None, None, None) => {
                if request.expected_position.is_some() {
                    return Err("invalidComment".to_owned());
                }
                let endpoint = format!("/projects/{project}/merge_requests/{iid}/notes");
                let body_field = format!("body={body}");
                self.runner
                    .run(CommandProbe {
                        executable: &executable,
                        args: &[
                            "api",
                            "--hostname",
                            host,
                            "--method",
                            "POST",
                            &endpoint,
                            "--raw-field",
                            &body_field,
                        ],
                    })
                    .map_err(|_| "providerFailed")?;
            }
            _ => return Err("invalidComment".to_owned()),
        }
        Ok(PublishGitlabReviewCommentResult {
            schema_version: SCHEMA_VERSION,
            repository_id: repository_id.to_owned(),
            iid,
            accepted: true,
        })
    }

    pub fn get_discussions(
        &self,
        repository_id: &str,
        iid: u64,
        workspace_repository: Option<&GitlabTrustedRepository>,
    ) -> Result<GitlabDiscussions, String> {
        let context = self.discussion_context(repository_id, iid, workspace_repository)?;
        let scope_id = context.scope_id(iid);
        let key = (scope_id.clone(), repository_id.to_owned());
        let generation = self
            .discussions
            .lock()
            .map_err(|_| "cacheUnavailable")?
            .generation;
        let fetched = self
            .fetch_discussions(&context, iid)
            .map(|(discussions, truncated)| GitlabDiscussions {
                schema_version: SCHEMA_VERSION,
                repository_id: repository_id.to_owned(),
                iid,
                scope_id,
                viewer_login: context.user.username.clone(),
                discussions,
                fetched_at_unix_ms: now_ms(),
                from_cache: false,
                truncated,
            });
        match fetched {
            Ok(result) => {
                if let Ok(mut cache) = self.discussions.lock() {
                    if cache.generation != generation {
                        return Ok(result);
                    }
                    cache.entries.insert(key, result.clone());
                    while cache.entries.len() > MAX_SAVED_REVIEW_PATCHES {
                        let oldest = cache
                            .entries
                            .iter()
                            .min_by_key(|(_, value)| value.fetched_at_unix_ms)
                            .map(|(key, _)| key.clone());
                        if let Some(oldest) = oldest {
                            cache.entries.remove(&oldest);
                        }
                    }
                }
                Ok(result)
            }
            Err(error) => {
                if let Some(mut cached) = self
                    .discussions
                    .lock()
                    .ok()
                    .and_then(|cache| cache.entries.get(&key).cloned())
                {
                    cached.from_cache = true;
                    cached.viewer_login = context.user.username;
                    return Ok(cached);
                }
                Err(error)
            }
        }
    }

    /// Read a thread from the exact project and branch verified for a workspace comparison.
    pub fn workspace_comparison_discussions(
        &self,
        repository: &GitlabTrustedRepository,
        iid: u64,
        plan_base_branch: Option<&str>,
    ) -> Result<GitlabDiscussions, String> {
        let patch = self.workspace_review_patch(repository, iid, plan_base_branch, true)?;
        if patch.from_cache {
            return Err("providerFailed".to_owned());
        }
        let executable = self
            .resolver
            .resolve("glab")
            .ok()
            .flatten()
            .ok_or("glabMissing")?;
        let user = self
            .current_user_identity(&executable, repository.host())
            .map_err(|_| "providerFailed")?;
        let context = DiscussionContext {
            executable,
            host: repository.host().to_owned(),
            project_path: repository.project_path().to_owned(),
            user,
        };
        let (discussions, truncated) = self.fetch_discussions(&context, iid)?;
        Ok(GitlabDiscussions {
            schema_version: SCHEMA_VERSION,
            repository_id: repository.repository_id().to_owned(),
            iid,
            scope_id: context.scope_id(iid),
            viewer_login: context.user.username,
            discussions,
            fetched_at_unix_ms: now_ms(),
            from_cache: false,
            truncated,
        })
    }

    pub fn workspace_review_patch(
        &self,
        repository: &GitlabTrustedRepository,
        iid: u64,
        plan_base_branch: Option<&str>,
        refresh: bool,
    ) -> Result<GitlabReviewPatch, String> {
        if iid == 0 || iid > i64::MAX as u64 {
            return Err("reviewNotFound".to_owned());
        }
        let key = serde_json::to_string(&(
            repository.repository_id(),
            repository.host(),
            repository.project_path(),
            repository.source_branch(),
            plan_base_branch,
            iid,
        ))
        .map_err(|_| "reviewNotFound")?;
        let cached = self
            .workspace_review_patches
            .lock()
            .ok()
            .and_then(|cache| cache.get(&key).cloned());
        if !refresh
            && let Some(cached) = cached.clone()
            && now_ms().saturating_sub(cached.fetched_at_unix_ms) < WORKSPACE_REVIEW_CACHE_TTL_MS
        {
            return Ok(cached);
        }
        let fetched = (|| -> Result<GitlabReviewPatch, String> {
            let executable = self
                .resolver
                .resolve("glab")
                .ok()
                .flatten()
                .ok_or("glabMissing")?;
            let user = self
                .current_user_identity(&executable, repository.host())
                .map_err(|_| "providerFailed")?;
            let context = DiscussionContext {
                executable,
                host: repository.host().to_owned(),
                project_path: repository.project_path().to_owned(),
                user,
            };
            let endpoint = format!("{}/changes", context.endpoint(iid));
            let output = self
                .runner
                .run(CommandProbe {
                    executable: &context.executable,
                    args: &["api", "--hostname", &context.host, &endpoint],
                })
                .map_err(|_| "providerFailed")?;
            let metadata: MergeRequestNode =
                serde_json::from_slice(output.stdout()).map_err(|_| "providerResponseInvalid")?;
            if metadata.iid != iid {
                return Err("reviewNotFound".to_owned());
            }
            let expected_repository = if metadata.source_branch == repository.source_branch() {
                repository.clone()
            } else if plan_base_branch == Some(metadata.source_branch.as_str()) {
                GitlabTrustedRepository::from_origin(
                    repository.repository_id(),
                    &format!(
                        "https://{}/{}.git",
                        repository.host(),
                        repository.project_path()
                    ),
                    &metadata.source_branch,
                    repository.head_commit_oid(),
                )
                .ok_or("reviewNotFound")?
            } else {
                return Err("reviewNotFound".to_owned());
            };
            let author = metadata.author.username.clone();
            let metadata = validated_merge_request(metadata, &expected_repository, &author)
                .ok_or("reviewNotFound")?;
            let response: ReviewChangesResponse =
                serde_json::from_slice(output.stdout()).map_err(|_| "providerResponseInvalid")?;
            let base = validated_oid(&response.diff_refs.base_sha)
                .ok_or("providerResponseInvalid")?
                .to_ascii_lowercase();
            let start = validated_oid(&response.diff_refs.start_sha)
                .ok_or("providerResponseInvalid")?
                .to_ascii_lowercase();
            let head = validated_oid(&response.diff_refs.head_sha)
                .ok_or("providerResponseInvalid")?
                .to_ascii_lowercase();
            if metadata
                .source_head_commit_oid
                .is_some_and(|oid| oid != head)
            {
                return Err("providerResponseInvalid".to_owned());
            }
            let (patch, truncated) = review_changes_patch(response.changes)?;
            Ok(GitlabReviewPatch {
                schema_version: SCHEMA_VERSION,
                repository_id: repository.repository_id().to_owned(),
                iid,
                base_commit_oid: base,
                start_commit_oid: start,
                head_commit_oid: head,
                selected_commit_oid: None,
                commits: Vec::new(),
                discussions: Vec::new(),
                patch,
                patch_truncated: truncated || response.overflow,
                from_cache: false,
                fetched_at_unix_ms: now_ms(),
            })
        })();
        match fetched {
            Ok(result) => {
                if let Ok(mut cache) = self.workspace_review_patches.lock() {
                    cache.insert(key, result.clone());
                    while cache.len() > MAX_SAVED_REVIEW_PATCHES {
                        if let Some(oldest) = cache
                            .iter()
                            .min_by_key(|(_, patch)| patch.fetched_at_unix_ms)
                            .map(|(key, _)| key.clone())
                        {
                            cache.remove(&oldest);
                        }
                    }
                }
                Ok(result)
            }
            Err(error)
                if matches!(error.as_str(), "providerFailed" | "glabMissing")
                    && cached.is_some() =>
            {
                let mut cached = cached.expect("cache checked");
                cached.from_cache = true;
                Ok(cached)
            }
            Err(error) => Err(error),
        }
    }

    pub fn reply_discussion(
        &self,
        repository_id: &str,
        iid: u64,
        workspace_repository: Option<&GitlabTrustedRepository>,
        discussion_id: &str,
        body: &str,
    ) -> Result<ReplyGitlabDiscussionResult, String> {
        if body.contains('\r') {
            return Err("invalidComment".to_owned());
        }
        let body = body.trim();
        if !valid_discussion_id(discussion_id)
            || body.is_empty()
            || body.chars().count() > MAX_REVIEW_COMMENT_CHARS
            || body.contains('\0')
        {
            return Err("invalidComment".to_owned());
        }
        let context = self.discussion_context(repository_id, iid, workspace_repository)?;
        let endpoint = format!("{}/discussions/{discussion_id}", context.endpoint(iid));
        let output = self
            .runner
            .run(CommandProbe {
                executable: &context.executable,
                args: &["api", "--hostname", &context.host, &endpoint],
            })
            .map_err(|_| "providerFailed")?;
        let thread: ReviewDiscussionNode =
            serde_json::from_slice(output.stdout()).map_err(|_| "providerResponseInvalid")?;
        if thread.id != discussion_id || thread.notes.iter().all(|note| note.system) {
            return Err("discussionNotFound".to_owned());
        }
        let endpoint = format!("{endpoint}/notes");
        let body_field = format!("body={body}");
        let output = self.runner.run(CommandProbe {
            executable: &context.executable,
            args: &[
                "api",
                "--hostname",
                &context.host,
                &endpoint,
                "--method",
                "POST",
                "--raw-field",
                &body_field,
            ],
        });
        if let Ok(mut cache) = self.discussions.lock() {
            let scope = context.scope_id(iid);
            cache.generation = cache.generation.wrapping_add(1);
            cache
                .entries
                .retain(|(cached_scope, _), _| cached_scope != &scope);
        }
        let output = output.map_err(|_| "providerFailed")?;
        let note: ReviewDiscussionNoteNode =
            serde_json::from_slice(output.stdout()).map_err(|_| "providerResponseInvalid")?;
        let comment = validated_discussion_comment(note).ok_or("providerResponseInvalid")?;
        if !comment
            .author_login
            .eq_ignore_ascii_case(&context.user.username)
        {
            return Err("providerResponseInvalid".to_owned());
        }
        Ok(ReplyGitlabDiscussionResult {
            schema_version: SCHEMA_VERSION,
            repository_id: repository_id.to_owned(),
            iid,
            discussion_id: discussion_id.to_owned(),
            comment,
        })
    }

    fn discussion_context(
        &self,
        repository_id: &str,
        iid: u64,
        workspace_repository: Option<&GitlabTrustedRepository>,
    ) -> Result<DiscussionContext, String> {
        if iid == 0 || iid > i64::MAX as u64 {
            return Err("reviewNotFound".to_owned());
        }
        let (host, project_path) = match workspace_repository {
            Some(repository) if repository.repository_id() == repository_id => {
                (repository.host.clone(), repository.project_path.clone())
            }
            Some(_) => return Err("reviewNotFound".to_owned()),
            None => {
                let (host, project_path) = self.review_target_parts(repository_id, iid)?;
                (
                    validated_gitlab_host(&host).ok_or("reviewNotFound")?,
                    validated_project_path(&project_path).ok_or("reviewNotFound")?,
                )
            }
        };
        let executable = self
            .resolver
            .resolve("glab")
            .ok()
            .flatten()
            .ok_or("glabMissing")?;
        let user = self
            .current_user_identity(&executable, &host)
            .map_err(|_| "providerFailed")?;
        let context = DiscussionContext {
            executable,
            host,
            project_path,
            user,
        };
        if let Some(repository) = workspace_repository {
            let endpoint = context.endpoint(iid);
            let output = self
                .runner
                .run(CommandProbe {
                    executable: &context.executable,
                    args: &["api", "--hostname", &context.host, &endpoint],
                })
                .map_err(|_| "providerFailed")?;
            let node: MergeRequestNode =
                serde_json::from_slice(output.stdout()).map_err(|_| "providerResponseInvalid")?;
            if node.iid != iid
                || validated_merge_request(node, repository, &context.user.username).is_none()
            {
                return Err("reviewNotFound".to_owned());
            }
        }
        Ok(context)
    }

    fn fetch_discussions(
        &self,
        context: &DiscussionContext,
        iid: u64,
    ) -> Result<(Vec<GitlabReviewDiscussion>, bool), String> {
        let mut nodes = Vec::new();
        let mut truncated = false;
        for page in 1..=MAX_REVIEW_DISCUSSIONS / DISCUSSIONS_PER_PAGE {
            let endpoint = format!(
                "{}/discussions?per_page={DISCUSSIONS_PER_PAGE}&page={page}",
                context.endpoint(iid)
            );
            let output = self
                .runner
                .run(CommandProbe {
                    executable: &context.executable,
                    args: &["api", "--hostname", &context.host, &endpoint],
                })
                .map_err(|_| "providerFailed")?;
            let batch: Vec<ReviewDiscussionNode> =
                serde_json::from_slice(output.stdout()).map_err(|_| "providerResponseInvalid")?;
            if batch.len() > DISCUSSIONS_PER_PAGE
                || batch.iter().any(|node| !valid_discussion_id(&node.id))
            {
                return Err("providerResponseInvalid".to_owned());
            }
            let complete = batch.len() < DISCUSSIONS_PER_PAGE;
            nodes.extend(batch);
            if complete {
                break;
            }
            if nodes.len() >= MAX_REVIEW_DISCUSSIONS {
                truncated = true;
            }
        }
        let note_count = nodes
            .iter()
            .flat_map(|node| &node.notes)
            .filter(|note| !note.system)
            .count();
        let discussions = validated_review_discussions(nodes);
        truncated |= note_count
            > discussions
                .iter()
                .map(|discussion| discussion.comments.len())
                .sum::<usize>();
        Ok((discussions, truncated))
    }

    pub fn publish_review_comment_for_origin(
        &self,
        repository_id: &str,
        iid: u64,
        origin: &str,
        request: GitlabReviewCommentRequest,
    ) -> Result<PublishGitlabReviewCommentResult, String> {
        let (host, project_path) = origin_parts(origin).ok_or("reviewNotFound")?;
        let host = validated_gitlab_host(&host).ok_or("reviewNotFound")?;
        let project_path = validated_project_path(&project_path).ok_or("reviewNotFound")?;
        if let Ok(mut targets) = self.review_targets.lock() {
            targets.insert(
                (repository_id.to_owned(), iid),
                ReviewOpenTarget {
                    origin: format!("https://{host}/{project_path}.git"),
                },
            );
        }
        self.publish_review_comment(repository_id, iid, request)
    }

    fn review_target_parts(
        &self,
        repository_id: &str,
        iid: u64,
    ) -> Result<(String, String), String> {
        let origin = self
            .cached_review_origin(repository_id, iid)
            .ok_or("reviewNotFound")?;
        let (host, project) = origin_parts(&origin).ok_or("reviewNotFound")?;
        Ok((
            validated_gitlab_host(&host).ok_or("reviewNotFound")?,
            validated_project_path(&project).ok_or("reviewNotFound")?,
        ))
    }

    fn review_failure(
        &self,
        repositories: &BTreeSet<GitlabReviewTrustedRepository>,
        error: Failure,
    ) -> GitlabReviewInbox {
        let mut cached = Vec::new();
        let mut fetched_at = None;
        let mut complete_cache = true;
        if let Ok(cache) = self.review_cache.lock() {
            for host in repositories
                .iter()
                .map(|repository| &repository.host)
                .collect::<BTreeSet<_>>()
            {
                if let Some(entry) = cache.get(&review_cache_key(host)) {
                    fetched_at =
                        Some(fetched_at.map_or(entry.fetched_at_unix_ms, |current: u64| {
                            current.min(entry.fetched_at_unix_ms)
                        }));
                    cached.extend(entry.reviews.clone());
                } else {
                    complete_cache = false;
                }
            }
        } else {
            complete_cache = false;
        }
        let (state, code, detail) = error.contract();
        if complete_cache && fetched_at.is_some() {
            cached.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
            cached.truncate(MAX_MERGE_REQUESTS);
            review_inbox(
                GitlabMergeRequestInboxState::Stale,
                cached,
                fetched_at,
                Some(code),
                "GitLab is unavailable. WTS shows the last verified review list.",
            )
        } else {
            review_inbox(state, Vec::new(), None, Some(code), detail)
        }
    }

    fn current_user(&self, executable: &PathBuf, host: &str) -> Result<String, Failure> {
        self.current_user_identity(executable, host)
            .map(|user| user.username)
    }

    fn current_user_identity(
        &self,
        executable: &PathBuf,
        host: &str,
    ) -> Result<GitlabCurrentUser, Failure> {
        let output = self
            .runner
            .run(CommandProbe {
                executable,
                args: &["api", "--hostname", host, "/user"],
            })
            .map_err(provider_failure)?;
        let user: GitlabCurrentUser =
            serde_json::from_slice(output.stdout()).map_err(|_| Failure::Invalid)?;
        if user.id == 0 || validated_username(&user.username).is_none() {
            return Err(Failure::Invalid);
        }
        Ok(user)
    }

    fn query_repository(
        &self,
        executable: &PathBuf,
        repository: &GitlabTrustedRepository,
        username: &str,
    ) -> Result<Vec<GitlabMergeRequest>, Failure> {
        let endpoint = merge_request_endpoint(repository, username);
        let output = self
            .runner
            .run(CommandProbe {
                executable,
                args: &["api", "--hostname", repository.host(), &endpoint],
            })
            .map_err(provider_failure)?;
        let nodes: Vec<MergeRequestNode> =
            serde_json::from_slice(output.stdout()).map_err(|_| Failure::Invalid)?;
        Ok(nodes
            .into_iter()
            .take(MAX_PER_REPOSITORY)
            .filter_map(|node| validated_merge_request(node, repository, username))
            .collect())
    }

    fn failure(
        &self,
        repositories: &BTreeSet<GitlabTrustedRepository>,
        error: Failure,
    ) -> GitlabMergeRequestInbox {
        let mut cached = Vec::new();
        let mut fetched_at = None;
        let mut complete_cache = true;
        if let Ok(cache) = self.cache.lock() {
            for repository in repositories {
                if let Some(entry) = cache.get(&cache_key(repository)) {
                    fetched_at =
                        Some(fetched_at.map_or(entry.fetched_at_unix_ms, |current: u64| {
                            current.min(entry.fetched_at_unix_ms)
                        }));
                    cached.extend(entry.merge_requests.clone());
                } else {
                    complete_cache = false;
                }
            }
        } else {
            complete_cache = false;
        }
        let (state, code, detail) = error.contract();
        if complete_cache && fetched_at.is_some() {
            cached.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
            cached.truncate(MAX_MERGE_REQUESTS);
            inbox(
                GitlabMergeRequestInboxState::Stale,
                cached,
                fetched_at,
                Some(code),
                "GitLab is unavailable. WTS shows the last verified merge request status.",
            )
        } else {
            inbox(state, Vec::new(), None, Some(code), detail)
        }
    }
}

#[derive(Clone, Copy)]
enum Failure {
    Missing,
    Auth,
    Provider(ProbeFailure),
    Invalid,
}

fn provider_failure(error: ProbeFailure) -> Failure {
    match error {
        ProbeFailure::UnsuccessfulExit => Failure::Auth,
        other => Failure::Provider(other),
    }
}

impl Failure {
    fn contract(
        self,
    ) -> (
        GitlabMergeRequestInboxState,
        GitlabMergeRequestDiagnosticCode,
        &'static str,
    ) {
        match self {
            Self::Missing => (
                GitlabMergeRequestInboxState::Auth,
                GitlabMergeRequestDiagnosticCode::GlabMissing,
                "Install and configure GitLab CLI in Terminal to check merge requests.",
            ),
            Self::Auth => (
                GitlabMergeRequestInboxState::Auth,
                GitlabMergeRequestDiagnosticCode::AuthenticationRequired,
                "Configure GitLab CLI in Terminal to check merge requests.",
            ),
            Self::Provider(ProbeFailure::TimedOut) => (
                GitlabMergeRequestInboxState::Error,
                GitlabMergeRequestDiagnosticCode::ProviderTimedOut,
                "GitLab did not answer before the timeout.",
            ),
            Self::Provider(ProbeFailure::OutputUnavailable) => (
                GitlabMergeRequestInboxState::Error,
                GitlabMergeRequestDiagnosticCode::ProviderOutputTooLarge,
                "The GitLab response exceeded the local safety limit.",
            ),
            Self::Provider(_) => (
                GitlabMergeRequestInboxState::Error,
                GitlabMergeRequestDiagnosticCode::ProviderFailed,
                "GitLab could not check merge requests.",
            ),
            Self::Invalid => (
                GitlabMergeRequestInboxState::Error,
                GitlabMergeRequestDiagnosticCode::ProviderResponseInvalid,
                "GitLab returned an invalid merge request response.",
            ),
        }
    }
}

fn inbox(
    state: GitlabMergeRequestInboxState,
    merge_requests: Vec<GitlabMergeRequest>,
    fetched_at_unix_ms: Option<u64>,
    diagnostic_code: Option<GitlabMergeRequestDiagnosticCode>,
    detail: &str,
) -> GitlabMergeRequestInbox {
    GitlabMergeRequestInbox {
        schema_version: SCHEMA_VERSION,
        state,
        merge_requests,
        fetched_at_unix_ms,
        detail: detail.to_owned(),
        diagnostic_code,
    }
}

fn review_inbox(
    state: GitlabMergeRequestInboxState,
    reviews: Vec<GitlabReview>,
    fetched_at_unix_ms: Option<u64>,
    diagnostic_code: Option<GitlabMergeRequestDiagnosticCode>,
    detail: &str,
) -> GitlabReviewInbox {
    GitlabReviewInbox {
        schema_version: SCHEMA_VERSION,
        state,
        reviews,
        fetched_at_unix_ms,
        detail: detail.to_owned(),
        diagnostic_code,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn merge_request_endpoint(repository: &GitlabTrustedRepository, username: &str) -> String {
    let project =
        form_urlencoded::byte_serialize(repository.project_path().as_bytes()).collect::<String>();
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("state", "all")
        .append_pair("source_branch", repository.source_branch())
        .append_pair("author_username", username)
        .append_pair("order_by", "updated_at")
        .append_pair("sort", "desc")
        .append_pair("per_page", &MAX_PER_REPOSITORY.to_string())
        .finish();
    format!("/projects/{project}/merge_requests?{query}")
}

fn publication_merge_request_endpoint(repository: &GitlabTrustedRepository, iid: u64) -> String {
    let project =
        form_urlencoded::byte_serialize(repository.project_path().as_bytes()).collect::<String>();
    format!("/projects/{project}/merge_requests/{iid}")
}

fn review_endpoint(username: &str, approved_by_id: Option<u64>) -> String {
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    serializer
        .append_pair("state", "all")
        .append_pair("reviewer_username", username);
    if let Some(approved_by_id) = approved_by_id {
        serializer.append_pair("approved_by_ids[]", &approved_by_id.to_string());
    }
    let query = serializer
        .append_pair("scope", "all")
        .append_pair("order_by", "updated_at")
        .append_pair("sort", "desc")
        .append_pair("per_page", &MAX_MERGE_REQUESTS.to_string())
        .finish();
    format!("/merge_requests?{query}")
}

fn validated_merge_request(
    node: MergeRequestNode,
    repository: &GitlabTrustedRepository,
    username: &str,
) -> Option<GitlabMergeRequest> {
    let status = match node.state.as_str() {
        "opened" => GitlabMergeRequestStatus::Open,
        "merged" => GitlabMergeRequestStatus::Merged,
        "closed" => GitlabMergeRequestStatus::Closed,
        _ => return None,
    };
    if node.id == 0
        || node.iid == 0
        || node.iid > i64::MAX as u64
        || node.source_branch != repository.source_branch
        || !node.author.username.eq_ignore_ascii_case(username)
    {
        return None;
    }
    validate_merge_request_url(&node.web_url, repository, node.iid)?;
    Some(GitlabMergeRequest {
        id: node.id.to_string(),
        repository_id: repository.repository_id.clone(),
        project_path: repository.project_path.clone(),
        web_url: node.web_url,
        iid: node.iid,
        title: bounded_text(node.title, 256)?,
        author_username: validated_username(&node.author.username)?.to_owned(),
        source_branch: repository.source_branch.clone(),
        target_branch: validated_branch(&node.target_branch)?.to_owned(),
        source_head_commit_oid: node
            .sha
            .as_deref()
            .and_then(validated_oid)
            .map(|oid| oid.to_ascii_lowercase()),
        updated_at: bounded_text(node.updated_at, MAX_TEXT_CHARS)?,
        draft: node.draft,
        status,
    })
}

fn validated_review(
    node: MergeRequestNode,
    host: &str,
    repositories: &BTreeSet<GitlabReviewTrustedRepository>,
    username: &str,
    review_state: GitlabReviewState,
) -> Option<(GitlabReview, Option<ReviewOpenTarget>)> {
    let status = match node.state.as_str() {
        "opened" => GitlabMergeRequestStatus::Open,
        "merged" if review_state == GitlabReviewState::Approved => GitlabMergeRequestStatus::Merged,
        "closed" if review_state == GitlabReviewState::Approved => GitlabMergeRequestStatus::Closed,
        _ => return None,
    };
    if node.id == 0
        || node.iid == 0
        || node.iid > i64::MAX as u64
        || !node
            .reviewers
            .iter()
            .any(|reviewer| reviewer.username.eq_ignore_ascii_case(username))
    {
        return None;
    }
    let project_path = review_project_path(&node.web_url, host, node.iid)?;
    let catalog_repository_id = repositories
        .iter()
        .find(|repository| {
            repository.host == host && repository.project_path.eq_ignore_ascii_case(&project_path)
        })
        .map(|repository| repository.repository_id.clone());
    let repository_id = catalog_repository_id
        .clone()
        .unwrap_or_else(|| format!("gitlab-review-{}", node.id));
    let target = Some(ReviewOpenTarget {
        origin: format!("https://{host}/{project_path}.git"),
    });
    Some((
        GitlabReview {
            id: node.id.to_string(),
            repository_id,
            repository: project_path,
            number: node.iid,
            title: bounded_text(node.title, 256)?,
            author_login: validated_username(&node.author.username)?.to_owned(),
            source_branch: validated_branch(&node.source_branch)?.to_owned(),
            target_branch: validated_branch(&node.target_branch)?.to_owned(),
            head_commit_oid: node
                .sha
                .as_deref()
                .and_then(validated_oid)
                .map(|oid| oid.to_ascii_lowercase()),
            updated_at: bounded_text(node.updated_at, MAX_TEXT_CHARS)?,
            draft: node.draft,
            review_state,
            status,
            comment_count: node.user_notes_count.min(10_000),
            discussions_resolved: node.blocking_discussions_resolved,
        },
        target,
    ))
}

fn validate_merge_request_url(
    candidate: &str,
    repository: &GitlabTrustedRepository,
    iid: u64,
) -> Option<()> {
    let url = Url::parse(candidate).ok()?;
    let expected_path = format!("/{}/-/merge_requests/{iid}", repository.project_path());
    (url.scheme() == "https"
        && url.host_str() == Some(repository.host())
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path() == expected_path)
        .then_some(())
}

fn review_project_path(candidate: &str, host: &str, iid: u64) -> Option<String> {
    let url = Url::parse(candidate).ok()?;
    let suffix = format!("/-/merge_requests/{iid}");
    if !(url.scheme() == "https"
        && url.host_str() == Some(host)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().ends_with(&suffix))
    {
        return None;
    }
    let project_path = url.path().strip_prefix('/')?.strip_suffix(&suffix)?;
    validated_project_path(project_path)
}

fn cache_key(repository: &GitlabTrustedRepository) -> String {
    format!(
        "{}/{}/{}",
        repository.host,
        repository.project_path.to_ascii_lowercase(),
        repository.source_branch
    )
}

fn review_cache_key(host: &str) -> String {
    host.to_ascii_lowercase()
}

fn origin_parts(origin: &str) -> Option<(String, String)> {
    if origin.is_empty()
        || origin.trim() != origin
        || origin.contains(['\0', '\n', '\r', '\t', '?', '#'])
    {
        return None;
    }
    if origin.starts_with("https://") || origin.starts_with("ssh://") {
        let url = Url::parse(origin).ok()?;
        let username_is_valid = if url.scheme() == "https" {
            url.username().is_empty()
        } else {
            url.username().is_empty() || url.username() == "git"
        };
        if url.query().is_some()
            || url.fragment().is_some()
            || !username_is_valid
            || url.password().is_some()
            || url.port().is_some()
        {
            return None;
        }
        return Some((
            url.host_str()?.to_owned(),
            url.path().trim_start_matches('/').to_owned(),
        ));
    }
    let (authority, path) = origin.split_once(':')?;
    let (username, host) = authority
        .rsplit_once('@')
        .map_or((None, authority), |(username, host)| (Some(username), host));
    if username.is_some_and(|username| username != "git") || host.contains(':') {
        return None;
    }
    Some((host.to_owned(), path.to_owned()))
}

fn validated_gitlab_host(host: &str) -> Option<String> {
    if host.is_empty() || host.len() > 253 || !host.is_ascii() {
        return None;
    }
    let host = host.to_ascii_lowercase();
    let labels = host.split('.').collect::<Vec<_>>();
    let first = *labels.first()?;
    if labels.len() < 2
        || (host != "gitlab.com" && first != "gitlab")
        || labels.iter().any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return None;
    }
    Some(host)
}

fn validated_project_path(path: &str) -> Option<String> {
    let path = path
        .trim_end_matches('/')
        .strip_suffix(".git")
        .unwrap_or(path.trim_end_matches('/'));
    let segments = path.split('/').collect::<Vec<_>>();
    if segments.len() < 2
        || segments.iter().any(|segment| {
            segment.is_empty()
                || segment.len() > 255
                || matches!(*segment, "." | "..")
                || !segment.is_ascii()
                || !segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
    {
        return None;
    }
    Some(segments.join("/"))
}

fn validated_branch(value: &str) -> Option<&str> {
    (!value.is_empty()
        && value.len() <= 255
        && value.trim() == value
        && !value.starts_with(['/', '-'])
        && !value.ends_with(['/', '.'])
        && !value.contains("..")
        && !value.contains("@{")
        && !value.contains("//")
        && !value.bytes().any(|byte| {
            byte.is_ascii_control()
                || matches!(byte, b' ' | b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
        }))
    .then_some(value)
}

fn validated_oid(value: &str) -> Option<&str> {
    ((value.len() == 40 || value.len() == 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(value)
}

fn validated_username(value: &str) -> Option<&str> {
    (!value.is_empty()
        && value.len() <= 255
        && value.trim() == value
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')))
    .then_some(value)
}

fn bounded_text(value: String, limit: usize) -> Option<String> {
    (!value.is_empty() && value.chars().count() <= limit && !value.contains(['\0', '\r']))
        .then_some(value)
}

fn validated_file_path(value: &str) -> Option<&str> {
    (!value.is_empty()
        && value.len() <= 4096
        && value.trim() == value
        && !value.starts_with('/')
        && !value.contains(['\0', '\n', '\r', '\\'])
        && !value.split('/').any(|part| part.is_empty() || part == ".."))
    .then_some(value)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedReviewPatchCache {
    schema_version: u8,
    entries: Vec<GitlabReviewPatch>,
}

fn saved_review_patch_key(patch: &GitlabReviewPatch) -> ReviewPatchKey {
    (
        patch.repository_id.clone(),
        patch.iid,
        patch.selected_commit_oid.clone(),
    )
}

fn valid_saved_review_patch(patch: &GitlabReviewPatch) -> bool {
    patch.schema_version == SCHEMA_VERSION
        && patch.repository_id.len() <= MAX_TEXT_CHARS
        && patch.iid > 0
        && validated_oid(&patch.base_commit_oid).is_some()
        && validated_oid(&patch.start_commit_oid).is_some()
        && validated_oid(&patch.head_commit_oid).is_some()
        && patch.patch.len() <= GLAB_MAX_OUTPUT_BYTES
        && patch.commits.len() <= MAX_REVIEW_COMMITS
        && patch.discussions.len() <= MAX_REVIEW_DISCUSSIONS
        && patch
            .discussions
            .iter()
            .map(|discussion| discussion.comments.len())
            .sum::<usize>()
            <= MAX_REVIEW_DISCUSSION_COMMENTS
        && patch.commits.iter().all(|commit| {
            validated_oid(&commit.oid).is_some()
                && commit
                    .parent_oid
                    .as_deref()
                    .is_none_or(|oid| validated_oid(oid).is_some())
                && commit.title.chars().count() <= MAX_TEXT_CHARS
                && commit.author_name.chars().count() <= MAX_TEXT_CHARS
        })
        && patch.discussions.iter().all(|discussion| {
            !discussion.id.is_empty()
                && discussion.id.len() <= 128
                && discussion
                    .file_path
                    .as_deref()
                    .is_none_or(|path| validated_file_path(path).is_some())
                && discussion
                    .side
                    .as_deref()
                    .is_none_or(|side| matches!(side, "additions" | "deletions"))
                && discussion.comments.iter().all(|comment| {
                    comment.id > 0
                        && comment.body.chars().count() <= MAX_REVIEW_COMMENT_CHARS
                        && validated_username(&comment.author_login).is_some()
                        && comment.created_at.chars().count() <= MAX_TEXT_CHARS
                })
        })
}

fn load_saved_review_patches(path: &Path) -> BTreeMap<ReviewPatchKey, GitlabReviewPatch> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return BTreeMap::new();
    };
    if !metadata.file_type().is_file() || metadata.len() > MAX_SAVED_REVIEW_CACHE_BYTES {
        return BTreeMap::new();
    }
    let Ok(bytes) = fs::read(path) else {
        return BTreeMap::new();
    };
    let Ok(saved) = serde_json::from_slice::<SavedReviewPatchCache>(&bytes) else {
        return BTreeMap::new();
    };
    if saved.schema_version != SCHEMA_VERSION || saved.entries.len() > MAX_SAVED_REVIEW_PATCHES {
        return BTreeMap::new();
    }
    saved
        .entries
        .into_iter()
        .filter(valid_saved_review_patch)
        .map(|mut patch| {
            patch.from_cache = true;
            (saved_review_patch_key(&patch), patch)
        })
        .collect()
}

fn save_review_patches(
    path: &Path,
    patches: &BTreeMap<ReviewPatchKey, GitlabReviewPatch>,
) -> Result<(), ()> {
    let parent = path.parent().ok_or(())?;
    fs::create_dir_all(parent).map_err(|_| ())?;
    if path
        .symlink_metadata()
        .is_ok_and(|metadata| !metadata.file_type().is_file())
    {
        return Err(());
    }
    let entries = patches
        .values()
        .rev()
        .take(MAX_SAVED_REVIEW_PATCHES)
        .cloned()
        .collect::<Vec<_>>();
    let bytes = serde_json::to_vec(&SavedReviewPatchCache {
        schema_version: SCHEMA_VERSION,
        entries,
    })
    .map_err(|_| ())?;
    if bytes.len() as u64 > MAX_SAVED_REVIEW_CACHE_BYTES {
        return Err(());
    }
    let temporary = path.with_extension("json.tmp");
    if temporary.symlink_metadata().is_ok() {
        fs::remove_file(&temporary).map_err(|_| ())?;
    }
    fs::write(&temporary, bytes).map_err(|_| ())?;
    fs::rename(temporary, path).map_err(|_| ())
}

fn validated_review_commits(nodes: Vec<ReviewCommitNode>) -> Vec<GitlabReviewCommit> {
    nodes
        .into_iter()
        .take(MAX_REVIEW_COMMITS)
        .filter_map(|node| {
            let oid = validated_oid(&node.id)?.to_ascii_lowercase();
            let parent_oid = node
                .parent_ids
                .first()
                .and_then(|value| validated_oid(value))
                .map(str::to_ascii_lowercase);
            Some(GitlabReviewCommit {
                short_id: oid.chars().take(8).collect(),
                oid,
                parent_oid,
                title: bounded_text(node.title, MAX_TEXT_CHARS)?,
                author_name: bounded_text(node.author_name, MAX_TEXT_CHARS)?,
                authored_at: bounded_text(node.authored_date, MAX_TEXT_CHARS)?,
            })
        })
        .collect()
}

fn valid_discussion_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn validated_discussion_comment(
    note: ReviewDiscussionNoteNode,
) -> Option<GitlabReviewDiscussionComment> {
    if note.id == 0 || note.system {
        return None;
    }
    Some(GitlabReviewDiscussionComment {
        id: note.id,
        body: bounded_text(note.body, MAX_REVIEW_COMMENT_CHARS)?,
        author_login: validated_username(&note.author.username)?.to_owned(),
        created_at: bounded_text(note.created_at, MAX_TEXT_CHARS)?,
    })
}

fn validated_review_discussions(nodes: Vec<ReviewDiscussionNode>) -> Vec<GitlabReviewDiscussion> {
    let mut comment_count = 0usize;
    nodes
        .into_iter()
        .take(MAX_REVIEW_DISCUSSIONS)
        .filter_map(|node| {
            if node.id.is_empty() || node.id.len() > 128 || node.id.contains(['\0', '\n', '\r']) {
                return None;
            }
            let anchor = node.notes.iter().find_map(|note| note.position.as_ref());
            let position = anchor.and_then(|position| {
                Some(GitlabReviewDiscussionPosition {
                    base_commit_oid: validated_oid(position.base_sha.as_deref()?)?
                        .to_ascii_lowercase(),
                    start_commit_oid: validated_oid(position.start_sha.as_deref()?)?
                        .to_ascii_lowercase(),
                    head_commit_oid: validated_oid(position.head_sha.as_deref()?)?
                        .to_ascii_lowercase(),
                })
            });
            let (file_path, side, line) = anchor.map_or((None, None, None), |position| {
                if let Some(line) = position.new_line {
                    (
                        position
                            .new_path
                            .as_deref()
                            .and_then(validated_file_path)
                            .map(str::to_owned),
                        Some("additions".to_owned()),
                        Some(line),
                    )
                } else if let Some(line) = position.old_line {
                    (
                        position
                            .old_path
                            .as_deref()
                            .and_then(validated_file_path)
                            .map(str::to_owned),
                        Some("deletions".to_owned()),
                        Some(line),
                    )
                } else {
                    (None, None, None)
                }
            });
            let resolvable = node.notes.iter().any(|note| note.resolvable);
            let resolved = resolvable
                && node
                    .notes
                    .iter()
                    .filter(|note| note.resolvable)
                    .all(|note| note.resolved.unwrap_or(false));
            let comments = node
                .notes
                .into_iter()
                .filter(|note| !note.system)
                .filter_map(|note| {
                    if comment_count >= MAX_REVIEW_DISCUSSION_COMMENTS || note.id == 0 {
                        return None;
                    }
                    let body = bounded_text(note.body, MAX_REVIEW_COMMENT_CHARS)?;
                    let author_login = validated_username(&note.author.username)?.to_owned();
                    let created_at = bounded_text(note.created_at, MAX_TEXT_CHARS)?;
                    comment_count += 1;
                    Some(GitlabReviewDiscussionComment {
                        id: note.id,
                        body,
                        author_login,
                        created_at,
                    })
                })
                .collect::<Vec<_>>();
            let automated = comments
                .iter()
                .all(|comment| is_automated_username(&comment.author_login));
            (!comments.is_empty()).then_some(GitlabReviewDiscussion {
                id: node.id,
                resolvable,
                resolved,
                automated,
                file_path,
                side,
                line,
                comments,
                position,
            })
        })
        .collect()
}

fn is_automated_username(username: &str) -> bool {
    let username = username.to_ascii_lowercase();
    username == "bot" || username.ends_with("bot") || username.ends_with("-bot")
}

fn review_changes_patch(changes: Vec<ReviewChange>) -> Result<(String, bool), String> {
    let mut patch = String::new();
    let mut truncated = false;
    for change in changes.into_iter().take(500) {
        let old_path = validated_file_path(&change.old_path).ok_or("providerResponseInvalid")?;
        let new_path = validated_file_path(&change.new_path).ok_or("providerResponseInvalid")?;
        let section = format!(
            "diff --git a/{old_path} b/{new_path}\n--- a/{old_path}\n+++ b/{new_path}\n{}\n",
            change.diff.trim_end()
        );
        if patch.len().saturating_add(section.len()) > GLAB_MAX_OUTPUT_BYTES {
            truncated = true;
            break;
        }
        patch.push_str(&section);
    }
    Ok((patch, truncated))
}

#[derive(Deserialize)]
struct ReviewChangesResponse {
    diff_refs: ReviewDiffRefs,
    #[serde(default)]
    overflow: bool,
    #[serde(default)]
    changes: Vec<ReviewChange>,
}

#[derive(Deserialize)]
struct ReviewDiffRefs {
    base_sha: String,
    start_sha: String,
    head_sha: String,
}

#[derive(Deserialize)]
struct ReviewChange {
    old_path: String,
    new_path: String,
    diff: String,
}

#[derive(Deserialize)]
struct ReviewCommitNode {
    id: String,
    #[serde(default)]
    parent_ids: Vec<String>,
    title: String,
    author_name: String,
    authored_date: String,
}

#[derive(Deserialize)]
struct ReviewDiscussionNode {
    id: String,
    #[serde(default)]
    notes: Vec<ReviewDiscussionNoteNode>,
}

#[derive(Deserialize)]
struct ReviewDiscussionNoteNode {
    id: u64,
    body: String,
    author: GitlabUser,
    created_at: String,
    #[serde(default)]
    system: bool,
    #[serde(default)]
    resolvable: bool,
    #[serde(default)]
    resolved: Option<bool>,
    #[serde(default)]
    position: Option<ReviewDiscussionPositionNode>,
}

#[derive(Deserialize)]
struct ReviewDiscussionPositionNode {
    #[serde(default)]
    base_sha: Option<String>,
    #[serde(default)]
    start_sha: Option<String>,
    #[serde(default)]
    head_sha: Option<String>,
    #[serde(default)]
    old_path: Option<String>,
    #[serde(default)]
    new_path: Option<String>,
    #[serde(default)]
    old_line: Option<u32>,
    #[serde(default)]
    new_line: Option<u32>,
}

#[derive(Deserialize)]
struct GitlabUser {
    username: String,
}

#[derive(Deserialize)]
struct GitlabCurrentUser {
    id: u64,
    username: String,
}

#[derive(Deserialize)]
struct ReviewSystemNote {
    #[serde(default)]
    system: bool,
    body: String,
    author: GitlabUser,
}

#[derive(Deserialize)]
struct MergeRequestNode {
    id: u64,
    iid: u64,
    title: String,
    web_url: String,
    state: String,
    source_branch: String,
    #[serde(default)]
    source_project_id: Option<u64>,
    #[serde(default)]
    target_project_id: Option<u64>,
    #[serde(default)]
    sha: Option<String>,
    target_branch: String,
    author: GitlabUser,
    #[serde(default)]
    reviewers: Vec<GitlabUser>,
    updated_at: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    user_notes_count: u64,
    #[serde(default)]
    blocking_discussions_resolved: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProbeOutput;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[cfg(unix)]
    struct DiscussionProcessFixture {
        root: tempfile::TempDir,
        adapter: GitlabMergeRequestsAdapter<ProcessCommandRunner, DiscussionExecutable>,
    }

    #[cfg(unix)]
    struct DiscussionExecutable(PathBuf);

    #[cfg(unix)]
    impl PathResolver for DiscussionExecutable {
        fn resolve(&self, executable: &str) -> Result<Option<PathBuf>, ProbeFailure> {
            assert_eq!(executable, "glab");
            Ok(Some(self.0.clone()))
        }
    }

    #[cfg(unix)]
    impl DiscussionProcessFixture {
        fn new() -> Self {
            use std::os::unix::fs::PermissionsExt;
            let root = tempfile::tempdir().unwrap();
            let executable = root.path().join("glab");
            let quoted_root = root.path().to_string_lossy().replace('\'', "'\\''");
            fs::write(
                &executable,
                format!(
                    r#"#!/bin/sh
set -eu
fixture='{quoted_root}'
case "$4" in
  --method) test "$5" = POST; printf 'post\n' >> "$fixture/posts"; printf '%s\0' "$@" >> "$fixture/args"; printf '{{}}' ;;
  /user) cat "$fixture/user.json" ;;
  */discussions/*/notes)
    printf 'post\n' >> "$fixture/posts"
    printf '%s\0' "$@" >> "$fixture/args"
    test ! -f "$fixture/fail-post"
    cat "$fixture/reply.json" ;;
  */discussions\?*)
    printf '%s\n' "$4" >> "$fixture/reads"
    test ! -f "$fixture/fail-discussions"
    if test -f "$fixture/hold-discussions"; then
      cp "$fixture/page1.json" "$fixture/captured.json"
      touch "$fixture/read-started"
      while test ! -f "$fixture/release-read"; do sleep 0.01; done
      cat "$fixture/captured.json"
      exit 0
    fi
    case "$4" in
      *page=1) cat "$fixture/page1.json" ;;
      *page=2) cat "$fixture/page2.json" ;;
      *) exit 21 ;;
    esac ;;
  */discussions/*) cat "$fixture/thread.json" ;;
  */merge_requests/17/changes) test ! -f "$fixture/fail-comparison"; cat "$fixture/changes.json" ;;
  */merge_requests/17) cat "$fixture/mr.json" ;;
  *) exit 22 ;;
esac
"#
                ),
            )
            .unwrap();
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
            let fixture = Self {
                adapter: GitlabMergeRequestsAdapter::new(
                    ProcessCommandRunner::new(Duration::from_secs(10), 1024 * 1024),
                    DiscussionExecutable(executable),
                ),
                root,
            };
            fixture.write("user.json", serde_json::json!({"id":1,"username":"alice"}));
            fixture.write("mr.json", serde_json::json!({"id":77,"iid":17,"title":"Change","web_url":"https://gitlab.example.com/acme/api/-/merge_requests/17","state":"opened","source_branch":"feat/delivery","target_branch":"main","author":{"username":"alice"},"updated_at":"2026-09-17T00:00:00Z"}));
            let note = serde_json::json!({"id":91,"body":"Please explain.","author":{"username":"bob"},"created_at":"2026-09-17T00:00:00Z","system":false});
            let discussion = serde_json::json!({"id":"thread-1","notes":[note]});
            fixture.write("page1.json", serde_json::json!([discussion]));
            fixture.write("page2.json", serde_json::json!([]));
            fixture.write("thread.json", discussion);
            fixture.write("reply.json", serde_json::json!({"id":92,"body":"Reply with $literal\ntext","author":{"username":"alice"},"created_at":"2026-09-17T00:01:00Z","system":false}));
            fixture.adapter.review_targets.lock().unwrap().insert(
                ("repo_api".to_owned(), 17),
                ReviewOpenTarget {
                    origin: "https://gitlab.example.com/acme/api.git".to_owned(),
                },
            );
            fixture
        }

        fn write(&self, name: &str, value: serde_json::Value) {
            fs::write(
                self.root.path().join(name),
                serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn discussion_process_read_preserves_stale_time_and_isolates_accounts() {
        let fixture = DiscussionProcessFixture::new();
        let fresh = fixture
            .adapter
            .get_discussions("repo_api", 17, None)
            .unwrap();
        assert_eq!(fresh.discussions[0].comments[0].id, 91);
        assert!(!fresh.from_cache);
        assert_eq!(fresh.scope_id.len(), 64);
        let repository = GitlabTrustedRepository::from_origin(
            "repo_api",
            "https://gitlab.example.com/acme/api.git",
            "feat/delivery",
            &"a".repeat(40),
        )
        .unwrap();
        let workspace = fixture
            .adapter
            .get_discussions("repo_api", 17, Some(&repository))
            .unwrap();
        assert_eq!(workspace.scope_id, fresh.scope_id);
        let fresh = workspace;
        fs::write(fixture.root.path().join("fail-discussions"), "").unwrap();
        let stale = fixture
            .adapter
            .get_discussions("repo_api", 17, None)
            .unwrap();
        assert!(stale.from_cache);
        assert_eq!(stale.fetched_at_unix_ms, fresh.fetched_at_unix_ms);
        assert_eq!(stale.scope_id, fresh.scope_id);
        fixture.write(
            "user.json",
            serde_json::json!({"id":1,"username":"alice-renamed"}),
        );
        let renamed = fixture
            .adapter
            .get_discussions("repo_api", 17, None)
            .unwrap();
        assert_eq!(renamed.scope_id, fresh.scope_id);
        assert_eq!(renamed.viewer_login, "alice-renamed");
        fixture.write("user.json", serde_json::json!({"message":"unauthorized"}));
        assert!(
            fixture
                .adapter
                .get_discussions("repo_api", 17, None)
                .is_err()
        );
        fixture.write("user.json", serde_json::json!({"id":2,"username":"bob"}));
        assert!(
            fixture
                .adapter
                .get_discussions("repo_api", 17, None)
                .is_err()
        );
        fs::remove_file(fixture.root.path().join("fail-discussions")).unwrap();
        let other = fixture
            .adapter
            .get_discussions("repo_api", 17, None)
            .unwrap();
        assert_ne!(other.scope_id, fresh.scope_id);
        assert_eq!(other.viewer_login, "bob");
        fixture.adapter.review_targets.lock().unwrap().insert(
            ("repo_api".to_owned(), 17),
            ReviewOpenTarget {
                origin: "https://gitlab.other.example.com/acme/api.git".to_owned(),
            },
        );
        fs::write(fixture.root.path().join("fail-discussions"), "").unwrap();
        assert!(
            fixture
                .adapter
                .get_discussions("repo_api", 17, None)
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn discussion_process_reply_keeps_literal_body_and_writes_only_once() {
        let fixture = DiscussionProcessFixture::new();
        let result = fixture
            .adapter
            .reply_discussion(
                "repo_api",
                17,
                None,
                "thread-1",
                "Reply with $literal\ntext",
            )
            .unwrap();
        assert_eq!(result.comment.id, 92);
        assert_eq!(result.discussion_id, "thread-1");
        let args = fs::read(fixture.root.path().join("args")).unwrap();
        assert!(
            args.split(|byte| *byte == 0)
                .any(|arg| arg == b"body=Reply with $literal\ntext")
        );
        assert_eq!(
            fs::read_to_string(fixture.root.path().join("posts")).unwrap(),
            "post\n"
        );
        fs::write(fixture.root.path().join("fail-post"), "").unwrap();
        assert!(
            fixture
                .adapter
                .reply_discussion("repo_api", 17, None, "thread-1", "second")
                .is_err()
        );
        assert_eq!(
            fs::read_to_string(fixture.root.path().join("posts")).unwrap(),
            "post\npost\n"
        );
        fs::remove_file(fixture.root.path().join("fail-post")).unwrap();
        fixture.write(
            "reply.json",
            serde_json::json!({"message":"accepted without a note"}),
        );
        assert!(
            fixture
                .adapter
                .reply_discussion("repo_api", 17, None, "thread-1", "third")
                .is_err()
        );
        assert_eq!(
            fs::read_to_string(fixture.root.path().join("posts")).unwrap(),
            "post\npost\npost\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn discussion_process_caps_pages_and_reports_omitted_comments() {
        let fixture = DiscussionProcessFixture::new();
        let page = |start| {
            (start..start+50).map(|id| serde_json::json!({
            "id":format!("thread-{id}"),"notes":[{"id":id+1,"body":"Reply","author":{"username":"bob"},"created_at":"2026-09-17T00:00:00Z","system":false}]
        })).collect::<Vec<_>>()
        };
        fixture.write("page1.json", serde_json::json!(page(0)));
        fixture.write("page2.json", serde_json::json!(page(50)));
        let result = fixture
            .adapter
            .get_discussions("repo_api", 17, None)
            .unwrap();
        assert_eq!(result.discussions.len(), 100);
        assert!(result.truncated);
        let reads = fs::read_to_string(fixture.root.path().join("reads")).unwrap();
        assert_eq!(reads.lines().count(), 2);
        assert!(reads.contains("per_page=50&page=2"));

        let notes = (1..=201).map(|id| serde_json::json!({"id":id,"body":"Reply","author":{"username":"bob"},"created_at":"2026-09-17T00:00:00Z","system":false})).collect::<Vec<_>>();
        fixture.write(
            "page1.json",
            serde_json::json!([{"id":"thread-1","notes":notes}]),
        );
        let result = fixture
            .adapter
            .get_discussions("repo_api", 17, None)
            .unwrap();
        assert_eq!(result.discussions[0].comments.len(), 200);
        assert!(result.truncated);
    }

    #[cfg(unix)]
    #[test]
    fn discussion_process_reply_prevents_older_reads_from_restoring_cache() {
        let fixture = DiscussionProcessFixture::new();
        fs::write(fixture.root.path().join("hold-discussions"), "").unwrap();
        std::thread::scope(|scope| {
            let pending = scope.spawn(|| fixture.adapter.get_discussions("repo_api", 17, None));
            let started = std::time::Instant::now();
            while !fixture.root.path().join("read-started").exists() {
                assert!(started.elapsed() < Duration::from_secs(5));
                std::thread::sleep(Duration::from_millis(10));
            }
            fixture
                .adapter
                .reply_discussion("repo_api", 17, None, "thread-1", "reply")
                .unwrap();
            fs::write(fixture.root.path().join("release-read"), "").unwrap();
            pending.join().unwrap().unwrap();
        });
        fs::write(fixture.root.path().join("fail-discussions"), "").unwrap();
        assert!(
            fixture
                .adapter
                .get_discussions("repo_api", 17, None)
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn discussion_process_rejects_other_threads_and_workspace_branches_before_writes() {
        let fixture = DiscussionProcessFixture::new();
        assert!(
            fixture
                .adapter
                .reply_discussion("repo_api", 17, None, "other-thread", "reply")
                .is_err()
        );
        assert!(
            fixture
                .adapter
                .reply_discussion("repo_api", 17, None, "../thread-1", "reply")
                .is_err()
        );
        assert!(
            fixture
                .adapter
                .reply_discussion("repo_api", 17, None, "thread-1", " \n ")
                .is_err()
        );
        assert!(
            fixture
                .adapter
                .reply_discussion("repo_api", 17, None, "thread-1", "bad\rtext")
                .is_err()
        );
        let repository = GitlabTrustedRepository::from_origin(
            "repo_api",
            "https://gitlab.example.com/acme/api.git",
            "different-branch",
            &"a".repeat(40),
        )
        .unwrap();
        assert!(
            fixture
                .adapter
                .get_discussions("repo_api", 17, Some(&repository))
                .is_err()
        );
        assert!(
            fixture
                .adapter
                .reply_discussion("repo_api", 17, Some(&repository), "thread-1", "reply")
                .is_err()
        );
        assert!(!fixture.root.path().join("posts").exists());
    }

    #[cfg(unix)]
    #[test]
    fn comparison_process_uses_one_verified_snapshot_and_scopes_cached_fallback() {
        let fixture = DiscussionProcessFixture::new();
        let mut changes: serde_json::Value =
            serde_json::from_slice(&fs::read(fixture.root.path().join("mr.json")).unwrap())
                .unwrap();
        changes["sha"] = serde_json::json!("b".repeat(40));
        changes["diff_refs"] = serde_json::json!({"base_sha":"a".repeat(40),"start_sha":"a".repeat(40),"head_sha":"b".repeat(40)});
        changes["changes"] = serde_json::json!([{"old_path":"source.rs","new_path":"source.rs","diff":"@@ -1 +1 @@\n-base\n+published\n"}]);
        fixture.write("changes.json", changes.clone());
        let repository = GitlabTrustedRepository::from_origin(
            "repo_api",
            "https://gitlab.example.com/acme/api.git",
            "feat/delivery",
            &"c".repeat(40),
        )
        .unwrap();
        let fresh = fixture
            .adapter
            .workspace_review_patch(&repository, 17, None, true)
            .unwrap();
        assert_eq!(fresh.base_commit_oid, "a".repeat(40));
        assert_eq!(fresh.head_commit_oid, "b".repeat(40));
        assert!(fresh.patch.contains("+published"));
        assert!(!fresh.from_cache);
        let current = fixture
            .adapter
            .workspace_review_patch(&repository, 17, None, false)
            .unwrap();
        assert!(!current.from_cache);
        assert_eq!(current.fetched_at_unix_ms, fresh.fetched_at_unix_ms);
        for value in fixture
            .adapter
            .workspace_review_patches
            .lock()
            .unwrap()
            .values_mut()
        {
            value.fetched_at_unix_ms = 0;
        }
        changes["sha"] = serde_json::json!("d".repeat(40));
        changes["diff_refs"]["head_sha"] = serde_json::json!("d".repeat(40));
        fixture.write("changes.json", changes.clone());
        let fresh = fixture
            .adapter
            .workspace_review_patch(&repository, 17, None, false)
            .unwrap();
        assert_eq!(fresh.head_commit_oid, "d".repeat(40));
        changes["author"]["username"] = serde_json::json!("bob");
        fixture.write("changes.json", changes.clone());
        let reviewer_worktree = GitlabTrustedRepository::from_origin(
            "repo_api",
            "https://gitlab.example.com/acme/api.git",
            "wts/review",
            &"c".repeat(40),
        )
        .unwrap();
        assert!(
            fixture
                .adapter
                .workspace_review_patch(&reviewer_worktree, 17, None, true)
                .is_err()
        );
        assert!(
            fixture
                .adapter
                .workspace_review_patch(&reviewer_worktree, 17, Some("feat/delivery"), true)
                .is_ok()
        );
        fs::write(fixture.root.path().join("fail-comparison"), "").unwrap();
        let stale = fixture
            .adapter
            .workspace_review_patch(&repository, 17, None, true)
            .unwrap();
        assert!(stale.from_cache);
        assert_eq!(stale.fetched_at_unix_ms, fresh.fetched_at_unix_ms);
        let other = GitlabTrustedRepository::from_origin(
            "repo_api",
            "https://gitlab.example.com/other/api.git",
            "feat/delivery",
            &"c".repeat(40),
        )
        .unwrap();
        assert!(
            fixture
                .adapter
                .workspace_review_patch(&other, 17, None, true)
                .is_err()
        );
        fs::remove_file(fixture.root.path().join("fail-comparison")).unwrap();
        changes["source_branch"] = serde_json::json!("other-branch");
        fixture.write("changes.json", changes);
        assert!(
            fixture
                .adapter
                .workspace_review_patch(&repository, 17, None, true)
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn discussion_process_preserves_original_position_refs() {
        let fixture = DiscussionProcessFixture::new();
        let mut page = serde_json::json!([{"id":"thread-1","notes":[{"id":91,"body":"Explain this.","author":{"username":"bob"},"created_at":"2026-09-17T00:00:00Z","position":{"base_sha":"a".repeat(40),"start_sha":"b".repeat(40),"head_sha":"c".repeat(40),"new_path":"src/source.rs","new_line":7}}]}]);
        fixture.write("page1.json", page.clone());
        let result = fixture
            .adapter
            .get_discussions("repo_api", 17, None)
            .unwrap();
        let wire = serde_json::to_value(result).unwrap();
        assert_eq!(
            wire["discussions"][0]["position"]["headCommitOid"],
            "c".repeat(40)
        );
        assert_eq!(wire["discussions"][0]["line"], 7);
        page[0]["notes"][0]["position"]["base_sha"] = serde_json::json!("invalid");
        fixture.write("page1.json", page);
        let result = fixture
            .adapter
            .get_discussions("repo_api", 17, None)
            .unwrap();
        assert!(result.discussions[0].position.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn comparison_process_rejects_stale_inline_coordinates_before_posting_to_trusted_project() {
        let fixture = DiscussionProcessFixture::new();
        let mut changes: serde_json::Value =
            serde_json::from_slice(&fs::read(fixture.root.path().join("mr.json")).unwrap())
                .unwrap();
        changes["sha"] = serde_json::json!("b".repeat(40));
        changes["diff_refs"] = serde_json::json!({"base_sha":"a".repeat(40),"start_sha":"a".repeat(40),"head_sha":"b".repeat(40)});
        changes["changes"] = serde_json::json!([{"old_path":"source.rs","new_path":"source.rs","diff":"@@ -1 +1 @@\n-base\n+published\n"}]);
        fixture.write("changes.json", changes);
        fixture.adapter.review_targets.lock().unwrap().insert(
            ("repo_api".to_owned(), 17),
            ReviewOpenTarget {
                origin: "https://gitlab.example.com/wrong/catalog.git".to_owned(),
            },
        );
        let repository = GitlabTrustedRepository::from_origin(
            "repo_api",
            "https://gitlab.example.com/acme/api.git",
            "feat/delivery",
            &"c".repeat(40),
        )
        .unwrap();
        let mut request = GitlabReviewCommentRequest {
            body: "Explain this.".to_owned(),
            file_path: Some("source.rs".to_owned()),
            side: Some("additions".to_owned()),
            line: Some(1),
            expected_position: Some(GitlabReviewDiscussionPosition {
                base_commit_oid: "a".repeat(40),
                start_commit_oid: "a".repeat(40),
                head_commit_oid: "c".repeat(40),
            }),
            workspace_id: None,
        };
        assert!(
            fixture
                .adapter
                .publish_workspace_review_comment(&repository, 17, None, request.clone())
                .is_err()
        );
        assert!(!fixture.root.path().join("posts").exists());
        request.expected_position.as_mut().unwrap().head_commit_oid = "b".repeat(40);
        fixture
            .adapter
            .publish_workspace_review_comment(&repository, 17, None, request)
            .unwrap();
        assert_eq!(
            fs::read_to_string(fixture.root.path().join("posts")).unwrap(),
            "post\n"
        );
        let args = fs::read(fixture.root.path().join("args")).unwrap();
        assert!(
            args.split(|byte| *byte == 0)
                .any(|arg| arg == b"/projects/acme%2Fapi/merge_requests/17/discussions")
        );
    }

    struct FixedResolver;
    impl PathResolver for FixedResolver {
        fn resolve(&self, executable: &str) -> Result<Option<PathBuf>, ProbeFailure> {
            assert_eq!(executable, "glab");
            Ok(Some(PathBuf::from("/test/glab")))
        }
    }

    struct FakeRunner {
        calls: AtomicUsize,
        fail_after_success: bool,
    }
    impl CommandRunner for FakeRunner {
        fn run(&self, probe: CommandProbe<'_>) -> Result<ProbeOutput, ProbeFailure> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail_after_success && call >= 2 {
                return Err(ProbeFailure::TimedOut);
            }
            match call % 2 {
                0 => Ok(ProbeOutput::new(
                    br#"{"id":7,"username":"alice"}"#.to_vec(),
                    [],
                )),
                _ => {
                    assert!(probe.args[3].contains("state=all"));
                    assert!(probe.args[3].contains("source_branch=feat%2Fdelivery"));
                    Ok(ProbeOutput::new(br#"[{"id":1017,"iid":17,"title":"Track the MR","web_url":"https://gitlab.example.com/acme/api/-/merge_requests/17","state":"opened","source_branch":"feat/delivery","sha":"ffffffffffffffffffffffffffffffffffffffff","target_branch":"develop","author":{"username":"alice"},"updated_at":"2026-08-14T09:00:00Z","draft":false}]"#.to_vec(), []))
                }
            }
        }
    }

    struct MissingResolver;
    impl PathResolver for MissingResolver {
        fn resolve(&self, _: &str) -> Result<Option<PathBuf>, ProbeFailure> {
            Ok(None)
        }
    }

    fn repository() -> GitlabTrustedRepository {
        GitlabTrustedRepository::from_origin(
            "repo_api",
            "git@gitlab.example.com:acme/api.git",
            "feat/delivery",
            "0123456789abcdef0123456789abcdef01234567",
        )
        .unwrap()
    }

    fn review_repository() -> GitlabReviewTrustedRepository {
        GitlabReviewTrustedRepository::from_catalog(
            "repo_api",
            "git@gitlab.example.com:acme/api.git",
        )
        .unwrap()
    }

    struct ReviewRunner {
        calls: AtomicUsize,
    }

    struct ContinuityRunner {
        response: &'static [u8],
    }

    struct RefreshingCommentRunner {
        changes_calls: Arc<AtomicUsize>,
        posted_head: Arc<Mutex<Option<String>>>,
    }

    impl CommandRunner for RefreshingCommentRunner {
        fn run(&self, probe: CommandProbe<'_>) -> Result<ProbeOutput, ProbeFailure> {
            if probe.args.iter().any(|arg| arg.contains("/commits?")) {
                return Ok(ProbeOutput::new(
                    format!(
                        r#"[{{"id":"{}","parent_ids":["{}"],"title":"Update","author_name":"Bob","authored_date":"2026-08-21T09:00:00Z"}}]"#,
                        "c".repeat(40),
                        "a".repeat(40),
                    )
                    .into_bytes(),
                    [],
                ));
            }
            if probe.args.iter().any(|arg| arg.ends_with("/changes")) {
                let head = if self.changes_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    "b".repeat(40)
                } else {
                    "c".repeat(40)
                };
                return Ok(ProbeOutput::new(
                    format!(
                        r#"{{"diff_refs":{{"base_sha":"{}","start_sha":"{}","head_sha":"{head}"}},"changes":[{{"old_path":"src/lib.rs","new_path":"src/lib.rs","diff":"@@ -1 +1 @@\n-old\n+new"}}]}}"#,
                        "a".repeat(40),
                        "a".repeat(40),
                    )
                    .into_bytes(),
                    [],
                ));
            }
            if probe
                .args
                .iter()
                .any(|arg| arg.contains("/discussions?per_page="))
            {
                return Ok(ProbeOutput::new(b"[]".to_vec(), []));
            }
            if probe.args.iter().any(|arg| arg.ends_with("/discussions")) {
                let position = probe
                    .args
                    .iter()
                    .find_map(|arg| arg.strip_prefix("position="))
                    .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
                    .expect("inline comment includes a nested position");
                let head = position["head_sha"]
                    .as_str()
                    .expect("inline comment includes the current GitLab head");
                *self.posted_head.lock().unwrap() = Some(head.to_owned());
                return Ok(ProbeOutput::new(br#"{"id":"discussion-new"}"#.to_vec(), []));
            }
            panic!("unexpected glab call: {:?}", probe.args);
        }
    }

    impl CommandRunner for ContinuityRunner {
        fn run(&self, probe: CommandProbe<'_>) -> Result<ProbeOutput, ProbeFailure> {
            assert_eq!(probe.args[0], "api");
            assert_eq!(probe.args[2], "gitlab.example.com");
            assert!(probe.args[3].contains("/acme%2Fapi/merge_requests/17/notes?"));
            assert!(probe.args[3].contains("system=true"));
            Ok(ProbeOutput::new(self.response.to_vec(), []))
        }
    }

    impl CommandRunner for ReviewRunner {
        fn run(&self, probe: CommandProbe<'_>) -> Result<ProbeOutput, ProbeFailure> {
            if probe.args.iter().any(|arg| arg.contains("/commits?")) {
                return Ok(ProbeOutput::new(br#"[{"id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","parent_ids":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],"title":"Refactor logging","author_name":"Bob","authored_date":"2026-08-19T09:00:00Z"}]"#.to_vec(), []));
            }
            if probe
                .args
                .iter()
                .any(|arg| arg.contains("/repository/commits/"))
            {
                return Ok(ProbeOutput::new(br#"[{"old_path":"src/lib.rs","new_path":"src/lib.rs","diff":"@@ -1 +1 @@\n-old\n+commit change"}]"#.to_vec(), []));
            }
            if probe.args.iter().any(|arg| arg.ends_with("/changes")) {
                return Ok(ProbeOutput::new(br#"{"diff_refs":{"base_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","start_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"changes":[{"old_path":"src/lib.rs","new_path":"src/lib.rs","diff":"@@ -1 +1 @@\n-old\n+new"}]}"#.to_vec(), []));
            }
            if probe
                .args
                .iter()
                .any(|arg| arg.contains("/discussions?per_page="))
            {
                return Ok(ProbeOutput::new(br#"[{"id":"discussion-55","notes":[{"id":91,"body":"Can this be configuration driven?","author":{"username":"alice"},"created_at":"2026-08-20T09:00:00Z","system":false,"resolvable":true,"resolved":false,"position":{"old_path":"src/lib.rs","new_path":"src/lib.rs","new_line":2}}]},{"id":"automated-note","notes":[{"id":92,"body":"**hello** <details><summary>Help</summary>Bot guidance</details>","author":{"username":"cibot"},"created_at":"2026-08-20T09:01:00Z","system":false,"resolvable":false,"resolved":null,"position":null}]}]"#.to_vec(), []));
            }
            if probe.args.iter().any(|arg| arg.ends_with("/discussions")) {
                let body_index = probe
                    .args
                    .iter()
                    .position(|arg| arg == &"--raw-field")
                    .expect("comment body is sent as text");
                assert!(probe.args.get(body_index + 1) == Some(&"body=Check this line."));
                let position = probe
                    .args
                    .iter()
                    .find_map(|arg| arg.strip_prefix("position="))
                    .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
                    .expect("GitLab position is one nested JSON object");
                assert_eq!(position["position_type"], "text");
                assert_eq!(position["new_line"], 2);
                assert!(position.get("old_line").is_none());
                assert_eq!(position["new_path"], "src/lib.rs");
                assert_eq!(position["old_path"], "src/lib.rs");
                assert_eq!(position["base_sha"], "a".repeat(40));
                assert!(probe.args.iter().all(|arg| !arg.starts_with("position[")));
                return Ok(ProbeOutput::new(br#"{"id":55}"#.to_vec(), []));
            }
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            match call {
                0 => Ok(ProbeOutput::new(
                    br#"{"id":7,"username":"alice"}"#.to_vec(),
                    [],
                )),
                1 => {
                    assert_eq!(probe.args[2], "gitlab.example.com");
                    assert!(probe.args[3].contains("state=all"));
                    assert!(probe.args[3].contains("reviewer_username=alice"));
                    assert!(!probe.args[3].contains("approved_by_ids"));
                    Ok(ProbeOutput::new(br#"[{"id":1017,"iid":17,"title":"Review the delivery","web_url":"https://gitlab.example.com/acme/api/-/merge_requests/17","state":"opened","source_branch":"feat/delivery","target_branch":"develop","author":{"username":"bob"},"reviewers":[{"username":"alice"}],"updated_at":"2026-08-14T09:00:00Z","draft":false},{"id":1020,"iid":20,"title":"Review another delivery","web_url":"https://gitlab.example.com/acme/api/-/merge_requests/20","state":"opened","source_branch":"feat/another","target_branch":"develop","author":{"username":"dana"},"reviewers":[{"username":"alice"}],"updated_at":"2026-08-14T08:45:00Z","draft":false},{"id":1019,"iid":19,"title":"Review outside the catalog","web_url":"https://gitlab.example.com/acme/other/-/merge_requests/19","state":"opened","source_branch":"feat/external","target_branch":"main","author":{"username":"carol"},"reviewers":[{"username":"alice"}],"updated_at":"2026-08-14T08:30:00Z","draft":false},{"id":1021,"iid":21,"title":"Approved and merged","web_url":"https://gitlab.example.com/acme/api/-/merge_requests/21","state":"merged","source_branch":"feat/merged","target_branch":"develop","author":{"username":"bob"},"reviewers":[{"username":"alice"}],"updated_at":"2026-08-13T09:00:00Z","draft":false},{"id":1018,"iid":18,"title":"Not assigned","web_url":"https://gitlab.example.com/acme/api/-/merge_requests/18","state":"opened","source_branch":"feat/other","target_branch":"develop","author":{"username":"bob"},"reviewers":[{"username":"carol"}],"updated_at":"2026-08-14T08:00:00Z","draft":false}]"#.to_vec(), []))
                }
                _ => {
                    assert!(probe.args[3].contains("approved_by_ids%5B%5D=7"));
                    Ok(ProbeOutput::new(br#"[{"id":1017,"iid":17,"title":"Review the delivery","web_url":"https://gitlab.example.com/acme/api/-/merge_requests/17","state":"opened","source_branch":"feat/delivery","target_branch":"develop","author":{"username":"bob"},"reviewers":[{"username":"alice"}],"updated_at":"2026-08-14T09:00:00Z","draft":false},{"id":1021,"iid":21,"title":"Approved and merged","web_url":"https://gitlab.example.com/acme/api/-/merge_requests/21","state":"merged","source_branch":"feat/merged","target_branch":"develop","author":{"username":"bob"},"reviewers":[{"username":"alice"}],"updated_at":"2026-08-13T09:00:00Z","draft":false}]"#.to_vec(), []))
                }
            }
        }
    }

    #[test]
    fn lists_only_individual_reviews_for_the_configured_glab_user() {
        let adapter = GitlabMergeRequestsAdapter::new(
            ReviewRunner {
                calls: AtomicUsize::new(0),
            },
            FixedResolver,
        );

        let result = adapter.list_reviews(&[review_repository()]);

        assert_eq!(result.state, GitlabMergeRequestInboxState::Fresh);
        assert_eq!(result.reviews.len(), 4);
        assert_eq!(result.reviews[0].repository_id, "repo_api");
        assert_eq!(result.reviews[0].number, 17);
        assert_eq!(result.reviews[0].author_login, "bob");
        assert_eq!(result.reviews[0].source_branch, "feat/delivery");
        assert_eq!(result.reviews[0].target_branch, "develop");
        assert_eq!(result.reviews[0].review_state, GitlabReviewState::Approved);
        assert_eq!(result.reviews[0].status, GitlabMergeRequestStatus::Open);
        let merged = result
            .reviews
            .iter()
            .find(|review| review.number == 21)
            .unwrap();
        assert_eq!(merged.review_state, GitlabReviewState::Approved);
        assert_eq!(merged.status, GitlabMergeRequestStatus::Merged);
        assert_eq!(
            adapter.cached_review_origin("repo_api", 17).as_deref(),
            Some("https://gitlab.example.com/acme/api.git")
        );
        assert_eq!(
            adapter.cached_review_origin("repo_api", 20).as_deref(),
            Some("https://gitlab.example.com/acme/api.git")
        );
        assert!(adapter.cached_review_origin("repo_api", 18).is_none());
        assert_eq!(result.reviews[2].repository, "acme/other");
        assert_eq!(result.reviews[2].repository_id, "gitlab-review-1019");
        assert_eq!(
            adapter
                .cached_review_origin("gitlab-review-1019", 19)
                .as_deref(),
            Some("https://gitlab.example.com/acme/other.git")
        );
        assert!(
            adapter
                .cached_review_origin("gitlab-review-1019", 20)
                .is_none()
        );
        assert!(
            adapter
                .cached_review_origin("gitlab-review-999", 19)
                .is_none()
        );
        let json = serde_json::to_value(&result).unwrap();
        assert!(json["reviews"][0].get("webUrl").is_none());
    }

    #[test]
    fn review_contract_keeps_the_verified_provider_head() {
        let node = MergeRequestNode {
            id: 1017,
            iid: 17,
            title: "Review the delivery".to_owned(),
            web_url: "https://gitlab.example.com/acme/api/-/merge_requests/17".to_owned(),
            state: "opened".to_owned(),
            source_project_id: None,
            target_project_id: None,
            source_branch: "feat/delivery".to_owned(),
            sha: Some("cccccccccccccccccccccccccccccccccccccccc".to_owned()),
            target_branch: "develop".to_owned(),
            author: GitlabUser {
                username: "bob".to_owned(),
            },
            reviewers: vec![GitlabUser {
                username: "alice".to_owned(),
            }],
            updated_at: "2026-08-14T09:00:00Z".to_owned(),
            draft: false,
            user_notes_count: 0,
            blocking_discussions_resolved: None,
        };
        let (review, _) = validated_review(
            node,
            "gitlab.example.com",
            &BTreeSet::from([review_repository()]),
            "alice",
            GitlabReviewState::Approved,
        )
        .unwrap();

        assert_eq!(
            review.head_commit_oid.as_deref(),
            Some("cccccccccccccccccccccccccccccccccccccccc")
        );
    }

    #[test]
    fn system_note_order_detects_a_push_after_approval_and_a_new_approval() {
        let pushed = GitlabMergeRequestsAdapter::new(
            ContinuityRunner {
                response: br#"[{"system":true,"body":"added 1 commit","author":{"username":"bob"}},{"system":true,"body":"approved this merge request","author":{"username":"alice"}}]"#,
            },
            FixedResolver,
        );
        assert_eq!(
            pushed
                .changes_after_approval(
                    &PathBuf::from("/test/glab"),
                    "gitlab.example.com",
                    "acme/api",
                    17,
                    "alice",
                )
                .ok(),
            Some(true)
        );

        let reapproved = GitlabMergeRequestsAdapter::new(
            ContinuityRunner {
                response: br#"[{"system":true,"body":"approved this merge request","author":{"username":"alice"}},{"system":true,"body":"added 1 commit","author":{"username":"bob"}}]"#,
            },
            FixedResolver,
        );
        assert_eq!(
            reapproved
                .changes_after_approval(
                    &PathBuf::from("/test/glab"),
                    "gitlab.example.com",
                    "acme/api",
                    17,
                    "alice",
                )
                .ok(),
            Some(false)
        );
    }

    #[test]
    fn loads_commit_patches_and_publishes_an_inline_discussion() {
        let adapter = GitlabMergeRequestsAdapter::new(
            ReviewRunner {
                calls: AtomicUsize::new(0),
            },
            FixedResolver,
        );
        adapter.list_reviews(&[review_repository()]);

        let patch = adapter.review_patch("repo_api", 17, None, false).unwrap();
        assert_eq!(patch.base_commit_oid, "a".repeat(40));
        assert_eq!(patch.start_commit_oid, "a".repeat(40));
        assert_eq!(patch.head_commit_oid, "b".repeat(40));
        assert_eq!(patch.commits.len(), 1);
        assert_eq!(patch.discussions.len(), 2);
        assert_eq!(
            patch.discussions[0].file_path.as_deref(),
            Some("src/lib.rs")
        );
        assert!(patch.discussions[0].resolvable);
        assert!(!patch.discussions[0].resolved);
        assert!(!patch.discussions[0].automated);
        assert_eq!(
            patch.discussions[0].comments[0].body,
            "Can this be configuration driven?"
        );
        assert!(!patch.discussions[1].resolvable);
        assert!(!patch.discussions[1].resolved);
        assert!(patch.discussions[1].automated);
        assert!(patch.patch.contains("diff --git a/src/lib.rs b/src/lib.rs"));
        assert!(patch.patch.contains("+new"));

        let refreshed = adapter.review_patch("repo_api", 17, None, true).unwrap();
        assert_eq!(refreshed.commits.len(), 1);
        assert_eq!(refreshed.head_commit_oid, "b".repeat(40));

        let result = adapter
            .publish_review_comment(
                "repo_api",
                17,
                GitlabReviewCommentRequest {
                    body: "Check this line.".to_owned(),
                    file_path: Some("src/lib.rs".to_owned()),
                    side: Some("additions".to_owned()),
                    line: Some(2),
                    expected_position: None,
                    workspace_id: None,
                },
            )
            .unwrap();
        assert!(result.accepted);

        let commit_patch = adapter
            .review_patch("repo_api", 17, Some(&"b".repeat(40)), false)
            .unwrap();
        assert_eq!(commit_patch.selected_commit_oid, Some("b".repeat(40)));
        assert!(commit_patch.patch.contains("+commit change"));
    }

    #[test]
    fn refreshes_gitlab_diff_refs_before_publishing_an_inline_discussion() {
        let changes_calls = Arc::new(AtomicUsize::new(0));
        let posted_head = Arc::new(Mutex::new(None));
        let adapter = GitlabMergeRequestsAdapter::new(
            RefreshingCommentRunner {
                changes_calls: Arc::clone(&changes_calls),
                posted_head: Arc::clone(&posted_head),
            },
            FixedResolver,
        );

        let cached = adapter
            .review_patch_for_origin(
                "repo_api",
                17,
                "https://gitlab.example.com/acme/api.git",
                None,
                false,
            )
            .unwrap();
        assert_eq!(cached.head_commit_oid, "b".repeat(40));

        adapter
            .publish_review_comment(
                "repo_api",
                17,
                GitlabReviewCommentRequest {
                    body: "Check this line.".to_owned(),
                    file_path: Some("src/lib.rs".to_owned()),
                    side: Some("additions".to_owned()),
                    line: Some(1),
                    expected_position: None,
                    workspace_id: None,
                },
            )
            .unwrap();

        assert_eq!(changes_calls.load(Ordering::SeqCst), 2);
        assert_eq!(*posted_head.lock().unwrap(), Some("c".repeat(40)));
    }

    #[test]
    fn loads_a_completed_review_patch_from_a_trusted_catalog_origin() {
        let adapter = GitlabMergeRequestsAdapter::new(
            ReviewRunner {
                calls: AtomicUsize::new(0),
            },
            FixedResolver,
        );

        let patch = adapter
            .review_patch_for_origin(
                "repo_api",
                22,
                "git@gitlab.example.com:acme/api.git",
                None,
                false,
            )
            .unwrap();

        assert_eq!(patch.repository_id, "repo_api");
        assert_eq!(patch.iid, 22);
        assert!(patch.patch.contains("+new"));
        assert_eq!(
            adapter.cached_review_origin("repo_api", 22).as_deref(),
            Some("git@gitlab.example.com:acme/api.git")
        );
        assert!(
            adapter
                .review_patch_for_origin(
                    "repo_evil",
                    22,
                    "https://alice@gitlab.example.com/acme/api.git",
                    None,
                    false,
                )
                .is_err()
        );
    }

    #[test]
    fn publishes_from_a_revalidated_catalog_origin_without_an_inbox_target() {
        let adapter = GitlabMergeRequestsAdapter::new(
            ReviewRunner {
                calls: AtomicUsize::new(0),
            },
            FixedResolver,
        );

        let result = adapter
            .publish_review_comment_for_origin(
                "repo_api",
                17,
                "git@gitlab.example.com:acme/api.git",
                GitlabReviewCommentRequest {
                    body: "Check this line.".to_owned(),
                    file_path: Some("src/lib.rs".to_owned()),
                    side: Some("additions".to_owned()),
                    line: Some(2),
                    expected_position: None,
                    workspace_id: None,
                },
            )
            .unwrap();

        assert!(result.accepted);
        assert_eq!(result.repository_id, "repo_api");
    }

    #[test]
    fn reopens_a_bounded_saved_review_patch_without_gitlab() {
        struct OfflineRunner;
        impl CommandRunner for OfflineRunner {
            fn run(&self, _: CommandProbe<'_>) -> Result<ProbeOutput, ProbeFailure> {
                Err(ProbeFailure::TimedOut)
            }
        }

        let directory = tempfile::tempdir().unwrap();
        let cache_file = directory.path().join("gitlab-review-patches.json");
        let online = GitlabMergeRequestsAdapter::new_with_review_patch_cache(
            ReviewRunner {
                calls: AtomicUsize::new(0),
            },
            FixedResolver,
            Some(cache_file.clone()),
        );
        let fresh = online
            .review_patch_for_origin(
                "repo_api",
                22,
                "git@gitlab.example.com:acme/api.git",
                None,
                true,
            )
            .unwrap();
        assert!(!fresh.from_cache);
        drop(online);

        let offline = GitlabMergeRequestsAdapter::new_with_review_patch_cache(
            OfflineRunner,
            FixedResolver,
            Some(cache_file),
        );
        let saved = offline
            .review_patch_for_origin(
                "repo_api",
                22,
                "git@gitlab.example.com:acme/api.git",
                None,
                false,
            )
            .unwrap();
        assert!(saved.from_cache);
        assert_eq!(saved.head_commit_oid, fresh.head_commit_oid);
        assert_eq!(saved.commits, fresh.commits);
        assert_eq!(saved.discussions, fresh.discussions);
        assert_eq!(saved.patch, fresh.patch);
    }

    #[test]
    fn accepts_only_exact_trusted_review_urls() {
        assert_eq!(
            review_project_path(
                "https://gitlab.example.com/acme/other/-/merge_requests/19",
                "gitlab.example.com",
                19,
            )
            .as_deref(),
            Some("acme/other")
        );
        for candidate in [
            "http://gitlab.example.com/acme/other/-/merge_requests/19",
            "https://gitlab.example.com.evil.test/acme/other/-/merge_requests/19",
            "https://alice@gitlab.example.com/acme/other/-/merge_requests/19",
            "https://gitlab.example.com:8443/acme/other/-/merge_requests/19",
            "https://gitlab.example.com/acme/other/-/merge_requests/20",
            "https://gitlab.example.com/acme/other/-/merge_requests/19?open=true",
        ] {
            assert_eq!(
                review_project_path(candidate, "gitlab.example.com", 19),
                None,
                "accepted untrusted review URL: {candidate}"
            );
        }
    }

    #[test]
    fn keeps_an_authored_open_branch_match_when_the_provider_head_differs() {
        let adapter = GitlabMergeRequestsAdapter::new(
            FakeRunner {
                calls: AtomicUsize::new(0),
                fail_after_success: false,
            },
            FixedResolver,
        );
        let result = adapter.list(&[repository()]);
        assert_eq!(result.state, GitlabMergeRequestInboxState::Fresh);
        assert_eq!(result.merge_requests.len(), 1);
        assert_eq!(result.merge_requests[0].repository_id, "repo_api");
        assert_eq!(
            result.merge_requests[0].status,
            GitlabMergeRequestStatus::Open
        );
        assert_ne!(
            result.merge_requests[0].source_head_commit_oid.as_deref(),
            Some(repository().head_commit_oid())
        );
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(
            json["mergeRequests"][0]["webUrl"],
            "https://gitlab.example.com/acme/api/-/merge_requests/17"
        );
    }

    #[test]
    fn preserves_merged_and_closed_branch_state_for_workflow_projection() {
        struct CompletedRunner(AtomicUsize);
        impl CommandRunner for CompletedRunner {
            fn run(&self, probe: CommandProbe<'_>) -> Result<ProbeOutput, ProbeFailure> {
                match self.0.fetch_add(1, Ordering::SeqCst) {
                    0 => Ok(ProbeOutput::new(
                        br#"{"id":7,"username":"alice"}"#.to_vec(),
                        [],
                    )),
                    _ => {
                        assert!(probe.args[3].contains("state=all"));
                        Ok(ProbeOutput::new(br#"[{"id":1018,"iid":18,"title":"Delivered","web_url":"https://gitlab.example.com/acme/api/-/merge_requests/18","state":"merged","source_branch":"feat/delivery","sha":"0123456789abcdef0123456789abcdef01234567","target_branch":"develop","author":{"username":"alice"},"updated_at":"2026-08-17T09:00:00Z","draft":false},{"id":1016,"iid":16,"title":"Stopped","web_url":"https://gitlab.example.com/acme/api/-/merge_requests/16","state":"closed","source_branch":"feat/delivery","sha":"0123456789abcdef0123456789abcdef01234567","target_branch":"develop","author":{"username":"alice"},"updated_at":"2026-08-16T09:00:00Z","draft":false}]"#.to_vec(), []))
                    }
                }
            }
        }

        let result =
            GitlabMergeRequestsAdapter::new(CompletedRunner(AtomicUsize::new(0)), FixedResolver)
                .list(&[repository()]);

        assert_eq!(result.merge_requests.len(), 2);
        assert_eq!(
            result.merge_requests[0].status,
            GitlabMergeRequestStatus::Merged
        );
        assert_eq!(
            result.merge_requests[1].status,
            GitlabMergeRequestStatus::Closed
        );
    }

    #[test]
    fn returns_stale_cached_matches_after_a_bounded_failure() {
        let adapter = GitlabMergeRequestsAdapter::new(
            FakeRunner {
                calls: AtomicUsize::new(0),
                fail_after_success: true,
            },
            FixedResolver,
        );
        assert_eq!(
            adapter.list(&[repository()]).state,
            GitlabMergeRequestInboxState::Fresh
        );
        let stale = adapter.list(&[repository()]);
        assert_eq!(stale.state, GitlabMergeRequestInboxState::Stale);
        assert_eq!(stale.merge_requests.len(), 1);
    }

    #[test]
    fn rejects_untrusted_or_credentialed_origins() {
        let oid = "0123456789abcdef0123456789abcdef01234567";
        for origin in [
            "https://evil.example/acme/api",
            "https://user@gitlab.example.com/acme/api",
            "https://git@gitlab.example.com/acme/api",
            "https://gitlab.example.com:8443/acme/api",
            "ssh://git@gitlab.example.com:2222/acme/api",
            "git@gitlab.example.com:acme/../api",
        ] {
            assert!(
                GitlabTrustedRepository::from_origin("repo_api", origin, "feat/delivery", oid)
                    .is_none(),
                "origin should be rejected: {origin}"
            );
        }
    }

    #[test]
    fn reports_a_missing_cli_as_an_auth_setup_state() {
        let adapter = GitlabMergeRequestsAdapter::new(
            FakeRunner {
                calls: AtomicUsize::new(0),
                fail_after_success: false,
            },
            MissingResolver,
        );
        let result = adapter.list(&[repository()]);
        assert_eq!(result.state, GitlabMergeRequestInboxState::Auth);
        assert_eq!(
            result.diagnostic_code,
            Some(GitlabMergeRequestDiagnosticCode::GlabMissing)
        );
    }

    struct AuthRunner {
        calls: Mutex<Vec<(PathBuf, Vec<String>)>>,
    }

    impl CommandRunner for AuthRunner {
        fn run(&self, probe: CommandProbe<'_>) -> Result<ProbeOutput, ProbeFailure> {
            self.calls.lock().unwrap().push((
                probe.executable.to_path_buf(),
                probe.args.iter().map(|arg| (*arg).to_owned()).collect(),
            ));
            if probe.args.first() == Some(&"api") {
                Ok(ProbeOutput::new(
                    br#"{"id":7,"username":"alice"}"#.to_vec(),
                    [],
                ))
            } else {
                Ok(ProbeOutput::new([], []))
            }
        }
    }

    #[test]
    fn reports_only_bounded_account_identity_to_the_caller() {
        let adapter = GitlabMergeRequestsAdapter::new(
            AuthRunner {
                calls: Mutex::new(Vec::new()),
            },
            FixedResolver,
        );
        let status = adapter.integration_status(&[repository()]);

        assert_eq!(status.cli_state, GitlabCliState::Ready);
        assert_eq!(status.accounts.len(), 1);
        assert_eq!(status.accounts[0].host, "gitlab.example.com");
        assert_eq!(status.accounts[0].state, GitlabAccountState::SignedIn);
        assert_eq!(status.accounts[0].username.as_deref(), Some("alice"));
        let serialized = serde_json::to_string(&status).unwrap();
        for secret_field in ["token", "url", "command", "executable", "path"] {
            assert!(!serialized.to_ascii_lowercase().contains(secret_field));
        }
    }

    struct FailingStatusRunner(ProbeFailure);

    impl CommandRunner for FailingStatusRunner {
        fn run(&self, _: CommandProbe<'_>) -> Result<ProbeOutput, ProbeFailure> {
            Err(self.0)
        }
    }

    #[test]
    fn distinguishes_signed_out_from_a_provider_status_failure() {
        let signed_out = GitlabMergeRequestsAdapter::new(
            FailingStatusRunner(ProbeFailure::UnsuccessfulExit),
            FixedResolver,
        )
        .integration_status(&[repository()]);
        assert_eq!(signed_out.accounts[0].state, GitlabAccountState::SignedOut);

        let provider_error = GitlabMergeRequestsAdapter::new(
            FailingStatusRunner(ProbeFailure::TimedOut),
            FixedResolver,
        )
        .integration_status(&[repository()]);
        assert_eq!(provider_error.accounts[0].state, GitlabAccountState::Error);
    }
}
