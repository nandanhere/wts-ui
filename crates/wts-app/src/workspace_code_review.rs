use super::*;
use crate::{
    AgentModelCatalog, CODE_REVIEW_SCHEMA_VERSION, CodeReviewMergeRequest, CodeReviewMode,
    CodeReviewOptions, CodeReviewOutcome, CodeReviewPrecedent, CodeReviewRepository,
    CodeReviewScope, CodeReviewSkillRef, CodeReviewStrictness, WorkspaceCodeReviewResult,
    agent_models::{ModelSources, discover_agent_models, valid_model_name},
    code_review::{
        ParsedFinding, SkillPromptInput, build_code_review_prompt, build_skill_review_prompt,
        count_reviewable_changed_lines, extract_agent_text, parse_review_text, review_strictness,
    },
    precedents::{MIN_PRECEDENT_SCORE, PrecedentIndex},
    review_skill::{
        PREFERRED_SKILL_ID, ReviewSkill, SkillEnvironment, discover_review_skills,
        select_review_skill,
    },
};

const CODE_REVIEW_FILE: &str = "code-review.json";
const MAX_CODE_REVIEW_FILE_BYTES: usize = 256 * 1024;
/// Room for the skill, the playbook, and the output contract inside the 64 KB prompt limit.
const PROMPT_OVERHEAD_BYTES: usize = 6 * 1024;
const MODEL_CATALOG_TTL: Duration = Duration::from_secs(300);

impl LocalWtsService {
    pub fn run_workspace_code_review(
        &self,
        workspace_id: Uuid,
        provider: AgentProvider,
        scope: CodeReviewScope,
        model: Option<&str>,
    ) -> Result<WorkspaceCodeReviewResult, LocalWtsError> {
        self.run_workspace_code_review_with_options(
            workspace_id,
            provider,
            scope,
            CodeReviewOptions {
                model: model.map(str::to_owned),
                ..CodeReviewOptions::default()
            },
        )
    }

