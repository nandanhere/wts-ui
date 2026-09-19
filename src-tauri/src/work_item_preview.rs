use super::*;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::CapabilityBuilder;
#[cfg(test)]
use tauri::ipc::RuntimeCapability;

type PreviewClaims = HashMap<String, Arc<Mutex<Uuid>>>;
fn window_claims() -> &'static Mutex<PreviewClaims> {
    static CLAIMS: OnceLock<Mutex<PreviewClaims>> = OnceLock::new();
    CLAIMS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn preview_label(work_set_id: Uuid, task_id: Uuid) -> String {
    format!("wts-preview-{work_set_id}-{task_id}")
}

fn read_commands() -> Vec<String> {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/default.json"))
            .expect("built-in capability");
    capability["permissions"]
        .as_array()
        .expect("built-in permissions")
        .iter()
        .filter_map(|permission| permission.as_str())
        .filter_map(|permission| permission.strip_prefix("allow-"))
        .map(|command| command.replace('-', "_"))
        .filter(|command| {
            command.starts_with("get_")
                || command.starts_with("list_")
                || command == "read_workspace_planning_document"
        })
        .collect()
}

fn preview_capability(label: &str, origin: &str) -> CapabilityBuilder {
    let mut builder = CapabilityBuilder::new(format!("{label}-{}", Uuid::new_v4()))
        .window(label)
        .local(false)
        .remote(format!("{origin}/*"));
    for command in read_commands() {
        builder = builder.permission(format!("allow-{}", command.replace('_', "-")));
    }
    builder
}

fn initialization_script(title: &str) -> String {
    let allowed = serde_json::to_string(&read_commands()).expect("read command names");
    let caption = serde_json::to_string(&format!(
        "Preview: {title} · Read only. Use the main WTS window to make changes."
    ))
    .expect("preview title");
    format!(
        r#"(() => {{
      Object.defineProperty(window, '__WTS_NATIVE_PREVIEW__', {{
        value: Object.freeze({{schemaVersion:1,allowedCommands:Object.freeze({allowed})}})
      }});
      document.addEventListener('DOMContentLoaded', () => {{
        const notice = document.createElement('div');
        notice.textContent = {caption}; notice.setAttribute('role', 'note');
        notice.style.cssText = 'position:fixed;bottom:0;left:0;right:0;padding:8px 16px;background:#182330;color:#f1f5f9;font:12px system-ui;z-index:2147483647;box-shadow:0 -1px 0 #455568;pointer-events:none';
        document.body.append(notice); document.body.style.paddingBottom='34px';
      }});
    }})();"#
    )
}

pub(super) fn show_preview(
    app: &tauri::AppHandle,
    service: LocalWtsService,
    preview: wts_app::AgentWorkItemPreview,
) -> Result<wts_app::AgentWorkItemPreview, WorkspaceCommandError> {
    if preview.state != wts_app::AgentWorkItemPreviewState::Running {
        return Ok(preview);
    }
    let url = preview
        .url
        .as_ref()
        .and_then(|value| url::Url::parse(value).ok())
        .filter(|url| {
            url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.port().is_some()
                && url.username().is_empty()
                && url.password().is_none()
        })
        .ok_or_else(|| {
            preview_error("WTS did not return a valid preview address. Retry the preview.")
        })?;
    let label = format!(
        "{}-{}",
        preview_label(preview.work_set_id, preview.task_id),
        url.port().expect("validated port")
    );
    if let Some(window) = app.get_webview_window(&label) {
        if let Some(claim) = window_claims()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&label)
        {
            *claim.lock().unwrap_or_else(|error| error.into_inner()) = preview.preview_instance_id;
        }
        window.set_focus().map_err(|_| {
            preview_error("WTS could not focus the preview. Close its window and retry.")
        })?;
        return Ok(preview);
    }
    let origin = url.origin().ascii_serialization();
    let expected_url = url.to_string();
    let workspace_id = preview.workspace_id;
    let task_id = preview.task_id;
    let claim_id = preview.preview_instance_id;
    if app
        .add_capability(preview_capability(&label, &origin))
        .is_err()
    {
        let _ =
            service.stop_agent_work_item_preview(workspace_id, task_id, &expected_url, claim_id);
        return Err(preview_error(
            "WTS could not prepare the read-only preview. Retry the preview.",
        ));
    }
    let window = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(url))
        .title(format!("WTS preview · {}", preview.title))
        .inner_size(1280.0, 840.0)
        .initialization_script(initialization_script(&preview.title))
        .on_navigation(move |url| url.origin().ascii_serialization() == origin)
        .build();
    let window = match window {
        Ok(window) => window,
        Err(_) => {
            let _ = service.stop_agent_work_item_preview(
                workspace_id,
                task_id,
                &expected_url,
                claim_id,
            );
            return Err(preview_error(
                "WTS could not open the preview window. Retry the preview.",
            ));
        }
    };
    let claim = Arc::new(Mutex::new(claim_id));
    window_claims()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(label.clone(), claim.clone());
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let claim_id = *claim.lock().unwrap_or_else(|error| error.into_inner());
            let mut claims = window_claims()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if claims
                .get(&label)
                .is_some_and(|current| Arc::ptr_eq(current, &claim))
            {
                claims.remove(&label);
            }
            drop(claims);
            let service = service.clone();
            let expected_url = expected_url.clone();
            std::thread::spawn(move || {
                let _ = service.stop_agent_work_item_preview(
                    workspace_id,
                    task_id,
                    &expected_url,
                    claim_id,
                );
            });
        }
    });
    Ok(preview)
}

