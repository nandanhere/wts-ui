# How to use WTS

WTS creates one local, issue-scoped workspace from one or more existing Git
repositories. Each selected repository receives a worktree on the same WTS
branch, and WTS opens the result as a VS Code multi-root workspace. Your
primary checkouts stay on their existing branches.

## Start with the main controls

1. Start WTS and open **Environment & integrations** from the gear button.
2. Confirm that Git is ready.
3. Open **Repositories** and confirm that the repositories you need were
   discovered below the configured `WTS_REPOSITORY_ROOT` or
   `WTS_REPOSITORY_ROOTS`.
4. Confirm VS Code if you want WTS to open the generated workspace.
5. If you are running the retained developer self-test, check **General** for
   Node, browser helper, Playwright, and Chromium readiness.

Jira, OpenProject, Graphify, and agent providers are optional for the basic
repository-to-worktree flow.

The top bar contains the global destinations:

- **WTS** or **Spaces** returns to the workspace list.
- **My reviews** shows direct GitHub review requests.
- **Updates** checks and installs a configured desktop update.
- <kbd>Command</kbd>+<kbd>K</kbd> opens the command palette.
- The question-mark button opens the product guide.
- The gear button opens **Environment & integrations**.

When a control is not visible, press <kbd>Command</kbd>+<kbd>K</kbd> and search
for its label.

## Configure GitLab CLI

Install and configure GitLab CLI (`glab`) before you start WTS. The configured
CLI instance must have access to the repositories and merge requests that you
want WTS to show. WTS does not include GitLab setup or sign-in.

1. Run `glab auth status` in Terminal.
2. Confirm that `glab` can access each required GitLab host.
3. Start WTS and open a workspace that contains a GitLab repository.
4. Open **Environment & integrations → Integrations** to check CLI readiness.
5. Select **Check connection** after you change the CLI configuration.

WTS derives each available GitLab host from the open workspace repositories.
Repository rows do not show CLI setup controls. GitLab CLI owns its credentials
and stores them in its normal credential store.

## Review requests assigned to you

Install GitHub CLI (`gh`) and run `gh auth login` in a terminal. Then select
**My reviews** in the top bar.

WTS lists open GitHub pull requests that request a review directly from the
active CLI user and belong to repositories in the WTS catalog. Team requests,
mentions, GitLab review assignments, and repositories outside the catalog are
not included in the first release.

Select **Review** to open a pull request. Rust re-inspects the catalog
repository and constructs the trusted GitHub target. The interface does not
open a provider-returned URL.

## Update or reopen WTS

Select **Updates** in the top bar, then select **Check for updates**. If an
update is available, select **Update WTS**. After verification and installation
finish, select **Relaunch WTS**.

The current updater uses a signed local QA feed. It is not a public update
channel. A public release requires an HTTPS feed, Developer ID signing, and
notarization.

Closing the WTS window hides the application on macOS. Select WTS in the Dock
or Applications to show it again. Use **WTS → Quit WTS** or
<kbd>Command</kbd>+<kbd>Q</kbd> to stop the application.

## Confirm repository identity in Source

Every source type that supplies repository scope shows the same compact
**Repository identity** review before you continue. WTS resolves an imported or
typed repository name against the trusted local catalog and displays:

- the canonical repository name.
- the sanitized `origin` URL.
- the catalog default branch.
- a GitHub or GitLab action when the trusted origin supports it.

A unique local-folder name can resolve to the catalog's canonical repository
identity. An unresolved or ambiguous name remains visible as **Needs match**.
WTS does not treat pasted text or a remote URL as repository authority.

## Create a workspace from OpenProject

For the first local build, start WTS with `WTS_OPENPROJECT_URL` set to the
OpenProject instance origin and `WTS_OPENPROJECT_TOKEN` set to a personal API
token. WTS reads both in Rust and never returns either value to the UI.

