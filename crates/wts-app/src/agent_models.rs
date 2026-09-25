//! Reads the models that each local agent CLI is configured to use.
//!
//! WTS reads provider configuration files and asks the CLI for its model list.
//! The browser cannot choose these paths or commands.

use crate::AgentProvider;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

const MAX_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_MODELS_PER_PROVIDER: usize = 200;
const MAX_MODEL_NAME_CHARS: usize = 200;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentModelCatalog {
    pub providers: Vec<AgentProviderModels>,
    /// True when WTS found the Raptik review skill on this machine.
    #[serde(default)]
    pub raptik_skill_loaded: bool,
    /// The review skills that WTS found, in lookup order.
    #[serde(default)]
    pub review_skills: Vec<crate::ReviewSkillSummary>,
    /// The skill that WTS uses when the request names no skill.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_review_skill: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProviderModels {
    pub provider: AgentProvider,
    pub installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    /// A short label for where the default came from, for example "~/.codex/config.toml".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_source: Option<String>,
    pub models: Vec<String>,
    /// True when the CLI accepts a model argument.
    pub model_selectable: bool,
}

pub(crate) struct ModelSources {
    pub(crate) codex_home: Option<PathBuf>,
    pub(crate) home: Option<PathBuf>,
    pub(crate) installed: Vec<(AgentProvider, bool)>,
}

impl ModelSources {
    fn installed(&self, provider: AgentProvider) -> bool {
        self.installed
            .iter()
            .any(|(candidate, installed)| *candidate == provider && *installed)
    }

    fn codex_home(&self) -> Option<PathBuf> {
        self.codex_home
            .clone()
            .or_else(|| self.home.as_ref().map(|home| home.join(".codex")))
    }
}

/// Builds the catalog. The runner executes a provider CLI and returns stdout.
pub(crate) fn discover_agent_models(
    sources: &ModelSources,
    mut run: impl FnMut(AgentProvider, &[&str]) -> Option<String>,
) -> AgentModelCatalog {
    let mut providers = Vec::new();

    let codex_installed = sources.installed(AgentProvider::Codex);
    let (codex_default, codex_models) = sources
        .codex_home()
        .map(|home| codex_models(&home))
        .unwrap_or_default();
    providers.push(provider_models(
        AgentProvider::Codex,
        codex_installed,
        codex_default.map(|model| (model, "~/.codex/config.toml".to_owned())),
        codex_models,
        true,
    ));

    let copilot_installed = sources.installed(AgentProvider::Copilot);
    let copilot_models = if copilot_installed {
        run(AgentProvider::Copilot, &["help", "config"])
            .map(|output| parse_copilot_help_models(&output))
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let copilot_default = sources
        .home
        .as_deref()
        .and_then(copilot_configured_model)
        .map(|model| (model, "~/.copilot/settings.json".to_owned()))
        .or_else(|| Some(("auto".to_owned(), "Copilot automatic selection".to_owned())));
    let mut copilot_list = vec!["auto".to_owned()];
    copilot_list.extend(copilot_models);
    providers.push(provider_models(
        AgentProvider::Copilot,
        copilot_installed,
        copilot_default,
        copilot_list,
        true,
    ));

    let opencode_installed = sources.installed(AgentProvider::OpenCode);
    let opencode_models = if opencode_installed {
        run(AgentProvider::OpenCode, &["models"])
            .map(|output| parse_line_models(&output))
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let opencode_default = sources
        .home
        .as_deref()
        .and_then(opencode_configured_model)
        .map(|model| (model, "~/.config/opencode/opencode.jsonc".to_owned()));
    providers.push(provider_models(
        AgentProvider::OpenCode,
        opencode_installed,
        opencode_default,
        opencode_models,
        true,
    ));

    let hermes_default = sources
        .home
        .as_deref()
        .and_then(hermes_configured_model)
        .map(|model| (model, "~/.hermes/config.yaml".to_owned()));
    providers.push(provider_models(
        AgentProvider::Hermes,
        sources.installed(AgentProvider::Hermes),
        hermes_default,
        Vec::new(),
        true,
    ));

    AgentModelCatalog {
        providers,
        raptik_skill_loaded: false,
        review_skills: Vec::new(),
        default_review_skill: None,
    }
}

fn provider_models(
    provider: AgentProvider,
    installed: bool,
    default: Option<(String, String)>,
    models: Vec<String>,
    model_selectable: bool,
) -> AgentProviderModels {
    let (default_model, default_source) = match default {
        Some((model, source)) => (Some(model), Some(source)),
        None => (None, None),
    };
    let mut ordered = Vec::new();
    for model in default_model.iter().cloned().chain(models) {
        let model = model.trim().to_owned();
        if valid_model_name(&model) && !ordered.contains(&model) {
            ordered.push(model);
        }
        if ordered.len() >= MAX_MODELS_PER_PROVIDER {
            break;
        }
    }
    AgentProviderModels {
        provider,
        installed,
        default_model: default_model.filter(|model| valid_model_name(model)),
        default_source,
        models: ordered,
        model_selectable,
    }
}

pub(crate) fn valid_model_name(model: &str) -> bool {
    !model.is_empty()
        && model.chars().count() <= MAX_MODEL_NAME_CHARS
        && model
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_./:@+".contains(character))
        && !model.starts_with('-')
}

fn read_small(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

/// Reads a top-level string key from a TOML file without a full TOML parser.
fn toml_top_level_string(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            return None;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        if name.trim() != key {
            continue;
        }
        let value = value.trim();
        let value = value.split(" #").next().unwrap_or(value).trim();
        let unquoted = value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|value| value.strip_suffix('\'')))?;
        return Some(unquoted.to_owned());
    }
    None
}

