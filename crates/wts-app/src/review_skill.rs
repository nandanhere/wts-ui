//! Review skills: the contract between WTS and a user's code review skill.
//!
//! A review skill is a directory with a `SKILL.md` file, the same format that
//! Codex, Copilot, and other agents use. WTS reads the skill text and gives it
//! to the review agent. An optional `wts-review.toml` manifest tells WTS which
//! extra files to read and which review gates to apply. WTS never runs the
//! scripts in a skill.
//!
//! See docs/review-skills.md for the manifest format.

use crate::precedents::{PrecedentComment, read_precedent_comments};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub(crate) const REVIEW_SKILL_MANIFEST: &str = "wts-review.toml";
pub(crate) const REVIEW_SKILL_DIRS_ENV: &str = "WTS_REVIEW_SKILL_DIRS";
/// The earlier single-skill override. WTS still reads it.
pub(crate) const LEGACY_RAPTIK_SKILL_DIR_ENV: &str = "WTS_RAPTIK_SKILL_DIR";
pub(crate) const PREFERRED_SKILL_ID: &str = "raptik-review";
const MANIFEST_SCHEMA: u32 = 1;
const MAX_SKILL_FILE_BYTES: usize = 16 * 1024;
const MAX_REFERENCE_BYTES: usize = 16 * 1024;
const MAX_REFERENCE_FILES: usize = 4;
const MAX_MANIFEST_BYTES: u64 = 16 * 1024;
const MAX_SKILLS: usize = 40;
const MAX_LABEL_CHARS: usize = 60;
const MAX_DESCRIPTION_CHARS: usize = 400;

/// What the model catalog shows about one review skill.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewSkillSummary {
    /// The skill directory name. The run request uses this ID.
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer: Option<String>,
    /// A display path, for example "~/.codex/skills/raptik-review".
    pub source: String,
    /// True when the skill has a wts-review.toml file.
    pub has_manifest: bool,
    /// The number of past review comments that WTS can match.
    pub precedent_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_gate_lines: Option<u32>,
}

/// The manifest. Every field is optional.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(crate) struct ReviewSkillManifest {
    #[serde(default)]
    pub(crate) schema: Option<u32>,
    #[serde(default)]
    pub(crate) label: Option<String>,
    #[serde(default)]
    pub(crate) reviewer: Option<String>,
    /// Extra Markdown files that the agent reads with the skill.
    #[serde(default)]
    pub(crate) references: Option<Vec<String>>,
    /// A JSONL file of past review comments: {"body", "file", "url"}.
    #[serde(default)]
    pub(crate) precedents: Option<String>,
    /// WTS stops before the agent runs when a change has more lines.
    #[serde(default)]
    pub(crate) size_gate_lines: Option<u32>,
    /// Repositories that always get strict review.
    #[serde(default)]
    pub(crate) strict_repositories: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ReviewSkill {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) description: Option<String>,
    pub(crate) reviewer: Option<String>,
    pub(crate) directory: PathBuf,
    pub(crate) has_manifest: bool,
    pub(crate) rules: String,
    /// (file name, text) pairs.
    pub(crate) references: Vec<(String, String)>,
    pub(crate) precedents: Vec<PrecedentComment>,
    pub(crate) size_gate_lines: Option<u32>,
    pub(crate) strict_repositories: Vec<String>,
}

impl ReviewSkill {
    pub(crate) fn summary(&self, home: Option<&Path>) -> ReviewSkillSummary {
        ReviewSkillSummary {
            id: self.id.clone(),
            label: self.label.clone(),
            description: self.description.clone(),
            reviewer: self.reviewer.clone(),
            source: display_path(&self.directory, home),
            has_manifest: self.has_manifest,
            precedent_count: u32::try_from(self.precedents.len()).unwrap_or(u32::MAX),
            size_gate_lines: self.size_gate_lines,
        }
    }
}

/// The built-in manifest for the Raptik skill, which has no wts-review.toml file.
fn builtin_manifest(id: &str) -> Option<ReviewSkillManifest> {
    (id == PREFERRED_SKILL_ID).then(|| ReviewSkillManifest {
        schema: Some(MANIFEST_SCHEMA),
        label: Some("Raptik rules".to_owned()),
        reviewer: Some("Pratik".to_owned()),
        references: Some(vec!["references/playbook.md".to_owned()]),
        precedents: Some("references/pratik_comments.jsonl".to_owned()),
        size_gate_lines: Some(500),
        strict_repositories: Some(vec!["senzu".to_owned(), "pious".to_owned(), "coredhcp".to_owned()]),
    })
}

