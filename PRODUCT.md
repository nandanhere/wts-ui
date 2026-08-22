# WTS product brief

## Product

WTS is a lightweight, local development workspace supervisor for engineers who
work on several issues across several repositories at the same time.

It is not an infrastructure or SRE dashboard. It creates and supervises
issue-scoped Git worktrees, a multi-root editor workspace, isolated local
processes, a workspace-only code graph, and an optional agent or editor
launch.

## Core promise

> Give WTS an issue or an existing local setup. Review the proposed boundary.
> Enter a coherent local workspace that cannot silently grow beyond what was
> approved.

## Primary user

A developer in a large organization who:

- may not know every repository involved in an issue.
- needs several bugs or features active without branch, port, or context
  collisions.
- uses Codex, OpenCode, Hermes, or VS Code depending on the task.
- wants automation, but needs local visibility and explicit authority.

## Product experience

WTS is one personal desktop application with two connected views:

- **Workspace Board:** the Kanban home for scanning local sessions and seeing
  which one needs input.
- **Workbench:** the same-window focus view for operating the selected session.

The Board is not a project-management board. Its lanes are derived from local
workspace state:

- **Ready:** provisioned and available to start.
- **Running:** a service, agent, or active development process is running.
- **Needs input:** a local approval, conflict, failure, or scope decision blocks
  progress.
- **Parked:** worktrees are retained while processes are stopped.

Selecting a card opens the Workbench without creating another WTS window.
Returning restores the Board's search, filters, scroll position, and selected
card. VS Code may open separately with the generated multi-root workspace.

## Product lifecycle

```text
Issue, repository set, saved plan, or VS Code workspace file
        ↓
Evidence-backed repository proposal
        ↓ human approval
Versioned workspace boundary
        ↓ deterministic provisioning
Linked worktrees + runtime namespace + graph overlay + editor workspace
        ↓
Agent or VS Code launch
        ↓
Observed changes, checks, approvals, and scope drift
        ↓
Review capsule or clean suspension
```

## Workspace boundary

The boundary is the central WTS object. A revision binds:

- issue intent and acceptance criteria.
- repository names and compatible pinned base commits.
- exact worktree paths.
- runtime leases and injected configuration.
- base-graph and workspace-overlay digests.
- agent or editor capabilities.
- a parent revision and content digest.

All mutating actions carry the boundary digest. A stale or broader action fails
before execution. New evidence can propose a new revision, but it does not
silently broaden the current agent.

## Automation policy

Use plain Rust orchestration for deterministic work:

- Git inspection and worktree creation.
- default-branch resolution.
- compatibility and preflight checks.
- path, branch, and workspace-file generation.
- port/runtime namespace leasing.
- process supervision, health checks, and logs.
- graph invalidation, file watching, and event journaling.
- capability validation and rollback.

Use an LLM only where interpretation is useful:

- converting ticket language into candidate entities.
- ranking unfamiliar repositories with evidence.
- explaining why a graph path matters.
- implementation, debugging, or review inside the approved boundary.
- summarizing evidence while retaining links to the underlying events.

The LLM proposes. Rust validates and executes.

## Provider semantics

- **Codex:** scoped run. A denied sandbox/network requirement stops
  fail-closed. A reviewed policy starts a new run.
- **OpenCode:** local run with visible, command-level approvals.
- **Hermes:** resumable ACP session with negotiated capabilities and approval
  requests.
- **VS Code:** editor launch, not a pretend autonomous agent. WTS watches Git,
  runtime, checks, and boundary drift.

## Experience principles

1. **Attention before activity.** The Board emphasizes decisions that unblock
   useful work, not the volume of events.
2. **Progressive disclosure.** The default view shows intent, health, and the
   next action. Terminals, graph evidence, and raw logs stay one action away.
3. **Suggestions are not authority.** Confidence explains a proposal. Only an
   approved boundary authorizes effects.
4. **Color has a job.** Blue identifies structure and actions, green means
   verified health, amber means input is needed, and red means failure.
5. **Local state is explicit.** WTS says what it created, what it did not
   modify, and how rollback works.
6. **Motion explains change.** Short transitions reveal state or a panel.
   The interface honors reduced-motion preferences.

## Target initial scope

Included:

- local repository catalog and bounded, one-time `.code-workspace` folder
  import.
- Jira/MCP issue import plus direct repository-set creation.
- creation from a copied saved WTS plan.
- compatible base selection with per-repository override.
- linked multi-repository worktrees and `.code-workspace` generation.
- isolated process/runtime namespaces.
- cached default-branch graph plus a session delta overlay.
- provider-neutral capability and approval model.
- Workspace Board and integrated Workbench.
- local event journal and review capsule.

Deferred:

- remote Git cloning and synchronization.
- remote deployment tracking.
- arbitrary plug-in execution from repositories.
- Kubernetes, production infrastructure, or SRE fleet management.

## Implementation boundary

All trusted WTS logic is Rust:

- domain rules, orchestration, storage, Git, runtime, graph, agent, terminal,
  and editor adapters.
- Tauri commands for the macOS/desktop application.
- Axum commands and event streams for headless Linux/x86 and browser use.

The interface uses React, TypeScript, and Vite. Tauri embeds the compiled static
assets in the desktop application. `wtsd` serves the same assets for browser
mode. UI code can request typed operations and submit a bounded, user-selected
`.code-workspace` file as untrusted input, but it cannot invent filesystem
paths or directly execute host commands. Folder entries in the selected file
can only suggest repositories already present in Rust's local catalog. They do
not grant path authority or trigger cloning.

Git, Jira/MCP, Graphify, Codex, OpenCode, Hermes, VS Code, and repository
toolchains are controlled external programs. Core workspace supervision works
from local state. Network calls occur only through integrations the developer
has explicitly configured.
