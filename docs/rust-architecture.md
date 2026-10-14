# WTS architecture

## Decision

Use one shared Rust application service behind two thin hosts:

- **WTS Desktop:** Tauri v2 embeds the React/Vite interface and exposes a narrow
  set of typed Rust commands.
- **`wtsd`:** Axum serves the same compiled interface and exposes the same
  operations through an authenticated loopback API for browser and Linux/x86
  use.

React owns presentation. Rust owns repository discovery, path construction,
Git effects, durable state, effect validation, and external launch. The core is
local and offline-capable. Jira and AI traffic is isolated behind explicit
adapters and user actions.

## Implemented MVP boundary

`LocalWtsService` in `wts-app` is the trusted application boundary. The working
vertical slice is:

1. `wts-core` validates versioned workspace-plan DTOs.
2. `wts-store` persists an append-only creation event, idempotency key, and
   current projection in one SQLite `IMMEDIATE` transaction.
3. `LocalWtsService` deterministically discovers existing Git repositories
   below one or more configured trust roots, within fixed depth and directory
   limits.
4. An optional, read-only `.code-workspace` import accepts one bounded
   user-selected file, reads only folder entries, and matches them against the
   local catalog. Unmatched and ambiguous entries are diagnostics, not
   authority. Editor settings, tasks, extensions, and launch configuration are
   ignored.
5. A read-only preflight resolves each pinned repository identity (or the
   unique label on a legacy plan) and base ref into an exact local checkout,
   full ref, commit OID, branch name, and Rust-owned target path.
6. Before save, an optional read-only runtime analyzer reads only bounded,
   allowlisted blobs from those exact commits. It returns deterministic
   service/port candidates with evidence. The browser may retain candidate IDs
   and bounded port-policy overrides, but cannot supply executable or path
   authority. Save re-runs the analysis and rejects stale or unknown
   selections.
7. A successful create retry is replayed from the durable idempotency record
   before mutable repository inputs are inspected again.
8. Preflight resolves the current exact commits, re-runs runtime analysis, and
   blocks a saved service plan whose digest, candidate IDs, ports, or dependency
   closure is no longer valid.
9. The deterministically serialized Git, reviewed runtime intent, and optional
   bounded planning-home selection receive a SHA-256 effect digest.
10. Materialization re-runs preflight and rejects a stale digest before making
    changes.
11. `wts-git` creates each worktree from the commit OID pinned by preflight,
    never from a ref that could move between validation and creation. It creates
    the multi-repository worktree set transactionally. On a
   partial failure it removes only worktrees, branches, and directories proven
   to have been created by that attempt.
12. When selected, WTS creates a fixed `plans/` or `plans-and-kanban/` starter
    and adds it to the multi-root workspace. The browser never supplies a path.
    Starter files are created once and then become user-owned content.
13. WTS writes `wts.code-workspace` and `.wts-workspace.json` through bounded
    atomic renames. A file failure removes only starter/generated files proven
    to belong to that attempt and triggers the same Git rollback.
14. Reload and VS Code launch revalidate the persisted manifest, target
    repository identities, and exact generated workspace before
    `code --new-window <trusted-path>` is spawned.

The source checkouts remain on their original branches. A valid existing
manifest makes materialization replay-safe and returns the durable result.
The same reconciliation and replay path is exercised after reopening the
service against the existing SQLite registry and workspace root.

The Graphify field starts as `notStarted`. An explicit Agent-tab action runs a
workspace-local structural update and changes the derived materialization view
to `ready` only after a regular, non-symlink `graphify-out/graph.json` exists.

## Repository shape

```text
ui/                    React + TypeScript + Vite
src-tauri/             desktop host and narrow Tauri commands
crates/wts-core/       workspace-plan and boundary protocol
crates/wts-store/      SQLite plan registry and creation events
crates/wts-git/        repository inspection, preflight, worktrees, rollback
crates/wts-integrations/
                       bounded setup detection and Jira MCP stdio client
crates/wts-app/        service orchestration, manifest, graph/agent adapters
crates/wts-server/     authenticated loopback host (`wtsd`)
```

Runtime process start/stop, actual port allocation, PTY/terminal, and
status/review/deployment adapters remain outside the current service boundary.
Runtime analysis and durable preferred-port intent are inside it.

