# WTS testing and verification strategy

## Purpose

WTS is trusted with a developer's repositories, branches, local processes, and
agent context. A useful test strategy therefore has to prove more than “the
screen renders” or “a worktree was created.”

The product should prove five things for every supported workflow:

1. **Isolation** — an issue can only affect its selected repositories,
   worktrees, graph, processes, and ports.
2. **Correctness** — the requested change satisfies explicit checks and does
   not merely look plausible.
3. **Recoverability** — interruption, restart, retry, and partial failure do not
   lose user work or leave misleading state.
4. **Transparency** — the human and the active agent can inspect the same task,
   graph, changes, commands, and results.
5. **Portability** — the packaged local application behaves consistently on
   the supported laptop and x86 environments.

The strategy below treats the current full-stack lab as the first fixture, not
as the completed test system.

## Current baseline

WTS already has useful coverage:

- Rust contract and validation tests in `wts-core`
- SQLite persistence, migration, concurrency, and idempotency tests
- real temporary-repository tests for Git discovery, preflight, worktree
  creation, conflicts, path safety, and rollback
- application-service tests for materialization, restart/replay, VS Code
  launch authority, trusted repository-base browser construction, macOS
  Workspace CLI launch construction, and branch drift
- loopback HTTP tests for session, host, origin, body, error, and API contracts
- React tests for board, workbench, creation, Preferences, retries, and
  transport normalization
- real Chromium tests driving create, preflight, two-repository
  materialization, verification, Help, and Preferences against the Rust server
- a manifest-driven two-repository lab with frontend-only, backend-only, and
  combined red-to-green scenarios
- three dependency-free service-stack shapes exercised at 12 simultaneous
  stack copies and 28 service processes
- a bounded Rust runtime supervisor suite covering port collisions,
  dependency order, partial-start rollback, targeted stop, and final cleanup
- a deterministic parallel-agent coordinator and fake Codex process suite
  covering disjoint scopes, overlap rejection, phase barriers, cancellation,
  deadlines, excessive output, provider failure, and descendant cleanup
- a versioned `.wts` evidence bundle and Workbench Verification surface
- a bounded, shell-free Rust verification executor with persisted results and
  logs
- a retained internal 12-step WTS Help + Preferences self-test driven through
  semantic actions in an ephemeral local Chromium process
- local, bounded journey manifests, screenshots, ARIA state, diagnostics, and
  failure-only traces with no Replay or cloud evidence service
- browser-runner readiness in Preferences for Node, the fixed helper,
  Playwright, and Chromium
- debug-only VS Code workspace import diagnostics with an opaque import ID,
  bounded catalog and matching evidence, and a deliberately copied local
  diagnostic payload
- shallow self-test run-history integrity checks, followed by full artifact
  SHA-256 validation before preparing bounded failure context

The largest remaining gaps are:

- no packaged Tauri application smoke suite
- no visual-regression or automated accessibility gate
- no HTTP/Tauri transport-parity suite
- incomplete deterministic fake-executable coverage for Graphify, VS Code,
  Jira MCP, OpenCode, and Hermes failure injection
- no graph refresh, corruption, exclusion, or secret-leakage suite
- no scored agent evaluation across Codex, OpenCode, and Hermes
- no WTS-owned PTY, managed provider-session, or packaged native Terminal
  integration suite beyond fixed-command construction and transport contracts
- no soak, migration-upgrade, or platform release matrix

The repeatable 30-workspace core profile and executable budgets are documented
in [Performance and capacity](./performance-and-capacity.md). It measures
registered, materialized, indexed, restart-listed, and explicitly
deep-reconciled workspaces. The separate simultaneous-runtime sample exercises
12 stack copies and 28 application-service processes, including resource
sampling and final port/process cleanup.

## The shared workspace evidence model

Testing and agent communication use one machine-readable contract. Each
materialized workspace contains this WTS-owned directory:

```text
.wts/
├── context.json
├── verification-plan.json
├── verification-result.json
├── graph-manifest.json
├── agent-report.json
├── agent-runs/
│   └── <run-id>.json
├── test-runs/
│   └── <run-id>/
│       ├── journey.json
│       ├── result.json
│       ├── manifest.json
│       ├── aria/
│       └── screenshots/
└── logs/
    └── <check-id>.log
```

