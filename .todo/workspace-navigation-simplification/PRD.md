# Workspace Navigation Simplification PRD

## Overview

Simplify the saved-workspace experience around two genuine destinations:
`Workspace` and `Verification`. Opening an editor or agent becomes a direct
workspace action instead of a third `CLI` destination, and internal source
terminology such as `Set` is replaced with language users can understand.

This change is an information-architecture and interaction redesign. It should
reuse the existing workbench, verification panel, launch adapters, dropdowns,
and setup surfaces. No new backend capability is required.

## Problem

The current workbench exposes three peer tabs:

- `Overview`, which combines provisioning, current workspace state,
  repositories, and plan metadata.
- `Verification`, which is a coherent destination for deterministic checks.
- `CLI`, which is not a view of workspace data. It duplicates the header's
  existing open action and makes launching a tool feel like navigation.

The header also splits common actions across a primary provider button,
Refresh, the `CLI` tab, the Overview provisioning panel, and an `Actions`
overflow menu. Finally, `Set` exposes the internal `repositorySet` intent name
without explaining what it means.

## User Needs

1. Understand what workspace is open, what it contains, and whether it is ready.
2. See the next useful action without searching multiple tabs and menus.
3. Open the workspace in an editor or agent from one predictable place.
4. Run and inspect verification without mixing it with launch configuration.
5. Understand whether a workspace came from Jira, OpenProject, or manually
   selected repositories.
6. Access maintenance and destructive commands without giving them equal weight
   to everyday actions.

## User Stories

- As a developer, I want the workspace header to tell me its identity and
  readiness so that I can decide what to do next.
- As a developer, I want one Open control so that I do not need a dedicated CLI
  tab to launch an editor or agent.
- As a developer, I want setup actions to be prominent only while setup is
  incomplete.
- As a developer, I want Verification to remain a stable destination for checks,
  journeys, evidence, and graph-informed planning.
- As a developer, I want a prepared verification brief to offer an immediate
  agent launch without moving me to another tab.
- As a developer, I want uncommon commands grouped separately so that the main
  interface remains calm.

## Terminology

| Current | Proposed | Reason |
| --- | --- | --- |
| `Set` | `Repositories` | Describes the source in user language. |
| `Overview` | `Workspace` | Names the object being inspected, not a generic dashboard pattern. |
| `CLI` tab | Remove | Opening a tool is an action, not a destination. |
| `Actions` | `More` | Contains uncommon workspace-management commands only. |
| `Open <provider> in <terminal>` | Keep as explicit primary label | The result and destination remain clear. |

For manually created workspaces, supporting text should say
`Created from selected repositories`. Do not use `repository set` outside
developer diagnostics or serialized contracts.

## Navigation Model

```text
My workspaces
    |
    +-- Workspace
    |     +-- readiness / setup decision
    |     +-- repositories and worktrees
    |     +-- plan details
    |
    +-- Verification
          +-- deterministic checks
          +-- user journeys
          +-- evidence / graph
          +-- prepared agent brief

Header actions
    +-- Open <preferred tool>       everyday primary action
    +-- Open with…                  alternate editor/agent action
    +-- Copy path                   everyday utility
    +-- More
          +-- Refresh status
          +-- Create revised copy
          +-- Remove workspace
```

Graph build/re-index belongs inside Verification because it changes
verification evidence. It should not remain a generic header command.

## Screen 1: Workspace View — Ready

```text
┌──────────────────────────────────────────────────────────────────────┐
│ ← My workspaces                                                     │
│                                                                      │
│ flow-review                                             ● Ready       │
│ Created from selected repositories · 5 repositories                 │
│ /Users/…/workspaces/flow-review                                     │
│                                      [Copy path] [Open VS Code ▾] […]│
├──────────────────────────────────────────────────────────────────────┤
│  Workspace     Verification                                         │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Repositories                                             5 worktrees│
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ jellyfish       develop · 12ab34cd       Clean      [Open repo]│  │
│  │ ppec-ui        master  · 34cd56ef       Changed               │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ▸ Plan details                                                     │
└──────────────────────────────────────────────────────────────────────┘
```

### Behavior

