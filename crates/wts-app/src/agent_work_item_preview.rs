//! Live WTS UI previews from completed isolated source work.
use super::*;
use crate::{
    RuntimeHealthCheck, RuntimeLimits, RuntimeServiceRequest, RuntimeStackKey, RuntimeStackRequest,
    RuntimeSupervisor,
};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentWorkItemPreviewState {
    Running,
    Stopped,
    Blocked,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentWorkItemPreview {
    #[serde(skip)]
    pub preview_instance_id: Uuid,
    pub schema_version: u32,
    pub work_set_id: Uuid,
    pub task_id: Uuid,
    pub workspace_id: Uuid,
    pub repository_id: String,
    pub after_checkpoint_id: Uuid,
    pub state: AgentWorkItemPreviewState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub title: String,
    pub detail: String,
}

pub(super) struct PreviewHost {
    runtime: RuntimeSupervisor,
    proofs: Mutex<BTreeMap<RuntimeStackKey, (String, String, Uuid)>>,
}

pub(super) fn preview_supervisor() -> PreviewHost {
    PreviewHost {
        runtime: RuntimeSupervisor::new(RuntimeLimits {
            max_stacks: 2,
            max_services_per_stack: 1,
            max_services_total: 2,
            max_startup_timeout: Duration::from_secs(20),
            health_poll_interval: Duration::from_millis(50),
        })
        .expect("fixed preview limits"),
        proofs: Mutex::new(BTreeMap::new()),
    }
}

// The host supplies every argument. The parent check also stops an orphan after a host crash.
const PREVIEW_BOOTSTRAP: &str = r#"
const fs = require('node:fs');
const cache = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'wts-preview-cache-'));
process.on('exit', () => { try { fs.rmSync(cache, { recursive: true, force: true }); } catch (_) {} });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
const parent = process.ppid;
const watchdog = setInterval(() => {
  if (process.ppid !== parent || parent <= 1) {
    try { process.kill(-process.pid, 'SIGTERM'); } catch (_) {}
    process.exit(1);
  }
}, 500);
watchdog.unref();
import(require('node:url').pathToFileURL(process.argv[1]).href).then(async ({ createServer }) => {
  const server = await createServer({ root: process.cwd(), cacheDir: cache, configLoader: 'runner', server: { host: '127.0.0.1', port: Number(process.env.WTS_PORT), strictPort: true },
    plugins: [{ name: 'wts-preview-identity', configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== '/__wts_preview/' + process.env.WTS_PREVIEW_PROBE_ID) return next();
        response.setHeader('Content-Type', 'text/plain'); response.end(process.env.WTS_PREVIEW_PROBE_SECRET);
      });
    } }] });
  await server.listen();
}).catch(error => { console.error(error); process.exit(1); });
"#;

fn regular_bytes(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| {
        "WTS could not read the UI dependency files. Open this task workspace to inspect them."
            .to_owned()
    })?;
    let metadata = file
        .metadata()
        .map_err(|_| "WTS could not read the UI dependency files.".to_owned())?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(
            "The UI dependency file is not supported. Open this task workspace to inspect it."
                .to_owned(),
        );
    }
    let mut bytes = vec![];
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "WTS could not read the UI dependency files.".to_owned())?;
    if bytes.len() > limit as usize {
        return Err("The UI dependency file exceeds the preview limit.".to_owned());
    }
    Ok(bytes)
}