    /// Runs one review, attaches it to the reviewed patches, and saves it in the workspace.
    pub fn run_workspace_code_review_with_options(
        &self,
        workspace_id: Uuid,
        provider: AgentProvider,
        scope: CodeReviewScope,
        options: CodeReviewOptions,
    ) -> Result<WorkspaceCodeReviewResult, LocalWtsError> {
        let model = options
            .model
            .as_deref()
            .map(str::trim)
            .filter(|model| !model.is_empty() && *model != "default")
            .map(str::to_owned);
        if model.as_deref().is_some_and(|model| !valid_model_name(model)) {
            return Err(LocalWtsError::InvalidAgentPrompt);
        }
        let materialization = self.load_materialization(workspace_id)?;
        let selected = materialization
            .worktrees
            .iter()
            .filter(|worktree| {
                options
                    .repository_id
                    .as_deref()
                    .is_none_or(|repository_id| worktree.repository_id == repository_id)
            })
            .collect::<Vec<_>>();
        if selected.is_empty() {
            return Err(LocalWtsError::RepositoryNotFound);
        }
        if options.merge_request_iid.is_some() && (options.repository_id.is_none() || selected.len() != 1) {
            return Err(LocalWtsError::RepositoryNotFound);
        }
        let environment = SkillEnvironment::from_process();
        let skill = select_review_skill(discover_review_skills(&environment.roots), options.skill.as_deref())
            .map_err(|()| LocalWtsError::InvalidAgentPrompt)?;
        let strict_repositories = skill
            .as_ref()
            .map(|skill| skill.strict_repositories.clone())
            .unwrap_or_default();

        let mut reviewed = Vec::new();
        for worktree in &selected {
            let (repository_label, base, head, patch, patch_sha256, patch_truncated, merge_request) =
                match options.merge_request_iid {
                    Some(iid) => {
                        let comparison = self.workspace_gitlab_comparison(workspace_id, &worktree.repository_id, iid, false)?;
                        let published = comparison.published;
                        let sha = sha256_bytes(published.patch.as_bytes());
                        (
                            comparison.repository_label,
                            published.base_commit_oid.clone(),
                            published.head_commit_oid.clone(),
                            published.patch,
                            sha,
                            published.patch_truncated,
                            Some(CodeReviewMergeRequest {
                                iid,
                                base_commit_oid: published.base_commit_oid,
                                start_commit_oid: published.start_commit_oid,
                                head_commit_oid: published.head_commit_oid,
                            }),
                        )
                    }
                    None => {
                        let diff = self.workspace_repository_diff(workspace_id, &worktree.repository_id)?;
                        (
                            diff.repository_label,
                            diff.base_commit_oid,
                            diff.head_commit_oid,
                            diff.patch,
                            diff.patch_sha256,
                            diff.patch_truncated,
                            None,
                        )
                    }
                };
            let changed_lines = count_reviewable_changed_lines(&patch);
            let size_gate = skill.as_ref().and_then(|skill| skill.size_gate_lines);
            reviewed.push((
                CodeReviewRepository {
                    repository_id: worktree.repository_id.clone(),
                    strictness: if skill.is_some() {
                        review_strictness(&repository_label, &patch, &strict_repositories)
                    } else {
                        CodeReviewStrictness::Normal
                    },
                    repository_label,
                    base_commit_oid: base,
                    head_commit_oid: head,
                    patch_sha256,
                    changed_lines,
                    size_gate_exceeded: size_gate.is_some_and(|gate| changed_lines > gate),
                    patch_truncated,
                    merge_request,
                },
                patch,
            ));
        }
        let mode = match &skill {
            Some(skill) if skill.id == PREFERRED_SKILL_ID => CodeReviewMode::Raptik,
            Some(_) => CodeReviewMode::Skill,
            None => CodeReviewMode::Standard,
        };
        let skill_ref = skill.as_ref().map(|skill| CodeReviewSkillRef {
            id: skill.id.clone(),
            label: skill.label.clone(),
            reviewer: skill.reviewer.clone(),
        });
        let repositories = reviewed.iter().map(|(repository, _)| repository.clone()).collect::<Vec<_>>();
        let total_lines = repositories
            .iter()
            .map(|repository| repository.changed_lines)
            .fold(0_u32, u32::saturating_add);
        let base_result = |outcome, summary: String| WorkspaceCodeReviewResult {
            schema_version: CODE_REVIEW_SCHEMA_VERSION,
            workspace_id,
            provider,
            scope,
            model: model.clone(),
            agent: model.clone(),
            mode,
            skill: skill_ref.clone(),
            outcome,
            intent: None,
            summary,
            findings: Vec::new(),
            actionable_steps: Vec::new(),
            suggested_tests: Vec::new(),
            not_checked: Vec::new(),
            repositories: repositories.clone(),
            raw_output: None,
            reviewed_at_unix_ms: now_unix_ms(),
        };

        if scope == CodeReviewScope::RecentChanges && total_lines == 0 {
            let result = base_result(
                CodeReviewOutcome::NoChanges,
                "There are no changes to review in this scope.".to_owned(),
            );
            self.save_workspace_code_review(&materialization, &result)?;
            return Ok(result);
        }
        let size_gate = skill.as_ref().and_then(|skill| skill.size_gate_lines);
        if let Some(gate) = size_gate
            && scope == CodeReviewScope::RecentChanges
            && total_lines > gate
            && !options.ignore_size_gate
        {
            let reviewer = skill.as_ref().and_then(|skill| skill.reviewer.as_deref());
            let stop = match reviewer {
                Some(reviewer) => format!("{reviewer} stops at {gate}."),
                None => format!("The review skill stops at {gate}."),
            };
            let mut result = base_result(
                CodeReviewOutcome::SizeGateStopped,
                format!(
                    "This change has {total_lines} changed lines. {stop} Split it into merge requests of {gate} lines or fewer, by concern or layer."
                ),
            );
            result.actionable_steps = repositories
                .iter()
                .filter(|repository| repository.changed_lines > 0)
                .enumerate()
                .map(|(index, repository)| crate::CodeReviewActionableStep {
                    step_number: index as u32 + 1,
                    instruction: format!(
                        "{} has {} changed lines. Split it by concern or layer.",
                        repository.repository_label, repository.changed_lines
                    ),
                })
                .collect();
            self.save_workspace_code_review(&materialization, &result)?;
            return Ok(result);
        }

        let view = self.inner.registry.get(workspace_id)?.ok_or(LocalWtsError::WorkspaceNotFound)?;
        let intent = review_intent(&view);
        let prompt = match &skill {
            Some(skill) => {
                let references_len = skill.references.iter().map(|(name, text)| name.len() + text.len() + 40).sum::<usize>();
                let budget = MAX_AGENT_PROMPT_BYTES
                    .saturating_sub(PROMPT_OVERHEAD_BYTES)
                    .saturating_sub(skill.rules.len())
                    .saturating_sub(references_len)
                    .saturating_sub(intent.len());
                build_skill_review_prompt(&SkillPromptInput {
                    skill_id: &skill.id,
                    reviewer: skill.reviewer.as_deref(),
                    rules: &skill.rules,
                    references: &skill.references,
                    precedents_available: !skill.precedents.is_empty(),
                    size_gate_lines: skill.size_gate_lines,
                    intent: &intent,
                    repositories: &reviewed,
                    scope,
                    patch_budget: budget,
                })
            }
            None => {
                let mut context = format!("{intent}\n");
                let mut remaining = 24 * 1024_usize;
                for (repository, patch) in &reviewed {
                    context.push_str(&format!("--- Repository: {} ---\n", repository.repository_label));
                    let mut boundary = remaining.min(patch.len());
                    while !patch.is_char_boundary(boundary) {
                        boundary -= 1;
                    }
                    context.push_str(&patch[..boundary]);
                    context.push('\n');
                    remaining -= boundary;
                }
                build_code_review_prompt(scope, &context, model.as_deref())
            }
        };
        let prompt = validate_agent_prompt(&prompt)?.to_owned();
        let working_directory = if selected.len() == 1 {
            PathBuf::from(&selected[0].target_display_path)
        } else {
            PathBuf::from(&materialization.workspace_display_path)
        };
        let lease = self.lease_workspace_agent_operation(workspace_id)?;
        let traces = self.inner.code_review_traces.clone();
        let run_id = traces.begin(workspace_id, provider, model.clone());
        let trace_sink = {
            let traces = traces.clone();
            crate::review_trace::ReviewTraceSink::new(move |step| traces.push(workspace_id, run_id, step))
        };
        let adapter = self
            .inner
            .adapter
            .clone()
            .for_read_only_review()
            .with_review_trace(trace_sink)
            .with_process_lease(lease);
        let cancellation = Arc::new(AtomicBool::new(false));
        let run = match adapter
            .run_agent_with_custom(
                workspace_id,
                provider,
                &working_directory,
                &prompt,
                model.as_deref(),
                &cancellation,
                || {},
                || {},
                |_| {},
            )
        {
            Ok(run) => run,
            Err(failure) => {
                traces.push(workspace_id, run_id, crate::review_trace::ParsedStep {
                    kind: crate::CodeReviewTraceKind::Error,
                    text: adapter_failure_text(failure).to_owned(),
                    detail: None,
                    item_id: None,
                    running: false,
                });
                traces.finish(workspace_id, run_id, false);
                return Err(map_adapter_failure(failure));
            }
        };
        traces.finish(workspace_id, run_id, run.succeeded);
        let text = extract_agent_text(provider, &run.output);
        if !run.succeeded {
            let mut result = base_result(
                CodeReviewOutcome::Unstructured,
                "The agent stopped before it finished the review. Check the agent output, then run the review again.".to_owned(),
            );
            result.raw_output = Some(bounded_text(&text, 8 * 1024));
            return Ok(result);
        }
        let parsed = parse_review_text(&text);
        let no_precedents = Vec::new();
        let index = PrecedentIndex::new(skill.as_ref().map_or(&no_precedents, |skill: &ReviewSkill| &skill.precedents));
        let findings = parsed
            .findings
            .into_iter()
            .enumerate()
            .map(|(position, finding)| {
                let (repository_id, anchor) = anchor_finding(&finding, &reviewed);
                let precedent = precedent_for(&index, &finding);
                finding.into_finding(position, repository_id, anchor, precedent)
            })
            .collect::<Vec<_>>();
        let mut result = base_result(
            if parsed.structured {
                CodeReviewOutcome::Reviewed
            } else {
                CodeReviewOutcome::Unstructured
            },
            parsed.summary,
        );
        result.intent = parsed.intent;
        result.findings = findings;
        result.actionable_steps = parsed.steps;
        result.suggested_tests = parsed.suggested_tests;
        result.not_checked = parsed.not_checked;
        if repositories.iter().any(|repository| repository.patch_truncated) {
            result.not_checked.push("Part of the patch was too large for WTS to read.".to_owned());
        }
        if !parsed.structured {
            result.raw_output = Some(bounded_text(&text, 8 * 1024));
        }
        self.save_workspace_code_review(&materialization, &result)?;
        Ok(result)
    }