- The readiness badge belongs beside the workspace title, not among actions.
- The source description replaces the `SET` badge.
- The primary Open button uses the saved preferred provider.
- The adjacent disclosure opens alternate launch choices.
- `Copy path` remains visible because it is common and reversible.
- The Workspace view leads with current repository/worktree state.

## Screen 2: Workspace View — Needs Setup

```text
┌──────────────────────────────────────────────────────────────────────┐
│ flow-review                                          ● Needs setup    │
│ Created from selected repositories · 5 repositories                 │
├──────────────────────────────────────────────────────────────────────┤
│  Workspace     Verification                                         │
├──────────────────────────────────────────────────────────────────────┤
│  Finish workspace setup                                              │
│  Review the exact branches, paths, and worktrees before creation.   │
│                                                                      │
│  5 repository requests · no worktrees created                       │
│                                           [Review setup →]           │
│                                                                      │
│  Repository requests                                      [Revise]  │
│  ...                                                                 │
└──────────────────────────────────────────────────────────────────────┘
```

### Behavior

- The normal Open action is replaced by the next valid setup action.
- `Review setup` is the only primary action.
- `Revise` sits with repository requests, where the decision has context.
- Verification remains reachable but shows its existing materialization
  prerequisite state.

## Screen 3: Open Workspace Menu

Use a compact popover for quick opening. Do not recreate the large CLI tab.

```text
                               ┌──────────────────────────────────┐
 [Open Codex in Terminal ▾] -->│ Preferred                        │
                               │ [CX] Codex in Terminal     ↵      │
                               ├──────────────────────────────────┤
                               │ Editors                          │
                               │ [VS] VS Code                     │
                               ├──────────────────────────────────┤
                               │ Other agents                     │
                               │ [OC] OpenCode in Terminal         │
                               │ [HM] Hermes in Terminal           │
                               ├──────────────────────────────────┤
                               │ Terminal: macOS Terminal   [Change]│
                               └──────────────────────────────────┘
```

### Behavior

- Clicking the primary half launches the preferred tool immediately.
- Clicking the disclosure opens alternatives.
- Agent authentication/setup status is shown inline when relevant.
- Terminal selection can be changed in this popover or in Environment &
  integrations.
- A launch result uses the existing workspace command status.
  It does not navigate to another view.

## Screen 4: Verification and Agent Handoff

```text
┌──────────────────────────────────────────────────────────────────────┐
│  Workspace     Verification                                         │
├──────────────────────────────────────────────────────────────────────┤
│  Verification status                                 [Run checks]    │
│  12 passed · 1 needs attention                                      │
│                                                                      │
│  Prepared investigation brief                                       │
│  WTS.md is ready · saved at the workspace root                      │
│  [Review brief]                         [Open with Codex →]          │
└──────────────────────────────────────────────────────────────────────┘
```

### Behavior

- Preparing a CLI task no longer changes the active tab.
- The prepared brief remains inside Verification as an output of verification.
- The primary handoff opens the preferred agent. A disclosure offers other
  agents.
- The durable WTS.md path and save/error/retry states remain unchanged.

## Screen 5: More Menu

```text
┌──────────────────────────────┐
│ WORKSPACE MANAGEMENT         │
│ Refresh status              │
│ Create revised copy…        │
├──────────────────────────────┤
│ Remove workspace…           │
└──────────────────────────────┘
```

The menu must not duplicate the primary Open or Copy path actions. Graph
operations move to Verification.

## Board Card Changes

```text
Current:  [SET]  VS Code · flow-review
Proposed: [folder] Repositories · flow-review
          Created from 5 selected repositories
```

Issue-backed cards retain `Jira` or `OpenProject`, because those are recognizable
external sources. The card's main emphasis remains title, lifecycle state,
repository count, and update time.

## States

### Loading

- Retain the last-known workspace content.
- Show a small `Refreshing` indicator beside readiness.
- Disable only commands that conflict with the active operation.

### Launching

- The primary Open button reads `Opening…`.
- Keep the user on the current Workspace or Verification view.
- Report accepted/rejected handoff in the existing command-status region.

### Needs Attention

- Replace the header Open action with the specific recovery action.
- Show the precise branch, drift, or setup blocker in the Workspace view.

### Verification Unavailable

