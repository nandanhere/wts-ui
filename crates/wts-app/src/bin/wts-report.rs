use std::{
    env, fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::ExitCode,
};
use wts_app::{MAX_AGENT_REPORT_BYTES, publish_agent_report};

const USAGE: &str = "Usage: wts-report [--input PATH]\n\
Reads an agent report from PATH, or from stdin when --input is omitted.";

fn main() -> ExitCode {
    match run(env::args_os().skip(1).collect()) {
        Ok(message) => {
            println!("{message}");
            ExitCode::SUCCESS
        }
        Err(CliError::Help) => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Err(CliError::Usage(message)) => {
            eprintln!("wts-report: {message}\n{USAGE}");
            ExitCode::from(2)
        }
        Err(CliError::Failure(message)) => {
            eprintln!("wts-report: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: Vec<std::ffi::OsString>) -> Result<String, CliError> {
    let input = parse_args(args)?;
    let bytes = match input {
        Some(path) => read_file(&path)?,
        None => read_bounded(io::stdin().lock(), "stdin")?,
    };
    let workspace = env::current_dir()
        .map_err(|_| CliError::Failure("could not determine the current workspace".to_owned()))?;
    let published = publish_agent_report(&workspace, &bytes)
        .map_err(|error| CliError::Failure(error.to_string()))?;
    Ok(format!(
        "Published {}",
        display_relative(&workspace, &published)
    ))
}

fn parse_args(args: Vec<std::ffi::OsString>) -> Result<Option<PathBuf>, CliError> {
    match args.as_slice() {
        [] => Ok(None),
        [flag] if flag == "--help" || flag == "-h" => Err(CliError::Help),
        [flag, path] if flag == "--input" => {
            if path.is_empty() {
                Err(CliError::Usage("--input requires a path".to_owned()))
            } else {
                Ok(Some(PathBuf::from(path)))
            }
        }
        [flag] if flag == "--input" => Err(CliError::Usage("--input requires a path".to_owned())),
        _ => Err(CliError::Usage(
            "expected no arguments or exactly --input PATH".to_owned(),
        )),
    }
}

fn read_file(path: &Path) -> Result<Vec<u8>, CliError> {
    let metadata = path.symlink_metadata().map_err(|error| {
        CliError::Failure(format!("could not read input {}: {error}", path.display()))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CliError::Failure(format!(
            "input {} must be a regular file, not a symbolic link",
            path.display()
        )));
    }
    if metadata.len() > MAX_AGENT_REPORT_BYTES as u64 {
        return Err(CliError::Failure(format!(
            "input {} exceeds the {MAX_AGENT_REPORT_BYTES}-byte limit",
            path.display()
        )));
    }
    let file = fs::File::open(path).map_err(|error| {
        CliError::Failure(format!("could not read input {}: {error}", path.display()))
    })?;
    read_bounded(file, &format!("input {}", path.display()))
}

fn read_bounded(reader: impl Read, label: &str) -> Result<Vec<u8>, CliError> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_AGENT_REPORT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| CliError::Failure(format!("could not read {label}: {error}")))?;
    if bytes.len() > MAX_AGENT_REPORT_BYTES {
        return Err(CliError::Failure(format!(
            "{label} exceeds the {MAX_AGENT_REPORT_BYTES}-byte limit"
        )));
    }
    Ok(bytes)
}

fn display_relative(workspace: &Path, path: &Path) -> String {
    path.strip_prefix(workspace)
        .unwrap_or(path)
        .display()
        .to_string()
}

enum CliError {
    Help,
    Usage(String),
    Failure(String),
}
