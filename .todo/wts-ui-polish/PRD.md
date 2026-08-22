# WTS UI Polish PRD

## Overview

Turn WTS into a compact, keyboard-friendly workspace command center. The
resting UI should prioritize the next useful action, preserve user context,
and reveal diagnostics only when requested.

## User Needs

1. Open the current workspace in the preferred agent or VS Code with one action.
2. Understand verification status and run the relevant checks without decoding
   agent-planning terminology.
3. See background refresh, launch, copy, and failure feedback without permanent
   banners consuming the workspace.
4. Return to the same workspace tab after navigation or reload.
5. Review ActivityWatch/Jira evidence separately from live agent activity.
6. Operate all tabs and primary workflows with a keyboard.
7. Use the same information hierarchy and controls in light and dark mode.

## Clusters

The audit findings are clustered by the user outcome they affect:

1. **Action hierarchy** — CLI provider choice, verification ordering, duplicated
   workspace status, and permanent notices.
2. **Navigation continuity** — command palette semantics, URL-addressable tabs,
   refresh caching, and narrow-screen navigation.
3. **Interaction contract** — accessible tabs, live regions, field error
   association, consistent button states, and copy feedback.
4. **Visual system** — shared tokens, dark-mode elevation, minimum metadata
   size, spacing, and responsive density.
5. **Information architecture** — separate Activity review from Agent activity,
   make agent findings optional evidence, and rename diagnostic preferences.

## Primary Flow

```text
Workspaces → Workspace
               ├─ Overview: blockers or compact ready state
               ├─ Verification: result → checks → run → optional evidence
               └─ CLI: Open preferred agent → alternatives / VS Code
```

## Workspace Shell

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Workspaces / FLOW-123  Workspace title      ↻  Open Codex ▾  •••    │
│ branch · graph status                                             │
├──────────────────────────────────────────────────────────────────────┤
│ Overview     Verification     CLI                                    │
├──────────────────────────────────────────────────────────────────────┤
│ One primary task surface; diagnostics are collapsed or contextual.   │
└──────────────────────────────────────────────────────────────────────┘
```

## Verification

```text
┌ Verification ───────────── last run · duration ─── Run all checks ┐
│ Result summary                                                   │
│ Failed and runnable checks                                       │
│ Checks grouped by repository                                     │
│ ▸ Coverage & agent findings (unverified)                          │
└───────────────────────────────────────────────────────────────────┘
```

## CLI

```text
┌ Open this workspace ──────────────────────────────────────────────┐
│ [Open Codex in Warp]  [Open in VS Code]  [Other agents ▾]         │
│ Working directory                                      Copy path  │
│ ▸ Launch details                                                  │
└───────────────────────────────────────────────────────────────────┘
```

## States

- Loading: retain cached content and show a compact refresh indicator.
- Success: announce a transient, auto-dismissing notice.
- Error: show an actionable inline error with retry/dismiss.
- Empty: explain the missing input and provide one primary action.
- Disabled: retain the control and explain why it is unavailable.

## Component Reuse

- Radix Tabs for every tab set.
- React Aria Button for labeled actions.
- Existing Glyph icon set with accessible labels/tooltips for icon-only actions.
- Existing WTS semantic tokens, extended instead of adding literal colors.

## Validation

- Component tests for keyboard tabs, live regions, transient notices, preferred
  CLI launch, URL tab persistence, and split daily-review views.
- CSS/token contract tests for shared control sizing and dark elevation.
- Responsive browser check at 320px and existing 500px coverage.
- Full `npm --prefix ui test` and `npm --prefix ui run build`.

## Out of Scope

- Adding unrelated Blink capabilities such as SEO, email delivery, video, or
  storage to WTS solely because their skills are installed.
- Replacing deterministic verification with agent-generated assertions.