fn prepare_preview_ui(source: &Path, candidate: &Path) -> Result<(PathBuf, PathBuf), String> {
    let ui = candidate.join("ui").canonicalize().map_err(|_| {
        "This task has no WTS UI directory. Open its workspace to inspect the result.".to_owned()
    })?;
    let candidate = candidate.canonicalize().map_err(|_| {
        "The task workspace is unavailable. Open the workspace and retry.".to_owned()
    })?;
    if !ui.starts_with(&candidate) {
        return Err(
            "The UI directory is outside this task workspace. Open the workspace to inspect it."
                .to_owned(),
        );
    }
    let manifest = regular_bytes(&ui.join("package.json"), 65_536)?;
    let package: serde_json::Value = serde_json::from_slice(&manifest).map_err(|_| {
        "The UI package file is invalid. Open the task workspace to correct it.".to_owned()
    })?;
    if package.get("name").and_then(|value| value.as_str()) != Some("wts-ui") {
        return Err("Live preview currently supports the WTS UI package. Open this task workspace to run its own preview.".to_owned());
    }
    let modules = ui.join("node_modules");
    if let Ok(installed) = modules.canonicalize()
        && !installed.starts_with(&candidate)
    {
        let source_ui = source.join("ui").canonicalize().map_err(|_| "The shared UI dependency cache is unavailable. Open the task workspace to install its own dependencies, then retry.".to_owned())?;
        if !source_ui.starts_with(
            source
                .canonicalize()
                .map_err(|_| "The source workspace is unavailable.".to_owned())?,
        ) || source_ui.join("node_modules").canonicalize().ok().as_ref() != Some(&installed)
            || regular_bytes(&source_ui.join("package.json"), 65_536)? != manifest
            || regular_bytes(&source_ui.join("package-lock.json"), 2 * 1024 * 1024)?
                != regular_bytes(&ui.join("package-lock.json"), 2 * 1024 * 1024)?
        {
            return Err("The shared UI dependencies changed. Open the task workspace to install its own dependencies, then retry the preview.".to_owned());
        }
    }
    if !modules
        .try_exists()
        .map_err(|_| "WTS could not inspect the UI dependencies.".to_owned())?
    {
        // Attaching a dependency cache must not add a captured source path.
        let ignored = std::process::Command::new("git")
            .args([
                "--no-optional-locks",
                "check-ignore",
                "--quiet",
                "--",
                "ui/node_modules",
            ])
            .current_dir(&candidate)
            .status()
            .is_ok_and(|status| status.success());
        if !ignored {
            return Err("The task does not exclude UI dependencies from source files. Add ui/node_modules to its Git ignore rules, then retry the preview.".to_owned());
        }
        let source_ui = source.join("ui").canonicalize().map_err(|_| "The source UI dependencies are unavailable. Run npm ci in this task's ui directory, then retry.".to_owned())?;
        if !source_ui.starts_with(
            source
                .canonicalize()
                .map_err(|_| "The source workspace is unavailable.".to_owned())?,
        ) {
            return Err("The source UI directory is outside its workspace.".to_owned());
        }
        if regular_bytes(&source_ui.join("package.json"), 65_536)? != manifest
            || regular_bytes(&source_ui.join("package-lock.json"), 2 * 1024 * 1024)?
                != regular_bytes(&ui.join("package-lock.json"), 2 * 1024 * 1024)?
        {
            return Err("This option changes UI dependencies. Run npm ci in this task's ui directory, then retry the preview.".to_owned());
        }
        let installed = source_ui.join("node_modules").canonicalize().map_err(|_| "UI dependencies are not installed. Run npm ci in this task's ui directory, then retry.".to_owned())?;
        if !installed.is_dir() {
            return Err("UI dependencies are not installed. Run npm ci in this task's ui directory, then retry.".to_owned());
        }
        #[cfg(unix)] std::os::unix::fs::symlink(&installed, &modules).map_err(|_| "WTS could not attach the matching UI dependency cache. Run npm ci in this task's ui directory, then retry.".to_owned())?;
        #[cfg(not(unix))]
        return Err("Install UI dependencies in this task workspace, then retry.".to_owned());
    }
    let vite = modules
        .join("vite/dist/node/index.js")
        .canonicalize()
        .map_err(|_| {
            "Vite is not installed. Run npm ci in this task's ui directory, then retry.".to_owned()
        })?;
    if !vite.is_file() {
        return Err(
            "Vite is not installed. Open the task workspace to inspect its UI dependencies."
                .to_owned(),
        );
    }
    Ok((ui, vite))
}

