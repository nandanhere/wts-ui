# Workbench Information Architecture Simplification PRD

## Overview

Replace the current implementation-oriented `Overview / Verification / CLI`
workbench with a task-oriented workspace shell. Keep Verification as a clear
destination, make workspace launch and lifecycle actions immediately
accessible, and stop exposing internal terms such as `Set` and ambiguous
agent-report labels such as `Flows`.

This supersedes the Workspace Shell and CLI sections of
`.todo/wts-ui-polish/PRD.md`. It is a presentation and navigation redesign. The
trusted workspace, verification, and provider-launch contracts remain intact.

## Product Decisions

1. Keep two workbench destinations: **Workspace** and **Verification**.
2. Remove **CLI** as a tab. Opening an editor or agent is an action, not a place.
3. Replace the header's scattered controls with one state-aware primary action,
   one Verification shortcut, and a small maintenance menu.
4. Never show **Set** to users. The internal `repositorySet` intent remains
   unchanged, but its presentation becomes neutral workspace/repository copy.
5. Demote agent-reported system behavior from a nested **Flows** tab to
   optional supporting evidence.
6. Preserve old `/overview` and `/cli` deep links through compatibility
   handling rather than breaking saved URLs.

## User Needs

1. Understand what this workspace is and whether it is ready without decoding
   its internal source type.
2. See and use the next important action from anywhere in the workspace.
3. Open the workspace in the preferred editor or agent without navigating to a
   separate CLI page.
4. Run checks, understand failures, and decide what to do next from one
   Verification view.
5. Find infrequent maintenance and destructive actions in predictable places.
6. Distinguish trusted verification from optional agent-reported findings.

## User Stories

- As a developer opening a saved plan, I want the create/review action to remain
  visible so I do not have to discover that it lives under Overview.
- As a developer with a ready workspace, I want one Open action that offers my
  preferred tool and alternatives.
- As a developer reviewing quality, I want verification status and Run/Rerun
  actions before raw evidence and planning details.
- As a developer choosing repositories directly, I do not want my workspace
  described as a “Set.”
- As a developer following an old link, I want the workspace to open safely
  even after CLI stops being a tab.
- As a developer using an agent-generated verification brief, I want the brief
  handed to an Open action without being moved into another navigation area.

## Current Problems

### Navigation

- `Overview`, `Verification`, and `CLI` are presented as peer destinations even
  though CLI is only a launcher.
- The command palette and URL model repeat the same false hierarchy.
- Verification can send the user to CLI merely to open an agent with a prepared
  brief.

### Header and actions

- Open, VS Code, copy path, refresh, graph indexing, revision, and removal are
  split across the header, Overview, CLI, and the Actions menu.
- Saved plans lose their essential Review/Create action when another tab is
  active.
- Refresh exists both as a standalone icon and inside Actions.

### Terminology

- `repositorySet` is rendered as `Set`, an internal data-model term with no
  useful meaning to the user.
- A name such as `flow-review` is the workspace's title/key, not a workflow
  type. Pairing it with `SET` makes it look like a product-defined flow.
- Verification uses repeated technical headers and a nested report tab called
  `Flows`, even though that data is unverified agent-reported system behavior.

## Target Information Architecture

```text
My workspaces
    └── Workspace
          ├── Workspace
          │     ├── Setup / readiness
          │     ├── Repositories and worktrees
          │     └── Configuration (collapsed)
          └── Verification
                ├── Result and actions
                ├── Checks
                ├── Improve coverage (collapsed)
                └── Evidence and history (collapsed)
```

The editor/agent launcher is available from the shared workspace header and is
not part of the navigation tree.

## Workspace Shell

### Materialized workspace

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ My workspaces / flow-review                                                 │
│ flow-review                                      Ready                      │
│ /…/workspaces/flow-review  [Copy]   [Verification · 3/4 passed]             │
│                                      [Open workspace ▾] [•••]               │
├─────────────────────────────────────────────────────────────────────────────┤
│ Workspace                 Verification                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Repositories                                                              │
│  jellyfish             develop                 Ready                        │
│  ppec-ui              master                  Ready                        │
│                                                                             │
│  ▸ Configuration · planning home, source, graph state                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Saved plan requiring setup

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ My workspaces / PAY-1842                                                    │
│ Fix duplicate captures                         Needs setup                  │
│ PAY-1842                         [Verification · unavailable]               │
│                                  [Review & create workspace →] [•••]        │
├─────────────────────────────────────────────────────────────────────────────┤
│ Workspace                 Verification                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  Setup                                                                      │
│  Review the requested branches and exact Git effects before creation.       │
│  [Review setup]                                                             │
│                                                                             │
│  Repository requests                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

