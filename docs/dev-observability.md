# Development observability

WTS development builds expose enough local context to diagnose workspace
imports without recording the selected file or credentials. This document is
both the current runbook and the roadmap for broader development visibility.

## Delivery status

| Set | Status | Scope |
| --- | --- | --- |
| 1. Import and operation diagnostics | **Implemented** | Correlated Rust import logs, bounded match diagnostics, sanitized graph, repository-base browser, legacy one-shot agent, and Workspace CLI launch events, a developer UI panel, and a copyable import payload |
| 2. Development event recorder | **Partial** | The CLI surface reports truthful accepted/rejected handoff state, and legacy one-shot runs retain bounded evidence. A global timeline, rotated logs, error capture, and a diagnostic bundle remain planned |
| 3. Catalog controls | **Partial** | Bounded nested discovery and environment-configured multiple roots are implemented. Explicit rescans, scan-generation evidence, and reviewed persistent registration remain planned |

The remaining Set 2 and Set 3 controls describe intended work. They are not
promises about behavior in the current build.

## Set 1: VS Code workspace import diagnostics

Set 1 is available when the Rust host is compiled as a debug build, including
the normal `cargo run -p wts-server` and `npm run desktop:dev` workflows.

Each request that passes the transport guards and extractor and enters the
import handler receives an opaque import ID. A successful debug-build response
also returns a bounded `diagnostics` object containing:

- the primary configured repository root exposed by the current UI wire,
  discovered repository count, skipped-entry count, and a bounded catalog
  sample.
- one result per workspace folder, including its status and stable reason.
- the ordered matching attempts: exact absolute path, safe relative-path
  suffix, path basename, and optional VS Code folder name where applicable.
- candidate counts and a bounded set of decisive repository candidates.
- whether a folder selected a repository that an earlier folder had already
  selected.

The UI shows this data under **Developer diagnostics** in the import preview.
A release Rust build omits the debug diagnostics and the panel remains hidden.
A production-built `ui/dist` still shows the panel when it is served by a
debug Rust host because availability is controlled by the trusted response,
not by a CSS or client-side toggle.

When `WTS_REPOSITORY_ROOTS` configures more than one trust root, the current
catalog and diagnostics wire continues to show one canonical root as the
primary root. Debug repository-catalog events record the bounded list of all
configured roots and their count. Those values are local paths and follow the
disclosure rules below.

Relative folder paths remain non-authoritative. WTS does not open them relative
to the selected file. It compares their final folder name, followed by an
optional VS Code display name, with labels in the configured local catalog.
The diagnostics explain that decision. They do not widen filesystem access.
URI-shaped path or `uri` values are represented as the literal
`<unsupported-uri>` in diagnostics, copied JSON, and development events.
URI-shaped optional folder names are discarded before matching or
serialization, including when the same folder has an ordinary local path. In
that case the displayed name falls back to the local path's basename. WTS does
not retain or reproduce either URI-shaped value, including any user
information, host, query, or fragment it may contain.

Set 1 correlation starts after HTTP authentication, request-size enforcement,
and request extraction. A request rejected by authentication, body limits,
content type, or JSON extraction does not enter the import handler and does not
receive an import ID. Import error envelopes also do not yet guarantee that an
assigned ID is surfaced to the UI. Set 2 must move diagnostic-ID assignment to
the outer transport boundary and return it on sanitized errors without
weakening authentication.

### Enable and read the Rust logs

The debug server's default filter enables `wts_server` information events, the
bounded repository-catalog scan summary, and sanitized graph, CLI-launch, and
legacy one-shot agent operation events while keeping generic HTTP tracing
quiet. Use `RUST_LOG` when a focused or more verbose trace is useful:

```bash
export RUST_LOG='wts_server=info,wts_app::repository_catalog=info,wts_app::operations=info,tower_http=warn'
cargo run -p wts-server
```

For import and HTTP request details only:

```bash
export RUST_LOG='wts_server::code_workspace_import=info,wts_server::http=info,wts_app::repository_catalog=info,wts_app::operations=info'
cargo run -p wts-server
```

The browser host writes logs to the terminal that launched `wts-server`. The
Tauri debug host initializes the same development tracing boundary and writes
its correlated import events to the terminal that launched the desktop app:

