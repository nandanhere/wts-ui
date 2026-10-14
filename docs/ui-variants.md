# WTS interface specification

WTS has one personal interface for one developer's laptop. The Workspace Board
is its Kanban home. The Workbench is the same-window detail view for a selected
local workspace.

## Current MVP experience

The UI now drives a real local Git workflow:

1. Create a plan from an issue, a named repository set, a copied saved WTS
   plan, or a user-selected VS Code `.code-workspace` file. Issue imports can
   fill the summary and suggest local repositories.
2. Enter repository labels and requested base branches.
3. Choose a preferred provider to save with the plan.
4. Save the durable plan. No Git or provider effect occurs during this step.
5. In Overview, select **Review setup**.
6. Review the exact repository, resolved ref, base commit, branch, and worktree
   path returned by Rust.
7. Select **Create workspace**. The approved effect digest is sent back to Rust,
   which rechecks it and creates the worktrees transactionally.
8. Select **Open in VS Code** after WTS has written and validated the generated
   multi-root workspace.
9. In **CLI**, select Codex, OpenCode, or Hermes and open its interactive
   interface in native macOS Terminal at the validated workspace root. Building
   a Graphify index is optional.

All source imports are optional. Manually entered repository labels remain
reviewable and are resolved only against the configured local catalog.

## Workspace Board

The Board answers:

1. Which local workspace plans have I saved?
2. Which plan needs setup?
3. Which workspace is ready to open?

The visual lane vocabulary remains:

- **Ready:** worktrees were created and the durable materialization validates.
- **Running:** reserved for a future service or agent runtime.
- **Needs input:** a saved plan still needs review, has a preflight blocker, or
  encountered an actionable failure.
- **Parked:** reserved for a future lifecycle adapter.

New records enter **Needs input**. A successful materialization moves the card
to **Ready** in the current UI session. Running and Parked are not claims of
implemented process control. Their lifecycle controls remain disabled.

Cards stay intentionally compact: issue/set key, title, repository count,
provider preference, local path, and next state. Jira workflow is not used as
the Board's lane state.

Search, lane filters, and card selection stay on the Board. Selecting a card
opens its Workbench in the same WTS window.

On startup, the Board reads one persisted, explicitly last-known lifecycle
projection. A previously materialized workspace returns directly to **Ready**
without launching a Git subprocess tree for every card. Selecting or acting on
a workspace still asks Rust to perform authoritative materialization,
generated-file, worktree, and branch validation. Attributable drift then moves
the persisted summary to **Needs input**.

## How to use WTS

The question-mark button in the application chrome opens a compact,
task-oriented guide. It explains:

- the four-stage setup, plan, review/create, and open/delegate loop.
- that issue imports, workspace-source imports, and agents are optional for
  direct repository-set creation.
- safe save/materialization replay across retries and restarts.
- how WTS responds to external branch, path, and manifest drift.
- the Board search and Preferences shortcuts.
- the boundary between the working external Terminal handoff and future
  WTS-owned runtime/PTY/diff work.

The guide is a centered modal, not another persistent Board panel. Its primary
action closes the guide and opens **New workspace**.

## New workspace dialog

The five-step dialog separates intent from effects:

### 1. Source

- Choose **Issue**, **Saved WTS plan**, **VS Code workspace file**, or
  **Repository set**.
- Enter an issue reference or local set name, select a saved WTS plan, or
  choose one `.code-workspace` file.
- For Jira intent, use **Import** to retrieve issue context and repository
  suggestions, or continue with manually entered labels.
- **Saved WTS plan** copies the saved repository and base-ref requests plus the
  preferred provider into a fresh repository-set plan. It does not copy
  branches, dirty changes, graph or evidence state, or processes.
- **VS Code workspace file** reads only the selected file's folder entries.
  Settings, tasks, extensions, launch configuration, and other editor data are
  ignored.
- Folder entries produce bounded suggestions only for repositories already in
  the Rust-owned local catalog. Unmatched and ambiguous entries remain visible
  instead of silently entering the plan.
- A safe multi-component relative path is shown as a non-authoritative suffix
  match attempt before basename and optional-name fallbacks. It is compared
  only with catalog-owned checkout paths and aliases.
- The file is a one-time input. WTS does not retain or synchronize it, follow
  its paths as filesystem authority, or clone repositories named by it. WTS
  inspects the matching local checkout and its cached Git origin metadata. It
  performs no implicit clone or fetch. The adjacent **Clone from URL** action
  is explicit: the user reviews the remote and Rust-owned destination before
  Git runs, then the inspected clone is added to the plan.

### 2. Repositories

- Review the requested labels.
- Only matched VS Code folders enter the request list. Unmatched or ambiguous
  entries stay visible in the source preview. Update the catalog and re-import,
  or switch to **Repository set**, when they must be included.
