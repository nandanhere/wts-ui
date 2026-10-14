# Simultaneous workspaces and parallel agents

WTS now has an executable core experiment for running several issue-scoped
workspace stacks at once. This is a Rust orchestration slice and test lab, not
yet a Board or Workbench feature.

## What is implemented

`RuntimeSupervisor` owns local service processes by `(workspace_id, stack_id)`.
It:

- accepts executable-plus-argument vectors and never invokes a shell.
- confines working directories to a canonical workspace root.
- starts services in dependency order.
- assigns unique loopback ports when preferred ports collide.
- injects the complete stack endpoint map into every service.
- enforces stack, per-stack service, total-process, and startup limits.
- reports cheap last-known stack state and refreshes a selected stack on demand.
- rolls back a partial start and owns process-group cleanup.
- releases its processes when a stack stops or the final supervisor is dropped.

The default ceiling is 30 stacks, 16 services per stack, and 96 service
processes in total. Those are admission limits, not a claim that arbitrary
projects are inexpensive.

`CollaborationCoordinator` runs a bounded set of agent tasks. Tasks in the same
phase may overlap only when their canonical repository worktree scopes are
disjoint. Equal or nested write scopes are rejected before any adapter runs.
A later phase acts as a barrier for whole-workspace verification. Reports are
ordered by `(phase, task_id)` even when execution order differs.

The process adapter currently attests write confinement only for Codex on Unix:

- one ephemeral `codex exec` session per task.
- canonical repository scope passed as the only workspace root.
- `workspace-write`, no extra writable roots, no network, and no writable
  temporary directory.
- no interactive approvals and no shell-built command.
- option parsing ends before caller-authored prompt text.
- cooperative deadline/cancellation polling with process-group cleanup.
- bounded JSONL output with only the final agent message retained in the report.

OpenCode, Hermes, and non-Unix Codex deliberately fail closed for parallel
mutation until equivalent confinement and process ownership are implemented.
The Codex boundary is write isolation, not read secrecy: a stronger promise
that an agent cannot read any other local file requires an external container
or operating-system profile.

## Example stack set

The dependency-free fixtures in `examples/service-stacks/` use Node.js
built-ins, bind only `127.0.0.1`, and retain no watcher:

| Shape | Processes | Relationship tested |
| --- | ---: | --- |
| Frontend + backend | 2 | Browser-facing service with an upstream API |
| API + worker | 2 | HTTP job submission with asynchronous processing |
| Event-driven | 3 | Command API, projector, and read API |

Every shape has:

- a strict versioned `wts-stack.json`.
- dependency and named-port metadata.
- unit, health, and cross-service smoke checks.
- a versioned parallel-agent scenario.
- independently editable repository scopes.
- acceptance tests that are deliberately red before an agent change.

The manifests are test metadata. A future product loader must resolve a stored
workspace and repository IDs on the Rust side, show the resulting command and
port plan to the user, and require an explicit start. Browser input must not
become an executable, path, or environment-variable authority.

## Repeatable checks

Validate manifests, baseline tests, and the deliberately red collaboration
starting point without an LLM:

```bash
node examples/service-stacks/verify-fixtures.mjs
```

Exercise partial-start rollback and successful same-port recreation:

```bash
node examples/service-stacks/verify-runtime-cleanup.mjs 49700
```

Run the dependency-free Node harness:

```bash
node examples/service-stacks/smoke-many.mjs \
  --copies 4 \
  --base-port 48000 \
  --output target/simultaneous-stacks.json
```

Use `--hold-ms 5000` to keep the healthy service set alive long enough for an
external resource sample.

Run the Rust supervisor lab:

```bash
cargo run -p wts-app --example simultaneous_workspace_lab -- \
  --copies 4 \
  --root target/simultaneous-workspace-lab
```

The lab intentionally asks all copies for the same three preferred ports. It
starts and validates every stack, stops one stack, proves every survivor is
still healthy, stops the rest, and checks that the process registry and every
assigned port are empty.

## Current measured result

One local macOS arm64 debug run on 25 July 2026 produced:

| Check | Result |
| --- | ---: |
| Stack copies | 12 |
| Service processes | 28 |
| Preferred port values | 3 |
| Unique assigned ports | 28 |
| Parallel stack smoke checks passed | 12 |
| Healthy survivors after one targeted stop | 11 |
| Rust supervisor RSS sample | 2,880 KiB |
| Sum of fixture-child RSS samples | 1,162,656 KiB |
| Processes and ports released | All |

The RSS values are one best-effort `ps` sample, not a benchmark. Per-process
RSS includes shared pages, so summing it can double-count memory. The useful
conclusion is the shape: the Rust control plane is small, while application
children dominate cost. WTS should therefore keep inactive workspaces
process-free and add explicit start, stop, and park controls before presenting
20–30 running stacks as a normal mode.

The detailed retained report is
`target/simultaneous-workspace-lab-28/simultaneous-workspace-report.json`.

## Deterministic collaboration coverage

The no-LLM suite proves:

- disjoint frontend and backend scopes actually overlap in execution.
- overlapping scopes and unverified providers dispatch zero tasks.
- the whole-workspace phase starts after the parallel phase returns.
- a cancellation, timeout, provider failure, or adapter panic does not strand
  a sibling workspace.
- cancellation and output overflow kill descendant processes.
- reports remain deterministically ordered.
- retained evidence is digest-only and bounded by count and bytes.

A separate `parallel_agent_lab` example provides an explicit live-Codex path.
It copies the frontend/backend fixture to a fresh root, injects immutable
acceptance tests, proves both workstreams red, runs exactly two confined Codex
tasks, checks actual time overlap and changed-path allowlists, then runs local
unit and integration checks. Live execution is opt-in because it uses provider
credentials and model quota.

Run the no-LLM preflight or the explicit live path with:

```bash
cargo run -p wts-app --example parallel_agent_lab

cargo run -p wts-app --example parallel_agent_lab -- \
  --live-codex \
  --root target/parallel-agent-live
```

The hardened live run on 25 July 2026 passed:

| Collaboration check | Result |
| --- | ---: |
| Confined Codex tasks | 2 |
| Backend duration | 63,025 ms |
| Frontend duration | 76,564 ms |
| Actual overlap | Yes. Identical start millisecond |
| Changed files | 4 of 4 allowlisted files only |
| Injected tests preserved | Yes |
| Backend and frontend suites | Green |
| Cross-service integration | Green |
| Final port cleanup | Green |

The retained report is
`target/parallel-agent-live-hardened/lab-report.json`.

## Still product work

- Persist runtime stack state and expose start, stop, inspect, and park jobs
  through the Rust service.
- Add Board/Workbench controls, progress events, bounded disk logs, and a
  terminal surface.
- Resolve stack manifests from stored repository records. Never trust browser
  paths or arbitrary commands.
- Add adaptive health polling and per-stack descendant CPU/RSS accounting.
- Add macOS Seatbelt/container profiles when strict read isolation is needed.
- Add Windows Job Object and sandbox support before enabling parallel mutation
  there.
- Add equivalent confined adapters for OpenCode and Hermes.
- Run the release/platform/soak matrix described in
  `performance-and-capacity.md`.