```bash
export RUST_LOG='wts_desktop::code_workspace_import=info,wts_app::repository_catalog=info,wts_app::operations=info'
npm run desktop:dev
```

Set 1 does not retain, rotate, or upload either stream. If a temporary
browser-host capture is required, create a developer-private directory and
retain it only as long as the investigation:

```bash
wts_dev_log_dir="$(mktemp -d)"
chmod 700 "$wts_dev_log_dir"
umask 077
RUST_LOG='wts_server=info,wts_app::repository_catalog=info,wts_app::operations=info,tower_http=warn' \
  cargo run -p wts-server 2>&1 | tee "$wts_dev_log_dir/wts-dev.log"
```

After reproducing the problem, copy the import ID from the UI and find the
corresponding operation:

```bash
rg 'repository_catalog|code_workspace_import|PASTE-IMPORT-ID-HERE' \
  "$wts_dev_log_dir/wts-dev.log"
```

The HTTP development trace records the method, URL path, response status, and
latency. It does not record query values, headers, or bodies. Import events
record the opaque import ID and bounded start, catalog, folder, and completion
metadata. A Vite development client also writes a structured completion or
failure event to the browser console. Completion logging is enabled whenever
the host supplied debug diagnostics, so it also works when a debug host serves
a production UI build.

When the browser cannot reach the Rust host at all, the development client
writes a bounded `httpTransportFailed` event to the browser console with the
request stage, method, URL path, stable error code, and retryability. It never
records the request body, session token, headers, query values, native
exception text, or configured host. The visible error explains that Vite alone
cannot service WTS operations and points developers to the Tauri or authenticated
loopback-host workflows instead of exposing the browser's generic
`Failed to fetch` message.

Graph, Workspace CLI, and legacy one-shot agent operations use the
`wts_app::operations` target. Graph events record start, end, failure, workspace
ID, whether the request was forced or served from an existing index, elapsed
time, adapter duration, and a stable failure category.

Repository-base browser launches record `repository_base.launch_begin`,
`repository_base.launch_end`, or `repository_base.launch_failed`. The end event
includes the stable local repository ID, forge kind, operation ID, total
elapsed time, and separate catalog-lookup, local-Git-resolution, and browser
handoff timings. Failures include those timings plus only a stable category.
Interactive link opens reuse the last host-owned catalog identity snapshot and
then re-inspect Git identity and the selected ref, so an expired scan TTL does
not turn a click into a full repository-root rescan. These events intentionally
omit the requested base, resolved commit, checkout path, origin, generated
browser URL, credentials, and browser session state. An end event means only
that the operating system accepted the browser handoff. It cannot establish
that the remote repository, revision, or page exists, that the user is
authenticated, or that access succeeded.

Workspace CLI launches record `workspace_cli.launch_begin`,
`workspace_cli.launch_end`, or `workspace_cli.launch_failed`, plus workspace
ID, provider, elapsed time, and a stable failure category. They do not record
the workspace path or the fixed command. The event includes the fixed terminal
identifier (`warp` or `terminal`). The end event means only that the selected
terminal accepted the handoff. It cannot establish provider authentication,
process start, running status, completion, or success.

Legacy one-shot agent events record start, end, failure, workspace ID, durable
run ID, provider, elapsed time, provider duration where available, and a stable
failure category. All of these operation events omit prompts, provider output,
process arguments, environments, credentials, and full workspace paths. They
are compiled only into debug builds.

### Inspect a Workspace CLI launch

Open a materialized workspace and select **CLI**. The panel shows:

- the validated working directory, selected provider, and selected terminal.
- whether the browser is requesting the launch, whether the terminal accepted the
  handoff, or the sanitized launch error.
- a **Launch details** disclosure with the fixed provider command, the selected terminal as
  process owner, and the accepted/rejected-only lifecycle boundary.
- optional Graphify readiness, explicitly separate from CLI availability.

The live provider session is visible only in Warp or native macOS Terminal. Sign-in,
permission prompts, input, output, and process exit remain there. WTS does not
collect its output, retain a transcript, poll status, or expose a stop action.
Closing or reloading WTS does not stop the handed-off process.