/// The skill roots in lookup order. A directory can be one skill or a folder of skills.
pub(crate) fn review_skill_roots(
    override_dirs: Option<&str>,
    legacy_dir: Option<&Path>,
    codex_home: Option<&Path>,
    home: Option<&Path>,
) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(value) = override_dirs {
        roots.extend(std::env::split_paths(value).filter(|path| !path.as_os_str().is_empty()));
    }
    if let Some(directory) = legacy_dir {
        roots.push(directory.to_owned());
    }
    if let Some(codex_home) = codex_home {
        roots.push(codex_home.join("skills"));
    }
    if let Some(home) = home {
        roots.push(home.join(".codex/skills"));
        roots.push(home.join(".agents/skills"));
        roots.push(home.join(".claude/skills"));
        roots.push(home.join(".copilot/skills"));
    }
    let mut unique = Vec::new();
    for root in roots {
        if !unique.contains(&root) {
            unique.push(root);
        }
    }
    unique
}

pub(crate) struct SkillEnvironment {
    pub(crate) roots: Vec<PathBuf>,
    pub(crate) home: Option<PathBuf>,
}

impl SkillEnvironment {
    pub(crate) fn from_process() -> Self {
        let override_dirs = std::env::var(REVIEW_SKILL_DIRS_ENV).ok();
        let legacy = std::env::var_os(LEGACY_RAPTIK_SKILL_DIR_ENV).map(PathBuf::from);
        let codex_home = std::env::var_os("CODEX_HOME").map(PathBuf::from);
        let home = std::env::var_os("HOME").map(PathBuf::from);
        Self {
            roots: review_skill_roots(override_dirs.as_deref(), legacy.as_deref(), codex_home.as_deref(), home.as_deref()),
            home,
        }
    }
}

/// Finds every review skill. The first skill with an ID wins.
pub(crate) fn discover_review_skills(roots: &[PathBuf]) -> Vec<ReviewSkill> {
    let mut skills: Vec<ReviewSkill> = Vec::new();
    for root in roots {
        let mut candidates = Vec::new();
        if root.join("SKILL.md").is_file() {
            candidates.push(root.clone());
        } else if let Ok(entries) = fs::read_dir(root) {
            let mut children = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.join("SKILL.md").is_file())
                .collect::<Vec<_>>();
            children.sort();
            candidates.extend(children);
        }
        for directory in candidates {
            if skills.len() >= MAX_SKILLS {
                return skills;
            }
            let Some(skill) = load_review_skill(&directory) else {
                continue;
            };
            if skills.iter().any(|known| known.id == skill.id) {
                continue;
            }
            skills.push(skill);
        }
    }
    skills
}

/// Picks the requested skill, or the preferred default when the request has no skill.
pub(crate) fn select_review_skill(skills: Vec<ReviewSkill>, requested: Option<&str>) -> Result<Option<ReviewSkill>, ()> {
    match requested.map(str::trim).filter(|value| !value.is_empty()) {
        Some("none") => Ok(None),
        Some(id) => skills.into_iter().find(|skill| skill.id == id).map(Some).ok_or(()),
        None => {
            let preferred = skills.iter().position(|skill| skill.id == PREFERRED_SKILL_ID);
            Ok(match preferred {
                Some(index) => skills.into_iter().nth(index),
                None => skills.into_iter().find(|skill| skill.has_manifest),
            })
        }
    }
}