Most files are WTS-owned evidence, not agent-authored source code.
`agent-report.json` is the single exception: a foreground CLI agent may
atomically replace that bounded, versioned document to publish a concise
summary, workspace coverage ledger, structured user/service flows, findings,
evidence references, and suggested next actions. It may also publish bounded
`proposedChecks` and descriptive `validationFlows`.
WTS validates its workspace ID, repository scope, field sizes, and schema before
showing it as **agent-reported, not verified**. A malformed report never replaces
or invalidates deterministic verification evidence.

Agents should not write the inbox directly. From the materialized workspace
root, publish a candidate with:

```bash
wts-report --input /path/to/candidate-report.json
```

`npm run desktop:dev` builds the helper from the same checkout and installs it
atomically in `${XDG_BIN_HOME:-$HOME/.local/bin}` before starting WTS. This
removes the separate Cargo-install prerequisite from the intended development
flow. A custom absolute destination can be supplied with `WTS_DEV_BIN_DIR`.

The helper reads `.wts/context.json`, checks the workspace and repository
boundaries, validates the fixed command allowlist, and replaces the inbox only
after the complete report passes validation. It also accepts the candidate on
stdin when `--input` is omitted.
The `.wts/agent-runs/` summaries belong to the compatibility one-shot agent
API. A WTS-owned agent process uses one persisted, transcript-free session for
its observed lifecycle. Opening a Workspace CLI in Terminal remains a separate
handoff and does not create a managed session record or transcript.

### `agent-report.json`

The generated document starts empty and preserves:

- `schemaVersion` and the opaque `workspaceId`
- a `scope` that accounts for every allowed repository as reviewed,
  unresolved, or intentionally skipped and records the graph snapshot
- a graph-informed `environment` plan with evidence-backed toolchains,
  configuration and secret names, external services, review-only setup argv,
  and unresolved user decisions. The schema has no secret-value field
- ordered `flows` with actors, entry points, repository-owned steps, expected
  outcomes, risks, existing coverage, and proposed-check references
- `updatedAtUnixMs`, a concise `summary`, and bounded `findings`
- finding severity (`info`, `warning`, or `critical`)
- optional repository and flow IDs drawn only from the published scope
- workspace-relative evidence references and bounded `nextActions`
- proposed checks with an exact repository worktree, executable/argument
  vector, timeout, environment variable names, rationale, and source evidence
- review-only validation flows with prerequisites, ordered actions, expected
  outcomes, and evidence references

It is an agent-to-WTS inbox, not a transcript and not pass/fail authority.
Coverage describes what the agent claims to have reviewed. WTS validates the
repository accounting and graph digest but does not promote the claim to
verified truth. Re-indexing the workspace makes a report based on an older
graph digest visibly stale without deleting its useful history.
Verification reads it on demand when the user selects **Refresh findings**.
Proposed checks remain inert until the user selects **Add to verification**.
That promotion boundary revalidates repository scope, exact worktree path,
environment names, timeout, and the fixed WTS command allowlist, then creates a
new WTS-owned plan revision and resets its result to `notRun`. Validation flows
remain descriptive and cannot start processes.

The browser critical path exercises this contract through the real Rust host:
it writes the agent inbox inside a materialized fixture workspace, refreshes
the UI, promotes a fixed Cargo command, reruns the revised plan, and expects all
three trusted checks to pass.

The pull-request gate runs that focused real-backend browser flow, rather than
the entire Playwright catalog:

```bash
bash scripts/test-pr.sh
```

The gate also runs the focused Rust application-service test for agent report
loading and proposal promotion, the Rust HTTP endpoint contract for promotion
and verification execution, the complete React behavior suite, and the
production UI build. It uploads failure-only Playwright traces, screenshots,
videos, and the HTML report from `ui/test-results/` and
`ui/playwright-report/`.

The slower self-hosting lane remains opt-in locally:

```bash
npm run test:e2e:selfhost
```

It snapshots the current WTS source into an isolated Git repository and uses
WTS to create and verify a workspace for WTS. The test asserts both the visible
promotion state and the serialized `verification-result.json` entry for the
promoted check. GitHub runs the same lane every night, on manual dispatch, and
for a published release. It does not run on every pull request.

On failure, the self-host runner retains the isolated runtime only long enough
to produce a bounded diagnostic bundle. The collector:

- allowlists the five top-level JSON evidence contracts under `.wts`
- skips logs, agent transcripts, repository files, symlinks, invalid JSON, and
  oversized inputs