For a debug-host correlation, filter the local log by workspace ID or CLI event
name:

```bash
rg 'workspace_cli\.launch_(begin|end|failed)|PASTE-WORKSPACE-ID-HERE' \
  "$wts_dev_log_dir/wts-dev.log"
```

The older `workspace_agent.run_*` events and `.wts/agent-runs/` summaries belong
to the compatibility one-shot API. They are not evidence for a session opened
from the primary CLI tab.

### Inspect and copy import diagnostics

1. Open **New workspace** and select **VS Code workspace file**.
2. Choose the file and wait for the import preview.
3. Expand **Developer diagnostics**.
4. Check **Repository root**, **Catalog result**, and **Catalog sample**.
5. Review each folder's reason and ordered matching attempts.
6. Select **Copy diagnostics** and correlate its `importId` with the Rust
   terminal.

The copied JSON is designed for a local bug report. It includes:

- the file name and opaque import ID.
- folder, match, and warning counts.
- the primary configured repository root exposed by the current UI wire.
- bounded repository labels, stable local repository IDs for matched folders,
  and display paths.
- non-URI folder names and raw folder paths from the selected file, with
  URI-shaped path values replaced by `<unsupported-uri>` and URI-shaped names
  discarded.
- matching reasons, attempts, candidate counts, and bounded candidates.

It excludes the workspace-file contents, settings, tasks, extensions, launch
configuration, session token, request headers, and credentials. Local paths
and repository labels are intentionally present because they are necessary to
diagnose catalog scope. Excluding known secret-bearing fields does not make the
payload universally safe or anonymous. Review and minimize it before posting
outside the development team.

### Logging and redaction contract

Development observability must follow this contract across HTTP and Tauri:

| May be recorded | Must never be recorded |
| --- | --- |
| Opaque operation/import IDs and host-derived local repository IDs | Session tokens, authorization values, cookies, or full request headers |
| Event name, status, duration, bounded counts | Request or response bodies |
| File basename and byte count | `.code-workspace` contents |
| Configured local roots, repository labels, and display paths, with an explicit local-path disclosure | Settings, tasks, extensions, launch configuration, or ignored configuration values |
| Non-URI folder names, non-URI raw folder paths, match bases, reasons, and candidate counts | Remote origin URLs, unsupported folder URIs, URI-shaped folder names, URL user information, provider configuration, or process environments |
| Stable error codes and retryability | Git command output, agent prompts/output, or arbitrary exception objects without redaction |

Additional rules:

- Debug-only data is omitted from release payloads and release-only UI.
- Diagnostic collections and strings stay bounded. Truncation is explicit.
- User-supplied text is a field value, never a log event name or format string.
- Repository-base launch logs may identify the catalog repository and supported
  forge kind, but never record the requested ref, commit OID, origin, or
  generated browser URL.
- URI-shaped path values are replaced by `<unsupported-uri>`, and URI-shaped
  folder names are discarded, before they enter diagnostics, logs, console
  events, or copied JSON. This applies even when a URI-shaped name accompanies
  an ordinary local path.
- Logs remain local and are never uploaded automatically.
- Copying or persisting diagnostics is a deliberate developer action.
- Tests use sentinel credentials to prove that source contents and secrets do
  not enter responses, console events, terminal logs, or copied JSON.

## Troubleshooting a zero-match import

When the preview says that no local repositories matched:

1. Compare the diagnostic **Repository root** with the location of the source
   repositories. With multiple configured roots this field shows only the
   primary root, so use the `repository_catalog.scan_begin` development event
   to inspect the bounded list of all configured roots.
2. Confirm that the **Catalog result** contains the expected number of
   repositories. WTS deterministically scans at most four directory levels and
   4,096 directories across the configured roots. It never traverses symlinks,
   stops descending when it reaches a Git repository, and prunes common
   dependency, generated, and VCS metadata directories.
3. Review the ordered attempts. A relative path with at least two safe
   components is first compared lexically with trusted checkout-path suffixes
   and aliases, then WTS falls back to the path basename and optional VS Code
   name. Repository labels can come from the Git origin rather than the
   checkout directory name.