Planning-home selection is also inside the durable plan boundary. WTS derives
the fixed leaf from an enum, allows users and agents to edit its contents
without manifest drift, and treats the directory as user-owned during removal:
its presence blocks deletion instead of being recursively cleaned up.
WTS reads only the fixed planning-file names. It records canonical Jira keys
and source filenames in a separate SQLite projection. This observation can
inform repository recommendations, but it cannot change repository authority.

## Current trust and effect flow

```text
React view
   │ workspace ID, typed request, approved digest, explicit adapter action
   ├──────────── Tauri IPC ─────────────┐
   └──── authenticated loopback HTTP ───┤
                                       ▼
                               LocalWtsService
                         ┌───────────────┼──────────────┐
                         ▼               ▼              ▼
                    SQLite store   setup/imports    Git preflight
                         │                │                │
                         │                │      reviewed effect digest
                         │                │                ▼
                         │                │     transactional worktrees
                         │                │                │
                         └──── graph + provider adapters ──┘
```

The browser cannot nominate a source path, target path, or executable as
authority. It can submit the bounded contents and display name of a file the
user explicitly selected. Rust treats `.code-workspace` folder entries only as
catalog-matching hints and returns matched suggestions plus unmatched or
ambiguous diagnostics. It does not retain the source file or follow its paths.
Saved plans and every later effect are still resolved against host-owned
repository trust roots and the workspace root.

Effectful materialization requires the exact digest returned by the most recent
preflight. The HTTP endpoint also requires a UUID `Idempotency-Key`.
Workspace-plan creation has its own restart-safe idempotency key in the SQLite
store.

Runtime analysis accepts only pinned repository IDs, labels, and requested
base refs. `LocalWtsService` resolves them through the trusted catalog, and
`wts-git` reads allowlisted regular blobs from the exact commit tree with
file-count, per-file, aggregate-byte, path-depth, and command-output limits.
The dirty checkout, real `.env` files, symlinks, submodules, remote origins,
and network are not consulted. A saved runtime selection contains only the
server analysis digest, deterministic candidate/port IDs, preferred ports, and
policies. Creation re-analyzes and rejects a stale digest or an ID not present
in the server result.

## Repository discovery

Repository roots are local trust boundaries and not a persistent registration
database. The first canonical root is also the host-owned destination for an
explicit reviewed repository clone. Imported files and browser requests never
supply that destination. `WTS_REPOSITORY_ROOTS`, when non-empty, is
parsed with the platform path-list format and takes precedence over
`WTS_REPOSITORY_ROOT`. The existing single-root variable remains compatible.
Every root must be an existing absolute directory.

For each configured root, discovery:

- traverses directories in deterministic order to at most depth 4 and stops
  after 4,096 visited directories across the scan.
- never follows symlinks.
- stops descending when it reaches a valid Git repository, so a checkout is a
  traversal boundary.
- prunes VCS metadata and common generated or dependency directories,
  including `.git`, `.hg`, `.svn`, `.next`, `node_modules`, and `target`.
- keeps only valid local Git worktrees and canonically deduplicates a
  repository reached through more than one root.
- reports bounded skip counts without exposing Git command output.
- derives stable local repository IDs, origin-informed labels, checkout
  aliases, and default-branch evidence.
- pins catalog-backed plan entries by repository ID while legacy entries
  retain case-insensitive unique-label matching.
- blocks a missing pinned identity without falling back to a same-named
  checkout.

Default-branch resolution is local and deterministic: locally available
`origin/HEAD` metadata is preferred when available, followed by conventional
local/cached branches and bounded fallbacks. Repository inspection and
preflight perform no fetch, clone, checkout, or other network operation. The
separate clone command accepts only validated HTTPS/SSH remotes, invokes Git
without a shell or terminal prompt, stages below the trusted root, verifies the
origin, and atomically renames the inspected checkout. A
user-entered base ref can override the discovered default.