- redacts secret-shaped fields and replaces absolute self-host paths
- records hashes and byte counts in a manifest

CI uploads this sanitized bundle alongside Playwright diagnostics, then the
runner removes the temporary repository, worktrees, database, and evidence
root. Passing runs produce no evidence upload.

### `context.json`

Records the stable facts both the UI and agent need:

- workspace ID, issue key, title, and selected provider
- selected repository identities and labels
- source base refs and pinned base commit OIDs
- generated branch and worktree paths
- graph path, digest, creation time, and indexed commit OIDs
- allowed repository scope
- WTS schema and binary versions

### `verification-plan.json`

Defines checks before an agent runs:

- stable check ID and human-readable label
- check type: unit, integration, UI, contract, lint, build, or custom
- repository and working directory
- executable and fixed argument vector
- timeout and output limit
- required or advisory status
- environment-variable names, without secret values
- acceptance-file digests

WTS must never silently invent arbitrary shell commands from an LLM response.
Commands should come from repository configuration, a reviewed task plan, or a
user-confirmed action and should be executed without a shell.

### `verification-result.json`

Captures:

- overall status and per-check status
- start time, duration, and exit classification
- bounded stdout/stderr log references
- initial red result where red-to-green evaluation is expected
- final green result
- acceptance-test integrity result
- graph staleness and repository-scope warnings

### Why this matters

The same bundle powers:

- the Workbench verification UI
- prepared CLI tasks and future resumable managed-agent context
- bug reports and support diagnostics
- CI regression fixtures
- code-review evidence
- future deployment and review trackers

It removes the need for a user to repeatedly explain repository scope and
allows an agent to answer “what remains?” from durable local evidence.

## Test layers

### Layer 1 — pure contracts and units

Run on every edit and pull request.

Rust coverage:

- all input normalization and bounds
- repository labels, issue keys, refs, paths, and UUID parsing
- branch-name derivation and collision resistance
- state transitions and error classification
- serialization compatibility for every persisted and UI-facing structure
- command construction without launching a process
- secret redaction and bounded-output logic

TypeScript coverage:

- wire-payload normalization
- board grouping and state derivation
- form validation
- loading, retry, empty, and error reducers
- accessibility names and keyboard state

Use table-driven and property-based tests for path/ref/label parsing. Add
mutation testing periodically for security-sensitive validation so a high line
coverage number cannot hide ineffective assertions.

### Layer 2 — UI components in isolation

Keep the existing Vitest and Testing Library suite for fast behavioral tests.
Add real-browser component tests for behavior that jsdom cannot faithfully
represent:

- focus trapping and focus restoration in Preferences and creation dialogs
- dropdown positioning and dismissal
- keyboard-only board and workbench navigation
- drag/scroll behavior if introduced
- reduced-motion behavior
- viewport overflow at compact laptop sizes

Every important UI state needs a named story/fixture:

- first run
- empty board
- many concurrent workspaces
- loading
- disconnected Rust service
- partial integration readiness
- preflight blocked
- materialization running
- ready
- verification failed
- CLI launch requesting, accepted, and rejected
- repository-base browser launch requesting, accepted, rejected, and disabled
- graph stale
- recoverable restart

### Layer 3 — transport contract parity

The browser HTTP host and Tauri IPC are two transports for the same product.
Create one transport-neutral conformance suite and run it against both.

For every operation, verify:

- command/route name
- request shape
- response shape
- error code and safe message
- idempotency behavior
- authorization/session behavior where applicable
- cancellation and timeout semantics when those features are added

This prevents the browser build from working while the macOS app silently
drifts, or vice versa.

### Layer 4 — local-system integration

Use real temporary filesystems, SQLite, and Git. Replace only external
executables with controlled fixture binaries.

Create small fake CLIs for:

- `code`
- `graphify`
- `codex`
- `opencode`
- `hermes`
- Jira MCP stdio

Each fake executable should support success, missing executable, authentication
failure, non-zero exit, timeout, excessive output, malformed output, partial
write, and forced termination. Record the received current directory and
argument vector so tests can prove WTS did not invoke a shell or escape the
workspace.

