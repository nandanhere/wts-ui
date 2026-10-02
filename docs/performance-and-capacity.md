# WTS performance and capacity

## Capacity model

“Thirty projects” can mean four very different loads. WTS must report them
separately:

| State | Retained WTS cost | External cost |
| --- | --- | --- |
| Registered plan | SQLite rows and UI metadata | None |
| Materialized workspace | Small evidence records. No retained worker | Git worktree files on disk |
| Indexed workspace | Graph files on disk. No watcher by default | None after indexing |
| Running workspace | Supervisor metadata, bounded log tail, health samples | The repository's own service processes |

An interactive Codex, OpenCode, or Hermes CLI handed to native Terminal does
not move a workspace into WTS's **Running** state. Terminal owns that process,
and WTS has no status, output, stop control, or resource accounting for it after
the accepted/rejected launch response.

The first three can scale to dozens cheaply. The fourth cannot have one
universal memory promise: thirty 20 MiB services and thirty 1 GiB services are
different machines. WTS should keep its supervisory overhead bounded and make
the child-process cost visible instead of hiding it.

## Initial 30-workspace baseline

The repeatable profiler creates one tiny Git repository, registers 30
workspaces, materializes 30 worktrees, builds 30 workspace graphs, drops and
reopens the service, lists the persisted registry, and then separately performs
deep reconciliation of every workspace. It records wall time, RSS, virtual
address space, file descriptors, threads, child processes, and workspace disk
usage after each phase.

Initial release-build result on macOS arm64:

| Phase | Wall time | RSS | FDs | Threads | Retained children | Workspace disk |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Service open | 0 ms | 3.0 MiB | 4 | 1 | 0 | 0 |
| 30 plans registered | 50 ms | 3.8 MiB | 4 | 1 | 0 | 0 |
| 30 worktrees materialized | 21.4 s | 4.6 MiB | 4 | 1 | 0 | 124 KiB |
| 30 graphs indexed | 11.4 s | 4.6 MiB | 4 | 1 | 0 | 273 KiB |
| Restart and reconcile 30 | 3.9 s | 4.3 MiB | 4 | 1 | 0 | 273 KiB |

After the lifecycle-projection and batched-Git optimization pass on the same
macOS arm64 machine:

| Phase | Wall time | RSS | FDs | Threads | Retained children | Workspace disk |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Service open | 0 ms | 3.0 MiB | 4 | 1 | 0 | 0 |
| 30 plans registered | 64 ms | 4.1 MiB | 4 | 1 | 0 | 0 |
| 30 worktrees materialized | 14.3 s | 4.7 MiB | 4 | 1 | 0 | 124 KiB |
| 30 graphs indexed | 9.3 s | 4.5 MiB | 4 | 1 | 0 | 273 KiB |
| Restart and list registry | 2 ms | 4.5 MiB | 4 | 1 | 0 | 273 KiB |
| Explicitly deep-reconcile 30 | 1.8 s | 4.7 MiB | 4 | 1 | 0 | 273 KiB |

For this fixture, the user-visible restart path fell from 3.9 seconds to 2
milliseconds because it no longer includes 30 deep Git checks. Deep
reconciliation itself is 55% faster, materialization is 33% faster, and graph
indexing is 19% faster. These are local engineering measurements, not
cross-machine promises.

Virtual address space is recorded for diagnosis but is not a capacity budget
on macOS because runtime reservations make it misleadingly large. Fixture disk
usage is not representative of real repositories.

Run the release profiler with:

```bash
bash scripts/profile-many-workspaces.sh 30
```

The JSON report is written to `target/wts-profile-30.json`. Use an explicit
second argument to keep reports from different machines:

```bash
bash scripts/profile-many-workspaces.sh 30 \
  target/profiles/macos-arm64-30.json
```

The report now includes `passedResourceBudgets` and `budgetViolations`, and the
command fails if a phase retains a child process, more than ten file
descriptors, more than two threads, or more than 40 MiB of RSS above its
baseline.

## Initial simultaneous-runtime sample