fn start_preview_process(
    host: &PreviewHost,
    workspace_id: Uuid,
    task_id: Uuid,
    source: &Path,
    candidate: &Path,
    claim_id: Uuid,
) -> Result<String, String> {
    let key = RuntimeStackKey {
        workspace_id,
        stack_id: format!("preview-{task_id}"),
    };
    let mut proofs = host.proofs.lock().map_err(|_| {
        "The preview state is unavailable. Close the preview window and retry.".to_owned()
    })?;
    let supervisor = &host.runtime;
    let (ui, vite) = match prepare_preview_ui(source, candidate) {
        Ok(prepared) => prepared,
        Err(error) => {
            let _ = supervisor.stop_stack(&key);
            proofs.remove(&key);
            return Err(error);
        }
    };
    if let Ok(existing) = supervisor.inspect_stack(&key) {
        if let Some(service) = existing.services.first()
            && matches!(
                service.state,
                crate::RuntimeServiceState::Healthy | crate::RuntimeServiceState::Running
            )
            && proofs.get(&key).is_some_and(|(id, secret, _)| {
                preview_identity_matches(service.endpoint.port, id, secret)
            })
        {
            if let Some(proof) = proofs.get_mut(&key) {
                proof.2 = claim_id;
            }
            return Ok(format!("http://127.0.0.1:{}/", service.endpoint.port));
        }
        let _ = supervisor.stop_stack(&key);
    }
    proofs.remove(&key);
    let probe_id = Uuid::new_v4().to_string();
    let probe_secret = Uuid::new_v4().to_string();
    // Separate hosts can start previews at the same time. Avoid one shared first port.
    let preferred_port = 20_000 + (Uuid::new_v4().as_u128() % 30_000) as u16;
    let snapshot = supervisor.start_stack(RuntimeStackRequest {
        workspace_id, stack_id: key.stack_id.clone(), workspace_root: candidate.to_owned(),
        services: vec![RuntimeServiceRequest {
            id: "ui".to_owned(), working_directory: ui, executable: "node".to_owned(),
            args: vec!["-e".to_owned(), PREVIEW_BOOTSTRAP.to_owned(), vite.to_string_lossy().into_owned()],
            environment: BTreeMap::from([("WTS_PREVIEW_PROBE_ID".to_owned(), probe_id.clone()), ("WTS_PREVIEW_PROBE_SECRET".to_owned(), probe_secret.clone())]), preferred_port, depends_on: vec![],
            health_check: RuntimeHealthCheck::Tcp, startup_timeout: Duration::from_secs(20),
        }],
    }).map_err(|error| match error {
        crate::RuntimeError::CapacityExceeded => "Two previews are open. Close one preview window, then retry.".to_owned(),
        _ => "The UI preview did not start. Open this task workspace to inspect Node and its UI dependencies, then retry.".to_owned(),
    })?;
    let service = snapshot
        .services
        .first()
        .ok_or_else(|| "The UI preview did not return an address. Retry the preview.".to_owned())?;
    if !preview_identity_matches(service.endpoint.port, &probe_id, &probe_secret) {
        let _ = supervisor.stop_stack(&key);
        return Err("WTS could not verify the preview process. Retry the preview.".to_owned());
    }
    proofs.insert(key, (probe_id, probe_secret, claim_id));
    Ok(format!("http://127.0.0.1:{}/", service.endpoint.port))
}

fn preview_identity_matches(port: u16, id: &str, secret: &str) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_secs(1)) else {
        return false;
    };
    if stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .is_err()
        || stream
            .set_write_timeout(Some(Duration::from_secs(1)))
            .is_err()
    {
        return false;
    }
    if write!(
        stream,
        "GET /__wts_preview/{id} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .is_err()
    {
        return false;
    }
    let mut bytes = vec![];
    if stream.take(4097).read_to_end(&mut bytes).is_err() || bytes.len() > 4096 {
        return false;
    }
    let Ok(response) = String::from_utf8(bytes) else {
        return false;
    };
    response.starts_with("HTTP/1.1 200 ")
        && response
            .split_once("\r\n\r\n")
            .is_some_and(|(_, body)| body == secret)
}