/// Loads one skill when it is a review skill.
///
/// A skill is a review skill when it has a manifest, a built-in manifest, or the
/// word "review" in its name or description.
pub(crate) fn load_review_skill(directory: &Path) -> Option<ReviewSkill> {
    let id = directory.file_name()?.to_str()?.to_owned();
    if !valid_skill_id(&id) {
        return None;
    }
    let text = read_bounded_text(&directory.join("SKILL.md"), MAX_SKILL_FILE_BYTES)?;
    let front = front_matter(&text);
    let name = front.as_ref().and_then(|front| front_field(front, "name"));
    let description = front.as_ref().and_then(|front| front_field(front, "description"));
    let manifest_path = directory.join(REVIEW_SKILL_MANIFEST);
    let file_manifest = read_manifest(&manifest_path);
    let has_manifest = file_manifest.is_some();
    let manifest = file_manifest.or_else(|| builtin_manifest(&id));
    let names_review = [Some(id.as_str()), name.as_deref(), description.as_deref()]
        .into_iter()
        .flatten()
        .any(|value| value.to_ascii_lowercase().contains("review"));
    if manifest.is_none() && !names_review {
        return None;
    }
    let manifest = manifest.unwrap_or_default();
    if manifest.schema.is_some_and(|schema| schema != MANIFEST_SCHEMA) {
        return None;
    }
    let rules = strip_front_matter(&text).to_owned();
    if rules.is_empty() {
        return None;
    }
    let references = manifest
        .references
        .clone()
        .unwrap_or_default()
        .into_iter()
        .take(MAX_REFERENCE_FILES)
        .filter_map(|relative| {
            let path = skill_file(directory, &relative)?;
            let text = read_bounded_text(&path, MAX_REFERENCE_BYTES)?;
            (!text.trim().is_empty()).then_some((relative, text))
        })
        .collect();
    let precedents = manifest
        .precedents
        .as_deref()
        .and_then(|relative| skill_file(directory, relative))
        .map(|path| read_precedent_comments(&path))
        .unwrap_or_default();
    let label = manifest
        .label
        .clone()
        .map(|label| bounded(&label, MAX_LABEL_CHARS))
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| title_case(name.as_deref().unwrap_or(&id)));
    Some(ReviewSkill {
        id,
        label,
        description: description.map(|text| bounded(&text, MAX_DESCRIPTION_CHARS)),
        reviewer: manifest.reviewer.map(|reviewer| bounded(&reviewer, MAX_LABEL_CHARS)).filter(|value| !value.is_empty()),
        directory: directory.to_owned(),
        has_manifest,
        rules,
        references,
        precedents,
        size_gate_lines: manifest.size_gate_lines.filter(|lines| *lines > 0),
        strict_repositories: manifest
            .strict_repositories
            .unwrap_or_default()
            .into_iter()
            .map(|name| name.to_ascii_lowercase().replace(['-', '_'], ""))
            .filter(|name| !name.is_empty())
            .collect(),
    })
}

fn read_manifest(path: &Path) -> Option<ReviewSkillManifest> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_MANIFEST_BYTES {
        return None;
    }
    toml::from_str(&fs::read_to_string(path).ok()?).ok()
}

pub(crate) fn valid_skill_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && !id.starts_with('.')
        && id.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
}

/// Resolves a manifest path inside the skill directory. Absolute paths and ".." are rejected.
fn skill_file(directory: &Path, relative: &str) -> Option<PathBuf> {
    let relative = Path::new(relative);
    if relative.components().any(|component| !matches!(component, Component::Normal(_))) {
        return None;
    }
    let path = directory.join(relative);
    let metadata = fs::symlink_metadata(&path).ok()?;
    (metadata.is_file()).then_some(path)
}

fn read_bounded_text(path: &Path, maximum: usize) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    if text.len() <= maximum {
        return Some(text);
    }
    let mut boundary = maximum;
    while !text.is_char_boundary(boundary) {
        boundary -= 1;
    }
    Some(text[..boundary].to_owned())
}

fn front_matter(text: &str) -> Option<String> {
    let rest = text.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    Some(rest[..end].to_owned())
}

fn front_field(front: &str, key: &str) -> Option<String> {
    front.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        (name.trim() == key).then(|| value.trim().trim_matches('"').trim_matches('\'').to_owned())
    }).filter(|value| !value.is_empty())
}

fn strip_front_matter(text: &str) -> &str {
    let Some(rest) = text.strip_prefix("---\n") else {
        return text.trim();
    };
    match rest.find("\n---\n") {
        Some(end) => rest[end + 5..].trim(),
        None => text.trim(),
    }
}

fn bounded(text: &str, maximum: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= maximum {
        return text.to_owned();
    }
    let mut value = text.chars().take(maximum).collect::<String>();
    value.push('…');
    value
}

fn title_case(name: &str) -> String {
    let words = name
        .split(['-', '_', ' '])
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut characters = word.chars();
            characters
                .next()
                .map(|first| first.to_uppercase().chain(characters).collect::<String>())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    bounded(&words.join(" "), MAX_LABEL_CHARS)
}