The service-stack lab is a separate workload from the 30 inactive-workspace
profile. One macOS arm64 debug run used four copies of each fixture shape:

| Runtime check | Result |
| --- | ---: |
| Stack copies | 12 |
| Service processes | 28 |
| Unique preferred ports requested | 3 |
| Unique ports assigned | 28 |
| Parallel stack checks passed | 12 |
| Healthy stacks after stopping one | 11 |
| Rust supervisor RSS sample | 2,880 KiB |
| Sum of child-process RSS samples | 1,162,656 KiB |
| Processes and ports released | All |

This is a best-effort, one-point `ps` sample. Summed RSS can double-count
shared pages, and these tiny Node fixtures do not represent arbitrary user
services. It nevertheless confirms the expected cost split: supervisor state
is cheap. Running application processes dominate memory. The repeatable
command and detailed caveats are in
[Simultaneous workspaces and parallel agents](./simultaneous-workspaces.md).

## MVP resource budgets

These are engineering gates, not marketing promises:

- backend idle RSS: target at most 40 MiB in a release build, excluding the
  operating system WebView.
- idle CPU: below 1% averaged across 60 seconds.
- registered or materialized workspace: no retained child process, watcher, or
  dedicated thread.
- inactive graph: files only. No per-workspace Graphify daemon.
- open file descriptors with 30 inactive workspaces: baseline plus no more
  than 10.
- startup: render the registry from one persisted list projection without
  per-workspace Git reconciliation.
- reconciliation: deeply validate only a selected or explicitly acted-on
  workspace.
- HTTP admission: at most 16 cheap reads, four filesystem scans, and four
  heavyweight actions reach blocking workers at once. Excess work receives a
  structured `429` with `Retry-After`.
- verification: bounded direct commands, currently one workspace at a time.
- Workspace CLI handoffs: no WTS-retained child after native Terminal accepts
  the launch. Provider resource usage and lifecycle are Terminal-owned.
- compatibility one-shot agents: explicit bounded processes, currently one
  adapter operation at a time.
- parallel collaboration core: configurable global active-agent gate (default
  four), with same-phase overlapping write scopes rejected. It is not yet
  exposed through the service or UI.
- agent evidence: at most 256 summaries and 4 MiB of summary JSON per
  workspace.
- log memory: bounded tails only. Full bounded logs live on disk.

The current core meets the retained-process, thread, descriptor, and memory
shape in the tiny-repository baseline. Release-build numbers and realistic
large-repository fixtures still need to be recorded on every supported
platform.

## UI portfolio budget

The Board is designed as a personal portfolio for 20–30 workspaces, not as 30
live workbench screens:

- startup performs one workspace-list request and does not fan out into
  materialization, Graphify, verification, test-run, or agent reads per card.
- lane counts and the local focus recommendation are derived in one pass from
  the list projection.
- cards use browser rendering containment so off-screen cards do not require
  full layout and paint work.
- search and lane filtering operate on the in-memory projection.
- authoritative reconciliation and detailed evidence load only after the user
  opens one workspace.
- the Board's **Workspace focus** is deterministic local triage and makes no
  model call.
- a provider CLI launch is always explicit and scoped to the selected,
  materialized workspace. There is no background agent per project, and WTS
  retains no status/output monitor after the Terminal handoff.
- browser journeys start an ephemeral browser only for the selected workspace
  and retain no idle worker.
- browser evidence retains at most 8 runs and 128 MiB per materialized
  workspace, with a 96 MiB run ceiling and 64 MiB single-artifact ceiling.
  Cross-workspace disk budgeting remains a required manager-level follow-up.

Vitest exercises a 30-workspace portfolio and proves that filtering and search
do not trigger deep workspace or agent calls. The real-browser scale journey
creates 30 plans through the Rust API, renders and searches them, and asserts
that no per-card materialization, evidence, or test-run request is issued.
Larger portfolios should be profiled before adding virtualization: at this
scale, semantic DOM plus rendering containment is simpler and remains fully
keyboard- and screen-reader-accessible.

## Control-plane safeguards already implemented