1. In **Environment & integrations → Integrations**, verify OpenProject.
2. Select **New workspace**, choose **Issue**, then select **OpenProject**.
3. Enter the internal numeric ID, a semantic ID such as `APP-42`, `#42`, or
   paste a work-package URL, then import it.
4. Review the matched local repositories and add or remove repository labels
   before saving the plan.

The deterministic import uses OpenProject REST API v3. OpenProject's optional
MCP server is not required.

## Create from a saved WTS plan

1. Select **New workspace**, then choose **Saved WTS plan**.
2. Select a saved WTS plan and choose **Review copied setup**.
3. Review the copied repository and base-ref requests, make any changes, and
   confirm the preferred provider.
4. Review the manifest and select **Save workspace plan**.
5. Open the new plan, select **Review setup**, and continue through the normal
   preflight and **Create workspace** materialization flow.

This creates a fresh repository-set plan. It copies setup requests and the
preferred provider, not branches, dirty changes, graph or evidence state, or
processes.

## Create from a VS Code workspace file

Use this flow to turn the repository folders in an existing VS Code multi-root
workspace into a new WTS plan:

1. In **Environment & integrations → Repositories**, confirm that the repositories you need
   are already present in the local catalog.
2. Select **New workspace**, then choose **VS Code workspace file**.
3. Choose one `.code-workspace` file.
4. Review the matched repository suggestions and the visible unmatched or
   ambiguous folder entries. Use **Add repository folders** to include other
   repositories from the local catalog without restarting the import. Added
   repositories enter the same WTS plan and are materialized as isolated
   worktrees.
5. If the same additions should be available in VS Code outside WTS, select
   **Download edited copy**. WTS downloads
   `<original>.edited.code-workspace` with the imported folder entries and the
   added catalog folders. The original file is never overwritten.
6. Review each requested base branch. When a matched repository has a trusted
   GitHub or GitLab origin, use the action beside **Base** to inspect the exact
   locally resolved commit in your browser.
7. Continue to **Services**. WTS inspects a bounded set of runtime manifests
   and configuration files from those exact local commits, without checking
   out a branch or reading dirty working-tree files. Include the services you
   want, review their evidence, and adjust only the preferred port and
   `prefer`/`fixed` policy.
8. Review the preferred provider and plan, then select **Save workspace plan**.
9. Open the saved plan and continue through **Review setup** and
   **Create workspace** as usual.

The file import is a one-time setup import, not a synchronization feature. WTS
reads folder entries only. While reviewing it, use **Existing local** to add a
catalog repository or **Clone from URL** to explicitly clone an HTTPS/SSH Git
remote into the primary trusted repository root and add it to the plan. The
clone uses your Git credential helper or SSH agent. WTS does not store
credentials. It ignores settings, tasks, extensions, launch
configuration, and other editor data. The optional edited download is
deliberately folder-only too, so it does not claim to preserve ignored
settings, tasks, comments, or extensions. Paths in the file are matching
hints, not permission to access arbitrary locations. Only repositories in the
Rust-owned local catalog—or a repository produced by the explicit reviewed
clone action—can become plan entries. A multi-component relative path can
narrow a match by lexical suffix
(for example
`bmc-virtual-console/ppec-ui`), but WTS compares that text only with
catalog-owned checkout paths and aliases. It never opens the imported path.
WTS inspects each matched checkout and its Git origin metadata locally. Import
and preflight do not implicitly clone or fetch. New catalog-backed plans retain the
matched repository's stable local identity. Preflight resolves that identity
rather than retargeting the plan when another checkout later gets the same
label. Older saved plans without an identity pin retain their original
unique-label compatibility behavior. After the plan is reviewed, the normal
creation flow makes managed worktrees below `WTS_WORKSPACE_ROOT`.

### Inspect a selected base on its Git host

In the **Repositories** step, first choose the requested ref in **Base**, then
select the GitHub or GitLab action beside it. WTS re-inspects the checkout
identified by the catalog's stable repository ID, resolves that ref locally to
an exact commit OID, and asks the operating system to open the corresponding
commit tree on the trusted Git host. The action is independent of the
repository inclusion checkbox, so you can inspect a candidate before deciding
whether it belongs in the plan.