- Edit each requested base branch.
- For a repository pinned to the local catalog with a trusted GitHub or GitLab
  origin, use the compact action beside **Base** to inspect the exact commit
  that the selected ref resolves to locally. The action remains available when
  the repository is unchecked so the user can inspect before including it.
- Unsupported or unpinned origins show the same action disabled with an
  explanatory accessible name. WTS does not offer a raw URL or pasted-link
  fallback.
- Understand that the values are still requests. Rust resolves actual commits
  later during preflight.

The inspection action sends only the stable repository ID and requested base
ref to Rust. Rust re-inspects the catalog-owned checkout, verifies its identity,
resolves the ref to a commit OID, and constructs the supported forge deep link
from the trusted origin. The UI receives only sanitized forge, host, ref,
commit, and accepted-handoff fields. A raw origin or launch URL never becomes
browser authority. Accepted means that the operating system accepted the
browser handoff, not that the remote page or revision exists or is accessible.

### 3. Services

- Analyze only the exact locally resolved commits selected in the previous
  step.
- Show compact service proposals with repository/commit, trusted command and
  working directory, preferred ports, confidence, and expandable file
  evidence.
- Let the user include or exclude proposals and edit only an unprivileged
  preferred port plus `prefer`/`fixed` policy.
- Treat Graphify as optional enrichment and show when it is unavailable or
  stale. Never replace missing evidence with an invented port.

### 4. Plan

- Review the host-owned workspace display path.
- Choose Codex, OpenCode, Hermes, or VS Code as plan preference.
- Summarize selected runtime intent and explain that actual ports are assigned
  only by a later explicit runtime start.
- Confirm that saving starts no worktree, graph, runtime, terminal, or agent
  effect.

### 5. Save

- Persist the draft through the Rust registry.
- Open the saved plan's Workbench.

The dialog includes a file chooser only for the bounded `.code-workspace`
import above. It does not include an arbitrary repository-folder picker,
remote Git clone, or workspace synchronization.

## Preferences

Preferences opens from the application gear, compact Board health status, or
<kbd>Command</kbd>/<kbd>Ctrl</kbd>+<kbd>,</kbd>. It opens on Integrations and
has three focused sections:

- **Integrations** shows the local check, account-verification state, current
  WTS support, affected capability, version, diagnostics, and a truthful next
  action for Git, VS Code, Codex, OpenCode, Hermes, Graphify, and Jira MCP.
  The Jira row can explicitly start and verify a separate WTS-owned MCP
  process. It does not reuse a VS Code-owned stdio stream.
- **Repositories** shows the primary configured root on the current UI wire and
  repositories discovered by bounded nested scanning across all configured
  roots. Discovery is deterministic, has depth 4 and 4,096-directory limits,
  does not traverse symlinks, stops at Git repository boundaries, and prunes
  common dependency/generated directories. Debug host logs show all configured
  roots.
- **General** summarizes whether Git and the local repository catalog are ready
  for worktree creation and explains the local safety boundary.

**Verify all** and the current **Rescan** control run the same read-only host
check. The catalog may still come from its short-lived cache. An explicit,
authoritative cache-invalidating rescan remains planned. Executable presence,
version-call success, provider authentication, and WTS adapter support are
separate facts. Preferences does not install plugins, sign in to providers,
register roots, or modify configuration. Adapter availability is distinct from
executable and account readiness.

Preferences is a centered, bounded modal with subtle fade/scale motion. It is
not a side drawer and keeps a safe viewport inset on smaller displays.

Git availability and at least one discovered repository determine the compact
“Local setup ready” Board status. Other integrations block only their own
future capabilities.

## Integrated Workbench

### Overview

Overview contains the complete working provisioning path:

- durable plan summary.
- requested repository labels and base refs.
- Jira key or direct-set provenance.
- preferred provider metadata.
- the dominant **Review setup** action.
- preflight blockers, if any.
- an exact effect table when preflight succeeds.
- materialized branch, worktree paths, base commits, and generated VS Code
  workspace.
- explicit **Open in VS Code** action.

Preflight is visibly read-only. The create action appears only after a ready
preflight, and the copy explains that Rust will recheck the digest before
writing. During materialization the control shows progress and remains
disabled. Errors are displayed next to the action and require a new review.

On reload, Workbench asks Rust for durable materialization state. It reports
Ready only after the manifest and generated workspace validate.

### Changes

Before materialization, Changes explains that no worktrees exist. Afterwards it
reports the real worktree count. Cross-repository status, diff aggregation,
checks, and review preparation are not implemented.

### Runtime

Runtime remains a truthful start/stop empty state. New-plan analysis can now
parse bounded service evidence and persist reviewed preferred-port intent, but
WTS still has not allocated ports, started processes, or collected health and
logs. Those effects require a future explicit runtime **Start** flow.

### CLI

