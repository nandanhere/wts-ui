//! Deterministic cross-repository commit-vector selection.
//!
//! Independent "latest default branch" selection can produce a set of commits
//! that never passed together. This solver maximizes evidence score while
//! honoring every repository pair for which compatibility evidence exists.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitCandidate {
    pub repository: String,
    pub base_ref: String,
    pub commit: String,
    /// Higher values represent stronger recency/CI/release evidence.
    pub evidence_score: u32,
    pub evidence: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompatiblePair {
    pub left_repository: String,
    pub left_commit: String,
    pub right_repository: String,
    pub right_commit: String,
    pub evidence: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompatibilityProblem {
    pub required_repositories: Vec<String>,
    pub candidates: Vec<CommitCandidate>,
    /// If any pair is declared for two repositories, their relationship is
    /// closed: only the listed commit pairs are compatible.
    pub compatible_pairs: Vec<CompatiblePair>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompatibilityVector {
    pub commits: Vec<CommitCandidate>,
    pub evidence_score: u64,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CompatibilityError {
    #[error("at least one repository is required")]
    EmptyProblem,
    #[error("repository names must be unique: {0}")]
    DuplicateRepository(String),
    #[error("no commit candidates were supplied for repository {0}")]
    MissingCandidates(String),
    #[error("candidate {commit} references repository outside the required closure: {repository}")]
    CandidateOutsideClosure { repository: String, commit: String },
    #[error("no compatible commit vector satisfies the supplied constraints")]
    NoCompatibleVector,
}

pub fn solve_compatibility_vector(
    mut problem: CompatibilityProblem,
) -> Result<CompatibilityVector, CompatibilityError> {
    if problem.required_repositories.is_empty() {
        return Err(CompatibilityError::EmptyProblem);
    }

    problem.required_repositories.sort();
    for pair in problem.required_repositories.windows(2) {
        if pair[0] == pair[1] {
            return Err(CompatibilityError::DuplicateRepository(pair[0].clone()));
        }
    }

    let required: BTreeSet<_> = problem.required_repositories.iter().cloned().collect();
    let mut candidates_by_repository: BTreeMap<String, Vec<CommitCandidate>> = BTreeMap::new();
    for mut candidate in problem.candidates {
        if !required.contains(&candidate.repository) {
            return Err(CompatibilityError::CandidateOutsideClosure {
                repository: candidate.repository,
                commit: candidate.commit,
            });
        }
        candidate.evidence.sort();
        candidate.evidence.dedup();
        candidates_by_repository
            .entry(candidate.repository.clone())
            .or_default()
            .push(candidate);
    }

    for repository in &problem.required_repositories {
        let candidates = candidates_by_repository
            .get_mut(repository)
            .ok_or_else(|| CompatibilityError::MissingCandidates(repository.clone()))?;
        candidates.sort_by(|left, right| {
            right
                .evidence_score
                .cmp(&left.evidence_score)
                .then(left.commit.cmp(&right.commit))
                .then(left.base_ref.cmp(&right.base_ref))
        });
        candidates.dedup_by(|left, right| left.commit == right.commit);
    }

    let constraints = CompatibilityConstraints::new(problem.compatible_pairs);
    let mut best: Option<CompatibilityVector> = None;
    search(
        &problem.required_repositories,
        &candidates_by_repository,
        &constraints,
        0,
        &mut Vec::new(),
        0,
        &mut best,
    );

    best.ok_or(CompatibilityError::NoCompatibleVector)
}

fn search(
    repositories: &[String],
    candidates: &BTreeMap<String, Vec<CommitCandidate>>,
    constraints: &CompatibilityConstraints,
    index: usize,
    chosen: &mut Vec<CommitCandidate>,
    score: u64,
    best: &mut Option<CompatibilityVector>,
) {
    if index == repositories.len() {
        let vector = CompatibilityVector {
            commits: chosen.clone(),
            evidence_score: score,
        };
        if is_better(&vector, best.as_ref()) {
            *best = Some(vector);
        }
        return;
    }

    let repository = &repositories[index];
    let Some(options) = candidates.get(repository) else {
        return;
    };
    for candidate in options {
        if chosen
            .iter()
            .all(|existing| constraints.allows(existing, candidate))
        {
            chosen.push(candidate.clone());
            search(
                repositories,
                candidates,
                constraints,
                index + 1,
                chosen,
                score + u64::from(candidate.evidence_score),
                best,
            );
            chosen.pop();
        }
    }
}

fn is_better(candidate: &CompatibilityVector, current: Option<&CompatibilityVector>) -> bool {
    let Some(current) = current else {
        return true;
    };
    candidate.evidence_score > current.evidence_score
        || (candidate.evidence_score == current.evidence_score
            && canonical_commits(candidate) < canonical_commits(current))
}

fn canonical_commits(vector: &CompatibilityVector) -> Vec<(&str, &str)> {
    vector
        .commits
        .iter()
        .map(|candidate| (candidate.repository.as_str(), candidate.commit.as_str()))
        .collect()
}

struct CompatibilityConstraints {
    constrained_repository_pairs: BTreeSet<(String, String)>,
    allowed_commit_pairs: BTreeSet<(String, String, String, String)>,
}

impl CompatibilityConstraints {
    fn new(pairs: Vec<CompatiblePair>) -> Self {
        let mut constrained_repository_pairs = BTreeSet::new();
        let mut allowed_commit_pairs = BTreeSet::new();
        for pair in pairs {
            let (left_repository, left_commit, right_repository, right_commit) =
                canonical_pair(&pair);
            constrained_repository_pairs
                .insert((left_repository.clone(), right_repository.clone()));
            allowed_commit_pairs.insert((
                left_repository,
                left_commit,
                right_repository,
                right_commit,
            ));
        }
        Self {
            constrained_repository_pairs,
            allowed_commit_pairs,
        }
    }

    fn allows(&self, left: &CommitCandidate, right: &CommitCandidate) -> bool {
        let (left_repository, left_commit, right_repository, right_commit) =
            canonical_candidate_pair(left, right);
        if !self
            .constrained_repository_pairs
            .contains(&(left_repository.clone(), right_repository.clone()))
        {
            return true;
        }
        self.allowed_commit_pairs.contains(&(
            left_repository,
            left_commit,
            right_repository,
            right_commit,
        ))
    }
}

fn canonical_pair(pair: &CompatiblePair) -> (String, String, String, String) {
    if pair.left_repository <= pair.right_repository {
        (
            pair.left_repository.clone(),
            pair.left_commit.clone(),
            pair.right_repository.clone(),
            pair.right_commit.clone(),
        )
    } else {
        (
            pair.right_repository.clone(),
            pair.right_commit.clone(),
            pair.left_repository.clone(),
            pair.left_commit.clone(),
        )
    }
}

fn canonical_candidate_pair(
    left: &CommitCandidate,
    right: &CommitCandidate,
) -> (String, String, String, String) {
    if left.repository <= right.repository {
        (
            left.repository.clone(),
            left.commit.clone(),
            right.repository.clone(),
            right.commit.clone(),
        )
    } else {
        (
            right.repository.clone(),
            right.commit.clone(),
            left.repository.clone(),
            left.commit.clone(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(repository: &str, commit: &str, score: u32) -> CommitCandidate {
        CommitCandidate {
            repository: repository.into(),
            base_ref: "main".into(),
            commit: commit.into(),
            evidence_score: score,
            evidence: vec!["ci".into()],
        }
    }

    fn pair(
        left_repository: &str,
        left_commit: &str,
        right_repository: &str,
        right_commit: &str,
    ) -> CompatiblePair {
        CompatiblePair {
            left_repository: left_repository.into(),
            left_commit: left_commit.into(),
            right_repository: right_repository.into(),
            right_commit: right_commit.into(),
            evidence: vec!["integration-ci".into()],
        }
    }

    #[test]
    fn selects_a_coherent_vector_instead_of_independent_latest_commits() {
        let result = solve_compatibility_vector(CompatibilityProblem {
            required_repositories: vec!["checkout-api".into(), "payments-sdk".into()],
            candidates: vec![
                candidate("checkout-api", "checkout-new", 100),
                candidate("checkout-api", "checkout-stable", 90),
                candidate("payments-sdk", "payments-new", 100),
                candidate("payments-sdk", "payments-stable", 90),
            ],
            compatible_pairs: vec![
                pair(
                    "checkout-api",
                    "checkout-new",
                    "payments-sdk",
                    "payments-stable",
                ),
                pair(
                    "checkout-api",
                    "checkout-stable",
                    "payments-sdk",
                    "payments-stable",
                ),
            ],
        })
        .unwrap();

        assert_eq!(result.evidence_score, 190);
        assert_eq!(result.commits[0].commit, "checkout-new");
        assert_eq!(result.commits[1].commit, "payments-stable");
    }

    #[test]
    fn input_order_does_not_change_the_selected_vector() {
        let pairs = vec![pair("a", "a1", "b", "b1")];
        let forward = solve_compatibility_vector(CompatibilityProblem {
            required_repositories: vec!["a".into(), "b".into()],
            candidates: vec![candidate("a", "a1", 10), candidate("b", "b1", 10)],
            compatible_pairs: pairs.clone(),
        })
        .unwrap();
        let reversed = solve_compatibility_vector(CompatibilityProblem {
            required_repositories: vec!["b".into(), "a".into()],
            candidates: vec![candidate("b", "b1", 10), candidate("a", "a1", 10)],
            compatible_pairs: pairs,
        })
        .unwrap();

        assert_eq!(forward, reversed);
    }

    #[test]
    fn fails_when_all_declared_repository_pairs_are_incompatible() {
        let result = solve_compatibility_vector(CompatibilityProblem {
            required_repositories: vec!["a".into(), "b".into()],
            candidates: vec![candidate("a", "a2", 20), candidate("b", "b2", 20)],
            compatible_pairs: vec![pair("a", "a1", "b", "b1")],
        });

        assert_eq!(result, Err(CompatibilityError::NoCompatibleVector));
    }
}