VS Code workspace import does not widen discovery. Only matched catalog entries
can become automatic repository suggestions. Missing or ambiguous folder
entries remain visible for user action. A user may separately clone a reviewed
remote, which refreshes the catalog and adds that trusted checkout to the
current plan. Settings, tasks, extensions, launch configuration, and
all other editor data are outside the import contract. Folder paths and names
are hints. Matching tries an exact absolute trusted checkout path first. A
relative path with at least two safe components can then match the lexical
suffix of a catalog-owned checkout path or linked-worktree alias before WTS
falls back to the checkout leaf, origin-informed label, and optional folder
name. The imported path is never opened or canonicalized. A matched catalog
repository contributes its stable local ID to the new plan. Exact-path,
relative-suffix, and unique-leaf matches therefore remain safe even when
another repository has the same display label. WTS does not use a path in the
file as filesystem authority or a repository URL.

The catalog response currently retains one `repositoryRootDisplayPath` for
wire compatibility and exposes one canonical configured root there as the
primary root. Debug repository-catalog logs include the bounded list of all
configured roots.
Native repository-folder selection, persistent repository registration, and
authoritative rescans are deferred. WTS supports explicit remote Git cloning
into a trusted repository root. After reviewed preflight, materialization
creates linked worktrees below the host-owned `WTS_WORKSPACE_ROOT`.

Repository sync accepts only workspace and repository identities from the UI.
The Rust service resolves the trusted worktree and saved branch. It resolves
the local branch's configured tracking remote and fetches that remote branch.
The remote name is not limited to `origin`. WTS permits only a clean
fast-forward with no local commits or ignored files. After a commit change, the
service invalidates old graph and verification evidence. It rebuilds the graph
and records every current worktree HEAD before it reports the graph as ready.

## Setup detection

`wts-integrations` performs read-only, lightweight discovery:

- Git, VS Code, Codex, OpenCode, Hermes, and Graphify are resolved from `PATH`.
- every executable receives only a fixed `--version` argument.
- probes have bounded time and output.
- probes do not invoke a shell, contact the network, install anything, or
  mutate provider configuration.
- installation, setup/authentication, runtime, current WTS support, verification
  kind, and aggregate status are independent fields.

A successful version probe cannot establish agent authentication, so Codex,
OpenCode, and Hermes remain `unverified`. Git, VS Code, the three agent
providers, and Graphify report WTS support as `available`. Availability means
the typed adapter exists, not that the executable or account is ready.
`WTS_JIRA_MCP_URL` is still only a secret-free detection signal because the
implemented Jira transport is stdio.

When the Jira environment signal is absent, the detector can recognize a
Jira/Atlassian registration in VS Code's standard user MCP configuration. It
does not retain or expose any command, URL, header, environment value, or
credential. A fixed, bounded `podman ps` probe may report a known
`mcp-atlassian` container as running externally. That VS Code-owned stream is
never reused. An explicit Jira verification or import loads an allowlisted
stdio registration, starts a separate WTS-owned child, completes
initialize/initialized, discovers tools, and requires exactly
`jira_get_issue`. MCP messages, host configuration, and imported issue content
are size-bounded.

Only Git gates worktree materialization. VS Code gates the explicit editor
launch. Other missing integrations do not prevent the direct-repository flow.

## Persistence and reconciliation

The plan registry lives in the host data directory. Materialization evidence
lives with the generated workspace:

- `wts.code-workspace` contains the exact multi-root folder list.
- `.wts-workspace.json` records the schema version, workspace record version,
  effect digest, branch, worktree identities, target paths, base commits, and
  optional reviewed runtime intent.
- Workspace-root `AGENTS.md` directs agents to the current WTS guide.
- Workspace-root `WTS.md` contains generated boundaries and a preserved current
  task. WTS refreshes both files before each editor or agent handoff.

WTS owns only the two files at the workspace root. It does not replace an
`AGENTS.md` file inside a repository worktree.

Loading a materialization validates that the workspace ID and record version
still match, the manifest branch matches the branch derived from the saved
record, targets remain direct non-symlink children of the trusted workspace,
each target has the recorded repository identity, recorded commit OIDs are
well-formed, and the generated VS Code JSON is exact. An invalid manifest is
reported rather than silently accepted or repaired.

Graph readiness is derived from a validated workspace-local graph file. Agent
processes are one-shot and are not resumed, but bounded result summaries are
persisted as evidence: at most 256 summaries and 4 MiB of summary JSON per
workspace. The new runtime supervisor owns dependency-ordered service process
groups and loopback ports only for the lifetime of its Rust owner. Runtime
state is not persisted or reconciled after an application restart yet. There
are no PTYs to reconcile.

