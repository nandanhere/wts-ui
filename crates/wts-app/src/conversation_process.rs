//! Bounded output capture for an agent conversation. Tool output is drained, not retained.
use super::*;
use std::sync::Mutex;

pub(crate) const CONVERSATION_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const PIPE_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
const MAX_FINAL_BYTES: usize = 2 * 1024 * 1024;
const MAX_PROGRESS_BYTES: usize = 64 * 1024;
const MAX_DIAGNOSTIC_BYTES: usize = 16 * 1024;

#[derive(Debug, Default)]
pub(crate) struct ConversationCapture {
    pub(crate) progress: String,
    pub(crate) latest_message: String,
    pub(crate) provider_error: String,
    pub(crate) stderr: String,
    pub(crate) completed: bool,
    pub(crate) terminal_failed: bool,
    pub(crate) root_exited: bool,
    pub(crate) exit_code: Option<i32>,
    pub(crate) read_error: Option<String>,
    pub(crate) oversized_final: bool,
    pub(crate) skipped_frames: usize,
    pub(crate) text: String,
}

pub(crate) struct ConversationOutput {
    pub(crate) body: String,
    pub(crate) progress: String,
    pub(crate) diagnostic: String,
    pub(crate) provider_error: String,
    pub(crate) failure: Option<AdapterFailure>,
    pub(crate) root_exited: bool,
    pub(crate) exit_code: Option<i32>,
    pub(crate) terminal_failed: bool,
}

impl ConversationCapture {
    fn observe(&mut self, provider: AgentProvider, line: &[u8]) {
        if matches!(provider, AgentProvider::Codex | AgentProvider::OpenCode) {
            let Ok(value) = serde_json::from_slice::<Value>(line) else {
                append_tail(
                    &mut self.stderr,
                    &String::from_utf8_lossy(line),
                    MAX_DIAGNOSTIC_BYTES,
                );
                return;
            };
            if provider == AgentProvider::Codex
                && value["type"] == "item.completed"
                && value["item"]["type"] == "agent_message"
            {
                if let Some(text) = value["item"]["text"].as_str() {
                    if !self.latest_message.is_empty() {
                        append_tail(&mut self.progress, &self.latest_message, MAX_PROGRESS_BYTES);
                    }
                    self.oversized_final = text.len() > MAX_FINAL_BYTES;
                    self.latest_message = bound_utf8(text.replace('\0', ""), MAX_FINAL_BYTES);
                }
            } else if provider == AgentProvider::OpenCode
                && value["type"] == "text"
                && value["part"]["type"] == "text"
            {
                if let Some(text) = value["part"]["text"].as_str() {
                    append_final(&mut self.text, text, &mut self.oversized_final);
                }
            } else if value["type"] == "turn.completed" {
                self.completed = true;
                self.terminal_failed = false;
            } else if value["type"] == "error" || value["type"] == "turn.failed" {
                if value["type"] == "turn.failed" {
                    self.terminal_failed = true;
                }
                if let Some(text) = value["message"]
                    .as_str()
                    .or_else(|| value["error"]["message"].as_str())
                    .or_else(|| value["error"]["data"]["message"].as_str())
                    .or_else(|| value["error"]["name"].as_str())
                {
                    append_tail(&mut self.provider_error, text, MAX_DIAGNOSTIC_BYTES);
                }
            }
        } else {
            append_final(
                &mut self.text,
                &String::from_utf8_lossy(line),
                &mut self.oversized_final,
            );
        }
    }

    pub(crate) fn finish(
        &self,
        provider: AgentProvider,
        succeeded: bool,
        failure: Option<AdapterFailure>,
        final_path: &Path,
    ) -> ConversationOutput {
        let succeeded = succeeded && !self.terminal_failed;
        let mut failure = failure;
        let mut body = String::new();
        let mut progress = self.progress.clone();
        if succeeded && failure.is_none() {
            if provider == AgentProvider::Codex {
                match read_final_message(final_path) {
                    Ok(Some(final_message)) => body = final_message,
                    Ok(None) if self.completed && !self.oversized_final => {
                        body = self.latest_message.clone()
                    }
                    Ok(None) => {}
                    Err(error) => failure = Some(error),
                }
            } else if !self.oversized_final {
                body = self.text.trim().to_owned();
            } else {
                failure = Some(AdapterFailure::OutputTooLarge);
            }
        }
        if body.is_empty() || body != self.latest_message {
            append_tail(&mut progress, &self.latest_message, MAX_PROGRESS_BYTES);
        }
        if !succeeded || failure.is_some() {
            body.clear();
            append_tail(&mut progress, &self.text, MAX_PROGRESS_BYTES);
        }
        let mut diagnostic = self.provider_error.clone();
        if let Some(error) = &self.read_error {
            append_tail(&mut diagnostic, error, MAX_DIAGNOSTIC_BYTES);
        }
        // Keep the provider's explicit error ahead of secondary stderr warnings.
        if !self.stderr.trim().is_empty() {
            if !diagnostic.is_empty() && MAX_DIAGNOSTIC_BYTES.saturating_sub(diagnostic.len()) >= 2
            {
                diagnostic.push_str("\n\n");
            }
            let remaining = MAX_DIAGNOSTIC_BYTES.saturating_sub(diagnostic.len());
            diagnostic.push_str(&bound_utf8(self.stderr.clone(), remaining));
        }
        ConversationOutput {
            body,
            progress,
            diagnostic,
            provider_error: self.provider_error.clone(),
            failure,
            root_exited: self.root_exited,
            exit_code: self.exit_code,
            terminal_failed: self.terminal_failed,
        }
    }
}

