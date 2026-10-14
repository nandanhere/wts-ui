use std::time::{SystemTime, UNIX_EPOCH};
use wts_integrations::{ActivityWatchConnector, ActivityWatchState};

/// Opt-in smoke check for a real ActivityWatch installation.
///
/// Run with:
/// `cargo test -p wts-integrations --test activity_watch_local -- --ignored`
///
/// The connector contract returned to this test is already privacy-safe; raw
/// ActivityWatch event payloads are never printed or asserted here.
#[test]
#[ignore = "requires ActivityWatch running on the configured loopback endpoint"]
fn builds_a_sanitized_review_from_the_real_local_activitywatch_api() {
    let connector = ActivityWatchConnector::configured(None).expect("valid local endpoint");
    let status = connector.status();
    assert_eq!(
        status.state,
        ActivityWatchState::Running,
        "ActivityWatch must be running for the opt-in smoke check"
    );

    let ended_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("current time after Unix epoch")
        .as_millis() as i64;
    let started_at_unix_ms = ended_at_unix_ms - 15 * 60 * 1_000;
    let review = connector
        .daily_review(started_at_unix_ms, ended_at_unix_ms)
        .expect("real local ActivityWatch review");

    assert_eq!(review.schema_version, 1);
    assert_eq!(review.started_at_unix_ms, started_at_unix_ms);
    assert_eq!(review.ended_at_unix_ms, ended_at_unix_ms);
    assert!(
        review.detail.contains(
            "Raw ActivityWatch titles, URLs, paths, and event payloads were not retained"
        )
    );
}
