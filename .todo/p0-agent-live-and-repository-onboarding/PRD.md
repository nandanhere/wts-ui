# P0 Agent Live State and Repository Onboarding

## Overview

Make two foundational workflows honest and complete. WTS must derive agent
state from a process it owns, and a developer must be able to create a
workspace from any trusted local Git checkout or remote Git URL.

## User Needs

1. Know whether an agent is connecting, running, finished, failed, or stopped.
2. Trust that live state comes from an observed process, not a manual demo.
3. Stop a WTS-owned agent without leaving the workspace.
4. Distinguish an external Terminal handoff from a managed agent connection.
5. Add a repository that WTS has not discovered yet.
6. Confirm the repository and branch before creating a workspace.
7. Move backward and forward through setup without losing selections.
8. Get a useful recovery action when validation, cloning, or launch fails.

## User Stories

- As a developer, I want WTS to own the agent process so that its status is
  trustworthy.
- As a developer, I want live state and a stop action in the workspace so that
  I do not need to infer state from another terminal.
- As a developer, I want external Terminal launch labeled as a handoff so that
  it never appears as observed running time.
- As a developer, I want to add an existing local checkout so that repository
  discovery does not block workspace creation.
- As a developer, I want to clone a Git URL during setup so that I do not need
  a separate manual preparation workflow.
- As a developer, I want one consistent branch selector for catalog, local, and
  cloned repositories so that the choice is predictable.

## Screens and Flows

1. New workspace source selects issue, saved plan, VS Code workspace, or chosen
   repositories.
2. Chosen repositories offers catalog selection, local checkout validation, and
   remote clone.
3. Repository review uses one row model and one branch control for every origin.
4. Workspace agent connection starts a managed process and shows observed state.
5. Agent activity collates current and recent managed runs across workspaces.

## ASCII Designs

### Add repositories

```text
┌ New workspace ────────────────────────────────────────────────────┐
│ 1 Source  ─  2 Repositories  ─  3 Services  ─  4 Review         │
│                                                                   │
│ Choose repositories                                               │
│ [From this computer] [Local checkout] [Clone Git URL]             │
│                                                                   │
│ Local checkout                                                    │
│ ┌───────────────────────────────────────────────────────────────┐ │
│ │ /Users/example/code/project                                 │ │
│ └───────────────────────────────────────────────────────────────┘ │
│ [Validate repository]                                             │
│                                                                   │
│ ✓ project   /Users/example/code/project                           │
│   Branch  [main ▾]                                  [Remove]      │
│                                                                   │
│ [Back]                                              [Continue →]  │
└───────────────────────────────────────────────────────────────────┘
```

Remote cloning replaces the path field with a Git URL. Loading keeps the row
shape visible. Failure text explains whether the URL, credentials, destination,
or repository is invalid and leaves the input available for retry.

### Managed agent state

```text
┌ Agent connection ─────────────────────────────────────────────────┐
│ Codex                                        ● Running · 00:42    │
│ WTS owns this process and observes its exit state.                 │
│                                                                   │
│ Last signal 10:41:08       Started 10:40:26       PID managed     │
│                                              [Stop agent]          │
└───────────────────────────────────────────────────────────────────┘

Idle:        No managed agent · [Start Codex]
Connecting:  Starting Codex… · [Cancel]
Completed:   Completed successfully · [Start again]
Failed:      Failed · concise reason · [Retry]
Stopped:     Stopped by user · [Start again]
```

The alternate “Open in Terminal” action remains available in the workspace
launcher. Its result is “Terminal handoff accepted,” never “Running.”

## Component Reuse

- Reuse `NewWorkspaceDialog` and its existing four-step navigation.
- Reuse repository evidence rows and the existing branch picker.
- Reuse `OpenWorkspaceLauncher` for provider selection.
- Replace `AgentStatePrototype` with a managed-state component rather than
  adding another workspace card.
- Reuse `AgentSessionsPanel` for cross-workspace history.
- Use existing CSS variables, control heights, focus treatment, and Radix
  primitives. Do not introduce hardcoded colors or a second dialog system.

## API and Backend