Test the external Workspace CLI handoff separately from the compatibility
one-shot adapters. The macOS launcher contract must prove that the provider
command is fixed and an accepted launcher result is not reported as
provider-running or provider-succeeded. For native Terminal, prove that the
validated workspace path is passed as an argument and quoted before it reaches
the shell. For Warp, parse the generated managed Tab Config as TOML and prove
its exact directory, command, pane type, permissions, URI, safe update
behavior, and refusal to overwrite an unmanaged config. Tests must not open a
real terminal application during normal unit or CI runs.

Hermes requires an additional provider-visible working-directory regression
test. When the user's Hermes terminal backend is Docker, prove that WTS's
launch-scoped managed overlay retains the host workspace path, enables Hermes's
explicit `/workspace` bind mount, uses `/workspace`—never the host bind
source—as the container command cwd, preserves unrelated user volumes, reaches
the launched process through `HERMES_MANAGED_DIR`, safely quotes hostile paths,
and does not overwrite an unmanaged file. Resolve the installed backend and
volumes through the fixed `hermes config get terminal --json` command using a
fake CLI in tests. Execute the generated launch command against another fake
`hermes` executable and record its process cwd, arguments, and environment.
Checking only Warp's `directory` field is not sufficient.

Test repository-base browser handoff as a separate host-owned operation. The
contract must prove that the request contains only a stable repository ID and
base ref. Rust re-inspects that catalog-owned checkout, rejects identity drift,
resolves the ref locally to an exact commit, accepts only supported GitHub or
GitLab origins, and constructs a commit-tree URL without a shell. Cover HTTPS,
SSH, and SCP-style origins, including supported enterprise hosts, nested GitLab
groups, malformed origins, credentials, hostile refs, and 40- and 64-character
commit OIDs. Use a recording launcher in tests: normal unit and CI runs must
not open a real browser. An accepted launcher result must not be reported as
proof that the remote revision or page exists.

Do not mock Git for worktree tests. Real Git behavior is one of the primary
risks WTS is managing.

### Layer 5 — full-stack scenario lab

Convert the current Rust example into a reusable scenario runner with manifests
rather than hard-coded behavior.

Suggested structure:

```text
test-lab/
├── fixtures/
│   ├── basic-fullstack/
│   ├── monorepo/
│   ├── conflicting-branches/
│   ├── malicious-inputs/
│   ├── large-repository/
│   └── fake-tools/
├── scenarios/
│   ├── ui-only.toml
│   ├── backend-only.toml
│   ├── full-stack.toml
│   └── failure-cases/
└── expected/
```

A scenario manifest should declare repositories, base refs, task text,
provider, initial failing checks, final required checks, allowed changed paths,
forbidden changed paths, expected graph contents, injected failures, and
expected UI state.

The runner should support:

- `reference` — deterministic known-good change
- `agent:<provider>` — real provider evaluation
- `fake-agent:<behavior>` — deterministic orchestration testing
- `no-change` — verify WTS correctly reports red
- seeded scenario and stable output IDs for reproducibility

Each run produces JSON, JUnit, human-readable Markdown, and retained failure
artifacts.

### Layer 6 — real browser and native application

The current Playwright suite launches the real `wtsd` process with temporary
repository, workspace, and data roots. The browser interacts through visible
controls rather than injecting the fake React client. It covers workspace
creation and materialization, verification, preparing a graph-informed CLI
task, requesting a provider CLI handoff through a controlled launcher, and
direct WTS Help/Preferences discoverability.

Keep expanding the internal browser suite with these critical journeys:

1. First run → Preferences → repository discovery
2. Create direct repository-set workspace → preflight → materialize
3. Reload application → workspace remains Ready
4. Open CLI without a graph → assert accepted-only handoff → optionally build
   graph and prepare a task to copy
5. Verification failure → inspect log → fix/retry → green
6. Multiple workspaces remain isolated while switching rapidly
7. Service unavailable and service restart recovery

Capture bounded local diagnostics on failure. The retained internal self-test
can produce a privacy-reduced failure trace locally. It never uploads evidence
to Replay or another cloud service. The same redaction boundary applies to
development logging and copied diagnostics. See
[Development observability](./dev-observability.md).

The retained runner uses a small trusted contract. Rust passes the fixed
12-step WTS Help + Preferences self-test and one allowlisted loopback origin to
a fixed helper. The helper cannot accept raw selectors, scripts, shell
commands, uploads, downloads, or cross-origin navigation. Rust owns pass/fail.
Preferences reports Node, helper, Playwright, and Chromium readiness for
developers, but the self-test is not mounted in every workspace's Verification
view. See [Local browser self-test infrastructure](./local-user-testing.md).

