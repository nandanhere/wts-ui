use crate::{
    CommandProbe, CommandRunner, PathResolver, ProbeFailure, ProcessCommandRunner,
    SystemPathResolver,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use url::Url;

const SCHEMA_VERSION: u8 = 1;
const MAX_TRUSTED_REPOSITORIES: usize = 20;
const MAX_REVIEWS: usize = 50;
const MAX_TEXT_CHARS: usize = 512;
const GH_TIMEOUT: Duration = Duration::from_secs(10);
const GH_MAX_OUTPUT_BYTES: usize = 256 * 1024;
const GITHUB_REVIEW_QUERY: &str = r#"query($first:Int!,$searchQuery:String!){viewer{login}search(query:$searchQuery,type:ISSUE,first:$first){nodes{... on PullRequest{id number title url updatedAt isDraft author{login}repository{nameWithOwner url}reviewRequests(first:50){nodes{requestedReviewer{__typename ... on User{login}}}}}}}}"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GithubReviewInboxState {
    Fresh,
    Stale,
    Auth,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GithubReviewDiagnosticCode {
    GhMissing,
    AuthenticationRequired,
    ProviderTimedOut,
    ProviderOutputTooLarge,
    ProviderFailed,
    ProviderResponseInvalid,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GithubReview {
    pub id: String,
    pub repository_id: String,
    pub repository: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub author_login: String,
    pub updated_at: String,
    pub draft: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GithubReviewInbox {
    pub schema_version: u8,
    pub state: GithubReviewInboxState,
    pub reviews: Vec<GithubReview>,
    pub fetched_at_unix_ms: Option<u64>,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic_code: Option<GithubReviewDiagnosticCode>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct GithubTrustedRepository {
    repository_id: String,
    host: String,
    name_with_owner: String,
}

impl GithubTrustedRepository {
    pub fn from_origin(origin: &str) -> Option<Self> {
        let (_, path) = origin_parts(origin)?;
        let repository_id = validated_repository_path(&path)?;
        Self::from_catalog(&repository_id, origin)
    }

    pub fn from_catalog(repository_id: &str, origin: &str) -> Option<Self> {
        if repository_id.is_empty()
            || repository_id.len() > 160
            || repository_id.trim() != repository_id
            || repository_id.contains(['\0', '\n', '\r', '\t'])
        {
            return None;
        }
        let (host, path) = origin_parts(origin)?;
        let host = validated_github_host(&host)?;
        let name_with_owner = validated_repository_path(&path)?;
        Some(Self {
            repository_id: repository_id.to_owned(),
            host,
            name_with_owner,
        })
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn repository_id(&self) -> &str {
        &self.repository_id
    }

    pub fn name_with_owner(&self) -> &str {
        &self.name_with_owner
    }
}

#[derive(Clone, Debug)]
struct CacheEntry {
    fetched_at_unix_ms: u64,
    reviews: Vec<GithubReview>,
}

pub struct GithubReviewsAdapter<R = ProcessCommandRunner, P = SystemPathResolver> {
    runner: R,
    resolver: P,
    cache: Arc<Mutex<BTreeMap<String, CacheEntry>>>,
}

impl Default for GithubReviewsAdapter<ProcessCommandRunner, SystemPathResolver> {
    fn default() -> Self {
        Self::new(
            ProcessCommandRunner::new(GH_TIMEOUT, GH_MAX_OUTPUT_BYTES),
            SystemPathResolver,
        )
    }
}

impl<R, P> GithubReviewsAdapter<R, P>
where
    R: CommandRunner,
    P: PathResolver,
{
    pub fn new(runner: R, resolver: P) -> Self {
        Self {
            runner,
            resolver,
            cache: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    pub fn list(&self, repositories: &[GithubTrustedRepository]) -> GithubReviewInbox {
        let repositories = repositories
            .iter()
            .take(MAX_TRUSTED_REPOSITORIES)
            .cloned()
            .collect::<BTreeSet<_>>();
        if repositories.is_empty() {
            return inbox(
                GithubReviewInboxState::Fresh,
                Vec::new(),
                Some(now_ms()),
                None,
                "No linked GitHub repositories are available.",
            );
        }

        let executable = match self.resolver.resolve("gh") {
            Ok(Some(path)) => path,
            _ => return self.failure(&repositories, Failure::Missing),
        };
        let hosts = repositories
            .iter()
            .map(|repository| repository.host.clone())
            .collect::<BTreeSet<_>>();
        if hosts.len() != 1 {
            return self.failure(&repositories, Failure::Invalid);
        }

        let mut reviews = Vec::new();
        for host in hosts {
            if self.authenticate(&executable, &host).is_err() {
                return self.failure(&repositories, Failure::Auth);
            }
            match self.query(&executable, &host, &repositories) {
                Ok(mut host_reviews) => reviews.append(&mut host_reviews),
                Err(error) => return self.failure(&repositories, error),
            }
        }
        reviews.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.repository.cmp(&right.repository))
                .then_with(|| left.number.cmp(&right.number))
        });
        reviews.truncate(MAX_REVIEWS);
        let fetched_at = now_ms();
        if let Ok(mut cache) = self.cache.lock() {
            for repository in &repositories {
                cache.insert(
                    cache_key(repository),
                    CacheEntry {
                        fetched_at_unix_ms: fetched_at,
                        reviews: reviews
                            .iter()
                            .filter(|review| {
                                review
                                    .repository
                                    .eq_ignore_ascii_case(repository.name_with_owner())
                            })
                            .cloned()
                            .collect(),
                    },
                );
            }
        }
        inbox(
            GithubReviewInboxState::Fresh,
            reviews,
            Some(fetched_at),
            None,
            "GitHub returned the current individual review requests.",
        )
    }

    fn authenticate(&self, executable: &PathBuf, host: &str) -> Result<(), ProbeFailure> {
        self.runner
            .run(CommandProbe {
                executable,
                args: &["auth", "status", "--hostname", host],
            })
            .map(|_| ())
    }

    fn query(
        &self,
        executable: &PathBuf,
        host: &str,
        repositories: &BTreeSet<GithubTrustedRepository>,
    ) -> Result<Vec<GithubReview>, Failure> {
        let first = MAX_REVIEWS.to_string();
        let query = format!("query={GITHUB_REVIEW_QUERY}");
        let search_query = review_search_query(repositories);
        let search_query = format!("searchQuery={search_query}");
        let output = self
            .runner
            .run(CommandProbe {
                executable,
                args: &[
                    "api",
                    "graphql",
                    "--hostname",
                    host,
                    "--raw-field",
                    &query,
                    "--field",
                    &format!("first={first}"),
                    "--raw-field",
                    &search_query,
                ],
            })
            .map_err(Failure::Provider)?;
        let response: GraphqlResponse =
            serde_json::from_slice(output.stdout()).map_err(|_| Failure::Invalid)?;
        let data = response.data.ok_or(Failure::Invalid)?;
        let viewer = validated_login(&data.viewer.login).ok_or(Failure::Invalid)?;
        let mut found = Vec::new();
        for node in data.search.nodes.into_iter().take(MAX_REVIEWS * 2) {
            let Some(repository) = repositories.iter().find(|trusted| {
                trusted.host == host
                    && trusted
                        .name_with_owner
                        .eq_ignore_ascii_case(&node.repository.name_with_owner)
            }) else {
                continue;
            };
            if !validated_repository_url(&node.repository.url, repository) {
                continue;
            }
            let individually_requested = node.review_requests.nodes.iter().any(|request| {
                request.requested_reviewer.kind == "User"
                    && request
                        .requested_reviewer
                        .login
                        .as_deref()
                        .is_some_and(|login| login.eq_ignore_ascii_case(viewer))
            });
            if !individually_requested {
                continue;
            }
            let Some(review) = validated_review(node, repository) else {
                continue;
            };
            found.push(review);
        }
        Ok(found)
    }

    fn failure(
        &self,
        repositories: &BTreeSet<GithubTrustedRepository>,
        failure: Failure,
    ) -> GithubReviewInbox {
        let mut cached = Vec::new();
        let mut fetched_at = None;
        if let Ok(cache) = self.cache.lock() {
            for repository in repositories {
                if let Some(entry) = cache.get(&cache_key(repository)) {
                    fetched_at =
                        Some(fetched_at.map_or(entry.fetched_at_unix_ms, |current: u64| {
                            current.min(entry.fetched_at_unix_ms)
                        }));
                    cached.extend(entry.reviews.clone());
                }
            }
        }
        cached.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        cached.truncate(MAX_REVIEWS);
        let (state, code, detail) = failure.contract();
        if fetched_at.is_some() {
            inbox(
                GithubReviewInboxState::Stale,
                cached,
                fetched_at,
                Some(code),
                "GitHub is unavailable. WTS shows the last successful review list.",
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

impl Failure {
    fn contract(
        self,
    ) -> (
        GithubReviewInboxState,
        GithubReviewDiagnosticCode,
        &'static str,
    ) {
        match self {
            Self::Missing => (
                GithubReviewInboxState::Auth,
                GithubReviewDiagnosticCode::GhMissing,
                "Install GitHub CLI and sign in to load review requests.",
            ),
            Self::Auth => (
                GithubReviewInboxState::Auth,
                GithubReviewDiagnosticCode::AuthenticationRequired,
                "Sign in with GitHub CLI to load review requests.",
            ),
            Self::Provider(ProbeFailure::TimedOut) => (
                GithubReviewInboxState::Error,
                GithubReviewDiagnosticCode::ProviderTimedOut,
                "GitHub did not answer before the timeout.",
            ),
            Self::Provider(ProbeFailure::OutputUnavailable) => (
                GithubReviewInboxState::Error,
                GithubReviewDiagnosticCode::ProviderOutputTooLarge,
                "The GitHub response exceeded the local safety limit.",
            ),
            Self::Provider(_) => (
                GithubReviewInboxState::Error,
                GithubReviewDiagnosticCode::ProviderFailed,
                "GitHub could not load review requests.",
            ),
            Self::Invalid => (
                GithubReviewInboxState::Error,
                GithubReviewDiagnosticCode::ProviderResponseInvalid,
                "GitHub returned an invalid review response.",
            ),
        }
    }
}

fn inbox(
    state: GithubReviewInboxState,
    reviews: Vec<GithubReview>,
    fetched_at_unix_ms: Option<u64>,
    diagnostic_code: Option<GithubReviewDiagnosticCode>,
    detail: &str,
) -> GithubReviewInbox {
    GithubReviewInbox {
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

fn cache_key(repository: &GithubTrustedRepository) -> String {
    format!(
        "{}/{}",
        repository.host,
        repository.name_with_owner.to_ascii_lowercase()
    )
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
        if url.query().is_some() || url.fragment().is_some() || url.password().is_some() {
            return None;
        }
        return Some((
            url.host_str()?.to_owned(),
            url.path().trim_start_matches('/').to_owned(),
        ));
    }
    let (authority, path) = origin.split_once(':')?;
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    Some((host.to_owned(), path.to_owned()))
}

fn validated_github_host(host: &str) -> Option<String> {
    let host = host.to_ascii_lowercase();
    let labels = host.split('.').collect::<Vec<_>>();
    if host != "github.com"
        || labels.len() != 2
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

fn validated_repository_path(path: &str) -> Option<String> {
    let path = path
        .trim_end_matches('/')
        .strip_suffix(".git")
        .unwrap_or(path.trim_end_matches('/'));
    let segments = path.split('/').collect::<Vec<_>>();
    if segments.len() != 2
        || segments.iter().any(|segment| {
            segment.is_empty()
                || segment.len() > 255
                || matches!(*segment, "." | "..")
                || !segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
    {
        return None;
    }
    Some(segments.join("/"))
}

fn validated_login(value: &str) -> Option<&str> {
    (!value.is_empty()
        && value.len() <= 39
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'))
    .then_some(value)
}

fn bounded_text(value: String) -> Option<String> {
    (!value.is_empty() && value.chars().count() <= MAX_TEXT_CHARS && !value.contains(['\0', '\r']))
        .then_some(value)
}

fn validated_review(
    node: PullRequestNode,
    repository: &GithubTrustedRepository,
) -> Option<GithubReview> {
    if node.number == 0
        || node.number > i64::MAX as u64
        || node.id.is_empty()
        || node.id.len() > 128
    {
        return None;
    }
    let title = bounded_text(node.title)?;
    let author_login = validated_login(&node.author?.login)?.to_owned();
    let updated_at = bounded_text(node.updated_at)?;
    let url = Url::parse(&node.url).ok()?;
    let segments = url.path_segments()?.collect::<Vec<_>>();
    if url.scheme() != "https"
        || url.host_str()? != repository.host
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || segments.len() != 4
        || !segments[0].eq_ignore_ascii_case(repository.name_with_owner.split('/').next()?)
        || !segments[1].eq_ignore_ascii_case(repository.name_with_owner.split('/').nth(1)?)
        || segments[2] != "pull"
        || segments[3] != node.number.to_string()
    {
        return None;
    }
    Some(GithubReview {
        id: node.id,
        repository_id: repository.repository_id.clone(),
        repository: repository.name_with_owner.clone(),
        number: node.number,
        title,
        url: url.to_string(),
        author_login,
        updated_at,
        draft: node.is_draft,
    })
}

fn validated_repository_url(candidate: &str, repository: &GithubTrustedRepository) -> bool {
    let Ok(url) = Url::parse(candidate) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some(repository.host())
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().trim_start_matches('/').trim_end_matches('/') == repository.name_with_owner()
}

fn review_search_query(repositories: &BTreeSet<GithubTrustedRepository>) -> String {
    let repository_scope = repositories
        .iter()
        .map(|repository| format!("repo:{}", repository.name_with_owner()))
        .collect::<Vec<_>>()
        .join(" OR ");
    format!("is:pr is:open review-requested:@me ({repository_scope})")
}

#[derive(Deserialize)]
struct GraphqlResponse {
    data: Option<GraphqlData>,
}
#[derive(Deserialize)]
struct GraphqlData {
    viewer: Viewer,
    search: Search,
}
#[derive(Deserialize)]
struct Viewer {
    login: String,
}
#[derive(Deserialize)]
struct Search {
    #[serde(default)]
    nodes: Vec<PullRequestNode>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestNode {
    id: String,
    number: u64,
    title: String,
    url: String,
    updated_at: String,
    is_draft: bool,
    author: Option<Author>,
    repository: RepositoryNode,
    review_requests: ReviewRequests,
}
#[derive(Deserialize)]
struct Author {
    login: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryNode {
    name_with_owner: String,
    url: String,
}
#[derive(Deserialize)]
struct ReviewRequests {
    #[serde(default)]
    nodes: Vec<ReviewRequestNode>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewRequestNode {
    requested_reviewer: RequestedReviewer,
}
#[derive(Deserialize)]
struct RequestedReviewer {
    #[serde(rename = "__typename")]
    kind: String,
    #[serde(default)]
    login: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProbeOutput;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FixedResolver;
    impl PathResolver for FixedResolver {
        fn resolve(&self, executable: &str) -> Result<Option<PathBuf>, ProbeFailure> {
            assert_eq!(executable, "gh");
            Ok(Some(PathBuf::from("/test/gh")))
        }
    }

    struct FakeRunner {
        calls: AtomicUsize,
        fail_after_success: bool,
    }
    impl CommandRunner for FakeRunner {
        fn run(&self, probe: CommandProbe<'_>) -> Result<ProbeOutput, ProbeFailure> {
            assert_eq!(probe.executable, PathBuf::from("/test/gh"));
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail_after_success && call >= 2 {
                return Err(ProbeFailure::TimedOut);
            }
            if probe.args[0] == "auth" {
                return Ok(ProbeOutput::new([], []));
            }
            assert!(
                probe
                    .args
                    .iter()
                    .any(|argument| argument.contains("searchQuery=")
                        && argument.contains("(repo:acme/api)"))
            );
            Ok(ProbeOutput::new(valid_response(), []))
        }
    }

    struct MissingResolver;
    impl PathResolver for MissingResolver {
        fn resolve(&self, _executable: &str) -> Result<Option<PathBuf>, ProbeFailure> {
            Ok(None)
        }
    }

    struct InvalidRunner;
    impl CommandRunner for InvalidRunner {
        fn run(&self, probe: CommandProbe<'_>) -> Result<ProbeOutput, ProbeFailure> {
            if probe.args[0] == "auth" {
                Ok(ProbeOutput::new([], []))
            } else {
                Ok(ProbeOutput::new(b"not-json".to_vec(), []))
            }
        }
    }

    fn valid_response() -> Vec<u8> {
        br#"{"data":{"viewer":{"login":"alice"},"search":{"nodes":[
          {"id":"PR_1","number":7,"title":"Review trusted change","url":"https://github.com/acme/api/pull/7","updatedAt":"2026-08-14T09:00:00Z","isDraft":false,"author":{"login":"bob"},"repository":{"nameWithOwner":"acme/api","url":"https://github.com/acme/api"},"reviewRequests":{"nodes":[{"requestedReviewer":{"__typename":"User","login":"alice"}}]}},
          {"id":"PR_2","number":8,"title":"Team request","url":"https://github.com/acme/api/pull/8","updatedAt":"2026-08-14T10:00:00Z","isDraft":false,"author":{"login":"bob"},"repository":{"nameWithOwner":"acme/api","url":"https://github.com/acme/api"},"reviewRequests":{"nodes":[{"requestedReviewer":{"__typename":"Team"}}]}},
          {"id":"PR_3","number":9,"title":"Untrusted repository","url":"https://github.com/acme/other/pull/9","updatedAt":"2026-08-14T11:00:00Z","isDraft":false,"author":{"login":"bob"},"repository":{"nameWithOwner":"acme/other","url":"https://github.com/acme/other"},"reviewRequests":{"nodes":[{"requestedReviewer":{"__typename":"User","login":"alice"}}]}}
        ]}}}"#.to_vec()
    }

    #[test]
    fn returns_only_explicit_requests_from_trusted_repositories() {
        let adapter = GithubReviewsAdapter::new(
            FakeRunner {
                calls: AtomicUsize::new(0),
                fail_after_success: false,
            },
            FixedResolver,
        );
        let repository =
            GithubTrustedRepository::from_origin("git@github.com:acme/api.git").unwrap();
        let result = adapter.list(&[repository]);
        assert_eq!(result.state, GithubReviewInboxState::Fresh);
        assert_eq!(result.reviews.len(), 1);
        assert_eq!(result.reviews[0].number, 7);
        assert_eq!(result.reviews[0].repository_id, "acme/api");
        assert_eq!(result.reviews[0].repository, "acme/api");
    }

    #[test]
    fn search_scope_uses_a_boolean_union_for_linked_repositories() {
        let repositories = [
            GithubTrustedRepository::from_origin("https://github.com/acme/api").unwrap(),
            GithubTrustedRepository::from_origin("https://github.com/acme/web").unwrap(),
        ]
        .into_iter()
        .collect::<BTreeSet<_>>();

        assert_eq!(
            review_search_query(&repositories),
            "is:pr is:open review-requested:@me (repo:acme/api OR repo:acme/web)"
        );
    }

    #[test]
    fn returns_stale_cache_after_a_bounded_provider_failure() {
        let adapter = GithubReviewsAdapter::new(
            FakeRunner {
                calls: AtomicUsize::new(0),
                fail_after_success: true,
            },
            FixedResolver,
        );
        let repository =
            GithubTrustedRepository::from_origin("https://github.com/acme/api.git").unwrap();
        assert_eq!(
            adapter.list(std::slice::from_ref(&repository)).state,
            GithubReviewInboxState::Fresh
        );
        let stale = adapter.list(&[repository]);
        assert_eq!(stale.state, GithubReviewInboxState::Stale);
        assert_eq!(
            stale.diagnostic_code,
            Some(GithubReviewDiagnosticCode::AuthenticationRequired)
        );
        assert_eq!(stale.reviews.len(), 1);
    }

    #[test]
    fn rejects_untrusted_origins_and_provider_urls() {
        assert!(GithubTrustedRepository::from_origin("https://evil.example/acme/api").is_none());
        assert!(GithubTrustedRepository::from_origin("https://github.com/acme/../api").is_none());
        assert!(
            GithubTrustedRepository::from_origin("https://github.example.com/acme/api").is_none()
        );
        let repository =
            GithubTrustedRepository::from_origin("https://github.com/acme/api").unwrap();
        let node: PullRequestNode = serde_json::from_value(serde_json::json!({
            "id":"PR_1","number":7,"title":"Bad URL","url":"https://evil.example/acme/api/pull/7",
            "updatedAt":"2026-08-14T09:00:00Z","isDraft":false,"author":{"login":"bob"},
            "repository":{"nameWithOwner":"acme/api","url":"https://github.com/acme/api"},"reviewRequests":{"nodes":[]}
        })).unwrap();
        assert!(validated_review(node, &repository).is_none());
    }

    #[test]
    fn reports_auth_and_error_states_without_cached_data() {
        let repository =
            GithubTrustedRepository::from_origin("https://github.com/acme/api").unwrap();
        let missing = GithubReviewsAdapter::new(
            FakeRunner {
                calls: AtomicUsize::new(0),
                fail_after_success: false,
            },
            MissingResolver,
        )
        .list(std::slice::from_ref(&repository));
        assert_eq!(missing.state, GithubReviewInboxState::Auth);
        assert_eq!(
            missing.diagnostic_code,
            Some(GithubReviewDiagnosticCode::GhMissing)
        );

        let invalid = GithubReviewsAdapter::new(InvalidRunner, FixedResolver).list(&[repository]);
        assert_eq!(invalid.state, GithubReviewInboxState::Error);
        assert_eq!(
            invalid.diagnostic_code,
            Some(GithubReviewDiagnosticCode::ProviderResponseInvalid)
        );
    }
}