The browser cannot supply a remote URL, checkout path, host, or commit as
authority. WTS derives the link from the catalog-owned checkout and its
re-inspected origin. The action is disabled when the request is not pinned to
a catalog repository or the origin is not a supported GitHub or GitLab host.
WTS does not fetch or contact the forge before launching the browser. A success
message means only that the operating system accepted the browser handoff. It
does not prove that the remote repository, revision, or page exists, that you
are signed in, or that you can access it.

## Create a workspace without an issue tracker

Use this flow while Jira or OpenProject is unavailable:

1. Select **New workspace**.
2. Choose **Repository set**.
3. Enter the repository labels separated by commas.
4. Select **Review repositories**.
5. Review or change each requested base branch. The discovered default branch
   is used when no override is needed. If the row is pinned to a catalog
   repository with a trusted GitHub or GitLab origin, the adjacent action can
   open the exact locally resolved commit for inspection.
6. Select a preferred provider. This saves a preference. It does not start an
   agent.
7. Review the exact-commit service proposals, choose the services and port
   intent to retain, then continue. It is valid to save a plan with no runtime
   services.
8. Review the manifest and select **Save workspace plan**.
9. Open the saved plan.

Saving a plan writes registry state only. It does not create branches,
worktrees, graphs, or agent processes.

### Add a planning home for agents

The final plan review includes an optional **Planning home**:

- Choose **Use repositories as-is** when the selected repositories already
  contain the project’s planning or Kanban files.
- Choose **Create a starter kit** to add either `plans/` or
  `plans-and-kanban/` when the workspace is created.
- The notes starter creates `README.md`, `PLAN.md`, and `FINDINGS.md`. The
  Kanban starter also creates `KANBAN.md` and `PROGRAM-BACKLOG.md`.

The folder is included in the generated VS Code multi-root workspace beside
the repository worktrees. WTS creates the starter files once. After that they
are ordinary, editable user content. Editing or deleting individual planning
files does not invalidate the workspace. Because findings and plans may be the
durable handoff between agents, WTS never silently removes the folder. A
workspace-removal preflight blocks while it remains, so preserve it elsewhere
or delete it manually and select **Check again**.

WTS detects canonical Jira keys in these planning files when it lists or opens
the workspace. The workspace card shows the detected keys and their source
files. WTS passes the keys to a managed agent as local context. A later Jira
import can use the workspace repository set as recommendation evidence. WTS
does not add or remove a repository from this observation.

Plans and Kanban also reads subfolders within the planning home. The file list
shows a folder tree and searches complete relative paths. Files can share a
name in separate folders. For example, `payments/PLAN.md` and
`refunds/PLAN.md` remain separate documents.

Relative Markdown links open known planning files in the same viewer. For
example, `[Board](../../kanban/payments/KANBAN.md)` opens that board from
`plans/payments/PLAN.md`. WTS retains unsaved edits and feedback before you
open another file.

WTS reads Markdown, text, CSV, and Mermaid files through eight folder levels.
The scan checks at most 4,096 entries and includes up to 100 files beyond the
starter files. Each file can contain up to 256 KiB. WTS skips symbolic links.

### Review service and port proposals

The **Services** step is a read-only analysis followed by an explicit
selection. WTS currently recognizes a bounded, allowlisted set of files such
as `wts-stack.json`, `package.json`, Dockerfiles, and example environment
files. A declared `wts-stack.json` is stronger evidence than an inferred
Docker or package-script port. Each proposal identifies its repository, exact
commit, working directory, command, confidence, and source evidence.

Graphify enrichment is optional and its status is shown separately. A missing
or stale graph never causes WTS to invent a port. Deterministic commit evidence
continues to work without Graphify. WTS never reads a real `.env` file during
this analysis.