- A managed start operation must spawn a provider process inside the exact
  materialized workspace path.
- The backend owns the child handle and derives state from spawn success,
  observed process state, exit code, stop requests, and stale recovery.
- Status/list responses remain transcript-free. Output streaming is optional
  for this slice, but state must not depend on UI-generated heartbeats.
- The managed process and the agent activity view must use one persisted
  lifecycle record. Do not keep a separate demo-session record and agent-run
  record for the same process.
- A managed start response must identify the persisted session that receives
  later process observations. A UI refresh or application restart must load the
  same session identity and last trusted state.
- Stop must target only the registered child for the requested session.
- Tauri and loopback HTTP expose the same contract and permissions.
- Existing external Terminal launch remains a separate accepted-only handoff.
- Local repository addition must canonicalize and validate a Git worktree under
  an allowed root before it enters the catalog.
- Remote clone must use the existing bounded clone operation and return the
  discovered repository contract used by branch selection.

## Validation

1. A managed start reports running only after process spawn succeeds.
2. Natural process exit becomes completed or failed without a UI heartbeat.
3. Stop ends the owned child and persists an interrupted/stopped result.
4. Desktop permissions allow every UI-invoked managed-session command.
5. External Terminal handoff never reports observed running time.
6. A remote Git URL can be cloned, selected, assigned a branch, and serialized
   into a workspace request.
7. A valid local checkout can be selected through the same review row.
8. Invalid paths and clone failures keep user input and offer a retry.
9. Back and forward navigation retain repository and branch selections.
10. Rust boundary tests, client transport tests, React behavior tests, and one
    opt-in desktop or self-hosted integration check cover these contracts.

### Acceptance Matrix

| Behavior | Required deterministic boundary |
| --- | --- |
| Managed start | Use a fake provider executable. Prove that spawn success changes the persisted session from `launching` to `running`. Prove that spawn failure becomes `failed`. |
| Observed exit | Use fake executables with exit code 0 and a nonzero exit code. Prove that WTS persists `completed` or `failed` without a browser heartbeat. |
| Stop | Start a fake process with a child process. Stop the registered session. Prove that the process group exits, the session becomes `interrupted`, and a second stop is safe. |
| Restart recovery | Persist a running session, reopen the service without its child handle, and prove that WTS reports `interrupted` instead of `running`. |
| Session privacy | Serialize list and status responses. Prove that they contain no prompt, output, transcript, environment value, or command argument. |
| Transport parity | Run start, status, list, and stop through HTTP and Tauri client adapters. Prove that both transports use the same request and response contract. |
| Desktop authority | Read the generated Tauri command manifest, capability, and permission files. Prove that every agent command invoked by the desktop client is allowed. |
| External handoff | Launch a fake Terminal adapter. Prove that the result is `handoffAccepted` and never `running`. |
| Remote repository | Clone a local bare Git fixture through the trusted clone adapter. Prove that the returned repository identity and branches enter the workspace request. |
| Local repository | Validate a temporary Git checkout through the trusted local-path adapter. Reject a non-repository, an unapproved path, and a symlink escape. |
| Setup retention | In a React behavior test, add a repository, select a branch, move back and forward, and prove that the same repository identity and branch remain selected. |
| Complete onboarding | In a browser test with the Rust host, clone a Git fixture, select a non-default branch, save, materialize, and prove that the generated worktree uses the selected commit. |

### P0 Release Gate

Run these checks before the P0 is complete:

```bash
cargo fmt --all -- --check
cargo test -p wts-app
cargo test -p wts-server
cargo test --manifest-path src-tauri/Cargo.toml
npm --prefix ui test
npm --prefix ui run build
bash scripts/test-fast.sh
```

Also run one opt-in integration check with a fake provider executable and the
desktop application. Confirm that Start, refresh, and Stop operate on one
persisted session. Run the repository browser journey with a local bare Git
fixture. Do not use a public network repository as test authority.

## Open Questions

- Codex is the first exercised managed adapter. The process contract stays
  provider-neutral so OpenCode and Hermes can use the same lifecycle.
- Output streaming, attach, and resume follow after process-derived P0 state
  unless the current process supervisor already provides them safely.