- The Board reads a persisted, explicitly last-known lifecycle summary in the
  workspace list. It does not launch a Git validation subprocess tree for each
  card.
- Opening or acting on a workspace still performs authoritative manifest,
  generated-file, worktree, branch, and Git validation. Safely attributable
  drift updates the list projection to `needsAttention`.
- Existing v1 registries migrate without rewriting workspace records. Their
  first v2 list performs one bounded fixed-manifest observation, with no Git,
  graph, or evidence hashing, and persists the result.
- Repository catalog scans use a short single-flight cache, collapsing setup
  and Preferences reads that arrive together.
- Common repository inspection uses three Git subprocesses rather than eight.
  One metadata observation and one sorted ref snapshot preserve default-branch,
  linked-worktree, detached-HEAD, and SHA-1/SHA-256 behavior.
- Read, scan, and heavy HTTP work have independent admission lanes. Admission
  happens before `spawn_blocking`, and a disconnected request retains its
  permit until the underlying blocking operation actually exits.
- Compatibility one-shot agent evidence is pruned deterministically by count
  and bytes. Invalid names, symlinks, oversized files, and identity mismatches
  fail closed.
- Inactive workspaces retain no WTS-owned agent, verification, Graphify, or
  watcher process. A CLI handed to Terminal is external and may continue until
  the user exits it.
- On Unix, bounded verification, compatibility one-shot agent, and Graphify
  launches own a process group. Timeout or reader failure kills and reaps
  descendants, not just the top-level launcher. This does not apply after an
  external Terminal handoff.

This removes N×repository Git validation from Board startup. Explicit
reconciliation remains linear in the repositories of the one selected
workspace, where the safety check is required.

## Runtime supervisor status

The Rust core now owns a process group per service, invokes direct argument
vectors, resolves colliding loopback ports, starts dependency graphs, refreshes
selected-stack health, bounds stack and process counts, rolls back partial
starts, and performs final cleanup without a polling thread per process.

Product integration still needs:

1. Extend the existing global admission controller to service start and stop
   jobs. Existing setup, registry, materialization, verification, graph,
   compatibility agent, and Jira routes are already admitted before blocking
   workers. A Workspace CLI request ends when Terminal accepts or rejects the
   handoff.
2. Three local profiles:
   - **Eco**: park aggressively. Low concurrency.
   - **Balanced**: the default for laptop use.
   - **Full**: allow up to the configured 20–30 running workspaces, with an
     explicit projected-memory warning.
3. Adaptive sampling: frequent only for the visible workspace, slower for
   background workspaces, event-driven exit handling everywhere.
4. Disk-backed bounded logs with small UI tails.
5. Per-workspace and global CPU/RSS/process/FD measurements, including all
   descendants, so the Board can distinguish WTS overhead from project cost.
6. Automatic pressure actions that require user policy: stop indexing first,
   then pause health polling, then offer to park least-recently-used services.

Long operations should become durable jobs with IDs and progress events rather
than holding an HTTP or desktop invocation open while waiting on a global
mutex. Recommended initial limits are: one materialization, one graph, one
managed or compatibility agent (two opt-in), two verification jobs globally,
and one verification job per workspace. External Terminal sessions are not
counted because WTS does not own or observe them.

WTS should not claim that 30 arbitrary services are lightweight. It should
prove that 30 idle workspaces are cheap, show the measured cost of each running
service, and give the developer deliberate controls when the machine is under
pressure.

## Profiling matrix still required

- macOS arm64 and x86_64 release builds.
- Linux x86_64 native binary and container.
- 1, 10, 20, 30, 50, and 100 registered workspaces.
- 30 materialized workspaces using small, medium, and large repositories.
- graph cold build, warm rebuild, and unchanged no-op.
- verification with fast, slow, timed-out, and excessive-output checks.
- agent success, timeout, and cancellation once cancellation exists.
- 8-hour idle soak and repeated open/park cycles.
- startup and restart with cold and warm filesystem caches.
- Tauri WebView RSS measured separately from the Rust backend.
