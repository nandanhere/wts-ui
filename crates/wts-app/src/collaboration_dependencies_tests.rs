use super::*;

#[derive(Clone, Default)]
struct DependencyAdapter {
    completed: Arc<Mutex<Vec<String>>>,
}
impl CollaborationAdapter for DependencyAdapter {
    fn confinement(&self, _: AgentProvider) -> CollaborationConfinement {
        CollaborationConfinement::WorkspaceWriteIsolated
    }
    fn run(&self, invocation: CollaborationInvocation) -> CollaborationAdapterOutcome {
        if invocation.prompt() == "child" {
            assert!(
                recover_lock(&self.completed)
                    .iter()
                    .any(|name| name == "z-parent")
            );
        }
        if invocation.prompt() == "fail" {
            recover_lock(&self.completed).push(invocation.task_id().to_string());
            return CollaborationAdapterOutcome::Failed {
                failure: CollaborationAdapterFailure::ProviderFailed,
                output: "The parent task failed.".to_owned(),
            };
        }
        fs::write(
            invocation.scope_root().join("result.txt"),
            invocation.task_id().as_str(),
        )
        .unwrap();
        recover_lock(&self.completed).push(invocation.task_id().to_string());
        CollaborationAdapterOutcome::Succeeded {
            output: "The task completed.".to_owned(),
        }
    }
}
fn id(value: &str) -> CollaborationTaskId {
    CollaborationTaskId::parse(value).unwrap()
}
fn plan(root: &Path, entries: &[(&str, &str, u32)]) -> CollaborationPlan {
    CollaborationPlan {
        collaboration_id: Uuid::new_v4(),
        tasks: entries
            .iter()
            .enumerate()
            .map(|(index, (name, prompt, phase))| {
                let workspace = root.join(name);
                fs::create_dir_all(&workspace).unwrap();
                CollaborationTask {
                    task_id: id(name),
                    workspace_id: Uuid::from_u128(index as u128 + 1),
                    workspace_root: workspace.clone(),
                    scope_root: workspace,
                    provider: AgentProvider::Codex,
                    prompt: (*prompt).to_owned(),
                    phase: *phase,
                    timeout: Duration::from_secs(2),
                }
            })
            .collect(),
    }
}
fn dependencies(
    entries: &[(&str, &[&str])],
) -> BTreeMap<CollaborationTaskId, Vec<CollaborationTaskId>> {
    entries
        .iter()
        .map(|(task, parents)| (id(task), parents.iter().map(|value| id(value)).collect()))
        .collect()
}

#[test]
fn same_phase_dependencies_wait_for_success_before_source_effects() {
    let temp = tempfile::tempdir().unwrap();
    let adapter = DependencyAdapter::default();
    let completed = adapter.completed.clone();
    let coordinator = CollaborationCoordinator::new(
        adapter,
        CollaborationLimits {
            maximum_parallel_agents: 1,
            ..CollaborationLimits::default()
        },
    )
    .unwrap();
    let report = coordinator
        .execute_with_dependencies(
            plan(
                temp.path(),
                &[("a-child", "child", 0), ("z-parent", "parent", 0)],
            ),
            dependencies(&[("a-child", &["z-parent"])]),
            &CollaborationControl::default(),
        )
        .unwrap();
    assert!(
        report
            .tasks
            .iter()
            .all(|task| task.state == CollaborationTaskState::Succeeded)
    );
    assert_eq!(*recover_lock(&completed), vec!["z-parent", "a-child"]);
    assert_eq!(
        fs::read_to_string(temp.path().join("a-child/result.txt")).unwrap(),
        "a-child"
    );
    assert_eq!(
        report
            .tasks
            .iter()
            .map(|task| task.task_id.as_str())
            .collect::<Vec<_>>(),
        vec!["a-child", "z-parent"]
    );
}