Opening self-test run history performs a shallow integrity pass over the
journey/result digests and artifact metadata. Immediately before bounded
failure context is prepared, the service deep-reads it and recomputes every
artifact SHA-256 digest. Tampered evidence must prevent preparation.

The internal self-test currently targets only the WTS UI served by its
authenticated loopback browser host. A Tauri WebView is not that Chromium
target, and workspace frontend/backend service journeys remain follow-on work.

For Tauri, keep a smaller native smoke suite:

- application launches and loads saved data
- Rust commands cross the IPC boundary
- Preferences opens and restores focus
- generated VS Code workspace launch is requested correctly
- Workspace CLI transport requests preserve the selected provider and return
  accepted/rejected handoff state without claiming process status
- file/dialog permissions match the declared capability set
- packaged binary can create and reopen a real workspace

Native tests should not duplicate the full browser suite. They prove packaging,
IPC, capabilities, and platform integration.

### Layer 7 — agent evaluation

Separate product correctness from model quality.

#### Deterministic adapter tests

Use fake provider CLIs on every pull request to prove:

- correct provider and workspace are selected
- graph is required before execution
- task and verification context are available
- time and output limits are enforced
- failure is visible and retryable
- acceptance tests cannot be silently rewritten
- unselected repositories are inaccessible or detected as scope violations

#### Real-provider evaluations

Run a controlled, opt-in or scheduled suite for Codex, OpenCode, and Hermes.
Do not block ordinary development on provider availability.

Score each provider on:

- task completion
- required checks passed
- acceptance tests preserved
- changed-path precision
- unnecessary diff size
- graph use
- number of attempts
- wall time and cost
- quality of final structured summary

Use at least three repetitions per scenario before interpreting success rates.
Retain provider version and configuration with the result. Never compare
providers from one anecdotal run.

Add adversarial fixtures:

- misleading instructions inside repository documentation
- Jira text asking the agent to modify an unselected repository
- acceptance tests that are easy to bypass
- large irrelevant repositories
- a stale graph
- a valid task with an intentionally impossible acceptance criterion

The product must distinguish “agent failed,” “verification failed,” “tool was
unavailable,” and “task is impossible.”

## Required scenario catalog

### Repository discovery and planning

- no configured repositories
- one repository and many repositories
- duplicate labels differing only by case
- nested repositories and repository root that is itself a repository
- deterministic traversal across multiple roots, with `WTS_REPOSITORY_ROOTS`
  taking precedence over the single-root variable
- maximum depth 4 and 4,096-directory limits produce bounded skip evidence
- symlinked directories are never traversed. Git repositories stop descent.
  VCS metadata, dependency, and generated directories are pruned
- the same canonical repository reached through multiple roots is deduplicated
- repository moved or deleted after plan creation
- default `main`, default `master`, and remote default branch
- user-selected non-default base
- selected-base inspection resolves an exact local commit and never fetches
- source checkout currently on an unrelated feature branch
- detached HEAD
- missing base ref
- non-UTF-8 and long paths where the platform permits them

### Workspace source import

- valid JSON and supported JSON-with-comments `.code-workspace` inputs
- folder entries are matched only against the bounded repository catalog
- local checkout identity and cached origin metadata inform matching without a
  clone, fetch, or other network operation
- explicit HTTPS/SSH clone requests validate the remote, own the destination
  below the repository root, stage atomically, clean failed staging folders,
  refresh the catalog, and reject destination/origin conflicts
- the import UI previews the owned target, exposes pending/success/error
  states, and adds a successful clone to both the plan and edited workspace
  download
- absolute exact paths, safe multi-component relative-path suffixes, basename
  and optional-name fallbacks, missing, duplicate, and ambiguous folder hints
- Unix and Windows separators, leading non-authoritative parent components,
  linked-worktree aliases, and traversal-shaped relative paths
- settings, tasks, extensions, launch configuration, and unrelated keys are
  ignored
- URI-only folders and empty folder lists return no path-authoritative
  repository suggestion
- malformed input, oversized files, and excessive folder counts fail with
  actionable bounded errors
- imported suggestions still require repository review, plan save, and
  read-only preflight
- imported path text cannot authorize filesystem access, trigger a clone, or
  synchronize later changes