The browser sends back only WTS-issued candidate IDs, port IDs, a preferred
port in the unprivileged range, and a `prefer` or `fixed` policy. It cannot
submit an executable, working directory, repository path, or environment
contents. Saving records this intent and includes it in later preflight effect
digests. If a selected base moves afterward, **Review setup** blocks the stale
service plan and asks you to analyze it again. A retry of an already-successful
save still returns the original idempotent result. Saving does not reserve a
socket or start a process. Actual free-port assignment remains an explicit
future runtime **Start** action.

## Review and create the worktrees

1. In the Workbench **Overview**, select **Review setup**.
2. Review the exact effect table:
   - source repository.
   - resolved base ref and commit.
   - WTS branch.
   - target worktree path.
3. Resolve any blockers reported by WTS, then review again.
4. Select **Create workspace**.
5. After WTS reports the workspace as ready, select **Open in VS Code**.

Preflight is read-only. Creation rechecks the reviewed digest immediately
before applying Git effects. Multi-repository creation is transactional: when
one repository cannot be created, WTS rolls back worktrees and branches proven
to have been created by that attempt.

## What happens when you repeat an action

- Repeating **Save workspace plan** with the same request idempotency key
  returns the saved plan instead of creating a duplicate.
- Repeating **Create workspace** with the same reviewed digest returns the
  existing validated materialization with `replayed: true`.
- Restarting WTS does not require recreation. WTS reloads the SQLite plan,
  validates `.wts-workspace.json`, validates every worktree, and restores the
  Board card to **Ready**.
- A different or stale effect digest is rejected and must be reviewed again.
- Manual branch, path, manifest, or generated VS Code workspace drift is
  reported. WTS does not overwrite unknown external state.

The `replayed` field is WTS's local idempotency state: it means safely returning
the existing workspace. It is unrelated to Replay or any hosted service. WTS
does not silently rebuild or remove a workspace.

## Manage a workspace manually

Open a workspace and select **Workspace actions** in the Workbench header.
The menu keeps infrequent lifecycle commands in one predictable place:

- **Open in VS Code** opens a materialized workspace.
- **Copy workspace path** copies its local root.
- **Refresh status** revalidates the saved plan, manifest, and worktrees.
- **Build graph** or **Re-index graph** runs Graphify for the current
  worktree contents.
- **Create revised copy** starts a new editable plan using this workspace's
  repository and provider setup. The original record remains immutable.
- **Remove workspace** opens a read-only effects preview before anything is
  removed.

Each repository row also has a **Sync** action below its saved branch and
commit. Use it to fetch the saved branch from its configured tracking remote
and advance that repository. The remote can have a name such as `origin` or
`upstream`. WTS accepts only a fast-forward on a clean worktree. It then
rebuilds the workspace graph and shows the old and new commits.

Sync does not merge, rebase, reset, or run repository hooks. Local changes,
ignored files, local commits, and divergent history block the action. If the
Git update succeeds but Graphify fails, WTS keeps the new commit and marks the
graph for a new index attempt.

Removal is explicit and conservative. WTS retains every Git branch, accepts a
clean worktree whose branch contains committed work, and removes only
provenance-checked worktrees and WTS-generated files. Tracked, staged,
untracked, ignored, or unexpected files block the command. Review the blockers,
move or commit the files as appropriate, then select **Check again**. WTS does
not close VS Code or delete source checkouts. An optional planning home is
user-owned and also blocks removal until you preserve or manually delete it.

## Review repository changes

Select a changed-file or commit count in **Overview** to open the repository
diff. WTS compares the managed worktree with its saved base commit. The diff
includes committed work and tracked working-tree changes. WTS lists untracked
file names separately.

The patch is read-only and has a 1 MB limit. WTS marks a patch when it reaches
that limit. Select the repository name to open its saved base on the trusted
GitHub or GitLab origin.

## Understand agent status

The **Agent** panel can show a managed WTS session or locally observed Codex
activity. WTS surfaces only agent-authored status updates. It does not surface
prompts, reasoning, tool arguments, or command output.