The state-aware primary action must remain in the shared header on both
destinations:

- Saved plan: `Review & create workspace`
- Reviewed and ready: `Create workspace`
- Materialized: `Open workspace`
- Busy: keep the action visible with explicit progress
- Blocked: keep the action visible and explain the blocker

## Open Workspace Launcher

`Open workspace` opens a sheet/popover that reuses the existing provider and
terminal launch logic.

```text
┌ Open flow-review ─────────────────────────────────────────────── [×] ┐
│ Working directory  /…/workspaces/flow-review              [Copy]    │
│                                                                      │
│ Recommended                                                          │
│ [ Open Codex in Warp → ]                                             │
│                                                                      │
│ Other ways to open                                                   │
│ [VS Code]   [OpenCode]   [Hermes]                                    │
│                                                                      │
│ Terminal                                                   [Warp ▾]  │
│                                                                      │
│ ▸ Prepared verification brief                                        │
└──────────────────────────────────────────────────────────────────────┘
```

Rules:

- Preferred provider is first and visually primary.
- VS Code and alternate agents remain available without a separate tab.
- Terminal choice is secondary and remembers the current preference.
- If Verification prepared `WTS.md`, the same launcher shows `Brief ready` and
  enables the appropriate agent action after the write succeeds.
- Provider setup/auth remains clearly provider-owned.

## Header Action Model

### Always visible

- State-aware primary action
- Verification shortcut with current result:
  - `Verification · Not run`
  - `Verification · 3/4 passed`
  - `Verification · Failed`
- Copy button adjacent to the displayed workspace path

### More menu

- Refresh status
- Create revised workspace…
- Remove workspace…

### Contextual actions

- Build/Re-index workspace graph moves to Verification → Improve coverage.
- Open alternatives live in the Open workspace launcher.
- Remove the duplicate standalone refresh control.

## Workspace View

Rename `Overview` to `Workspace`.

Use three sections without repeated eyebrow/title pairs:

1. **Setup** — lifecycle state, blocker, exact next action. Hide the section once
   the workspace is materialized unless attention is required.
2. **Repositories** — requested repositories or managed worktrees.
3. **Configuration** — collapsed source, planning home, graph availability, and
   reserved path.

The page has one H1 in the shared shell. Section headings use H2. Subordinate
labels do not pretend to be additional page headers.

## Verification View

```text
┌ Verification ────────────────────────────────────────────────────────┐
│ 3 of 4 checks passed                       [Rerun failed] [Run all]  │
│ checkout-api typecheck failed — open the result below.               │
├──────────────────────────────────────────────────────────────────────┤
│ Checks                                                               │
│ ✓ jellyfish · cargo test                                  18.2 s     │
│ ✕ checkout-api · typecheck                 [Run again]     4.1 s     │
│ ✓ ppec-ui · unit tests                                   12.8 s     │
│                                                                      │
│ ▸ Improve coverage · 2 suggested checks                              │
│ ▸ Evidence and history · last run today, 3 agent findings            │
└──────────────────────────────────────────────────────────────────────┘
```

Decision order:

1. Result and Run/Rerun/Cancel action
2. Checks with individual actions
3. Improve coverage
4. Evidence and history

### Improve coverage

- Build/rebuild graph
- Prepare agent brief
- Suggested checks with `Add to verification`
- Coverage gaps

### Evidence and history

Flatten the current five nested report tabs into a decision-first sequence:

1. Findings and suggested next actions
2. Suggested checks
3. `System behavior (agent-reported)`
4. Environment
5. Verification and agent-run history

Trusted deterministic results and unverified agent findings must remain
visually and semantically distinct.

## Terminology Changes

| Current | Replacement |
| --- | --- |
| Overview | Workspace |
| CLI | Removed as navigation. `Open workspace` action |
| Set badge | No badge, or quiet `Local` metadata where needed |
| Repository set | Repositories |
| Direct repository set | Chosen repositories |
| Name this repository set | Enter at least one repository |
| Flows | System behavior (agent-reported) |
| Workspace commands | More / Workspace maintenance |

Jira and OpenProject provenance may appear quietly in Configuration. Source
type should not compete with workspace title, readiness, or next action.

## Routes and Compatibility

- Canonical workspace view: `/sessions/:workspaceId`
- Verification: `/sessions/:workspaceId/verification`
- Existing `/sessions/:workspaceId/overview` resolves to Workspace.
- Existing `/sessions/:workspaceId/cli` resolves to Workspace and opens the
  Open workspace launcher.
