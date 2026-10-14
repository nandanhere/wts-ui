use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;
use uuid::Uuid;

pub const SANITIZED_ATTENTION_SCHEMA_VERSION: u32 = 1;
pub const TIME_REVIEW_SCHEMA_VERSION: u32 = 1;
pub const MAX_SANITIZED_ATTENTION_INTERVALS: usize = 4_096;

const MILLIS_PER_MINUTE: i64 = 60_000;
const MILLIS_PER_DAY: i64 = 24 * 60 * MILLIS_PER_MINUTE;
const MAX_UTC_OFFSET_MINUTES: i16 = 14 * 60;
const MAX_PROJECT_KEY_BYTES: usize = 32;
const MAX_ISSUE_NUMBER_BYTES: usize = 18;
const MAX_PROPOSAL_SUMMARY_CHARS: usize = 240;

/// A privacy-safe human-attention interval supplied by an adapter.
///
/// This contract intentionally cannot carry window titles, URLs, prompts,
/// transcripts, terminal output, or other raw observation content.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SanitizedAttentionInterval {
    pub schema_version: u32,
    pub started_at_unix_ms: i64,
    pub ended_at_unix_ms: i64,
    pub workspace_id: Option<Uuid>,
    pub attribution: TimeAttribution,
}

/// A review-time proposal only. Nothing in this module performs a Jira write.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TimeAttribution {
    ExistingJira {
        issue_key: String,
    },
    CreateTicketProposal {
        project_key: Option<String>,
        summary: String,
    },
    Unassigned,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeReviewSegment {
    pub started_at_unix_ms: i64,
    pub ended_at_unix_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeReviewGroup {
    pub workspace_id: Option<Uuid>,
    pub attribution: TimeAttribution,
    pub attention_ms: i64,
    pub segments: Vec<TimeReviewSegment>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeReviewDraft {
    pub schema_version: u32,
    pub total_attention_ms: i64,
    pub unassigned_attention_ms: i64,
    pub groups: Vec<TimeReviewGroup>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeReviewSchedule {
    /// Minute after local midnight, in the inclusive range 0..=1439.
    pub minute_of_local_day: u16,
    /// The local offset applicable at `now`, supplied by the platform.
    pub utc_offset_minutes: i16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TimeReviewScheduleState {
    NotDue {
        next_due_at_unix_ms: i64,
    },
    Due {
        local_day: i64,
        due_at_unix_ms: i64,
    },
    CatchUp {
        oldest_unreviewed_local_day: i64,
        latest_due_local_day: i64,
        due_days: u32,
    },
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum TimeReviewError {
    #[error("too many sanitized attention intervals")]
    TooManyIntervals,
    #[error("sanitized attention interval is invalid")]
    InvalidInterval,
    #[error("time attribution is invalid")]
    InvalidAttribution,
    #[error("time review schedule is invalid")]
    InvalidSchedule,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct GroupKey {
    workspace_id: Option<Uuid>,
    attribution: TimeAttribution,
}

pub fn build_time_review_draft(
    intervals: &[SanitizedAttentionInterval],
) -> Result<TimeReviewDraft, TimeReviewError> {
    if intervals.len() > MAX_SANITIZED_ATTENTION_INTERVALS {
        return Err(TimeReviewError::TooManyIntervals);
    }
    if intervals.iter().any(|interval| {
        interval.schema_version != SANITIZED_ATTENTION_SCHEMA_VERSION
            || interval.started_at_unix_ms < 0
            || interval.ended_at_unix_ms <= interval.started_at_unix_ms
    }) {
        return Err(TimeReviewError::InvalidInterval);
    }
    if intervals
        .iter()
        .any(|interval| !valid_attribution(&interval.attribution))
    {
        return Err(TimeReviewError::InvalidAttribution);
    }

    let boundaries = intervals
        .iter()
        .flat_map(|interval| [interval.started_at_unix_ms, interval.ended_at_unix_ms])
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let mut normalized = Vec::<(GroupKey, TimeReviewSegment)>::new();

    for pair in boundaries.windows(2) {
        let started_at_unix_ms = pair[0];
        let ended_at_unix_ms = pair[1];
        let active = intervals
            .iter()
            .filter(|interval| {
                interval.started_at_unix_ms < ended_at_unix_ms
                    && interval.ended_at_unix_ms > started_at_unix_ms
            })
            .collect::<Vec<_>>();
        if active.is_empty() {
            continue;
        }

        let first = active[0];
        let same_group = active.iter().all(|interval| {
            interval.workspace_id == first.workspace_id && interval.attribution == first.attribution
        });
        let key = if same_group {
            GroupKey {
                workspace_id: first.workspace_id,
                attribution: first.attribution.clone(),
            }
        } else {
            let common_workspace = active
                .iter()
                .all(|interval| interval.workspace_id == first.workspace_id)
                .then_some(first.workspace_id)
                .flatten();
            GroupKey {
                workspace_id: common_workspace,
                attribution: TimeAttribution::Unassigned,
            }
        };

        if let Some((previous_key, previous_segment)) = normalized.last_mut()
            && *previous_key == key
            && previous_segment.ended_at_unix_ms == started_at_unix_ms
        {
            previous_segment.ended_at_unix_ms = ended_at_unix_ms;
        } else {
            normalized.push((
                key,
                TimeReviewSegment {
                    started_at_unix_ms,
                    ended_at_unix_ms,
                },
            ));
        }
    }

    let mut grouped = BTreeMap::<GroupKey, Vec<TimeReviewSegment>>::new();
    for (key, segment) in normalized {
        grouped.entry(key).or_default().push(segment);
    }
    let groups = grouped
        .into_iter()
        .map(|(key, segments)| {
            let attention_ms = segments
                .iter()
                .map(|segment| segment.ended_at_unix_ms - segment.started_at_unix_ms)
                .sum();
            TimeReviewGroup {
                workspace_id: key.workspace_id,
                attribution: key.attribution,
                attention_ms,
                segments,
            }
        })
        .collect::<Vec<_>>();
    let total_attention_ms = groups.iter().map(|group| group.attention_ms).sum();
    let unassigned_attention_ms = groups
        .iter()
        .filter(|group| group.attribution == TimeAttribution::Unassigned)
        .map(|group| group.attention_ms)
        .sum();

    Ok(TimeReviewDraft {
        schema_version: TIME_REVIEW_SCHEMA_VERSION,
        total_attention_ms,
        unassigned_attention_ms,
        groups,
    })
}

fn valid_attribution(attribution: &TimeAttribution) -> bool {
    match attribution {
        TimeAttribution::ExistingJira { issue_key } => {
            let Some((project_key, issue_number)) = issue_key.split_once('-') else {
                return false;
            };
            valid_project_key(project_key)
                && !issue_number.is_empty()
                && issue_number.len() <= MAX_ISSUE_NUMBER_BYTES
                && !issue_number.starts_with('0')
                && issue_number.bytes().all(|byte| byte.is_ascii_digit())
        }
        TimeAttribution::CreateTicketProposal {
            project_key,
            summary,
        } => {
            project_key.as_deref().is_none_or(valid_project_key)
                && !summary.is_empty()
                && summary.trim() == summary
                && summary.chars().count() <= MAX_PROPOSAL_SUMMARY_CHARS
                && !summary.chars().any(char::is_control)
        }
        TimeAttribution::Unassigned => true,
    }
}

fn valid_project_key(project_key: &str) -> bool {
    (2..=MAX_PROJECT_KEY_BYTES).contains(&project_key.len())
        && project_key
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_uppercase())
        && project_key
            .bytes()
            .skip(1)
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

/// Computes whether the local daily review is due without running a scheduler.
///
/// Local days are integer day identifiers relative to the Unix epoch. The
/// platform must supply the UTC offset currently in effect; a later scheduler
/// adapter remains responsible for timezone/DST lookup and wake-up delivery.
pub fn time_review_schedule_state(
    schedule: TimeReviewSchedule,
    now_unix_ms: i64,
    last_completed_local_day: Option<i64>,
) -> Result<TimeReviewScheduleState, TimeReviewError> {
    if schedule.minute_of_local_day >= 24 * 60
        || schedule.utc_offset_minutes.abs() > MAX_UTC_OFFSET_MINUTES
        || now_unix_ms < 0
    {
        return Err(TimeReviewError::InvalidSchedule);
    }

    let offset_ms = i64::from(schedule.utc_offset_minutes) * MILLIS_PER_MINUTE;
    let local_now_ms = now_unix_ms + offset_ms;
    let current_local_day = local_now_ms.div_euclid(MILLIS_PER_DAY);
    let current_local_minute = local_now_ms.rem_euclid(MILLIS_PER_DAY) / MILLIS_PER_MINUTE;
    let scheduled_minute = i64::from(schedule.minute_of_local_day);
    let latest_due_local_day = if current_local_minute >= scheduled_minute {
        current_local_day
    } else {
        current_local_day - 1
    };
    let due_at_unix_ms =
        latest_due_local_day * MILLIS_PER_DAY + scheduled_minute * MILLIS_PER_MINUTE - offset_ms;

    match last_completed_local_day {
        Some(completed) if completed >= latest_due_local_day => {
            let next_local_day = if current_local_minute < scheduled_minute {
                current_local_day
            } else {
                current_local_day + 1
            };
            Ok(TimeReviewScheduleState::NotDue {
                next_due_at_unix_ms: next_local_day * MILLIS_PER_DAY
                    + scheduled_minute * MILLIS_PER_MINUTE
                    - offset_ms,
            })
        }
        Some(completed) if latest_due_local_day.saturating_sub(completed) > 1 => {
            let due_days =
                u32::try_from(latest_due_local_day.saturating_sub(completed)).unwrap_or(u32::MAX);
            Ok(TimeReviewScheduleState::CatchUp {
                oldest_unreviewed_local_day: completed + 1,
                latest_due_local_day,
                due_days,
            })
        }
        _ => Ok(TimeReviewScheduleState::Due {
            local_day: latest_due_local_day,
            due_at_unix_ms,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn interval(
        start: i64,
        end: i64,
        workspace_id: Option<Uuid>,
        attribution: TimeAttribution,
    ) -> SanitizedAttentionInterval {
        SanitizedAttentionInterval {
            schema_version: SANITIZED_ATTENTION_SCHEMA_VERSION,
            started_at_unix_ms: start,
            ended_at_unix_ms: end,
            workspace_id,
            attribution,
        }
    }

    #[test]
    fn overlapping_attention_for_one_issue_is_unioned_not_double_counted() {
        let workspace_id = Uuid::new_v4();
        let attribution = TimeAttribution::ExistingJira {
            issue_key: "WTS-42".to_owned(),
        };
        let draft = build_time_review_draft(&[
            interval(1_000, 5_000, Some(workspace_id), attribution.clone()),
            interval(3_000, 7_000, Some(workspace_id), attribution.clone()),
        ])
        .expect("draft");

        assert_eq!(draft.total_attention_ms, 6_000);
        assert_eq!(draft.groups.len(), 1);
        assert_eq!(draft.groups[0].attention_ms, 6_000);
        assert_eq!(
            draft.groups[0].segments,
            vec![TimeReviewSegment {
                started_at_unix_ms: 1_000,
                ended_at_unix_ms: 7_000,
            }]
        );
    }

    #[test]
    fn conflicting_parallel_attributions_require_review_without_double_counting() {
        let workspace_id = Uuid::new_v4();
        let draft = build_time_review_draft(&[
            interval(
                1_000,
                5_000,
                Some(workspace_id),
                TimeAttribution::ExistingJira {
                    issue_key: "WTS-42".to_owned(),
                },
            ),
            interval(
                3_000,
                7_000,
                Some(workspace_id),
                TimeAttribution::ExistingJira {
                    issue_key: "WTS-84".to_owned(),
                },
            ),
        ])
        .expect("draft");

        assert_eq!(draft.total_attention_ms, 6_000);
        assert_eq!(draft.unassigned_attention_ms, 2_000);
        let conflicted = draft
            .groups
            .iter()
            .find(|group| group.attribution == TimeAttribution::Unassigned)
            .expect("review-required overlap");
        assert_eq!(conflicted.workspace_id, Some(workspace_id));
        assert_eq!(conflicted.attention_ms, 2_000);
    }

    #[test]
    fn serialized_contract_distinguishes_existing_unassigned_and_ticket_proposal() {
        let workspace_id = Uuid::new_v4();
        let draft = build_time_review_draft(&[
            interval(
                1_000,
                2_000,
                Some(workspace_id),
                TimeAttribution::ExistingJira {
                    issue_key: "WTS-42".to_owned(),
                },
            ),
            interval(
                3_000,
                4_000,
                None,
                TimeAttribution::CreateTicketProposal {
                    project_key: Some("WTS".to_owned()),
                    summary: "Review agent session evidence".to_owned(),
                },
            ),
            interval(5_000, 6_000, None, TimeAttribution::Unassigned),
        ])
        .expect("draft");
        let value = serde_json::to_value(&draft).expect("serialized review draft");

        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["totalAttentionMs"], 3_000);
        assert!(value["groups"].as_array().is_some_and(|groups| {
            groups.iter().any(|group| {
                group["attribution"] == json!({"kind": "existingJira", "issueKey": "WTS-42"})
            }) && groups.iter().any(|group| {
                group["attribution"]
                    == json!({
                        "kind": "createTicketProposal",
                        "projectKey": "WTS",
                        "summary": "Review agent session evidence"
                    })
            }) && groups
                .iter()
                .any(|group| group["attribution"] == json!({"kind": "unassigned"}))
        }));
        let encoded = serde_json::to_string(&value).expect("JSON text");
        for forbidden in [
            "windowTitle",
            "url",
            "prompt",
            "transcript",
            "terminalOutput",
        ] {
            assert!(!encoded.contains(forbidden));
        }
    }

    #[test]
    fn rejects_noncanonical_jira_identifiers_and_unsanitized_proposal_text() {
        let invalid_attributions = [
            TimeAttribution::ExistingJira {
                issue_key: "wts-42".to_owned(),
            },
            TimeAttribution::ExistingJira {
                issue_key: "WTS-0".to_owned(),
            },
            TimeAttribution::ExistingJira {
                issue_key: "WTS-42-extra".to_owned(),
            },
            TimeAttribution::CreateTicketProposal {
                project_key: Some("wts".to_owned()),
                summary: "Review agent evidence".to_owned(),
            },
            TimeAttribution::CreateTicketProposal {
                project_key: Some("WTS".to_owned()),
                summary: " leading whitespace".to_owned(),
            },
            TimeAttribution::CreateTicketProposal {
                project_key: None,
                summary: "raw title\nsecond line".to_owned(),
            },
            TimeAttribution::CreateTicketProposal {
                project_key: None,
                summary: "x".repeat(MAX_PROPOSAL_SUMMARY_CHARS + 1),
            },
        ];

        for attribution in invalid_attributions {
            assert_eq!(
                build_time_review_draft(&[interval(1_000, 2_000, None, attribution)]),
                Err(TimeReviewError::InvalidAttribution)
            );
        }
    }

    #[test]
    fn rejects_batches_above_the_interval_processing_bound() {
        let repeated = interval(1_000, 2_000, None, TimeAttribution::Unassigned);
        let intervals = vec![repeated; MAX_SANITIZED_ATTENTION_INTERVALS + 1];

        assert_eq!(
            build_time_review_draft(&intervals),
            Err(TimeReviewError::TooManyIntervals)
        );
    }

    #[test]
    fn schedule_uses_local_day_boundary_and_reports_catch_up() {
        let schedule = TimeReviewSchedule {
            minute_of_local_day: 18 * 60,
            utc_offset_minutes: 330,
        };
        // UTC day 10 at 12:45 is local day 10 at 18:15 (+05:30).
        let now = 10 * MILLIS_PER_DAY + (12 * 60 + 45) * MILLIS_PER_MINUTE;
        assert_eq!(
            time_review_schedule_state(schedule, now, Some(7)).expect("schedule"),
            TimeReviewScheduleState::CatchUp {
                oldest_unreviewed_local_day: 8,
                latest_due_local_day: 10,
                due_days: 3,
            }
        );

        // At 12:15 UTC it is 17:45 locally, so today's review is not due yet.
        let before_due = 10 * MILLIS_PER_DAY + (12 * 60 + 15) * MILLIS_PER_MINUTE;
        assert_eq!(
            time_review_schedule_state(schedule, before_due, Some(9)).expect("schedule"),
            TimeReviewScheduleState::NotDue {
                next_due_at_unix_ms: 10 * MILLIS_PER_DAY + (12 * 60 + 30) * MILLIS_PER_MINUTE,
            }
        );
    }
}