fn codex_models(codex_home: &Path) -> (Option<String>, Vec<String>) {
    let config = read_small(&codex_home.join("config.toml")).unwrap_or_default();
    let default = toml_top_level_string(&config, "model");
    let mut models = Vec::new();
    let mut catalogs = vec![codex_home.join("models_cache.json")];
    if let Some(catalog) = toml_top_level_string(&config, "model_catalog_json") {
        catalogs.insert(0, PathBuf::from(catalog));
    }
    for catalog in catalogs {
        let Some(value) = read_small(&catalog).and_then(|text| serde_json::from_str::<Value>(&text).ok())
        else {
            continue;
        };
        for model in value["models"].as_array().into_iter().flatten() {
            if model["visibility"].as_str().is_some_and(|visibility| visibility != "list") {
                continue;
            }
            if let Some(slug) = model["slug"].as_str()
                && !slug.contains("embedding")
                && !models.iter().any(|known| known == slug)
            {
                models.push(slug.to_owned());
            }
        }
    }
    (default, models)
}

pub(crate) fn parse_copilot_help_models(output: &str) -> Vec<String> {
    let mut models = Vec::new();
    let mut in_model_section = false;
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('`') {
            in_model_section = trimmed.starts_with("`model`:");
            continue;
        }
        if !in_model_section {
            continue;
        }
        if let Some(model) = trimmed
            .strip_prefix("- \"")
            .and_then(|value| value.strip_suffix('"'))
        {
            models.push(model.to_owned());
        }
    }
    models
}

pub(crate) fn parse_line_models(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| valid_model_name(line))
        .map(str::to_owned)
        .collect()
}

fn json5_model(path: &Path) -> Option<String> {
    let value: Value = json5::from_str(&read_small(path)?).ok()?;
    value["model"].as_str().map(str::to_owned)
}

fn copilot_configured_model(home: &Path) -> Option<String> {
    ["settings.json", "config.json"]
        .iter()
        .find_map(|leaf| json5_model(&home.join(".copilot").join(leaf)))
}

fn opencode_configured_model(home: &Path) -> Option<String> {
    ["opencode.jsonc", "opencode.json"]
        .iter()
        .find_map(|leaf| json5_model(&home.join(".config/opencode").join(leaf)))
}

/// Reads model.default, or a scalar model value, from the Hermes YAML file.
pub(crate) fn hermes_model_from_yaml(text: &str) -> Option<String> {
    let mut in_model = false;
    for line in text.lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if !indented {
            in_model = false;
            if let Some(value) = line.strip_prefix("model:") {
                let value = unquote_yaml(value);
                if !value.is_empty() {
                    return Some(value);
                }
                in_model = true;
            }
            continue;
        }
        if in_model && let Some(value) = line.trim().strip_prefix("default:") {
            let value = unquote_yaml(value);
            return (!value.is_empty()).then_some(value);
        }
    }
    None
}

fn unquote_yaml(value: &str) -> String {
    let value = value.split(" #").next().unwrap_or(value).trim();
    value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| value.strip_prefix('\'').and_then(|value| value.strip_suffix('\'')))
        .unwrap_or(value)
        .to_owned()
}