- new catalog-backed plans persist the matched repository ID, a missing pinned
  ID never falls back to a same-label checkout, and legacy records without an
  ID retain unique-label resolution
- two distinct, explicitly matched repositories with the same display label
  remain distinguishable through import, preflight, materialization, and
  reviewed removal
- browser HTTP and Tauri IPC return equivalent normalized import results
- browser HTTP and Tauri IPC enforce equivalent repository-base open requests,
  sanitized responses, and safe error codes
- successful debug HTTP and Tauri imports expose equivalent opaque import IDs,
  bounded catalog metadata, matching reasons, attempts, and candidate
  truncation
- URI-shaped path or `uri` values are represented as `<unsupported-uri>`, and
  URI-shaped folder names are discarded, in response diagnostics, logs,
  console events, and copied JSON, including when a local path accompanies the
  name
- the planned outer transport correlation assigns a diagnostic ID before
  authentication and extraction and surfaces it on sanitized authentication,
  body-limit, content-type, and extractor errors
- release imports omit debug diagnostics and the diagnostic panel remains
  absent
- copied diagnostics include an explicit local-path disclosure but exclude
  source contents, ignored editor configuration, session credentials, and
  remote origin URLs
- correlated terminal and browser-console events never contain a sentinel
  secret from settings, tasks, extensions, headers, or provider configuration

### Worktree lifecycle

- frontend-only, backend-only, and combined workspaces
- two issues using the same repositories simultaneously
- same issue key creating independent workspace records
- replay with the same idempotency key
- concurrent creation retries
- pre-existing target path
- pre-existing branch
- dirty primary checkout remains untouched
- failure while creating the first, middle, and final worktree
- rollback failure is reported honestly
- application termination between Git creation and manifest write
- restart after successful materialization
- worktree branch changed manually
- worktree directory deleted manually
- source repository deleted after materialization
- corrupt or symlinked manifest and VS Code workspace file
- disk full and read-only destination

### Graph lifecycle

- graph contains every selected repository
- graph contains no unselected repository
- generated files, `.git`, build output, credentials, and configured secret
  patterns are excluded
- graph built from the workspace branch rather than the primary checkout
- empty or unsupported repository
- Graphify missing, failure, timeout, and oversized output
- graph file missing, malformed, symlinked, or replaced after creation
- graph staleness after code changes is visible
- explicit graph refresh updates the digest
- a Workspace CLI can open without a graph
- a prepared graph-informed task is copy-only and is never submitted by WTS
- structural indexing performs no LLM call

### Verification

- required check starts red and becomes green
- baseline check remains green throughout
- frontend-only task cannot change backend
- backend-only task cannot change frontend
- combined contract changes agree on both sides
- acceptance file modified, deleted, renamed, or ignored
- executable missing
- non-zero exit, signal termination, timeout, and excessive output
- one of several checks fails
- rerun-all executes the complete fixed check set
- results survive restart
- logs are bounded, encoded safely, and redact secrets
- stale result is invalidated after source changes

### UI and interaction

- mouse, keyboard-only, and screen-reader-accessible flows
- focus order, dialog escape, focus restoration, and no stacked dialogs
- loading actions cannot be double-submitted
- changing a Base selector changes the ref sent to the trusted forge action.
  Unchecking a repository does not prevent inspection before inclusion
- supported GitHub/GitLab rows expose a keyboard- and screen-reader-accessible
  action. Unpinned or unsupported rows expose a disabled explanation
- workspace switch discards stale async responses
- board and workbench agree after reload
- errors are actionable and never claim false readiness
- long titles, paths, repository lists, and prepared CLI tasks do not break
  layout
- laptop-sized viewport, high zoom, dark/light mode when supported
- reduced motion removes nonessential animation
- visual snapshots for board, workbench, Preferences, creation, verification,
  failure, and CLI-launch states
- information density remains progressive: summary first, details on demand

### Security and privacy

- loopback-only host and exact host validation
- session, origin, content type, and body-size enforcement
- path traversal, symlink escape, command injection, and malicious labels
- hostile `.code-workspace` content cannot escape the repository catalog or
  import executable editor configuration
- no shell expansion in tool or verification commands. The macOS CLI handoff
  quotes the validated workspace path and keeps provider commands fixed
- repository-base launches accept no browser-supplied URL or checkout path,
  join catalog data only by stable repository ID, re-inspect origin and
  identity, and invoke the fixed OS browser launcher without a shell