fn preview_error(message: &str) -> WorkspaceCommandError {
    WorkspaceCommandError {
        code: "agent_preview_unavailable",
        message: message.to_owned(),
        retryable: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn candidate_preview_capability_allows_only_reads_on_one_exact_window_and_origin() {
        let label = preview_label(Uuid::new_v4(), Uuid::new_v4());
        let tauri::utils::acl::capability::CapabilityFile::Capability(capability) =
            preview_capability(&label, "http://127.0.0.1:41231").build()
        else {
            panic!("Expected one preview capability");
        };
        let value = serde_json::to_value(capability).unwrap();
        let serialized = serde_json::to_string(&value).unwrap();
        assert!(serialized.contains(&label));
        assert!(serialized.contains("http://127.0.0.1:41231/*"));
        assert!(!serialized.contains("127.0.0.1:*"));
        for forbidden in [
            "allow-send-",
            "allow-create-",
            "allow-save-",
            "allow-run-",
            "allow-restore-",
            "allow-recover-",
            "allow-integrate-",
            "allow-publish-",
            "allow-open-",
        ] {
            assert!(!serialized.contains(forbidden), "{forbidden}");
        }
        assert!(serialized.contains("allow-get-workspace"));
        assert!(serialized.contains("allow-list-workspaces"));
        assert!(serialized.contains("\"local\":false"));
    }
    #[test]
    fn dynamic_preview_capability_resolves_reads_and_rejects_writes_at_native_authority() {
        let acl = serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
        let mut authority = tauri::ipc::RuntimeAuthority::new(acl, Default::default());
        let label = preview_label(Uuid::new_v4(), Uuid::new_v4());
        let origin = tauri::ipc::Origin::Remote {
            url: "http://127.0.0.1:41231/sessions/fixture/plans"
                .parse()
                .unwrap(),
        };
        assert!(
            authority
                .resolve_access("read_workspace_planning_document", &label, &label, &origin)
                .is_none()
        );
        authority
            .add_capability(preview_capability(&label, "http://127.0.0.1:41231"))
            .unwrap();
        for read in [
            "list_workspaces",
            "get_workspace",
            "list_workspace_planning_documents",
            "read_workspace_planning_document",
        ] {
            assert!(
                authority
                    .resolve_access(read, &label, &label, &origin)
                    .is_some(),
                "{read}"
            );
            assert!(
                authority
                    .resolve_access(read, "other-window", "other-window", &origin)
                    .is_none(),
                "{read}"
            );
            assert!(
                authority
                    .resolve_access(
                        read,
                        &label,
                        &label,
                        &tauri::ipc::Origin::Remote {
                            url: "http://127.0.0.1:41232/".parse().unwrap()
                        }
                    )
                    .is_none(),
                "{read}"
            );
            assert!(
                authority
                    .resolve_access(read, &label, &label, &tauri::ipc::Origin::Local)
                    .is_none(),
                "{read}"
            );
        }
        for write in [
            "update_workspace_planning_document",
            "reply_gitlab_discussion",
            "send_agent_conversation_message",
            "restore_agent_turn",
            "recover_workspace_setup",
            "integrate_agent_work_item",
            "open_agent_work_item_preview",
        ] {
            assert!(
                authority
                    .resolve_access(write, &label, &label, &origin)
                    .is_none(),
                "{write}"
            );
        }
    }

    fn installed_tauri_core() -> Option<String> {
        let cargo_home = std::env::var_os("CARGO_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".cargo"))
            })?;
        let sources = std::fs::read_dir(cargo_home.join("registry/src")).ok()?;
        for source in sources.flatten() {
            let path = source
                .path()
                .join(format!("tauri-{}/scripts/core.js", tauri::VERSION));
            if let Ok(script) = std::fs::read_to_string(path) {
                return Some(
                    script
                        .replace("__TEMPLATE_os_name__", "\"macos\"")
                        .replace("__TEMPLATE_protocol_scheme__", "\"http\""),
                );
            }
        }
        None
    }

    #[test]
    fn preview_notice_publishes_immutable_guidance_after_tauri_initialization() {
        let source = "Title </script> ` ${window.secret} \\\"";
        let script = initialization_script(source);
        let installed = installed_tauri_core();
        eprintln!(
            "Installed Tauri {} core.js executed: {}",
            tauri::VERSION,
            installed.is_some()
        );
        let core = installed.unwrap_or_else(|| r#"
          Object.defineProperty(window.__TAURI_INTERNALS__, 'invoke', { value: async(command,args) => { calls.push([command,args]); return 'read-result'; } });
        "#.to_owned());
        let program = format!(
            r#"
          const calls=[]; let notice;
          global.window={{__TAURI_INTERNALS__:{{}},crypto:require('node:crypto').webcrypto}};
          global.document={{addEventListener:(_,callback)=>callback(),createElement:()=>({{setAttribute(){{}},style:{{}}}}),body:{{append(value){{notice=value}},style:{{}}}}}};
          {core}
          window.__TAURI_INTERNALS__.ipc = message => {{ calls.push([message.cmd,message.payload]); window.__TAURI_INTERNALS__.runCallback(message.callback,'read-result'); }};
          const originalInvoke=window.__TAURI_INTERNALS__.invoke;
          {script}
          (async()=>{{
            const assert=require('node:assert/strict');
            const marker=window.__WTS_NATIVE_PREVIEW__;
            assert.equal(marker.schemaVersion,1);
            assert.equal(Object.isFrozen(marker),true);
            assert.equal(Object.isFrozen(marker.allowedCommands),true);
            const descriptor=Object.getOwnPropertyDescriptor(window,'__WTS_NATIVE_PREVIEW__');
            assert.equal(descriptor.writable,false); assert.equal(descriptor.configurable,false);
            assert.ok(marker.allowedCommands.includes('get_workspace'));
            assert.ok(marker.allowedCommands.includes('read_workspace_planning_document'));
            for(const command of ['send_agent_conversation_message','integrate_agent_work_item','save_repository_source','open_agent_work_item_preview']){{
              assert.equal(marker.allowedCommands.includes(command),false);
            }}
            assert.equal(window.__TAURI_INTERNALS__.invoke,originalInvoke);
            assert.equal(Object.getOwnPropertyDescriptor(window.__TAURI_INTERNALS__,'invoke').writable,false);
            assert.equal(await window.__TAURI_INTERNALS__.invoke('read_workspace_planning_document',{{workspaceId:'source',documentId:'plan'}}),'read-result');
            assert.deepEqual(calls,[['read_workspace_planning_document',{{workspaceId:'source',documentId:'plan'}}]]);
            assert.equal(notice.textContent,{caption});
          }})().catch(error=>{{console.error(error);process.exit(1)}});
        "#,
            caption = serde_json::to_string(&format!(
                "Preview: {source} · Read only. Use the main WTS window to make changes."
            ))
            .unwrap()
        );
        let result = std::process::Command::new("node")
            .args(["-e", &program])
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
