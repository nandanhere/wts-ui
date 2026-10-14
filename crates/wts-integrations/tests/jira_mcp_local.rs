use wts_integrations::JiraMcpAdapter;

/// Opt-in smoke check for the Jira MCP registration on this machine.
///
/// Run with:
/// `cargo test -p wts-integrations --test jira_mcp_local -- --ignored`
///
/// Only the bounded issue key, summary, and status projection is retained.
#[test]
#[ignore = "requires a configured and authenticated Jira MCP stdio server"]
fn lists_assigned_active_issues_through_the_real_jira_mcp_registration() {
    let adapter = JiraMcpAdapter;
    let verification = adapter.verify().expect("connected Jira MCP");
    assert!(verification.connected);

    let issues = adapter
        .active_issues()
        .expect("assigned active Jira issues");
    assert_eq!(issues.schema_version, 1);
    assert!(issues.issues.len() <= 20);
    assert!(issues.issues.iter().all(|issue| !issue.issue_key.is_empty()
        && !issue.summary.is_empty()
        && !issue.status.is_empty()));
}