- credentials never enter UI payloads, logs, graphs, or reports
- raw origins and generated forge URLs never enter launch responses or
  development logs
- development import logs contain only allowlisted bounded metadata, and
  copied local-path diagnostics require a deliberate user action
- malicious Jira and repository instructions cannot expand repository scope
- generated workspace files cannot reference paths outside the materialization
- the external CLI output never crosses into the WTS UI

### Platform, upgrade, and performance

- supported macOS versions and architectures
- x86 Linux browser-host distribution
- clean install, upgrade, migration, restart, and uninstall-with-data-preserved
- repository roots containing spaces and long paths
- platform path-list parsing and precedence for multiple repository roots
- cold startup and warm startup
- flat and nested discovery with 100, 500, and 1,000 repository directories,
  plus the 4,096-directory bound
- materialization with 1, 8, and 32 repositories
- graph indexing for small, medium, and large fixtures
- 20 simultaneous saved workspaces and several active workspaces
- eight-hour idle/reopen soak without leaking child processes

Port allocation, isolated runtime configuration, WTS-owned PTYs, output
streaming, code review, and deployment tracking are deferred product features,
but their scenario contracts should be written before implementation. The
headless WTS-owned agent process has an observed lifecycle. The external macOS
Terminal handoff remains separate and must not be confused with that managed
session.

## Workbench verification experience

Add a **Verification** section to each workspace rather than hiding all proof in
a terminal.

The default view should show only:

- one overall state: Not run, Running, Passed, Failed, or Stale
- a compact count such as “5 of 6 checks passed”
- the failed check and next action
- **Run all**, **Rerun all**, and **Copy context** actions

Details expand on demand:

- checks grouped by repository
- duration and last-run time
- bounded logs
- changed and forbidden paths
- graph freshness
- acceptance-test integrity
- prepared CLI task associated with the result, if any

Animations should communicate state, not decorate it:

- a single progress track while checks run
- repository nodes activating as their checks start
- a short transition to Passed or Failed
- no perpetual pulsing once work has stopped
- reduced-motion mode uses static state changes

Useful communication actions:

- **Copy context for agent** — copies a concise, redacted summary and artifact
  paths
- **Open task brief** — shows the exact task prepared for the user to copy
- **Open graph context** — shows graph scope and freshness, not a huge raw graph
- **Prepare failure task** — creates a bounded task for the user to review and
  paste into a Workspace CLI. It does not start or monitor an agent
- **Export proof bundle** — packages the context, graph manifest, changed files,
  check results, and versions without repository secrets

## Automation and release gates

### Local fast gate

Target: under two minutes after compilation is warm.

- formatting and lint
- Rust unit/contract tests
- TypeScript typecheck
- Vitest jsdom tests
- fake-adapter tests

Run all currently implemented fast checks with one command:

```bash
bash scripts/test-fast.sh
```

Each phase is named and timed, and the command ends with one concise pass/fail
summary. The harness contract test also parses the checked-in workflow
contracts, runs `bash -n` over every gate entrypoint, and simulates a failed
self-host run to prove redaction and deterministic cleanup.

### Pull-request gate

Target: under ten minutes.

- all fast checks
- real Git and SQLite integration tests
- HTTP/Tauri contract conformance
- deterministic three-scenario lab
- critical real-browser journeys
- accessibility scan
- changed visual snapshots reviewed when applicable
- dependency and secret scan

Implemented in `.github/workflows/pull-request.yml`. It installs the pinned
Node/Rust toolchains and Chromium, then invokes `scripts/test-pr.sh`. The real
browser portion is deliberately scoped to `e2e/critical-path.spec.ts`, which
creates and materializes repositories through the real Rust loopback host,
publishes an agent report, promotes its check, and executes the revised
verification plan.

### Nightly gate

- full failure-injection matrix
- graph exclusion and refresh suite
- large fixture and concurrency tests
- browser matrix
- packaged Tauri smoke tests on available platforms
- optional real-provider agent evaluations
- flake detection and test-duration trend

The first implemented nightly/release slice is
`.github/workflows/wts-on-wts.yml`. It is scheduled daily, supports manual
dispatch, and runs for published releases. The job builds the production UI
and invokes `scripts/run-selfhost-e2e.sh`. It never operates on the developer
checkout directly.

### Release gate