#[test]
fn failed_dependencies_block_descendants_and_keep_independent_work() {
    let temp = tempfile::tempdir().unwrap();
    let adapter = DependencyAdapter::default();
    let completed = adapter.completed.clone();
    let coordinator =
        CollaborationCoordinator::new(adapter, CollaborationLimits::default()).unwrap();
    let report = coordinator
        .execute_with_dependencies(
            plan(
                temp.path(),
                &[
                    ("z-parent", "fail", 0),
                    ("a-child", "child", 1),
                    ("grandchild", "other", 2),
                    ("independent", "other", 2),
                ],
            ),
            dependencies(&[("a-child", &["z-parent"]), ("grandchild", &["a-child"])]),
            &CollaborationControl::default(),
        )
        .unwrap();
    let result = |name| {
        report
            .tasks
            .iter()
            .find(|task| task.task_id == id(name))
            .unwrap()
    };
    assert_eq!(
        result("z-parent").state,
        CollaborationTaskState::ProviderFailed
    );
    for name in ["a-child", "grandchild"] {
        assert_eq!(
            result(name).state,
            CollaborationTaskState::DependencyBlocked
        );
        assert!(result(name).started_at_unix_ms.is_none());
        assert!(!temp.path().join(name).join("result.txt").exists());
    }
    assert!(result("a-child").output.contains("z-parent"));
    assert_eq!(*recover_lock(&completed), vec!["z-parent", "independent"]);
    assert_eq!(
        result("independent").state,
        CollaborationTaskState::Succeeded
    );
    assert_eq!(
        coordinator
            .retained_evidence()
            .iter()
            .filter(|task| task.state == CollaborationTaskState::DependencyBlocked)
            .count(),
        2
    );
}

#[test]
fn invalid_dependency_graphs_fail_before_any_process_effect() {
    for (entries, edges, expected) in [
        (
            vec![("a", "other", 0), ("b", "other", 0)],
            dependencies(&[("a", &["b"]), ("b", &["a"])]),
            CollaborationPlanError::DependencyCycle,
        ),
        (
            vec![("a", "other", 0)],
            dependencies(&[("a", &["a"])]),
            CollaborationPlanError::DependencyCycle,
        ),
        (
            vec![("a", "other", 0)],
            dependencies(&[("missing", &["a"])]),
            CollaborationPlanError::UnknownDependency,
        ),
        (
            vec![("a", "other", 0)],
            dependencies(&[("a", &["missing"])]),
            CollaborationPlanError::UnknownDependency,
        ),
        (
            vec![("a", "other", 0), ("b", "other", 0)],
            dependencies(&[("b", &["a", "a"])]),
            CollaborationPlanError::DuplicateDependency,
        ),
        (
            vec![("a", "other", 0), ("b", "other", 1)],
            dependencies(&[("a", &["b"])]),
            CollaborationPlanError::DependencyPhaseConflict,
        ),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let adapter = DependencyAdapter::default();
        let completed = adapter.completed.clone();
        let coordinator =
            CollaborationCoordinator::new(adapter, CollaborationLimits::default()).unwrap();
        assert_eq!(
            coordinator.execute_with_dependencies(
                plan(temp.path(), &entries),
                edges,
                &CollaborationControl::default()
            ),
            Err(expected)
        );
        assert!(recover_lock(&completed).is_empty());
        assert!(coordinator.retained_evidence().is_empty());
    }
}

#[test]
fn dependency_failure_evidence_obeys_the_output_limit() {
    let temp = tempfile::tempdir().unwrap();
    let coordinator = CollaborationCoordinator::new(
        DependencyAdapter::default(),
        CollaborationLimits {
            maximum_output_bytes: 1,
            ..CollaborationLimits::default()
        },
    )
    .unwrap();
    let report = coordinator
        .execute_with_dependencies(
            plan(
                temp.path(),
                &[("z-parent", "fail", 0), ("a-child", "child", 1)],
            ),
            dependencies(&[("a-child", &["z-parent"])]),
            &CollaborationControl::default(),
        )
        .unwrap();
    assert!(report.tasks.iter().all(|task| task.output.len() <= 1));
    assert_eq!(
        report.tasks[1].state,
        CollaborationTaskState::DependencyBlocked
    );
    assert!(!temp.path().join("a-child/result.txt").exists());
}