The parallel collaboration core accepts only canonical, disjoint repository
write scopes, bounds active Codex processes, and retains digest-only summary
evidence. It is not exposed through either host surface yet.

## Host surfaces

Tauri exposes typed commands for:

- list, get, and create plan.
- setup snapshot and repository catalog.
- explicit repository clone from a validated HTTPS/SSH remote.
- bounded VS Code workspace-file import.
- workspace preflight and materialization status.
- workspace materialization.
- explicit VS Code open.
- Graphify workspace indexing.
- Codex, OpenCode, and Hermes one-shot runs.
- Jira MCP verification and issue import.

Axum exposes the equivalent versioned routes:

```text
GET  /api/v1/bootstrap
GET  /api/v1/setup
GET  /api/v1/repositories
POST /api/v1/code-workspaces/import
GET  /api/v1/workspaces
POST /api/v1/workspaces
GET  /api/v1/workspaces/{id}
GET  /api/v1/workspaces/{id}/preflight
GET  /api/v1/workspaces/{id}/materialization
POST /api/v1/workspaces/{id}/materialize
POST /api/v1/workspaces/{id}/open/vscode
POST /api/v1/workspaces/{id}/graph/index
POST /api/v1/workspaces/{id}/agents/{provider}/run
POST /api/v1/integrations/jira-mcp/verify
POST /api/v1/jira/issues/{issue_key}/import
```

Potentially blocking local operations run outside Axum's async executor.
Errors cross both hosts as stable, sanitized codes rather than raw Git or
provider output.

The desktop host exposes the equivalent import operation through
`import_code_workspace_file`.

## Browser-host security

- `wtsd` refuses a non-loopback bind address.
- The API enforces its exact bound Host and Origin.
- Startup generates a random per-process session token. The compiled UI gets it
  from the bootstrap route and sends it on protected requests.
- Protected mutation requests use strict schemas and reject unknown fields.
- Git is invoked with typed argument vectors, never a shell command string.
- Provider adapters use fixed argument vectors and a Rust-validated generated
  workspace. No arbitrary executable or working directory comes from the UI.
- Jira accepts only allowlisted `mcp-atlassian` stdio commands and rejects
  shells, substitutions, invalid environment keys, and oversized messages.
- Generated files are size-bounded and written atomically.
- Rollback is provenance-limited and never removes an unproven path or branch.

## Configuration and development

All configured paths for `wtsd` must be absolute. Every repository root must
already exist. The workspace root is created if necessary.

```bash
npm --prefix ui install
npm --prefix ui run build

export WTS_REPOSITORY_ROOT=/absolute/path/to/source-repositories
export WTS_WORKSPACE_ROOT=/absolute/path/to/generated-workspaces
export WTS_DATA_DIR=/absolute/path/to/wts-data
export WTS_ADDR=127.0.0.1:4300

cargo run -p wts-server
```

For multiple repository roots, use the platform path-list variable instead.
It takes precedence over `WTS_REPOSITORY_ROOT`:

```bash
# macOS/Linux example
export WTS_REPOSITORY_ROOTS="/absolute/path/to/repositories:/absolute/path/to/other-repositories"
```

Desktop development:

```bash
cargo tauri dev
```

Verification:

```bash
npm --prefix ui test
npm --prefix ui run build
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

## Next architectural slices

1. Add native repository-folder selection, persistent repository
   registration, and an authoritative rescan before adding remote Git cloning.
2. Add Jira OAuth 2.1/PKCE and HTTP MCP without weakening the current
   allowlisted stdio boundary.
3. Add reusable default-branch Graphify caches and expose graph revisions as
   evidence, not authority.
4. Wire the runtime supervisor to durable start/stop/inspect/park jobs, add
   bounded disk logs and adaptive resource sampling, and expose reviewed stack
   plans through the Workbench.
5. Wire the scoped collaboration coordinator to the service and UI, then
   extend equivalent confinement to OpenCode and Hermes.
6. Evolve one-shot agent adapters to streaming, cancellation, resume, and
   provider-native transports such as ACP where supported.
7. Add PTY streaming only after process ownership and shutdown behavior are
   defined.

References:

- [Tauri and Vite](https://v2.tauri.app/start/frontend/)
- [Tauri permissions](https://v2.tauri.app/security/permissions/)
- [VS Code multi-root workspaces](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces)