## Review local work activity

The **Activity review** reads ActivityWatch only when you build or refresh the
review. WTS stores the sanitized review on this Mac for the current day. The
review can include the application, activity title, category, time, and Jira
suggestion. WTS removes secrets, full paths, email addresses, URL payloads, and
raw ActivityWatch event data.

WTS compares the sanitized activity with assigned Jira ticket summaries on
this Mac. It does not create a worklog. Review each suggestion before you use
the copied agent brief.

## Open a workspace CLI

1. Create the workspace first.
2. Open the **CLI** tab.
3. Choose Codex, OpenCode, or Hermes.
4. Choose **Warp** or **Terminal**. WTS prefers Warp when `Warp.app` is detected,
   and keeps native Terminal available as a fallback.
5. Select **Open Codex CLI**, **Open OpenCode CLI**, or **Open Hermes CLI**.
6. Continue in the new terminal window. The provider starts with
   the validated materialized workspace root as its working directory.

Before each editor or agent handoff, WTS refreshes two files at the workspace
root. `AGENTS.md` tells supported agents to read `WTS.md`. `WTS.md` contains the
current WTS boundary and reporting rules. WTS preserves the reviewed
**Current task** section when it refreshes the generated guide. Repository-owned
`AGENTS.md` files remain under Git control.

For Warp, WTS maintains one managed Tab Config per provider under
`~/.warp/tab_configs/` and opens it through Warp's `warp://tab_config/` URI.
Each launch rewrites that provider's managed config with the selected
workspace directory and fixed CLI command. WTS does not open a temporary
`.command` file in Warp.

Hermes can run its terminal tools in Docker even though the Hermes TUI itself
starts in the correct host directory. For Hermes launches, WTS also writes a
small per-workspace overlay under
`~/Library/Application Support/WTS/hermes-workspaces/`. The overlay preserves
the user's Hermes model, preferences, sessions, and selected terminal backend.
It only pins the selected host workspace as Hermes's working directory and,
when the selected backend is Docker, preserves unrelated configured volumes,
bind-mounts the selected host workspace at `/workspace`, and records
`/workspace` as Hermes's command cwd. Keeping the host bind source separate
from the container cwd prevents Hermes's persistent shell from trying to
`cd` to a macOS path inside Docker. WTS does not edit `~/.hermes/config.yaml`.
Opening Hermes this way intentionally grants the Hermes tool container
read/write access to that workspace.

Graphify is optional. Use **Build index** or **Re-index** only when you want the
provider to use `graphify-out/graph.json` as structural context. WTS never sends
that graph, or a prepared task, to the provider automatically.

This is a deliberate external handoff, not a background WTS job. WTS launches a
fixed provider command. It does not accept a browser-supplied executable,
argument vector, or working directory. Authentication, permission prompts,
interactive input, output, and process exit are owned by the selected terminal
and the provider. WTS reports only whether the terminal accepted or rejected the launch. It
cannot show whether the provider is still running, stream its output, stop it,
or resume it after the handoff. Closing the WTS tab does not stop the CLI.

The current fixed commands are:

- Codex: `codex --sandbox workspace-write --ask-for-approval on-request`
- OpenCode: `opencode .`
- Hermes: `hermes chat --tui`

The older one-shot agent endpoint remains available for compatibility and
automation, but it is not the primary Workbench UI. A WTS-owned PTY with
start/status/attach/stop controls remains future work.

### Understand observed agent status

WTS can read bounded lifecycle metadata from supported local agent sessions.
This observation is read-only. It does not control the editor session.

WTS shows agent-authored status updates and completion results. It does not
show prompts, reasoning, tool arguments, or command output. Select **Refresh**
in the **Agent** panel to request the latest observed state.

## Verify a workspace

WTS creates a versioned evidence bundle under `.wts/` when it materializes a
workspace. It discovers bounded Cargo, npm, Go, and pytest checks from trusted
repository manifests and test configuration. Commands still use fixed argument
vectors rather than arbitrary shell text.

