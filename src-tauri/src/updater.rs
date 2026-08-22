use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use uuid::Uuid;

const SCHEMA_VERSION: u8 = 1;
const MANIFEST_FILE: &str = "latest.json";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_NOTES_CHARS: usize = 4_000;
const MAX_SIGNATURE_CHARS: usize = 4_096;
const UPDATE_TIMEOUT: Duration = Duration::from_secs(120);
pub(crate) const UPDATE_PROGRESS_EVENT: &str = "wts://update-progress";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AppUpdateStatusState {
    Disabled,
    UpToDate,
    Available,
    Downloading,
    Ready,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AppUpdateDiagnosticCode {
    NotConfigured,
    NetworkUnavailable,
    ManifestInvalid,
    SignatureInvalid,
    DownloadFailed,
    InstallFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppUpdateStatus {
    schema_version: u8,
    state: AppUpdateStatusState,
    current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    available_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    published_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    downloaded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostic_code: Option<AppUpdateDiagnosticCode>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppUpdateProgress {
    version: String,
    downloaded_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppRelaunchResult {
    pub accepted: bool,
}

pub(crate) struct AppUpdateState {
    status: Mutex<AppUpdateStatus>,
    pending: Mutex<Option<PendingUpdate>>,
    operation_active: Arc<AtomicBool>,
}

struct PendingUpdate {
    update: Update,
    source: LocalUpdateServer,
}

impl AppUpdateState {
    pub(crate) fn new(current_version: String) -> Self {
        let configured = !update_public_key().trim().is_empty();
        Self {
            status: Mutex::new(if configured {
                status(
                    AppUpdateStatusState::UpToDate,
                    current_version,
                    "WTS has not checked for a local update.",
                    None,
                )
            } else {
                status(
                    AppUpdateStatusState::Disabled,
                    current_version,
                    "This WTS build does not contain an update verification key.",
                    Some(AppUpdateDiagnosticCode::NotConfigured),
                )
            }),
            pending: Mutex::new(None),
            operation_active: Arc::new(AtomicBool::new(false)),
        }
    }
}

struct UpdateOperation(Arc<AtomicBool>);

impl Drop for UpdateOperation {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn begin_operation(app: &AppHandle) -> Option<UpdateOperation> {
    let active = Arc::clone(&app.state::<AppUpdateState>().operation_active);
    claim_operation(active)
}

fn claim_operation(active: Arc<AtomicBool>) -> Option<UpdateOperation> {
    active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .ok()
        .map(|_| UpdateOperation(active))
}

pub(crate) fn update_public_key() -> &'static str {
    option_env!("WTS_UPDATE_PUBLIC_KEY").unwrap_or("")
}

pub(crate) fn get_status(app: &AppHandle) -> AppUpdateStatus {
    app.state::<AppUpdateState>()
        .status
        .lock()
        .map(|status| status.clone())
        .unwrap_or_else(|_| {
            status(
                AppUpdateStatusState::Error,
                app.package_info().version.to_string(),
                "WTS could not read the update state.",
                Some(AppUpdateDiagnosticCode::ManifestInvalid),
            )
        })
}

pub(crate) fn can_relaunch(app: &AppHandle) -> bool {
    app.state::<AppUpdateState>()
        .status
        .lock()
        .is_ok_and(|status| status_allows_relaunch(&status))
}

fn status_allows_relaunch(status: &AppUpdateStatus) -> bool {
    status.state == AppUpdateStatusState::Ready
}

pub(crate) async fn check(app: AppHandle) -> AppUpdateStatus {
    let current_version = app.package_info().version.to_string();
    if update_public_key().trim().is_empty() {
        return replace_status(
            &app,
            status(
                AppUpdateStatusState::Disabled,
                current_version,
                "This WTS build does not contain an update verification key.",
                Some(AppUpdateDiagnosticCode::NotConfigured),
            ),
        );
    }
    let Some(_operation) = begin_operation(&app) else {
        return get_status(&app);
    };
    let update_directory = match app.path().app_data_dir() {
        Ok(path) => path.join("updates"),
        Err(_) => {
            return replace_status(
                &app,
                error_status(
                    current_version,
                    AppUpdateDiagnosticCode::ManifestInvalid,
                    "WTS could not resolve the local update directory.",
                ),
            );
        }
    };
    let prepared = match PreparedLocalUpdate::load(&update_directory) {
        Ok(Some(prepared)) => prepared,
        Ok(None) => {
            clear_pending(&app);
            return replace_status(
                &app,
                status(
                    AppUpdateStatusState::UpToDate,
                    current_version,
                    "No signed local update is available.",
                    None,
                ),
            );
        }
        Err(_) => {
            clear_pending(&app);
            return replace_status(
                &app,
                error_status(
                    current_version,
                    AppUpdateDiagnosticCode::ManifestInvalid,
                    "The staged local update is invalid.",
                ),
            );
        }
    };
    let metadata = prepared.metadata.clone();
    let source = match LocalUpdateServer::start(prepared) {
        Ok(source) => source,
        Err(_) => {
            return replace_status(
                &app,
                error_status(
                    current_version,
                    AppUpdateDiagnosticCode::NetworkUnavailable,
                    "WTS could not start the local update check.",
                ),
            );
        }
    };
    let endpoint = source.manifest_url();
    let updater = match app
        .updater_builder()
        .pubkey(update_public_key())
        .endpoints(vec![endpoint])
        .and_then(|builder| builder.no_proxy().timeout(UPDATE_TIMEOUT).build())
    {
        Ok(updater) => updater,
        Err(_) => {
            return replace_status(
                &app,
                error_status(
                    current_version,
                    AppUpdateDiagnosticCode::NetworkUnavailable,
                    "WTS could not configure the local update check.",
                ),
            );
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let available = available_status(&current_version, &metadata);
            let state = app.state::<AppUpdateState>();
            if let Ok(mut pending) = state.pending.lock() {
                *pending = Some(PendingUpdate { update, source });
            } else {
                return replace_status(
                    &app,
                    error_status(
                        current_version,
                        AppUpdateDiagnosticCode::ManifestInvalid,
                        "WTS could not save the pending update.",
                    ),
                );
            }
            replace_status(&app, available)
        }
        Ok(None) => {
            clear_pending(&app);
            replace_status(
                &app,
                status(
                    AppUpdateStatusState::UpToDate,
                    current_version,
                    "WTS is up to date.",
                    None,
                ),
            )
        }
        Err(_) => {
            clear_pending(&app);
            replace_status(
                &app,
                error_status(
                    current_version,
                    AppUpdateDiagnosticCode::NetworkUnavailable,
                    "WTS could not check the signed local update.",
                ),
            )
        }
    }
}

pub(crate) async fn download_and_install(app: AppHandle) -> AppUpdateStatus {
    let current_version = app.package_info().version.to_string();
    let Some(_operation) = begin_operation(&app) else {
        return get_status(&app);
    };
    let pending = app
        .state::<AppUpdateState>()
        .pending
        .lock()
        .ok()
        .and_then(|mut pending| pending.take());
    let Some(pending) = pending else {
        return replace_status(
            &app,
            error_status(
                current_version,
                AppUpdateDiagnosticCode::DownloadFailed,
                "Check for an update before you install it.",
            ),
        );
    };
    let version = pending.update.version.clone();
    let available = get_status(&app);
    let downloading = AppUpdateStatus {
        state: AppUpdateStatusState::Downloading,
        downloaded_bytes: Some(0),
        detail: "WTS downloads and verifies the signed update.".to_owned(),
        ..available
    };
    replace_status(&app, downloading);
    let downloaded = Arc::new(AtomicU64::new(0));
    let progress_downloaded = Arc::clone(&downloaded);
    let progress_app = app.clone();
    let progress_version = version.clone();
    let result = pending
        .update
        .download_and_install(
            move |chunk, total| {
                let amount = u64::try_from(chunk).unwrap_or(u64::MAX);
                let downloaded = progress_downloaded.fetch_add(amount, Ordering::Relaxed) + amount;
                let _ = progress_app.emit(
                    UPDATE_PROGRESS_EVENT,
                    AppUpdateProgress {
                        version: progress_version.clone(),
                        downloaded_bytes: downloaded,
                        total_bytes: total,
                    },
                );
            },
            || {},
        )
        .await;
    drop(pending.source);
    match result {
        Ok(()) => {
            let mut ready = get_status(&app);
            ready.state = AppUpdateStatusState::Ready;
            ready.downloaded_bytes = Some(downloaded.load(Ordering::Relaxed));
            ready.detail = "WTS installed the verified update. Relaunch WTS to use it.".to_owned();
            replace_status(&app, ready)
        }
        Err(error) => {
            let code = if matches!(
                error,
                tauri_plugin_updater::Error::Minisign(_)
                    | tauri_plugin_updater::Error::Base64(_)
                    | tauri_plugin_updater::Error::SignatureUtf8(_)
            ) {
                AppUpdateDiagnosticCode::SignatureInvalid
            } else {
                AppUpdateDiagnosticCode::InstallFailed
            };
            replace_status(
                &app,
                error_status(
                    current_version,
                    code,
                    "WTS could not verify and install the update.",
                ),
            )
        }
    }
}

fn replace_status(app: &AppHandle, next: AppUpdateStatus) -> AppUpdateStatus {
    if let Ok(mut status) = app.state::<AppUpdateState>().status.lock() {
        *status = next.clone();
    }
    next
}

fn clear_pending(app: &AppHandle) {
    if let Ok(mut pending) = app.state::<AppUpdateState>().pending.lock() {
        *pending = None;
    }
}

fn status(
    state: AppUpdateStatusState,
    current_version: String,
    detail: &str,
    diagnostic_code: Option<AppUpdateDiagnosticCode>,
) -> AppUpdateStatus {
    AppUpdateStatus {
        schema_version: SCHEMA_VERSION,
        state,
        current_version,
        available_version: None,
        published_at: None,
        notes: None,
        downloaded_bytes: None,
        total_bytes: None,
        detail: detail.to_owned(),
        diagnostic_code,
    }
}

fn error_status(
    current_version: String,
    diagnostic_code: AppUpdateDiagnosticCode,
    detail: &str,
) -> AppUpdateStatus {
    status(
        AppUpdateStatusState::Error,
        current_version,
        detail,
        Some(diagnostic_code),
    )
}

fn available_status(current_version: &str, metadata: &StagedUpdateManifest) -> AppUpdateStatus {
    AppUpdateStatus {
        schema_version: SCHEMA_VERSION,
        state: AppUpdateStatusState::Available,
        current_version: current_version.to_owned(),
        available_version: Some(metadata.version.clone()),
        published_at: metadata.pub_date.clone(),
        notes: metadata.notes.clone(),
        downloaded_bytes: None,
        total_bytes: Some(metadata.size),
        detail: "A signed local WTS update is available.".to_owned(),
        diagnostic_code: None,
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StagedUpdateManifest {
    schema_version: u8,
    version: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    pub_date: Option<String>,
    artifact_file: String,
    signature: String,
    sha256: String,
    size: u64,
}

struct PreparedLocalUpdate {
    metadata: StagedUpdateManifest,
    artifact_path: PathBuf,
}

impl PreparedLocalUpdate {
    fn load(directory: &Path) -> Result<Option<Self>, LocalUpdateError> {
        let manifest_path = directory.join(MANIFEST_FILE);
        let metadata = match manifest_path.symlink_metadata() {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(LocalUpdateError::Invalid),
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > MAX_MANIFEST_BYTES
        {
            return Err(LocalUpdateError::Invalid);
        }
        let manifest: StagedUpdateManifest = serde_json::from_slice(
            &fs::read(&manifest_path).map_err(|_| LocalUpdateError::Invalid)?,
        )
        .map_err(|_| LocalUpdateError::Invalid)?;
        if manifest.schema_version != SCHEMA_VERSION
            || !valid_version(&manifest.version)
            || manifest.notes.as_ref().is_some_and(|notes| {
                notes.chars().count() > MAX_NOTES_CHARS || notes.contains('\0')
            })
            || manifest
                .pub_date
                .as_ref()
                .is_some_and(|date| date.len() > 64 || date.contains(['\0', '\r', '\n']))
            || !valid_artifact_file(&manifest.artifact_file)
            || !valid_signature(&manifest.signature)
            || manifest.sha256.len() != 64
            || !manifest.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || manifest.size == 0
            || manifest.size > MAX_ARTIFACT_BYTES
        {
            return Err(LocalUpdateError::Invalid);
        }
        let artifact_path = directory.join(&manifest.artifact_file);
        let artifact_metadata = artifact_path
            .symlink_metadata()
            .map_err(|_| LocalUpdateError::Invalid)?;
        if artifact_metadata.file_type().is_symlink()
            || !artifact_metadata.is_file()
            || artifact_metadata.len() != manifest.size
        {
            return Err(LocalUpdateError::Invalid);
        }
        let digest = sha256_file(&artifact_path, manifest.size)?;
        if !digest.eq_ignore_ascii_case(&manifest.sha256) {
            return Err(LocalUpdateError::Invalid);
        }
        Ok(Some(Self {
            metadata: StagedUpdateManifest {
                signature: manifest.signature.trim().to_owned(),
                ..manifest
            },
            artifact_path,
        }))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LocalUpdateError {
    Invalid,
    Io,
}

fn valid_version(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 10
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part == &"0" || !part.starts_with('0'))
        })
}

fn valid_artifact_file(value: &str) -> bool {
    Path::new(value).file_name().and_then(|name| name.to_str()) == Some(value)
        && value.starts_with("WTS_")
        && value.ends_with("_aarch64.app.tar.gz")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_signature(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= MAX_SIGNATURE_CHARS
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
}

fn sha256_file(path: &Path, expected_size: u64) -> Result<String, LocalUpdateError> {
    let mut file = File::open(path).map_err(|_| LocalUpdateError::Io)?;
    let mut hasher = Sha256::new();
    let mut read_size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|_| LocalUpdateError::Io)?;
        if count == 0 {
            break;
        }
        read_size = read_size
            .checked_add(u64::try_from(count).map_err(|_| LocalUpdateError::Invalid)?)
            .ok_or(LocalUpdateError::Invalid)?;
        if read_size > expected_size || read_size > MAX_ARTIFACT_BYTES {
            return Err(LocalUpdateError::Invalid);
        }
        hasher.update(&buffer[..count]);
    }
    if read_size != expected_size {
        return Err(LocalUpdateError::Invalid);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

struct LocalUpdateServer {
    address: SocketAddrV4,
    token: String,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl LocalUpdateServer {
    fn start(update: PreparedLocalUpdate) -> Result<Self, LocalUpdateError> {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .map_err(|_| LocalUpdateError::Io)?;
        listener
            .set_nonblocking(true)
            .map_err(|_| LocalUpdateError::Io)?;
        let address = match listener.local_addr().map_err(|_| LocalUpdateError::Io)? {
            std::net::SocketAddr::V4(address) if address.ip().is_loopback() => address,
            _ => return Err(LocalUpdateError::Invalid),
        };
        let token = Uuid::new_v4().simple().to_string();
        let artifact_url = format!("http://{address}/{token}/artifact");
        let manifest = serde_json::json!({
            "version": update.metadata.version,
            "notes": update.metadata.notes,
            "pub_date": update.metadata.pub_date,
            "url": artifact_url,
            "signature": update.metadata.signature,
        })
        .to_string()
        .into_bytes();
        let artifact_path = update.artifact_path;
        let artifact_size = update.metadata.size;
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread_token = token.clone();
        let thread = thread::spawn(move || {
            let mut served = 0_u8;
            while !thread_stop.load(Ordering::Relaxed) && served < 8 {
                match listener.accept() {
                    Ok((stream, peer)) if peer.ip().is_loopback() => {
                        served = served.saturating_add(1);
                        let _ = serve_connection(
                            stream,
                            &thread_token,
                            &manifest,
                            &artifact_path,
                            artifact_size,
                        );
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            address,
            token,
            stop,
            thread: Some(thread),
        })
    }

    fn manifest_url(&self) -> url::Url {
        loopback_manifest_url(self.address, &self.token)
    }
}

fn loopback_manifest_url(address: SocketAddrV4, token: &str) -> url::Url {
    format!("http://{address}/{token}/manifest")
        .parse()
        .expect("fixed loopback update URL")
}

impl Drop for LocalUpdateServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn serve_connection(
    mut stream: TcpStream,
    token: &str,
    manifest: &[u8],
    artifact_path: &Path,
    artifact_size: u64,
) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(UPDATE_TIMEOUT))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader
        .by_ref()
        .take(8 * 1024)
        .read_line(&mut request_line)?;
    let manifest_path = format!("/{token}/manifest");
    let artifact_route = format!("/{token}/artifact");
    match request_line
        .trim_end()
        .split_whitespace()
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["GET", path, "HTTP/1.1"] if *path == manifest_path => {
            write_headers(&mut stream, "application/json", manifest.len() as u64, 200)?;
            stream.write_all(manifest)
        }
        ["GET", path, "HTTP/1.1"] if *path == artifact_route => {
            write_headers(&mut stream, "application/octet-stream", artifact_size, 200)?;
            let mut file = File::open(artifact_path)?;
            io::copy(
                &mut std::io::Read::by_ref(&mut file).take(artifact_size),
                &mut stream,
            )?;
            Ok(())
        }
        _ => write_headers(&mut stream, "text/plain", 0, 404),
    }
}

fn write_headers(
    stream: &mut TcpStream,
    content_type: &str,
    content_length: u64,
    status: u16,
) -> io::Result<()> {
    let reason = if status == 200 { "OK" } else { "Not Found" };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {content_length}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_fixture(directory: &Path, artifact: &[u8], sha256: &str) {
        fs::write(directory.join("WTS_0.1.2_aarch64.app.tar.gz"), artifact).unwrap();
        fs::write(
            directory.join(MANIFEST_FILE),
            serde_json::json!({
                "schemaVersion": 1,
                "version": "0.1.2",
                "notes": "Local QA update.",
                "pubDate": "2026-08-14T09:00:00Z",
                "artifactFile": "WTS_0.1.2_aarch64.app.tar.gz",
                "signature": "dGVzdHNpZ25hdHVyZQ==",
                "sha256": sha256,
                "size": artifact.len()
            })
            .to_string(),
        )
        .unwrap();
    }

    #[test]
    fn accepts_only_a_bounded_regular_artifact_with_the_declared_hash() {
        let directory = tempfile::tempdir().unwrap();
        let artifact = b"signed updater fixture";
        let digest = format!("{:x}", Sha256::digest(artifact));
        write_fixture(directory.path(), artifact, &digest);
        let prepared = PreparedLocalUpdate::load(directory.path())
            .unwrap()
            .expect("prepared update");
        assert_eq!(prepared.metadata.version, "0.1.2");

        write_fixture(directory.path(), artifact, &"0".repeat(64));
        assert_eq!(
            PreparedLocalUpdate::load(directory.path()).err(),
            Some(LocalUpdateError::Invalid)
        );
    }

    #[test]
    fn status_contract_does_not_expose_the_trusted_source_or_signature() {
        let serialized = serde_json::to_value(AppUpdateStatus {
            schema_version: SCHEMA_VERSION,
            state: AppUpdateStatusState::Available,
            current_version: "0.1.1".to_owned(),
            available_version: Some("0.1.2".to_owned()),
            published_at: Some("2026-08-14T09:00:00Z".to_owned()),
            notes: Some("Local QA update.".to_owned()),
            downloaded_bytes: None,
            total_bytes: Some(42),
            detail: "A signed local WTS update is available.".to_owned(),
            diagnostic_code: None,
        })
        .unwrap();
        assert_eq!(serialized["state"], "available");
        assert_eq!(serialized["availableVersion"], "0.1.2");
        assert!(serialized.get("url").is_none());
        assert!(serialized.get("path").is_none());
        assert!(serialized.get("sha256").is_none());
        assert!(serialized.get("signature").is_none());
    }

    #[test]
    fn only_a_verified_ready_status_can_request_a_relaunch() {
        let mut update_status = status(
            AppUpdateStatusState::Available,
            "0.1.1".to_owned(),
            "A signed local WTS update is available.",
            None,
        );
        assert!(!status_allows_relaunch(&update_status));

        update_status.state = AppUpdateStatusState::Ready;
        assert!(status_allows_relaunch(&update_status));
    }

    #[test]
    fn only_one_update_operation_can_run_at_a_time() {
        let active = Arc::new(AtomicBool::new(false));
        let first = claim_operation(Arc::clone(&active)).expect("first update operation");
        assert!(claim_operation(Arc::clone(&active)).is_none());
        drop(first);
        assert!(claim_operation(active).is_some());
    }

    #[test]
    fn loopback_source_requires_its_random_server_owned_route() {
        let token = Uuid::new_v4().simple().to_string();
        let url = loopback_manifest_url(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 49152), &token);
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        assert!(url.path().contains(&token));
        assert!(!url.path().contains("WTS_"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_update_artifact() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let outside = directory.path().join("outside");
        let artifact = b"signed updater fixture";
        fs::write(&outside, artifact).unwrap();
        let artifact_path = directory.path().join("WTS_0.1.2_aarch64.app.tar.gz");
        symlink(&outside, &artifact_path).unwrap();
        let digest = format!("{:x}", Sha256::digest(artifact));
        write_fixture(directory.path(), artifact, &digest);
        fs::remove_file(&artifact_path).unwrap();
        symlink(&outside, &artifact_path).unwrap();
        assert_eq!(
            PreparedLocalUpdate::load(directory.path()).err(),
            Some(LocalUpdateError::Invalid)
        );
    }
}