- Keep Verification visible.
- Explain the prerequisite and provide `Review setup` or `Create workspace`.

### Launch Provider Unavailable

- Disable that provider in Open with…
- Show `Not installed` or `Sign-in handled by CLI`.
- Offer Environment & integrations without blocking other providers.

## Component Reuse

- Reuse the existing `Tabs.Root`, but render only Workspace and Verification.
- Reuse `WorkspaceActionsMenu` as the basis for the smaller `More` menu.
- Reuse provider marks, terminal labels, adapter status, and launch functions
  from `WorkspaceCliPanel`.
- Reuse the existing dropdown surface for `Open with…`. Do not introduce a new
  full-screen route.
- Reuse `WorkspaceProvisionPanel`, repository table, plan details, and
  `VerificationPanel`.
- Reuse the existing command-status live region for launch feedback.

## API and Backend

No new API is required.

- Existing editor and agent launch commands remain unchanged.
- Existing provider/terminal detection remains unchanged.
- Existing graph index, verification, revision, refresh, and removal commands
  remain unchanged.
- This is a frontend routing and presentation change around existing trusted
  boundaries.

## Compatibility

- Keep accepting deep links or persisted state using `overview`. Map them to
  `workspace`.
- Keep accepting `agent`/`cli` deep links for one compatibility window. Map
  them to `workspace` and open the launch menu only when doing so is
  non-disruptive. Otherwise show Workspace normally.
- Do not rename serialized `repositorySet` contracts. Translate only at the UI
  boundary.

## Implementation Plan

### Phase 1 — Terminology and two-view navigation

1. Rename the visible `Overview` tab to `Workspace`.
2. Remove the visible `CLI` tab.
3. Translate `Set` to `Repositories` and add the source description.
4. Add compatibility mapping for old tab values and deep links.

### Phase 2 — Consolidated Open action

1. Extract provider/terminal choices from `WorkspaceCliPanel`.
2. Add the split Open control to the workbench header.
3. Preserve explicit labels such as `Open Codex in Terminal`.
4. Keep launch feedback in the command-status region.

### Phase 3 — Action hierarchy

1. Keep Copy path visible.
2. Make setup/recovery the primary action when the workspace is not ready.
3. Move Revise beside repository-plan content.
4. Move graph build/re-index into Verification.
5. Reduce More to refresh, revised copy, and removal.

### Phase 4 — Verification handoff

1. Stop navigating to `agent` after preparing a brief.
2. Render prepared-brief status and launch actions inside Verification.
3. Preserve WTS.md save, error, retry, and provider-unavailable states.

### Phase 5 — Responsive and accessibility validation

1. Ensure the two tabs and header actions fit at 320px.
2. Collapse Open alternatives into the disclosure without hiding the primary
   next action.
3. Validate keyboard navigation, focus return, live status, and disabled
   provider explanations.

## Automated Validation

Every phase must include behavior-level coverage:

- Board/workbench tests assert `Repositories`, never `Set`.
- Navigation tests assert only Workspace and Verification are exposed.
- Compatibility tests map old `overview` and `agent` deep links safely.
- Launch tests assert all providers still call the exact existing trusted
  launch contract without changing tabs.
- Verification tests assert a prepared brief remains in Verification and can
  launch the preferred agent.
- Action tests assert setup, copy path, refresh, revise, graph, and remove are
  reachable from their new locations.
- Responsive Playwright tests assert header, tabs, Open menu, and primary
  actions remain within the viewport at 768px and 320px.

## Success Criteria

- A user can identify the workspace source without seeing `Set`.
- A user can open the preferred editor or agent in one action from either view.
- No launch workflow requires a CLI tab.
- Workspace setup/recovery is the most prominent action when required.
- Verification remains a dedicated, stable destination.
- Common actions are visible. Maintenance/destructive actions remain available
  but visually secondary.

## Open Questions

1. Should the primary Open action always follow the saved preferred provider,
   or should materialized workspaces default to VS Code regardless of the saved
   provider?
2. Should terminal selection remain in the Open popover or live only in
   Environment & integrations?

Recommended defaults: respect the saved preferred provider, and keep a compact
terminal selector in Open with… with full setup details in Environment &
integrations.