1. Create the workspace, then open **Verification**.
2. Review the checks grouped by repository. WTS shows their direct executable,
   arguments, and current status.
3. Select **Run all**.
4. Expand a failed check to inspect its bounded local log. After a fix, select
   **Rerun all**.
5. Select **Copy context** when you want to give an agent the exact repository,
   base-commit, graph, and verification boundary.

### Map and verify workspace-specific flows with Graphify

Verification no longer places the fixed WTS Help + Preferences self-test in
every workspace. That flow tests WTS's own shell, not the application represented
by the selected repositories.

1. Open **Verification** and find **Graph-informed planning**.
2. Select **Prepare for CLI** when a graph index is available, or **Open CLI**
   when it still needs to be built.
3. Review the proposal-only prompt. It explicitly asks the provider to read
   `graphify-out/graph.json`, account for every selected repository, identify
   the environment setup and user/service/operational flows supported by graph
   and file evidence, avoid assuming WTS Help or Preferences flows, and
   propose checks without running commands or modifying repository files.
4. Build or re-index the graph in **CLI** if needed.
5. Choose a provider, open its CLI, and copy the prepared task into Terminal.
   WTS does not submit it. The prompt tells the agent to write candidate JSON
   outside `.wts`, then run `wts-report --input <candidate.json>` from the
   workspace root. The helper validates the candidate and atomically publishes
   `.wts/agent-report.json` with a concise summary, repository coverage,
   an environment plan, ordered workspace flows, structured findings, evidence
   references, suggested next actions, proposed deterministic checks, and
   review-only validation flows. The environment plan contains variable names
   and setup argv only. Secret values are rejected by the report schema.
6. Return to **Verification** and select **Refresh findings**. WTS validates the
   report and labels it **agent-reported, not verified**. The tab leads with
   **Environment**, **Flows**, deterministic **Coverage**, secondary
   **Findings**, and historical **Runs**. Partial and stale reports remain
   visible but cannot imply workspace-wide coverage.
7. Inspect each proposed command and worktree. Select **Add to verification**
   only for a check you want WTS to own. WTS accepts fixed Cargo, npm, Go, and
   pytest vectors, creates a new plan revision, and leaves it unrun.
8. Select **Run all** to create trusted pass/fail evidence. Agent-authored
   validation flows stay review-only. They communicate prerequisites, actions,
   expected outcomes, and evidence without executing hidden work.

The retained fixed browser runner remains developer/CI self-test
infrastructure. Source-checkout development requires `WTS_BROWSER_DRIVER` to
point at the absolute `scripts/wts-browser-driver.mjs` path and a locally
installed Playwright Chromium build. Set `WTS_BROWSER_NODE` to an absolute
Node path when `node` is not available on `PATH`. WTS uses no Replay account,
hosted session, or cloud evidence service.

Commands run directly without a shell, inside a validated selected worktree,
with time and output limits. Results survive an application restart in
`.wts/verification-result.json`. Per-check logs stay in `.wts/logs/`. WTS
reports a stale result when the reviewed plan revision no longer matches.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| <kbd>Command</kbd>+<kbd>K</kbd> | Open the command palette |
| <kbd>Command</kbd>+<kbd>,</kbd> | Open Environment & integrations |

Use <kbd>Ctrl</kbd> instead of <kbd>Command</kbd> on Linux.

## Troubleshooting

### A repository is missing

Confirm that it is within four directory levels of one of the configured trust
roots. WTS scans deterministically, visits at most 4,096 directories, does not
traverse symlinks, stops descending at Git repository boundaries, and prunes
common dependency, generated, and VCS metadata directories. A repository below
one of those pruned directories or outside the configured roots will not
appear.

Use `WTS_REPOSITORY_ROOTS` when local checkouts span more than one trust root.
It is parsed as the platform path list (`:` on macOS/Linux and `;` on Windows)
and takes precedence over `WTS_REPOSITORY_ROOT`. Restart the host after changing
either variable.