CLI requires a materialized workspace. It offers Codex, OpenCode, and Hermes,
shows the exact validated working directory, and asks the Rust host to open the
selected provider in a new native macOS Terminal window. The current fixed
provider commands are:

- `codex --sandbox workspace-write --ask-for-approval on-request`
- `opencode .`
- `hermes chat --tui`

The workspace path crosses the platform-launch boundary as an argument and is
quoted before it reaches Terminal's login shell. The browser cannot select the
executable, argument vector, or working directory. Provider authentication,
permission prompts, interactive input, output, and exit remain in Terminal.

The panel has only **launching**, **accepted**, and **error** launch states. An
accepted result means Terminal accepted the handoff. It does not mean the
provider authenticated, started successfully, remains running, or completed.
After handoff, WTS has no output stream, status polling, stop control, session
identifier, or transcript. Closing the WTS tab does not stop the CLI.

Graphify is optional. The panel can build or re-index
`graphify-out/graph.json`, but opening a CLI does not depend on graph readiness
and WTS never injects graph context. Verification may prepare a local task for
the user to copy and paste. It does not submit that task to the provider.

The older one-shot agent API remains for compatibility and automation. It is
not the primary Workbench surface.

### Managed terminal

The external Terminal handoff is not a WTS-owned PTY. In-app output,
start/status/attach/stop controls, streaming, cancellation, resume, token usage,
and durable transcripts remain deferred.

## Interaction and feedback

- Setup checks, preflight, materialization, and VS Code open each have explicit
  busy, success, and error text.
- The materialize button cannot be pressed while preflight is blocked or an
  effect is running.
- A stale effect digest returns the user to review instead of applying changed
  effects.
- The generated workspace path is shown only after Rust has created and
  persisted it.
- Missing Jira, Graphify, or provider executables do not obstruct the direct Git
  path.
- Source checkouts are described as unchanged only after successful
  materialization.

Subtle transitions support state changes, but progress is also communicated in
text and does not depend on animation.

## Current acceptance checks

- WTS opens to a personal Workspace Board.
- A plan is durably saved through Tauri or the authenticated browser host.
- Setup refresh shows live, secret-free local detection.
- Repository discovery reflects bounded deterministic nested scanning across
  the configured local trust roots without symlink traversal.
- A selected `.code-workspace` file suggests only catalog repositories, shows
  unmatched or ambiguous folder entries, and imports no editor configuration.
- Imported suggestions still pass through the normal repository review, plan
  save, and read-only preflight before any Git effect.
- A catalog-pinned GitHub or GitLab row can open the selected base's exact
  locally resolved commit through a host-owned browser handoff. Unpinned and
  unsupported rows remain disabled.
- Repository-base inspection is joined by stable repository ID, never by a
  possibly duplicated display label, and no raw remote URL is accepted from
  the UI.
- Review setup performs no Git mutation and shows exact commits and targets.
- Create workspace requires the reviewed digest.
- A multi-repository failure is rolled back without touching primary
  checkouts.
- Successful creation writes `wts.code-workspace` and
  `.wts-workspace.json`.
- Restart reload renders the Rust-owned last-known lifecycle projection rather
  than trusting UI memory.
- Opening the Workbench deeply validates durable materialization and records
  safely attributable drift.
- Open in VS Code uses the Rust-validated generated path.
- Opening a provider CLI uses the Rust-validated materialized workspace root
  and reports only accepted or rejected Terminal handoff.
- Jira MCP, Graphify, and provider actions report only real adapter results.
  Pending runtime, managed-terminal, and diff features never simulate success.

## Product-direction states not yet implemented

The larger design should eventually cover:

- native repository-folder selection, persistent registration, authoritative
  rescanning, remote Git cloning, and saved repository sets.
- Jira OAuth and HTTP MCP states.
- Graphify base-cache progress and graph revision evidence.
- deterministic runtime plans, port conflicts, health, stop, and park.
- WTS-owned PTY sessions with bounded output and start/status/attach/stop
  controls.
- provider streaming, cancellation, resume, and capability approval.
- status/diff/check aggregation, review-ready, archive, and deployment
  tracking.

These states should be added as adapters become real, not as interactive mocks
in the default product.

## Technical basis

- [VS Code multi-root workspaces](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces)
  provide one editor window over all issue-scoped worktrees.
- [Tauri recommends a static SPA such as Vite](https://v2.tauri.app/start/frontend/)
  while keeping privileged operations in Rust.
- [React Aria Components](https://react-spectrum.adobe.com/react-aria/components.html)
  provide accessible Board controls.
- [Radix Primitives](https://www.radix-ui.com/primitives/docs/overview/introduction)
  provide headless dialogs, menus, and Workbench controls.

Deferred until there is a proven local need: arbitrary generative UI, a full
embedded code editor, editable graph canvases, and shared multi-user workflow.