- Remove CLI from the command palette.
- Add `Open workspace…` as an action in the command palette.

No existing saved link should produce a blank or not-found state.

## States

### Open launcher

- Loading provider setup: retain actions and show checking state.
- Brief saving: launcher is visible. Agent action is disabled with `Saving
  brief…`.
- Brief error: show retry and allow VS Code/open-without-brief where safe.
- Provider unavailable: keep it listed with a concrete setup explanation.
- Launch accepted: close the launcher and announce which application accepted
  the handoff.

### Verification

- No workspace: explain that workspace creation is required and offer the
  shared Review/Create action.
- Loading: retain cached verification when available.
- No checks: show Improve coverage, not an empty technical report.
- Running: keep check state visible and make Cancel discoverable.
- Failed/stale: lead with the decision and relevant rerun action.
- No agent report: keep optional evidence collapsed.

## Component Reuse

- Existing Radix workbench tabs, reduced to two triggers.
- Existing `WorkspaceCliPanel` state and provider launch controls, extracted
  into `WorkspaceOpenSheet`.
- Existing `WorkspaceActionsMenu`, narrowed to maintenance actions.
- Existing `WorkspaceProvisionPanel`, repository table, and plan-details
  disclosure.
- Existing `VerificationPanel` transport/state logic and `CheckRow`.
- Existing dialog/sheet surface, semantic tokens, focus restoration, live
  notices, and provider marks.

## API and Backend

No new backend capability is required.

Preserve these existing trusted boundaries:

- `openWorkspaceCli`
- `openWorkspaceInVscode`
- `writeWorkspaceAgentBrief`
- workspace refresh, graph indexing, revision, and removal
- full, failed-only, and individual verification execution

The serialized `repositorySet` intent remains unchanged. Only its presentation
changes.

## Implementation Phases

### Phase 1 — Terminology and two-destination navigation

- Rename Overview to Workspace.
- Remove all user-visible `Set` / `Repository set` language.
- Reduce workbench navigation and command-palette destinations to Workspace and
  Verification.
- Add legacy `/cli` and `/overview` compatibility tests before changing route
  behavior.

### Phase 2 — Shared header actions and launcher

- Extract provider/terminal controls into `WorkspaceOpenSheet`.
- Add state-aware primary action and Verification result shortcut.
- Keep Review/Create visible from both destinations.
- Reduce More to maintenance actions.

### Phase 3 — Workspace content hierarchy

- Collapse repeated provision/overview headings into Setup, Repositories, and
  Configuration.
- Remove the prominent source badge.
- Keep title, key, readiness, and path as the shared identity.

### Phase 4 — Verification simplification

- Consolidate result and primary verification actions.
- Keep checks immediately visible.
- Move graph operations into Improve coverage.
- Replace nested report tabs with findings-first disclosures.

### Phase 5 — Compatibility, responsive, and live QA

- Validate keyboard/focus behavior for both destinations and the launcher.
- Validate narrow-width header action collapse and launcher layout.
- Confirm legacy URLs, saved plans, and existing workspace actions.
- Perform light/dark live QA.

## Automated Validation

Every implementation phase must include behavior-level tests:

1. Only Workspace and Verification are exposed as workbench destinations.
2. Direct-repository workspaces never render `Set`.
3. Header Review/Create remains available from Verification.
4. Header Open launches the preferred provider and exposes exact alternatives.
5. Prepared verification brief is written before agent launch becomes enabled,
   without tab navigation.
6. Verification status shortcut navigates to the correct workspace URL.
7. Run all, rerun failed, cancel, and individual check requests preserve their
   exact transport contracts.
8. Graph indexing remains available under Improve coverage and refreshes
   evidence afterward.
9. `/overview` and `/cli` legacy routes resolve safely.
10. Copy, refresh, revise, remove, VS Code, and all provider handoffs retain
    their current trusted-boundary assertions.
11. Heading hierarchy contains one page H1 and meaningful section headings.
12. At phone width, primary/header actions and the Open launcher remain inside
    the viewport.

## Out of Scope

- Changing the Rust `repositorySet` intent or stored workspace schema.
- Replacing deterministic Verification with agent judgment.
- Adding a browser terminal or embedded shell.
- Changing provider authentication or permission behavior.
- Redesigning the saved-plan completion and full setup surfaces.

## Open Question

Use a labeled Verification shortcut (`Verification · 3/4 passed`) rather than
an unexplained status-only pill. This is the recommended default. It can be
shortened responsively while retaining the accessible label.