fn read_final_message(path: &Path) -> Result<Option<String>, AdapterFailure> {
    let metadata = fs::symlink_metadata(path).map_err(|_| AdapterFailure::SpawnFailed)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AdapterFailure::SpawnFailed);
    }
    if metadata.len() > MAX_FINAL_BYTES as u64 {
        return Err(AdapterFailure::OutputTooLarge);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| AdapterFailure::SpawnFailed)?
        .take(MAX_FINAL_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| AdapterFailure::SpawnFailed)?;
    if bytes.len() > MAX_FINAL_BYTES {
        return Err(AdapterFailure::OutputTooLarge);
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| AdapterFailure::SpawnFailed)?
        .replace('\0', "");
    Ok((!text.trim().is_empty()).then_some(text))
}

fn append_final(output: &mut String, text: &str, oversized: &mut bool) {
    if output.len().saturating_add(text.len()) > MAX_FINAL_BYTES {
        *oversized = true;
    }
    let remaining = MAX_FINAL_BYTES.saturating_sub(output.len());
    output.push_str(&bound_utf8(text.replace('\0', ""), remaining));
}

fn append_tail(output: &mut String, text: &str, maximum: usize) {
    if text.is_empty() {
        return;
    }
    if !output.is_empty() {
        output.push('\n');
    }
    output.push_str(&text.replace('\0', ""));
    if output.len() > maximum {
        let mut offset = output.len() - maximum;
        while !output.is_char_boundary(offset) {
            offset += 1;
        }
        output.drain(..offset);
    }
}