impl LocalWtsService {
    pub fn start_agent_work_item_preview(
        &self,
        work_set_id: Uuid,
        task_id: Uuid,
    ) -> Result<AgentWorkItemPreview, LocalWtsError> {
        let trusted = work_sets::load_integration_candidate(self, work_set_id, task_id)?;
        let candidate = &trusted.candidate;
        let after_checkpoint_id = candidate
            .receipt
            .after
            .as_ref()
            .ok_or(LocalWtsError::AgentConversationUnavailable)?
            .checkpoint_id;
        let mut result = AgentWorkItemPreview {
            preview_instance_id: Uuid::new_v4(),
            schema_version: 1,
            work_set_id,
            task_id,
            workspace_id: candidate.receipt.workspace_id,
            repository_id: candidate.receipt.repository_id.clone(),
            after_checkpoint_id,
            state: AgentWorkItemPreviewState::Blocked,
            url: None,
            title: match &candidate.conversation.source {
                AgentConversationSource::Ui { label, .. }
                | AgentConversationSource::WorkItem { label, .. } => label.clone(),
                AgentConversationSource::GitlabDiscussion { title, .. } => {
                    title.clone().unwrap_or_else(|| "Task preview".to_owned())
                }
            },
            detail: String::new(),
        };
        if !turn_changes::matches_check_target(candidate)? {
            result.detail = "This task's files changed after its recorded result. Review the current task workspace before you start another preview.".to_owned();
            return Ok(result);
        }
        match start_preview_process(
            &self.inner.agent_conversations.previews,
            result.workspace_id,
            task_id,
            &trusted.source.target,
            &candidate.target,
            result.preview_instance_id,
        ) {
            Ok(url) => {
                result.state = AgentWorkItemPreviewState::Running;
                result.url = Some(match &trusted.source.conversation.source {
                    AgentConversationSource::Ui { route, .. }
                        if route.starts_with('/')
                            && !route.starts_with("//")
                            && !route.contains('\\') =>
                    {
                        url::Url::parse(&url)
                            .ok()
                            .and_then(|base| base.join(route).ok())
                            .map(|url| url.to_string())
                            .filter(|url| url.len() <= 2048)
                            .unwrap_or(url)
                    }
                    _ => url,
                });
                result.detail = "The preview uses this option's files. The preview window can read WTS data. Use the main WTS window to make changes.".to_owned();
            }
            Err(detail) => result.detail = detail,
        }
        Ok(result)
    }

    pub fn stop_agent_work_item_preview(
        &self,
        workspace_id: Uuid,
        task_id: Uuid,
        expected_url: &str,
        claim_id: Uuid,
    ) -> Result<(), LocalWtsError> {
        stop_preview_process(
            &self.inner.agent_conversations.previews,
            workspace_id,
            task_id,
            expected_url,
            claim_id,
        )
    }
}