4. Check for an ambiguous label. Two different checkouts can derive the same
   case-insensitive catalog label.
5. Remember that a relative path is not resolved against the location of the
   `.code-workspace` file and is never opened. Its suffix is only a
   non-authoritative catalog-matching hint.
6. Copy the diagnostic payload and correlate its import ID with the terminal
   log before changing configuration.

Changing `WTS_REPOSITORY_ROOTS` or `WTS_REPOSITORY_ROOT` requires a host restart
today. `WTS_REPOSITORY_ROOTS` is a platform path list and takes precedence over
the single-root variable. The Preferences refresh action rereads the configured
catalog after its short cache expires. It is not an authoritative
cache-invalidating rescan and does not persistently register a repository.

### Sanitized `infra.code-workspace` example

The reported `infra.code-workspace` topology can be represented without a user
name or remote URL:

```text
<dev-root>/
├── workspaces/
│   ├── infra.code-workspace
│   ├── dashboard/
│   └── wts-ui/
├── active/
│   └── infra/
│       └── <13 Git repositories>
└── <one sibling Git repository>
```

With `WTS_REPOSITORY_ROOT=<dev-root>/workspaces`, bounded nested discovery stays
inside that trust root. It can find repositories nested below `workspaces`, but
it cannot discover the 13 repositories below `active/infra` or the sibling
repository merely because the file refers to them. Those entries therefore
remain unmatched under the catalog-only security boundary.

On macOS or Linux, a developer who intends to trust all three locations can
configure a platform path list such as:

```bash
export WTS_REPOSITORY_ROOTS="<dev-root>/workspaces:<dev-root>/active/infra:<dev-root>/<sibling>"
```

The host inspects those local checkouts and their Git origin metadata. It still
does not follow file paths, clone, or fetch. The scan can also expose identity
mismatches that logging needs to make obvious: a checkout directory can derive
a different label from its origin, and two checkout directories can derive the
same label.

## Set 2: bounded development event recorder (planned)

The next slice should connect user actions to host operations beyond this one
import flow:

- record file-selection, local read, request start/end, navigation, stale
  result suppression, and handled/unhandled failures.
- assign one correlation ID at the outer HTTP or Tauri boundary before
  authentication and extraction, surface it on sanitized error responses, and
  carry it through the UI, service, and successful result.
- keep a bounded in-memory ring, for example 500 events, with deterministic
  eviction.
- add a development-only diagnostics drawer with **Copy sanitized bundle** and
  **Clear** controls.
- optionally write owner-only JSONL files under
  `WTS_DATA_DIR/dev-logs`, with byte and age limits plus rotation.
- include build identity, runtime mode, configured roots, catalog counts,
  recent operation IDs, and sanitized events in the bundle.

The recorder must use the Set 1 redaction contract. Production builds must not
expose its drawer, endpoint, global object, or disk writer.

Required coverage includes event ordering, cross-layer correlation, stale
request suppression, ring eviction, rotation and file permissions, malformed
event bounds, production omission, and property-style secret-redaction tests.

## Set 3: catalog discovery controls (partially implemented)

The catalog now supports deterministic nested discovery across one or more
environment-configured trust roots. Each scan is bounded to depth 4 and 4,096
directories, never traverses symlinks, stops at Git repository boundaries,
prunes dependency/generated directories, and deduplicates the same canonical
repository reached through multiple roots.

The remaining catalog-control slice should add:

- an explicit authoritative **Rescan repositories** operation rather than a
  refresh that depends on a short cache timeout.
- scan generation, duration, cache status, candidate count, and bounded skip
  reason counts.
- user-approved persistent repository registration and root management in the
  application.
- a reviewed preview before registering paths suggested by a selected file.
- clearer UI treatment for origin-derived label mismatches and duplicate
  labels.

An imported file must remain a suggestion source. It must not silently expand
the trusted filesystem boundary, follow remote URIs, clone repositories, or
persist new roots.

Required fixtures include nested and outside-root repositories, symlinks,
mixed-root workspace files, duplicate canonical repositories, duplicate
case-insensitive labels, origin labels that differ from directory basenames,
cache invalidation, explicit rescans, and registration persistence after
restart.