fn read_frames(reader: impl Read, mut on_line: impl FnMut(Option<&[u8]>)) -> io::Result<()> {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if oversized {
                on_line(None);
            } else if !line.is_empty() {
                on_line(Some(&line));
            }
            return Ok(());
        }
        let length = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        let ended = available[length - 1] == b'\n';
        if !oversized && line.len().saturating_add(length) <= MAX_FRAME_BYTES {
            line.extend_from_slice(&available[..length]);
        } else {
            oversized = true;
            line.clear();
        }
        reader.consume(length);
        if ended {
            if oversized {
                on_line(None);
            } else {
                on_line(Some(&line));
            }
            line.clear();
            oversized = false;
        }
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "Keep process scope and lifecycle callbacks explicit."
)]
pub(super) fn run_conversation_process(
    executable: &OsStr,
    args: &[OsString],
    current_dir: &Path,
    provider: AgentProvider,
    timeout: Duration,
    cancellation: &Arc<AtomicBool>,
    lease: Option<&fs::File>,
    capture: &Arc<Mutex<ConversationCapture>>,
    on_spawn: &mut impl FnMut(),
    heartbeat: &mut impl FnMut(),
    on_event: &mut impl FnMut(AgentProcessEvent),
) -> Result<ProcessOutput, AdapterFailure> {
    if cancellation.load(Ordering::Acquire) {
        return Err(AdapterFailure::Cancelled);
    }
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(current_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    inherit_process_lease(&mut command, lease);
    let mut child = command.spawn().map_err(|error| match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied => AdapterFailure::Unavailable,
        _ => AdapterFailure::SpawnFailed,
    })?;
    let Some(stdout) = child.stdout.take() else {
        let _ = terminate_process_group(&mut child, false);
        return Err(AdapterFailure::SpawnFailed);
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = terminate_process_group(&mut child, false);
        return Err(AdapterFailure::SpawnFailed);
    };
    let (events_sender, events) = mpsc::sync_channel(32);
    let (done_sender, done) = mpsc::channel();
    let stdout_capture = Arc::clone(capture);
    let stdout_done = done_sender.clone();
    thread::spawn(move || {
        let result = read_frames(stdout, |line| {
            let Some(line) = line else {
                if let Ok(mut value) = stdout_capture.lock() {
                    value.skipped_frames += 1;
                }
                return;
            };
            if let Ok(mut value) = stdout_capture.lock() {
                value.observe(provider, line);
            }
            if provider == AgentProvider::Codex
                && let Some(event) = parse_codex_event(line)
            {
                let _ = events_sender.try_send(event);
            }
        });
        let _ = stdout_done.send(result);
    });
    let stderr_capture = Arc::clone(capture);
    thread::spawn(move || {
        let mut reader = stderr;
        let mut buffer = [0_u8; 8192];
        let result = loop {
            match reader.read(&mut buffer) {
                Ok(0) => break Ok(()),
                Ok(count) => {
                    if let Ok(mut value) = stderr_capture.lock() {
                        append_tail(
                            &mut value.stderr,
                            &String::from_utf8_lossy(&buffer[..count]),
                            MAX_DIAGNOSTIC_BYTES,
                        );
                    }
                }
                Err(error) => break Err(error),
            }
        };
        let _ = done_sender.send(result);
    });
    on_spawn();
    let started = Instant::now();
    let mut heartbeat_at = started;
    let mut finished_readers = 0;
    let mut failure = None;
    let status = loop {
        for event in events.try_iter().take(32) {
            on_event(event);
        }
        for result in done.try_iter() {
            finished_readers += 1;
            if let Err(error) = result {
                if let Ok(mut value) = capture.lock() {
                    value.read_error =
                        Some(format!("The provider output could not be read: {error}"));
                }
                failure = Some(AdapterFailure::SpawnFailed);
            }
        }
        if failure.is_some() {
            let _ = terminate_process_group(&mut child, false);
            break None;
        }
        if cancellation.load(Ordering::Acquire) {
            failure = Some(AdapterFailure::Cancelled);
            let _ = terminate_process_group(&mut child, false);
            break None;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                if let Ok(mut value) = capture.lock() {
                    value.root_exited = true;
                    value.exit_code = status.code();
                }
                if terminate_process_group(&mut child, true).is_err() {
                    failure = Some(AdapterFailure::SpawnFailed);
                }
                break Some(status);
            }
            Ok(None) if started.elapsed() >= timeout => {
                failure = Some(AdapterFailure::TimedOut);
                let _ = terminate_process_group(&mut child, false);
                break None;
            }
            Ok(None) => {}
            Err(error) => {
                if let Ok(mut value) = capture.lock() {
                    value.read_error = Some(format!(
                        "The provider process could not be checked: {error}"
                    ));
                }
                failure = Some(AdapterFailure::SpawnFailed);
                let _ = terminate_process_group(&mut child, false);
                break None;
            }
        }
        if heartbeat_at.elapsed() >= Duration::from_secs(10) {
            heartbeat();
            heartbeat_at = Instant::now();
        }
        thread::sleep(POLL_INTERVAL);
    };
    let drain_started = Instant::now();
    while finished_readers < 2 {
        for event in events.try_iter().take(32) {
            on_event(event);
        }
        match done.recv_timeout(PIPE_DRAIN_TIMEOUT.saturating_sub(drain_started.elapsed())) {
            Ok(result) => {
                finished_readers += 1;
                if let Err(error) = result {
                    if let Ok(mut value) = capture.lock() {
                        value.read_error =
                            Some(format!("The provider output could not be read: {error}"));
                    }
                    failure.get_or_insert(AdapterFailure::SpawnFailed);
                }
            }
            Err(_) => {
                failure.get_or_insert(AdapterFailure::TimedOut);
                break;
            }
        }
    }
    for event in events.try_iter().take(32) {
        on_event(event);
    }
    if let Some(failure) = failure {
        return Err(failure);
    }
    Ok(ProcessOutput {
        success: status.is_some_and(|status| status.success()),
        stdout: Vec::new(),
        stderr: Vec::new(),
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn run_fixture(
        script: &str,
        timeout: Duration,
    ) -> (Result<ProcessOutput, AdapterFailure>, ConversationOutput) {
        let directory = tempdir().unwrap();
        let final_path = directory.path().join("final.txt");
        fs::write(&final_path, "").unwrap();
        let capture = Arc::new(Mutex::new(ConversationCapture::default()));
        let result = run_conversation_process(
            OsStr::new("/bin/sh"),
            &[
                "-c".into(),
                script.into(),
                "wts-chat-output-test".into(),
                final_path.as_os_str().to_owned(),
            ],
            directory.path(),
            AgentProvider::Codex,
            timeout,
            &Arc::new(AtomicBool::new(false)),
            None,
            &capture,
            &mut || {},
            &mut || {},
            &mut |_| {},
        );
        let output = capture.lock().unwrap().finish(
            AgentProvider::Codex,
            result.as_ref().is_ok_and(|output| output.success),
            result.as_ref().err().copied(),
            &final_path,
        );
        (result, output)
    }

    #[test]
    fn conversation_root_exit_drains_inherited_pipes_and_keeps_only_confirmed_final() {
        let script = r#"sleep 30 &
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Progress before final"}}' '{"type":"item.completed","item":{"type":"agent_message","text":"Confirmed final"}}' '{"type":"turn.completed"}'
printf 'Confirmed final' > "$1"
printf 'warning is not failure' >&2
exit 0"#;
        let (result, output) = run_fixture(script, Duration::from_secs(2));
        assert!(result.unwrap().success);
        assert!(output.root_exited);
        assert_eq!(output.body, "Confirmed final");
        assert_eq!(output.progress, "Progress before final");
        assert!(output.diagnostic.contains("warning is not failure"));
        assert!(output.failure.is_none());
    }

    #[test]
    fn a_running_provider_timeout_preserves_full_progress_and_diagnostics() {
        let text = format!("{}PROGRESS_TAIL", "Progress detail. ".repeat(100));
        let event = serde_json::json!({"type":"item.completed","item":{"type":"agent_message","text":text}}).to_string();
        let script = format!("printf '%s\\n' '{event}'; printf 'timeout diagnostic' >&2; sleep 30");
        let (result, output) = run_fixture(&script, Duration::from_millis(200));
        assert!(matches!(result, Err(AdapterFailure::TimedOut)));
        assert!(!output.root_exited);
        assert!(output.body.is_empty());
        assert_eq!(output.progress, text);
        assert!(output.progress.len() > 800);
        assert!(output.diagnostic.contains("timeout diagnostic"));
        assert_eq!(output.failure, Some(AdapterFailure::TimedOut));
    }

    #[test]
    fn terminal_failure_cannot_publish_a_final_candidate_even_with_exit_zero() {
        let script = r#"printf 'Unverified final candidate' > "$1"
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Unverified progress"}}' '{"type":"turn.failed","error":{"message":"Provider capacity reached"}}'
exit 0"#;
        let (result, output) = run_fixture(script, Duration::from_secs(2));
        assert!(result.unwrap().success);
        assert!(output.terminal_failed);
        assert!(output.body.is_empty());
        assert!(output.progress.contains("Unverified progress"));
        assert_eq!(output.provider_error, "Provider capacity reached");
    }

    #[test]
    fn completed_stream_fallback_removes_non_displayable_nul_bytes() {
        let script = r#"printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Confirmed\u0000 reply"}}' '{"type":"turn.completed"}'; exit 0"#;
        let (result, output) = run_fixture(script, Duration::from_secs(2));
        assert!(result.unwrap().success);
        assert_eq!(output.body, "Confirmed reply");
        assert!(!output.body.contains('\0'));
    }

    #[test]
    fn progress_without_a_terminal_event_or_final_file_is_not_a_final_response() {
        let script = r#"printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"I will now start the checks."}}'; exit 0"#;
        let (result, output) = run_fixture(script, Duration::from_secs(2));
        assert!(result.unwrap().success);
        assert!(output.body.is_empty());
        assert_eq!(output.progress, "I will now start the checks.");
    }

    #[test]
    fn oversized_tool_frames_are_drained_before_the_terminal_event() {
        let mut bytes = vec![b'x'; MAX_FRAME_BYTES + 100];
        bytes.extend_from_slice(b"\n{\"type\":\"turn.completed\"}\n");
        let mut discarded = 0;
        let mut final_seen = false;
        read_frames(bytes.as_slice(), |frame| match frame {
            None => discarded += 1,
            Some(frame) => {
                final_seen =
                    serde_json::from_slice::<Value>(frame).unwrap()["type"] == "turn.completed"
            }
        })
        .unwrap();
        assert_eq!(discarded, 1);
        assert!(final_seen);
    }

    #[test]
    fn failed_provider_keeps_plain_error_without_private_reasoning() {
        let script = r#"printf '%s\n' '{"type":"item.completed","item":{"type":"reasoning","text":"PRIVATE_REASONING"}}' 'Authentication required'; exit 1"#;
        let (result, output) = run_fixture(script, Duration::from_secs(2));
        assert!(!result.unwrap().success);
        assert!(output.body.is_empty());
        assert!(output.diagnostic.contains("Authentication required"));
        assert!(!output.diagnostic.contains("PRIVATE_REASONING"));
        assert!(!output.progress.contains("PRIVATE_REASONING"));
    }

    #[test]
    fn conversation_deadline_does_not_change_other_agent_workflows() {
        assert_eq!(AGENT_TIMEOUT, Duration::from_secs(15 * 60));
        assert_eq!(CONVERSATION_TIMEOUT, Duration::from_secs(60 * 60));
        assert_eq!(GRAPH_TIMEOUT, Duration::from_secs(10 * 60));
    }
}