    /// Returns the last saved review for the workspace, or None.
    pub fn get_workspace_code_review(
        &self,
        workspace_id: Uuid,
    ) -> Result<Option<WorkspaceCodeReviewResult>, LocalWtsError> {
        let (workspace_path, _) = match self.read_materialization_receipt(workspace_id) {
            Ok(receipt) => receipt,
            Err(LocalWtsError::NotMaterialized) => return Ok(None),
            Err(error) => return Err(error),
        };
        let path = workspace_path.join(EVIDENCE_DIRECTORY).join(CODE_REVIEW_FILE);
        let Ok(metadata) = path.symlink_metadata() else {
            return Ok(None);
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() as usize > MAX_CODE_REVIEW_FILE_BYTES
        {
            return Ok(None);
        }
        let Ok(bytes) = fs::read(&path) else {
            return Ok(None);
        };
        Ok(serde_json::from_slice::<WorkspaceCodeReviewResult>(&bytes)
            .ok()
            .filter(|review| review.workspace_id == workspace_id))
    }

    fn save_workspace_code_review(
        &self,
        materialization: &WorkspaceMaterialization,
        result: &WorkspaceCodeReviewResult,
    ) -> Result<(), LocalWtsError> {
        let evidence = Path::new(&materialization.workspace_display_path).join(EVIDENCE_DIRECTORY);
        let metadata = evidence
            .symlink_metadata()
            .map_err(|_| LocalWtsError::EvidenceUnavailable)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(LocalWtsError::InvalidWorkspaceEvidence);
        }
        let mut saved = result.clone();
        let mut bytes = serde_json::to_vec_pretty(&saved).map_err(|_| LocalWtsError::InvalidWorkspaceEvidence)?;
        while bytes.len() > MAX_CODE_REVIEW_FILE_BYTES {
            saved.raw_output = None;
            if saved.findings.pop().is_none() {
                return Err(LocalWtsError::InvalidWorkspaceEvidence);
            }
            bytes = serde_json::to_vec_pretty(&saved).map_err(|_| LocalWtsError::InvalidWorkspaceEvidence)?;
        }
        atomic_upsert_managed_bytes(&evidence.join(CODE_REVIEW_FILE), &bytes)
    }

