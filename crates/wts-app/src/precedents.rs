//! Finds a reviewer's closest past comments for a finding.
//!
//! A review skill can ship a JSONL file of earlier review comments. WTS reads
//! the file and ranks the comments with the same TF-IDF method as the Raptik
//! skill's similar.py script. WTS never runs the scripts in a skill.

use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

const MAX_COMMENT_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_COMMENTS: usize = 5_000;
const EXTENSION_BOOST: f64 = 1.3;
/// A score under about 3 means "no similar comment".
pub(crate) const MIN_PRECEDENT_SCORE: f64 = 3.0;

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct PrecedentComment {
    pub(crate) body: String,
    #[serde(default)]
    pub(crate) file: Option<String>,
    #[serde(default)]
    pub(crate) url: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PrecedentMatch {
    pub(crate) score: f64,
    pub(crate) body: String,
    pub(crate) file: Option<String>,
    pub(crate) url: Option<String>,
}

pub(crate) fn read_precedent_comments(path: &Path) -> Vec<PrecedentComment> {
    let Ok(metadata) = fs::metadata(path) else {
        return Vec::new();
    };
    if !metadata.is_file() || metadata.len() > MAX_COMMENT_FILE_BYTES {
        return Vec::new();
    }
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| serde_json::from_str::<PrecedentComment>(line).ok())
        .filter(|comment| !comment.body.trim().is_empty())
        .take(MAX_COMMENTS)
        .collect()
}

/// Matches the tokenizer in the Raptik skill's similar.py script.
fn tokens(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut words = Vec::new();
    let mut current = String::new();
    let flush = |current: &mut String, words: &mut Vec<String>| {
        if current.len() > 2 {
            words.push(std::mem::take(current));
        } else {
            current.clear();
        }
    };
    for character in lower.chars() {
        let starts = character.is_ascii_lowercase() || character == '_';
        let continues = starts || character.is_ascii_digit();
        if current.is_empty() {
            if starts {
                current.push(character);
            }
        } else if continues {
            current.push(character);
        } else {
            flush(&mut current, &mut words);
        }
    }
    flush(&mut current, &mut words);
    words
}

fn counts(words: Vec<String>) -> BTreeMap<String, usize> {
    let mut counted = BTreeMap::new();
    for word in words {
        *counted.entry(word).or_insert(0) += 1;
    }
    counted
}

/// Port of similar.py: TF-IDF overlap with an extension boost and body dedup.
pub(crate) struct PrecedentIndex<'a> {
    comments: &'a [PrecedentComment],
    documents: Vec<BTreeMap<String, usize>>,
    idf: BTreeMap<String, f64>,
}

impl<'a> PrecedentIndex<'a> {
    pub(crate) fn new(comments: &'a [PrecedentComment]) -> Self {
        let documents = comments
            .iter()
            .map(|comment| counts(tokens(&comment.body)))
            .collect::<Vec<_>>();
        let mut frequency = BTreeMap::<String, usize>::new();
        for document in &documents {
            for word in document.keys() {
                *frequency.entry(word.clone()).or_insert(0) += 1;
            }
        }
        let total = documents.len().max(1) as f64;
        let idf = frequency
            .into_iter()
            .map(|(word, count)| (word, (total / (1.0 + count as f64)).ln()))
            .collect();
        Self {
            comments,
            documents,
            idf,
        }
    }

    pub(crate) fn search(&self, query: &str, extension: Option<&str>, limit: usize) -> Vec<PrecedentMatch> {
        let query = counts(tokens(query));
        if query.is_empty() {
            return Vec::new();
        }
        let suffix = extension.map(|extension| format!(".{extension}"));
        let mut scored = self
            .comments
            .iter()
            .zip(&self.documents)
            .filter_map(|(comment, document)| {
                let mut score = query
                    .iter()
                    .map(|(word, count)| {
                        let overlap = (*count).min(document.get(word).copied().unwrap_or(0));
                        self.idf.get(word).copied().unwrap_or(0.0) * overlap as f64
                    })
                    .sum::<f64>();
                if let (Some(suffix), Some(file)) = (&suffix, &comment.file)
                    && file.ends_with(suffix.as_str())
                {
                    score *= EXTENSION_BOOST;
                }
                (score > 0.0).then_some((score, comment))
            })
            .collect::<Vec<_>>();
        scored.sort_by(|left, right| right.0.total_cmp(&left.0));
        let mut seen = BTreeSet::new();
        let mut matches = Vec::new();
        for (score, comment) in scored {
            let body = comment.body.split_whitespace().collect::<Vec<_>>().join(" ");
            if !seen.insert(body.clone()) {
                continue;
            }
            matches.push(PrecedentMatch {
                score,
                body,
                file: comment.file.clone(),
                url: comment.url.clone(),
            });
            if matches.len() >= limit {
                break;
            }
        }
        matches
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comment(body: &str, file: &str) -> PrecedentComment {
        PrecedentComment {
            body: body.to_owned(),
            file: Some(file.to_owned()),
            url: Some(format!("https://gitlab.example.test/{}", body.len())),
        }
    }

    #[test]
    fn tokenizer_matches_the_skill_script() {
        assert_eq!(
            tokens("Log the error before returning, e.g. resp.Body 2x"),
            vec!["log", "the", "error", "before", "returning", "resp", "body"]
        );
    }

    #[test]
    fn search_prefers_rare_words_boosts_the_extension_and_drops_duplicates() {
        let comments = vec![
            comment("log the error before returning", "api/handler.go"),
            comment("log the error before returning", "api/other.go"),
            comment("close the response body", "client.py"),
            comment("close the response body", "client.go"),
            comment("nice work", "main.go"),
            comment("rename this variable", "main.go"),
        ];
        let index = PrecedentIndex::new(&comments);
        let matches = index.search("response body is never closed", Some("go"), 3);
        assert_eq!(matches[0].body, "close the response body");
        assert_eq!(matches[0].file.as_deref(), Some("client.go"));
        assert_eq!(matches.len(), 1);
        assert!(index.search("", None, 3).is_empty());
    }

    #[test]
    fn reader_skips_invalid_lines_and_empty_bodies() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("comments.jsonl");
        fs::write(&path, "{\"body\":\"log it\",\"file\":\"a.go\",\"extra\":1}\nnot json\n{\"body\":\"  \"}\n").unwrap();
        let comments = read_precedent_comments(&path);
        assert_eq!(comments.len(), 1);
        assert!(read_precedent_comments(&directory.path().join("missing")).is_empty());
    }
}