fn display_path(path: &Path, home: Option<&Path>) -> String {
    if let Some(home) = home
        && let Ok(relative) = path.strip_prefix(home)
    {
        return format!("~/{}", relative.display());
    }
    path.display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn discovers_review_skills_from_manifests_names_and_the_builtin_raptik_manifest() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("skills");
        write(&root.join("raptik-review/SKILL.md"), "---\nname: raptik-review\ndescription: Review like Pratik\n---\n# Rules\nFlag panics.");
        write(&root.join("raptik-review/references/playbook.md"), "Log errors.");
        write(&root.join("raptik-review/references/pratik_comments.jsonl"), "{\"body\":\"log it\",\"file\":\"a.go\"}\n");
        write(&root.join("team-rules/SKILL.md"), "---\nname: team-rules\ndescription: Our house style\n---\nUse constants.");
        write(&root.join("team-rules/wts-review.toml"), "schema = 1\nlabel = \"Team rules\"\nreviewer = \"Asha\"\nreferences = [\"notes.md\", \"../secret.md\"]\nsize_gate_lines = 300\n");
        write(&root.join("team-rules/notes.md"), "Prefer early returns.");
        write(&directory.path().join("secret.md"), "SECRET");
        write(&root.join("go-readability-review/SKILL.md"), "---\nname: go-readability-review\ndescription: Improve Go code\n---\nKeep names short.");
        write(&root.join("pdf/SKILL.md"), "---\nname: pdf\ndescription: Read PDF files\n---\nUse poppler.");
        write(&root.join("broken/SKILL.md"), "---\nname: broken review\n---\nText");
        write(&root.join("broken/wts-review.toml"), "schema = 2\n");

        let skills = discover_review_skills(&[root.clone(), root.join("raptik-review")]);
        let ids = skills.iter().map(|skill| skill.id.as_str()).collect::<Vec<_>>();
        assert_eq!(ids, vec!["go-readability-review", "raptik-review", "team-rules"]);

        let raptik = &skills[1];
        assert_eq!(raptik.label, "Raptik rules");
        assert_eq!(raptik.reviewer.as_deref(), Some("Pratik"));
        assert_eq!(raptik.rules, "# Rules\nFlag panics.");
        assert_eq!(raptik.references, vec![("references/playbook.md".to_owned(), "Log errors.".to_owned())]);
        assert_eq!(raptik.precedents.len(), 1);
        assert_eq!(raptik.size_gate_lines, Some(500));
        assert!(!raptik.has_manifest);

        let team = &skills[2];
        assert!(team.has_manifest);
        assert_eq!(team.label, "Team rules");
        assert_eq!(team.references.len(), 1, "A reference outside the skill must not load.");
        assert_eq!(team.size_gate_lines, Some(300));

        let readability = &skills[0];
        assert_eq!(readability.label, "Go Readability Review");
        assert_eq!(readability.size_gate_lines, None);

        let summary = raptik.summary(Some(directory.path()));
        assert_eq!(summary.source, "~/skills/raptik-review");
        assert_eq!(summary.precedent_count, 1);
    }

    #[test]
    fn selection_prefers_raptik_then_a_manifest_and_rejects_unknown_ids() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("skills");
        write(&root.join("code-review/SKILL.md"), "---\nname: code-review\n---\nFind bugs.");
        write(&root.join("team/SKILL.md"), "Team rules.");
        write(&root.join("team/wts-review.toml"), "label = \"Team\"\n");
        let skills = discover_review_skills(std::slice::from_ref(&root));
        assert_eq!(select_review_skill(skills.clone(), None).unwrap().unwrap().id, "team");
        assert_eq!(select_review_skill(skills.clone(), Some("code-review")).unwrap().unwrap().id, "code-review");
        assert!(select_review_skill(skills.clone(), Some("none")).unwrap().is_none());
        assert!(select_review_skill(skills, Some("missing")).is_err());
    }

    #[test]
    fn roots_follow_the_override_then_agent_homes() {
        let roots = review_skill_roots(Some("/one:/two"), Some(Path::new("/legacy")), Some(Path::new("/codex")), Some(Path::new("/home/u")));
        assert_eq!(
            roots,
            ["/one", "/two", "/legacy", "/codex/skills", "/home/u/.codex/skills", "/home/u/.agents/skills", "/home/u/.claude/skills", "/home/u/.copilot/skills"]
                .map(PathBuf::from)
                .to_vec()
        );
    }
}