### A base branch is unavailable

WTS performs no fetch during preflight. Fetch the branch in the primary
repository, or select a locally available base ref and review again.

### The GitHub or GitLab base action is unavailable

The action requires a stable catalog repository ID and a trusted, supported
GitHub or GitLab origin on that checkout. It stays disabled for unpinned,
unsupported, or missing origins. Confirm that the repository appears in
**Environment & integrations → Repositories** and that its local `origin` points to the
expected GitHub or GitLab host. WTS intentionally does not accept a pasted URL
or use a label-only fallback for this action.

If the browser opens a missing or inaccessible page, confirm that the locally
resolved commit has been pushed and that your browser session can access the
repository. WTS reports only whether the operating system accepted the launch.
It does not verify the remote page.

### Creation reports a branch or path conflict

WTS found state at the branch or target path it intended to create. Inspect
that state manually. WTS will not delete it without provenance.

### A previously Ready workspace needs attention

Open the workspace to see the reconciliation error. Common causes are a
manually switched worktree branch, a moved worktree, or edits to
`.wts-workspace.json` or `wts.code-workspace`.

### A VS Code workspace file does not match every repository

Confirm that each repository is visible in
**Environment & integrations → Repositories**.
Import matches folder entries only against that bounded local catalog. It does
not follow arbitrary embedded paths or clone a missing repository. Ambiguous
and unmatched entries stay visible. If the repository is already in the
catalog, add it directly with **Add repository folders**. Otherwise adjust
`WTS_REPOSITORY_ROOTS`/`WTS_REPOSITORY_ROOT`, restart WTS, refresh after the
short catalog cache expires, and re-import. You can also continue with
**Repository set**. An explicit cache-invalidating rescan and persistent
repository registration are still planned.

### Jira import is unavailable

Choose **Repository set** and continue manually. Jira import is an optional
convenience and never blocks direct workspace creation.

### OpenProject import is unavailable

Confirm that `WTS_OPENPROJECT_URL` contains only the instance origin and that
`WTS_OPENPROJECT_TOKEN` is a valid personal API token. Remote instances must
use HTTPS. HTTP is accepted only for a loopback instance. WTS does not follow
redirects while sending the token. Restart WTS after changing environment
variables, or choose **Repository set** and continue manually.

## Current boundaries

WTS can clone one explicitly reviewed HTTPS or SSH remote into the primary
trusted repository root. It does not clone during discovery, import, preflight,
or review refresh. It does not synchronize an imported VS Code workspace file,
wire application service stacks into the Board, provide a WTS-owned PTY,
aggregate cross-repository diffs, let a user edit arbitrary verification plans,
or rebuild a materialized workspace in place.

GitHub **My reviews** includes direct individual requests only. GitLab delivery
tracking includes open or draft merge requests authored by the active GitLab
CLI user for the current managed branch. When an MR uses another branch in the
same trusted project, the agent can report its repository ID and MR number.
WTS shows **Link agent MR !43** for the matching workspace. Select it to
let WTS check the MR in the trusted GitLab project. The repository row shows
**Different local branch** and keeps the managed worktree unchanged. A linked
MR does not make the local worktree eligible for MR comparison or publication.
WTS does not yet combine all forge activity into one remote delivery inbox.

Optional integration check: use a disposable GitLab project and a workspace
with a different local branch. Let an agent report an open MR, link it, restart WTS, and
check that the row still shows the MR. Check that the local branch, files, and
commits did not change. Do not use the live Senzu MR for this check.

The external CLI handoff targets native macOS Terminal or Warp. Unsupported
hosts return an unavailable error instead of a simulated success. Use **Create
revised copy** to change a workspace plan and the reviewed manual removal
command to retire the old local workspace. The fixed WTS shell journey remains
developer self-test infrastructure. WTS can prepare a workspace-specific,
Graphify-informed task for the user to paste into a CLI. Executing arbitrary
user-defined browser journeys and a WTS-owned resumable PTY remain future work.