    /// Lists each provider's configured model and its available models.
    pub fn agent_model_catalog(&self, refresh: bool) -> AgentModelCatalog {
        if !refresh
            && let Ok(cache) = self.inner.agent_model_catalog_cache.lock()
            && let Some((cached_at, catalog)) = cache.as_ref()
            && cached_at.elapsed() < MODEL_CATALOG_TTL
        {
            return catalog.clone();
        }
        let adapter = &self.inner.adapter;
        let providers = [
            AgentProvider::Codex,
            AgentProvider::Copilot,
            AgentProvider::OpenCode,
            AgentProvider::Hermes,
        ];
        let sources = ModelSources {
            codex_home: env::var_os("CODEX_HOME").map(PathBuf::from),
            home: env::var_os("HOME").map(PathBuf::from),
            installed: providers
                .iter()
                .map(|provider| (*provider, adapter.installed_executable(*provider).is_some()))
                .collect(),
        };
        let mut catalog = discover_agent_models(&sources, |provider, args| {
            adapter.run_model_listing(provider, args)
        });
        let environment = SkillEnvironment::from_process();
        let skills = discover_review_skills(&environment.roots);
        catalog.raptik_skill_loaded = skills.iter().any(|skill| skill.id == PREFERRED_SKILL_ID);
        catalog.default_review_skill = select_review_skill(skills.clone(), None)
            .ok()
            .flatten()
            .map(|skill| skill.id);
        catalog.review_skills = skills
            .iter()
            .map(|skill| skill.summary(environment.home.as_deref()))
            .collect();
        if let Ok(mut cache) = self.inner.agent_model_catalog_cache.lock() {
            *cache = Some((Instant::now(), catalog.clone()));
        }
        catalog
    }

    /// Returns the live steps of the newest review run. With `after`, it returns only newer steps.
    pub fn workspace_code_review_trace(
        &self,
        workspace_id: Uuid,
        after: Option<u32>,
    ) -> Option<crate::CodeReviewTrace> {
        self.inner.code_review_traces.get(workspace_id, after)
    }
}