fn hermes_configured_model(home: &Path) -> Option<String> {
    hermes_model_from_yaml(&read_small(&home.join(".hermes/config.yaml"))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn infers_each_provider_default_and_model_list_from_local_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path();
        let catalog_path = home.join("catalog.json");
        write(
            &home.join(".codex/config.toml"),
            &format!(
                "model = \"gpt-5.6-sol\" # chosen\nmodel_catalog_json = \"{}\"\n[features]\nmodel = \"not-top-level\"\n",
                catalog_path.display()
            ),
        );
        write(
            &catalog_path,
            r#"{"models":[{"slug":"gpt-6-astra","visibility":"list"},{"slug":"hidden","visibility":"hide"}]}"#,
        );
        write(
            &home.join(".codex/models_cache.json"),
            r#"{"models":[{"slug":"gpt-5.5","visibility":"list"},{"slug":"text-embedding-3-small","visibility":"list"}]}"#,
        );
        write(
            &home.join(".config/opencode/opencode.jsonc"),
            "// comment\n{ \"model\": \"godric/glm-5\", }",
        );
        write(
            &home.join(".hermes/config.yaml"),
            "model:\n  default: gpt-5.6-terra\n  provider: openai\nagent:\n  default: other\n",
        );
        let sources = ModelSources {
            codex_home: None,
            home: Some(home.to_owned()),
            installed: vec![
                (AgentProvider::Codex, true),
                (AgentProvider::Copilot, true),
                (AgentProvider::OpenCode, true),
                (AgentProvider::Hermes, false),
            ],
        };
        let mut calls = Vec::new();
        let catalog = discover_agent_models(&sources, |provider, args| {
            calls.push((provider, args.join(" ")));
            match provider {
                AgentProvider::Copilot => Some(
                    "  `model`: AI model to use\n    - \"claude-sonnet-5\"\n    - \"gpt-5.5\"\n\n  `contextTier`: tier\n    - \"long_context\"\n".to_owned(),
                ),
                AgentProvider::OpenCode => Some("godric/glm-5\nopencode/big-pickle\n\n".to_owned()),
                _ => None,
            }
        });
        let by = |provider| {
            catalog
                .providers
                .iter()
                .find(|entry| entry.provider == provider)
                .unwrap()
                .clone()
        };
        let codex = by(AgentProvider::Codex);
        assert_eq!(codex.default_model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(codex.models, vec!["gpt-5.6-sol", "gpt-6-astra", "gpt-5.5"]);
        let copilot = by(AgentProvider::Copilot);
        assert_eq!(copilot.default_model.as_deref(), Some("auto"));
        assert_eq!(copilot.models, vec!["auto", "claude-sonnet-5", "gpt-5.5"]);
        let opencode = by(AgentProvider::OpenCode);
        assert_eq!(opencode.default_model.as_deref(), Some("godric/glm-5"));
        assert_eq!(opencode.models, vec!["godric/glm-5", "opencode/big-pickle"]);
        let hermes = by(AgentProvider::Hermes);
        assert!(!hermes.installed);
        assert!(hermes.model_selectable);
        assert_eq!(hermes.default_model.as_deref(), Some("gpt-5.6-terra"));
        assert_eq!(
            calls,
            vec![
                (AgentProvider::Copilot, "help config".to_owned()),
                (AgentProvider::OpenCode, "models".to_owned())
            ]
        );
        let wire = serde_json::to_value(&catalog).unwrap();
        assert_eq!(wire["providers"][0]["provider"], "codex");
        assert_eq!(wire["providers"][0]["defaultModel"], "gpt-5.6-sol");
        assert_eq!(wire["providers"][0]["modelSelectable"], true);
    }

    #[test]
    fn rejects_model_names_that_look_like_arguments() {
        assert!(valid_model_name("github-copilot/claude-opus-5.5"));
        assert!(valid_model_name("godric-phonepe/global:LLM_GLOBAL_GPT_5_PRD"));
        assert!(!valid_model_name("--sandbox"));
        assert!(!valid_model_name("gpt 5"));
        assert!(!valid_model_name(""));
    }

    #[test]
    fn reads_a_scalar_hermes_model() {
        assert_eq!(hermes_model_from_yaml("model: \"x-1\"\n").as_deref(), Some("x-1"));
        assert_eq!(hermes_model_from_yaml("agent:\n  default: y\n"), None);
    }
}