- clean installation of the signed/package candidate
- upgrade from the previous supported release
- persistent workspace reopen
- full browser critical path
- native Tauri smoke path
- x86 Linux browser-host smoke path
- performance budgets
- no unresolved critical or high-severity security findings
- retained release evidence bundle

Retries may diagnose a flaky test but must not make it disappear. CI should
report tests that passed only after retry as flaky and fail the quality gate
until they are quarantined with an owner and expiry.

## Suggested implementation sequence

### Phase 1 — evidence contract

1. Define versioned Rust types for context, verification plan, result, and
   graph manifest.
2. Write them atomically under `.wts/`.
3. Add digest and scope validation.
4. Extend the current full-stack report to use those types.

Exit criterion: the UI, reference runner, and fake agent can all consume the
same artifacts.

### Phase 2 — manifest-driven lab and fake tools

1. Move hard-coded scenarios into versioned manifests.
2. Add controlled fake executables and fault injection.
3. Add the repository/worktree/graph/verification failure matrices.
4. Emit JUnit and retained diagnostics.

Exit criterion: orchestration failures are reproducible without network access
or LLM calls.

### Phase 3 — verification UI

1. Add the compact Workbench Verification section.
2. Add Run all, Rerun all, logs, Copy context, and stale-result handling.
3. Add component, accessibility, and visual tests for every state.

Exit criterion: a user can understand what failed and hand exact context to an
agent without copying terminal output.

### Phase 4 — browser expansion and Tauri parity

1. Extend the existing real-loopback Playwright coverage to workspace service
   journeys.
2. Add shared HTTP/Tauri conformance tests.
3. Add focused Tauri/WebDriver smoke tests or a separate native automation
   adapter.

Exit criterion: equivalent critical coverage passes through both supported
transports and the packaged desktop boundary.

### Phase 5 — agent evaluation

1. Add fake-agent boundary tests to the pull-request gate.
2. Define the scoring rubric and retained run schema.
3. Add scheduled opt-in evaluations for each installed provider.
4. Track pass rate, scope precision, diff size, duration, and cost over time.

Exit criterion: agent support is evaluated with evidence rather than a manual
impression.

### Phase 6 — release hardening

1. Add cross-platform packaging, migration, large-fixture, and soak tests.
2. Define measurable startup, discovery, materialization, and graph budgets.
3. Publish a release checklist generated from test artifacts.

Exit criterion: a release candidate can be installed, upgraded, used, closed,
and reopened without relying on developer-machine state.

## Tooling choices

- Keep Vitest and Testing Library for fast React behavior.
- Add Vitest Browser Mode or Playwright-backed component tests where real
  browser behavior matters.
- Use Playwright for real loopback browser journeys, web-first assertions,
  accessibility integration, traces, and selective screenshots.
- Use the official Tauri WebDriver support for a small native smoke layer.
- Evaluate `cargo-nextest` for parallel Rust execution, timeouts, JUnit output,
  and explicit flaky-test reporting.
- Keep the scenario runner and evidence types in Rust so they exercise the same
  trusted core shipped to users.

Primary references:

- <https://playwright.dev/docs/test-assertions>
- <https://playwright.dev/docs/trace-viewer-intro>
- <https://vitest.dev/guide/browser/>
- <https://vitest.dev/guide/browser/visual-regression-testing>
- <https://v2.tauri.app/develop/tests/>
- <https://v2.tauri.app/develop/tests/webdriver/>
- <https://nexte.st/docs/configuring-nextest/>
- <https://nexte.st/docs/machine-readable/junit/>

## Definition of done for a WTS feature

A feature is complete only when:

- the same change includes an automated validation or regression test that
  fails against the preceding implementation and proves the affected
  user-visible behavior or trusted boundary
- an integration-boundary fix validates the serialized contract, transport,
  filesystem/process effect, or deterministic adapter rather than only
  asserting that a command was constructed
- its trusted Rust contract is explicit
- success, failure, interruption, restart, and retry are tested
- HTTP and Tauri behavior agree where both expose it
- the UI has loading, empty, error, and accessible keyboard behavior
- filesystem and process boundaries are tested with hostile input
- logs and artifacts contain no credentials
- the user and agent receive the same durable context
- a deterministic fixture proves the core behavior without an LLM
- any real-agent evaluation is supplemental and reproducible
- the appropriate pull-request, nightly, and release gates include it
