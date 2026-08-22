//! Lightweight discovery and bounded adapters for integrations available to WTS.
//!
//! Detection deliberately uses fixed executable names and arguments. It does
//! not invoke a shell, install software, contact a network service, or mutate
//! provider configuration. Runtime adapters are separate, explicit operations.

mod activity_watch;
mod github_reviews;
mod gitlab_merge_requests;
mod jira_mcp;
mod model;
mod open_project;
mod probe;
mod time_review;

pub use activity_watch::{
    ActivityWatchCapability, ActivityWatchConnector, ActivityWatchDailyReview,
    ActivityWatchDiagnosticCode, ActivityWatchError, ActivityWatchInstallation,
    ActivityWatchReviewError, ActivityWatchSessionCandidate, ActivityWatchSessionKind,
    ActivityWatchState, ActivityWatchStatus, DEFAULT_ACTIVITYWATCH_URL, WTS_ACTIVITYWATCH_URL_ENV,
};
pub use github_reviews::{
    GithubReview, GithubReviewDiagnosticCode, GithubReviewInbox, GithubReviewInboxState,
    GithubReviewsAdapter, GithubTrustedRepository,
};
pub use gitlab_merge_requests::{
    GitlabAccountState, GitlabAccountStatus, GitlabCliState, GitlabIntegrationStatus,
    GitlabMergeRequest, GitlabMergeRequestDiagnosticCode, GitlabMergeRequestInbox,
    GitlabMergeRequestInboxState, GitlabMergeRequestStatus, GitlabMergeRequestsAdapter,
    GitlabReview, GitlabReviewCommentRequest, GitlabReviewCommit, GitlabReviewDiscussion,
    GitlabReviewDiscussionComment, GitlabReviewInbox, GitlabReviewPatch, GitlabReviewState,
    GitlabReviewTrustedRepository, GitlabTrustedRepository, PublishGitlabReviewCommentResult,
};
pub use jira_mcp::{
    JiraActiveIssue, JiraActiveIssueList, JiraIssue, JiraMcpAdapter, JiraMcpError,
    JiraMcpVerification,
};
pub use model::{
    BlockingCapability, BrowserJourneyCheckStatus, BrowserJourneyDiagnosticCode,
    BrowserJourneyDiscoverySource, BrowserJourneyReadiness, BrowserJourneyReadinessCheck,
    DiagnosticCode, InstallationState, IntegrationCapability, IntegrationCategory, IntegrationId,
    IntegrationSnapshot, IntegrationStatus, RuntimeState, SetupSnapshot, SetupState,
    VerificationKind, WtsSupport,
};
pub use open_project::{
    OpenProjectAdapter, OpenProjectError, OpenProjectVerification, OpenProjectWorkPackage,
    WTS_OPENPROJECT_TOKEN_ENV, WTS_OPENPROJECT_URL_ENV,
};
pub use probe::{
    CommandProbe, CommandRunner, HostIntegrationSignals, IntegrationDetector, PathResolver,
    ProbeFailure, ProbeOutput, ProcessCommandRunner, SystemPathResolver, WTS_JIRA_MCP_URL_ENV,
};
pub use time_review::{
    TimeReviewAgentBrief, TimeReviewAssignmentProposal, TimeReviewAssignmentTarget,
    TimeReviewContractError, TimeReviewJiraCandidate, TimeReviewLedgerRow,
    TimeReviewNewJiraIssueProposal, TimeReviewProposalDocument,
};