fn stop_preview_process(
    host: &PreviewHost,
    workspace_id: Uuid,
    task_id: Uuid,
    expected_url: &str,
    claim_id: Uuid,
) -> Result<(), LocalWtsError> {
    let mut proofs = host
        .proofs
        .lock()
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    let key = RuntimeStackKey {
        workspace_id,
        stack_id: format!("preview-{task_id}"),
    };
    if proofs.get(&key).is_none_or(|proof| proof.2 != claim_id) {
        return Ok(());
    }
    if let Ok(stack) = host.runtime.inspect_stack(&key) {
        let expected_port = url::Url::parse(expected_url)
            .ok()
            .and_then(|url| url.port());
        if stack
            .services
            .first()
            .is_some_and(|service| Some(service.endpoint.port) == expected_port)
        {
            host.runtime
                .stop_stack(&key)
                .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
            proofs.remove(&key);
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn start_preview_process(
        host: &PreviewHost,
        workspace_id: Uuid,
        task_id: Uuid,
        source: &Path,
        candidate: &Path,
    ) -> Result<String, String> {
        super::start_preview_process(
            host,
            workspace_id,
            task_id,
            source,
            candidate,
            Uuid::new_v4(),
        )
    }

    #[test]
    fn a_delayed_close_cannot_stop_a_new_preview_claim() {
        let (_directory, source, candidate) = fixture();
        let host = preview_supervisor();
        let workspace_id = Uuid::new_v4();
        let task_id = Uuid::new_v4();
        let old_claim = Uuid::new_v4();
        let new_claim = Uuid::new_v4();
        let url = super::start_preview_process(
            &host,
            workspace_id,
            task_id,
            &source,
            &candidate,
            old_claim,
        )
        .unwrap();
        assert_eq!(
            super::start_preview_process(
                &host,
                workspace_id,
                task_id,
                &source,
                &candidate,
                new_claim
            )
            .unwrap(),
            url
        );
        stop_preview_process(&host, workspace_id, task_id, &url, old_claim).unwrap();
        assert!(get(&url).contains("CANDIDATE_UI_BYTES"));
        stop_preview_process(&host, workspace_id, task_id, &url, new_claim).unwrap();
        assert!(host.runtime.list_stacks().unwrap().is_empty());
    }

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let directory = tempdir().unwrap();
        let source = directory.path().join("source");
        let candidate = directory.path().join("candidate");
        for root in [&source, &candidate] {
            fs::create_dir_all(root.join("ui")).unwrap();
            assert!(
                std::process::Command::new("git")
                    .args(["init", "--quiet"])
                    .current_dir(root)
                    .status()
                    .unwrap()
                    .success()
            );
            fs::write(root.join(".gitignore"), "ui/node_modules\n").unwrap();
            fs::write(
                root.join("ui/package.json"),
                r#"{"name":"wts-ui","type":"module"}"#,
            )
            .unwrap();
            fs::write(root.join("ui/package-lock.json"), "{}").unwrap();
        }
        fs::write(source.join("ui/index.html"), "ORIGINAL_UI_BYTES").unwrap();
        fs::write(candidate.join("ui/index.html"), "CANDIDATE_UI_BYTES").unwrap();
        let module = source.join("ui/node_modules/vite/dist/node");
        fs::create_dir_all(&module).unwrap();
        fs::write(
            source.join("ui/node_modules/vite/package.json"),
            r#"{"type":"module"}"#,
        )
        .unwrap();
        fs::write(module.join("index.js"), r#"
import http from 'node:http'; import fs from 'node:fs';
export async function createServer(options) {
  const handlers=[];
  for (const plugin of options.plugins) plugin.configureServer({middlewares:{use(handler){handlers.push(handler)}}});
  const server=http.createServer((request,response)=>{
    let index=0;
    const next=()=>index<handlers.length?handlers[index++](request,response,next):response.end(fs.readFileSync(options.root+'/index.html'));
    next();
  });
  return {listen:()=>new Promise(resolve=>server.listen(options.server.port,options.server.host,resolve))};
}
"#).unwrap();
        (
            directory,
            source.canonicalize().unwrap(),
            candidate.canonicalize().unwrap(),
        )
    }

    fn get(url: &str) -> String {
        let url = url::Url::parse(url).unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", url.port().unwrap())).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        write!(
            stream,
            "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut output = String::new();
        stream.read_to_string(&mut output).unwrap();
        output
    }

    #[test]
    fn candidate_preview_serves_its_own_files_on_a_verified_port_and_reuses_its_process() {
        let (_directory, source, candidate) = fixture();
        let supervisor = preview_supervisor();
        let workspace_id = Uuid::new_v4();
        let task_id = Uuid::new_v4();
        let url =
            start_preview_process(&supervisor, workspace_id, task_id, &source, &candidate).unwrap();
        let first = supervisor.runtime.list_stacks().unwrap()[0].services[0].process_id;
        assert!(get(&url).contains("CANDIDATE_UI_BYTES"));
        assert!(!get(&url).contains("ORIGINAL_UI_BYTES"));
        assert_eq!(
            start_preview_process(&supervisor, workspace_id, task_id, &source, &candidate).unwrap(),
            url
        );
        assert_eq!(
            supervisor.runtime.list_stacks().unwrap()[0].services[0].process_id,
            first
        );
        assert_eq!(
            fs::read_to_string(source.join("ui/index.html")).unwrap(),
            "ORIGINAL_UI_BYTES"
        );
        let port = url::Url::parse(&url).unwrap().port().unwrap();
        assert!(!preview_identity_matches(port, "wrong-id", "wrong-secret"));
        supervisor.runtime.stop_all().unwrap();
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    }

    #[test]
    fn different_dependencies_block_before_process_start_and_do_not_create_a_cache_link() {
        let (_directory, source, candidate) = fixture();
        fs::write(candidate.join("ui/package-lock.json"), "{\"changed\":true}").unwrap();
        let supervisor = preview_supervisor();
        let error = start_preview_process(
            &supervisor,
            Uuid::new_v4(),
            Uuid::new_v4(),
            &source,
            &candidate,
        )
        .unwrap_err();
        assert!(error.contains("Run npm ci"));
        assert!(supervisor.runtime.list_stacks().unwrap().is_empty());
        assert!(!candidate.join("ui/node_modules").exists());
    }

    #[test]
    fn shared_dependency_link_is_checked_again_after_the_source_lock_changes() {
        let (_directory, source, candidate) = fixture();
        let host = preview_supervisor();
        let workspace_id = Uuid::new_v4();
        let task_id = Uuid::new_v4();
        start_preview_process(&host, workspace_id, task_id, &source, &candidate).unwrap();
        fs::write(
            source.join("ui/package-lock.json"),
            "{\"dependency\":\"new-version\"}",
        )
        .unwrap();
        let error =
            start_preview_process(&host, workspace_id, task_id, &source, &candidate).unwrap_err();
        assert!(error.contains("shared UI dependencies changed"));
        assert!(host.runtime.list_stacks().unwrap().is_empty());
        // An independent task install does not use the source's changed cache.
        fs::remove_file(candidate.join("ui/node_modules")).unwrap();
        fs::create_dir_all(candidate.join("ui/node_modules/vite/dist/node")).unwrap();
        fs::copy(
            source.join("ui/node_modules/vite/dist/node/index.js"),
            candidate.join("ui/node_modules/vite/dist/node/index.js"),
        )
        .unwrap();
        fs::copy(
            source.join("ui/node_modules/vite/package.json"),
            candidate.join("ui/node_modules/vite/package.json"),
        )
        .unwrap();
        let url = start_preview_process(&host, workspace_id, task_id, &source, &candidate).unwrap();
        assert!(get(&url).contains("CANDIDATE_UI_BYTES"));
        host.runtime.stop_all().unwrap();
    }

    #[test]
    fn preview_does_not_attach_a_cache_that_would_change_captured_source() {
        let (_directory, source, candidate) = fixture();
        fs::write(candidate.join(".gitignore"), "").unwrap();
        let supervisor = preview_supervisor();
        let error = start_preview_process(
            &supervisor,
            Uuid::new_v4(),
            Uuid::new_v4(),
            &source,
            &candidate,
        )
        .unwrap_err();
        assert!(error.contains("Git ignore rules"));
        assert!(!candidate.join("ui/node_modules").exists());
        assert!(supervisor.runtime.list_stacks().unwrap().is_empty());
    }

    #[test]
    #[ignore = "Child process helper for preview_host_death_stops_its_owned_server"]
    fn preview_host_process_helper() {
        let Ok(root) = std::env::var("WTS_PREVIEW_TEST_ROOT") else {
            return;
        };
        let root = PathBuf::from(root).canonicalize().unwrap();
        let host = preview_supervisor();
        let url = start_preview_process(
            &host,
            Uuid::new_v4(),
            Uuid::new_v4(),
            &root.join("source"),
            &root.join("candidate"),
        )
        .unwrap();
        fs::write(root.join("preview-url"), url).unwrap();
        std::thread::sleep(Duration::from_secs(30));
    }

    #[test]
    fn preview_host_death_stops_its_owned_server() {
        struct ChildGuard(std::process::Child);
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let (directory, _, _) = fixture();
        let mut child = ChildGuard(std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "service::agent_conversations::work_item_preview::tests::preview_host_process_helper", "--ignored"])
            .env("WTS_PREVIEW_TEST_ROOT", directory.path())
            .stdout(fs::File::create(directory.path().join("host-output")).unwrap()).stderr(std::process::Stdio::inherit()).spawn().unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let url = loop {
            if let Ok(url) = fs::read_to_string(directory.path().join("preview-url")) {
                break url;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "Preview host did not start"
            );
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "Preview host exited early: {}",
                fs::read_to_string(directory.path().join("host-output")).unwrap_or_default()
            );
            std::thread::sleep(Duration::from_millis(25));
        };
        assert!(get(&url).contains("CANDIDATE_UI_BYTES"));
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        let port = url::Url::parse(&url).unwrap().port().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while TcpStream::connect(("127.0.0.1", port)).is_ok() {
            assert!(
                std::time::Instant::now() < deadline,
                "Preview remained after host death"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    #[test]
    #[ignore = "Requires npm ci, Playwright Chromium, and Node 22"]
    fn installed_vite_serves_candidate_files_and_hot_updates() {
        let (_directory, source, candidate) = fixture();
        let installed = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../ui/node_modules")
            .canonicalize()
            .unwrap();
        fs::remove_dir_all(source.join("ui/node_modules")).unwrap();
        let modules = source.join("ui/node_modules");
        fs::create_dir_all(&modules).unwrap();
        std::os::unix::fs::symlink(installed.join("vite"), modules.join("vite")).unwrap();
        fs::create_dir_all(modules.join("preview-fixture-dependency")).unwrap();
        fs::write(
            modules.join("preview-fixture-dependency/package.json"),
            r#"{"name":"preview-fixture-dependency","version":"1.0.0","main":"index.js"}"#,
        )
        .unwrap();
        fs::write(
            modules.join("preview-fixture-dependency/index.js"),
            "module.exports = 'DEPENDENCY_VALUE';",
        )
        .unwrap();
        fs::create_dir_all(modules.join(".vite")).unwrap();
        fs::write(modules.join(".vite/main-cache"), "MAIN_CACHE_BYTES").unwrap();
        fs::write(
            candidate.join("ui/index.html"),
            "<!doctype html><html><body>CANDIDATE_UI_BYTES<output id=\"candidate-result\"></output><script>window.previewDocumentId=crypto.randomUUID()</script><script type=\"module\" src=\"/main.js\"></script></body></html>",
        )
        .unwrap();
        fs::write(
            candidate.join("ui/main.js"),
            r#"import dependency from 'preview-fixture-dependency';
import value from './value.js';
const render = value => { document.querySelector('#candidate-result').textContent = `${dependency}: ${value}`; };
render(value);
if (import.meta.hot) {
  import.meta.hot.accept('./value.js', next => render(next.default));
}
"#,
        )
        .unwrap();
        fs::write(
            candidate.join("ui/value.js"),
            "export default 'BEFORE_UPDATE';\n",
        )
        .unwrap();
        fs::write(
            candidate.join("ui/.browser-fixture"),
            "wts-candidate-preview-test\n",
        )
        .unwrap();
        let disable_hmr = std::env::var_os("WTS_PREVIEW_DISABLE_HMR_FOR_TEST").is_some();
        fs::write(
            candidate.join("ui/vite.config.mjs"),
            format!("export default {{ optimizeDeps: {{ include: ['preview-fixture-dependency'] }}, server: {{ hmr: {} }} }};", !disable_hmr),
        )
        .unwrap();
        let supervisor = preview_supervisor();
        let url = start_preview_process(
            &supervisor,
            Uuid::new_v4(),
            Uuid::new_v4(),
            &source,
            &candidate,
        )
        .unwrap();
        assert!(get(&url).contains("CANDIDATE_UI_BYTES"));
        let browser = std::process::Command::new("node")
            .arg(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../scripts/check-candidate-preview-browser.mjs"),
            )
            .arg(&url)
            .arg(candidate.join("ui"))
            .output()
            .expect("run the installed candidate browser check");
        supervisor.runtime.stop_all().unwrap();
        eprintln!("{}", String::from_utf8_lossy(&browser.stdout));
        assert!(
            browser.status.success(),
            "Candidate browser failed: {}",
            String::from_utf8_lossy(&browser.stderr)
        );
        assert_eq!(
            fs::read_to_string(source.join("ui/index.html")).unwrap(),
            "ORIGINAL_UI_BYTES"
        );
        assert_eq!(
            fs::read_to_string(modules.join(".vite/main-cache")).unwrap(),
            "MAIN_CACHE_BYTES"
        );
        assert_eq!(fs::read_dir(modules.join(".vite")).unwrap().count(), 1);
        assert!(!modules.join(".vite-temp").exists());
    }

    #[test]
    fn previews_use_separate_ports_and_reject_a_third_process() {
        let (_directory, source, candidate) = fixture();
        let supervisor = preview_supervisor();
        let first = start_preview_process(
            &supervisor,
            Uuid::new_v4(),
            Uuid::new_v4(),
            &source,
            &candidate,
        )
        .unwrap();
        let second = start_preview_process(
            &supervisor,
            Uuid::new_v4(),
            Uuid::new_v4(),
            &source,
            &candidate,
        )
        .unwrap();
        assert_ne!(first, second);
        assert!(
            start_preview_process(
                &supervisor,
                Uuid::new_v4(),
                Uuid::new_v4(),
                &source,
                &candidate
            )
            .unwrap_err()
            .contains("Close one preview window")
        );
        assert_eq!(supervisor.runtime.list_stacks().unwrap().len(), 2);
        supervisor.runtime.stop_all().unwrap();
    }
}