fn adapter_failure_text(failure: crate::AdapterFailure) -> &'static str {
    match failure {
        crate::AdapterFailure::Unavailable => "WTS could not find the agent CLI.",
        crate::AdapterFailure::SpawnFailed => "The agent did not start.",
        crate::AdapterFailure::TimedOut => "The agent did not finish in 15 minutes. WTS stopped it.",
        crate::AdapterFailure::OutputTooLarge => "The agent output was too large for WTS.",
        crate::AdapterFailure::GraphFailed => "The agent stopped with an error.",
        crate::AdapterFailure::Cancelled => "The review was stopped.",
    }
}

fn review_intent(view: &wts_store::WorkspaceView) -> String {
    let work_item = match &view.intent {
        WorkspaceIntent::Jira { issue_key } => format!("Jira: {issue_key}"),
        WorkspaceIntent::OpenProject { display_id, .. } => format!("OpenProject: {display_id}"),
        WorkspaceIntent::RepositorySet { label } => format!("Jira: not read (repository set {label})"),
    };
    format!("Workspace title: {}\n{work_item}", view.title)
}

fn bounded_text(text: &str, maximum: usize) -> String {
    let mut boundary = maximum.min(text.len());
    while !text.is_char_boundary(boundary) {
        boundary -= 1;
    }
    text[..boundary].to_owned()
}

/// Finds the repository and changed line that a finding names.
fn anchor_finding(
    finding: &ParsedFinding,
    reviewed: &[(CodeReviewRepository, String)],
) -> (Option<String>, Option<(u32, ReviewCodeSide)>) {
    let named = finding.repository.as_deref().map(str::to_ascii_lowercase);
    let mut candidates = reviewed
        .iter()
        .filter(|(repository, _)| {
            named.as_deref().is_none_or(|name| {
                repository.repository_label.eq_ignore_ascii_case(name)
                    || repository.repository_id.eq_ignore_ascii_case(name)
            })
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        candidates = reviewed.iter().collect();
    }
    let mut paths = vec![finding.file_path.clone()];
    for (repository, _) in &candidates {
        if let Some(stripped) = finding
            .file_path
            .strip_prefix(&format!("{}/", repository.repository_label))
        {
            paths.push(stripped.to_owned());
        }
    }
    let sides = match finding.side {
        Some(ReviewCodeSide::Deletions) => [ReviewCodeSide::Deletions, ReviewCodeSide::Additions],
        _ => [ReviewCodeSide::Additions, ReviewCodeSide::Deletions],
    };
    let mut file_owner = None;
    for (repository, patch) in &candidates {
        for path in &paths {
            let in_patch = patch_names_file(patch, path);
            if !in_patch {
                continue;
            }
            file_owner.get_or_insert_with(|| repository.repository_id.clone());
            if let Some(line) = finding.line {
                for side in sides {
                    if patch_contains_changed_line(patch, path, side, line) {
                        return (Some(repository.repository_id.clone()), Some((line, side)));
                    }
                }
            }
        }
    }
    let owner = file_owner.or_else(|| (candidates.len() == 1).then(|| candidates[0].0.repository_id.clone()));
    (owner, None)
}

fn patch_names_file(patch: &str, path: &str) -> bool {
    patch.lines().any(|line| {
        (line.starts_with("+++ ") && git_patch_header_path(line, "+++ ").as_deref() == Some(path))
            || (line.starts_with("--- ") && git_patch_header_path(line, "--- ").as_deref() == Some(path))
    })
}

fn precedent_for(index: &PrecedentIndex<'_>, finding: &ParsedFinding) -> Option<CodeReviewPrecedent> {
    let query = format!(
        "{} {} {}",
        finding.title,
        finding.why,
        finding.code.as_deref().unwrap_or_default()
    );
    let extension = finding.file_path.rsplit_once('.').map(|(_, extension)| extension);
    let best = index.search(&query, extension, 1).into_iter().next()?;
    (best.score >= MIN_PRECEDENT_SCORE).then(|| CodeReviewPrecedent {
        body: bounded_text(&best.body, 600),
        url: best.url,
        file_path: best.file,
        score: (best.score * 10.0).round() / 10.0,
    })
}
