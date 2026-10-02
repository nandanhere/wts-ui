# Workspace Review Loop PRD

## Status

Approved on 2026-08-12. Implementation is in progress.

This PRD supersedes the navigation parts of the existing workspace IA PRDs.
It extends the Human Change Review PRD. It does not replace its code review
requirements.

## Overview

Make each workspace a durable review loop between a person and an agent.

The workspace must show what the agent did, what needs review, what failed,
what needs a user answer, and what happens next. Plans, code changes, and
verification must use one feedback model. Jira links, workflow state, review
feedback, and scheduled summaries must remain valid after an app restart.

## Product Principles

1. Show the first useful item. Do not open a clean repository before a changed
   repository.
2. Keep user-owned planning files as the source of truth.
3. Keep workspace origin separate from Jira links added later.
4. Require user approval before an external Jira write.
5. Show background work, progress, failure details, and the next action.
6. Keep review controls visible while the user moves through content.
7. Store workflow state and feedback in WTS. Do not use browser storage as the
   authority.
8. Use the same feedback behavior for plans, code, and checks.

## User Needs

1. Read and review PLAN.md, FINDINGS.md, KANBAN.md, and related planning files.
2. Add an idea, question, or response at a file or line.
3. Let an agent ask for a decision and receive a durable answer.
4. Link an existing Jira issue after workspace creation.
5. Create a Jira issue from reviewed workspace context.
6. Start Changes on code that has changes and load it quickly.
7. See an agent-suggested review order and open questions.
8. Run deterministic checks automatically after work stops changing.
9. See the active check, output, failure reason, and related discussion.
10. See Ready, Active, Review, and Parked as real workspace states.
11. Open Spaces from the WTS mark and open My time from the Spaces toolbar.
12. Receive periodic work summaries and useful system notifications.

## Target Information Architecture

```text
[WTS]  Workspace · Prevent Senzu…                 [Command] [?] [Settings]

Workspace | Plans & Kanban 2 | Changes 4 | Verification !
```

The WTS mark always opens Spaces. Remove the centered Spaces and Daily review
switch. Rename Daily review to My time. Put My time beside New workspace on
the Spaces screen.

```text
Spaces
[Search] [All workspaces 7]                 [My time] [+ New workspace]

┌ Ready 2 ──────┐ ┌ Active 1 ─────┐ ┌ Review 1 ─────┐ ┌ Parked 0 ─┐
│ workspace     │ │ workspace      │ │ needs review  │ │ Empty     │
└───────────────┘ └────────────────┘ └────────────────┘ └───────────┘
```

Show all four states by default, including useful empty states. A user can
hide empty states in settings. An automatic action cannot unpark a workspace.

## Workspace Card

Use one normal-flow action row. Do not position actions over card content. Do
not repeat an action as passive text and as a button.

```text
┌──────────────────────────────────────────────────────┐
│ Prevent Senzu ServerInfoTask…             34 min ago │
│ JIRA · PLATFORM-42                                │
│ ● Agent finished · Review requested                 │
│ Implemented the ServerInfoTask fix…                 │
├──────────────────────────────────────────────────────┤
│ [Open Jira]                [Open VS Code] [Details]  │
└──────────────────────────────────────────────────────┘
```

The default card click opens Details. Command-click opens the configured
workspace action. Keep this setting in the existing workspace-open preference.

## App-Wide Keyboard Navigation

Use predictable roving focus for repeated items and composite controls.

- Up and Down move within a list or lane.
- Left and Right move between sibling groups or the nearest card in a lane.
- Home and End move to the first and last item in the current group.
- Enter or Space activates the focused control.
- Escape closes the current menu, popover, or dialog and restores focus.
- Command-click and modifier shortcuts keep their documented meaning.
- Do not intercept arrow keys in text inputs, editors, code views, or native
  controls that use them.

Every keyboard move must set an exact target. It must not only move focus away
from the current item. Drag actions must also have an accessible Move menu.

## Plans and Kanban

Add a stable Plans & Kanban workspace tab.

```text
┌ Files ───────────┬ Document ──────────────────┬ Feedback ─────────┐
│ PLAN.md          │ 18 ## Next decisions       │ Agent asks 1      │
│ FINDINGS.md      │ 19 - Define retry rule     │                   │
│ KANBAN.md        │                             │ Your response     │
│ PROGRAM-…md      │                             │ [Write…] [Send]   │
└──────────────────┴─────────────────────────────┴───────────────────┘
```

The first release must:

- Read only the fixed planning files that WTS recognizes.
- Offer rendered Markdown and source views.
- Support safe in-app editing with a revision check. Reject a save if the file
  changed after it was opened.
- Support file-level and line-level feedback threads.
- Mark a line thread as stale when the file digest changes.
- Show agent questions and user answers in the feedback pane.
- Offer Open in editor for other editing workflows.

WTS must not overwrite a planning file when a Jira item is linked. A separate
Insert Jira context action can show an exact patch and ask for confirmation.

## Shared Review Feedback

Use one durable review thread model for all review surfaces.

Targets:

- Planning document: document ID, file digest, and optional line range.
- Code change: repository ID, review digest, path, side, line, or hunk.
- Verification: run ID and check ID.

A thread has a stable ID, author type, body, open or resolved state, created
time, updated time, and revision. SQLite is authoritative. Generate a bounded,
read-only review inbox for agents. An agent can respond, but it cannot resolve
a user thread.

## Changes Review

Open the first repository that has a patch or an untracked file. Do not probe
full diffs one repository at a time.

Add a cheap workspace change summary. It returns repository change counts,
review digests, and status. Load only the selected patch. Load graph context
after the patch is visible. Cache a result by workspace, repository, base,
head, and worktree generation.

Cancel or ignore an obsolete request when the user changes the repository or
workspace. Return a bounded-context patch first. Fetch full unchanged file
context only after the user expands it. Render one file first and virtualize or
defer the remaining files.

Keep the change navigator sticky while the user jumps. Arrow keys must move
between changes. The review brief must show:

- The agent-suggested review order.
- The reason for that order.
- Risks and affected behavior.
- Open agent questions.
- Reviewed and unreviewed files.

CodeRabbit and a full merge-request review screen are deferred. Future
findings must use the shared review thread anchors.

## Jira After Workspace Creation

Do not change the immutable workspace origin. Add mutable linked work items.

### Link an existing issue

1. Select Link work item from Workspace or Plans & Kanban.
2. Enter a Jira key or use a name-scoped search.
3. Show the exact issue title, status, project, and bounded description.
4. Ask the user to confirm the local link.
5. Store the link and refresh WTS-owned agent context.

An issue key found in a planning file is a suggestion. It is not a confirmed
link.

### Create an issue

1. Select Create Jira issue.
2. Build a draft from selected plan text, resolved feedback, and workspace
   summary.
3. Let the user edit project, issue type, summary, and description.
4. Show the exact remote effect.
5. Require explicit confirmation.
6. Create the issue, store the receipt, and link the returned key.

Persist the external operation before the remote call. If the result is
unknown, do not retry automatically. Reconcile the operation before another
create attempt.

## Workflow State

Add a durable workflow state that is separate from workspace materialization:

- Ready: scoped and ready for the next task.
- Active: an agent or user is changing the workspace.
- Review: work, findings, a failed check, or a question needs attention.
- Parked: the user paused the workspace.

Persist a current state and append-only transition events. Use optimistic
revision checks.

Default transitions:

```text
Ready --work starts--> Active
Active --agent completes or asks--> Review
Active --verification fails-------> Review
Review --user accepts review------> Ready
Any non-Parked --user parks-------> Parked
Parked --user resumes-------------> Ready
```

Before parking, show active jobs and sessions. Stop owned work before the state
change. A failed stop keeps the prior state.

## Verification and Agent Findings

Move verification and agent review to observable background jobs.

A run must have a run ID, trigger, input digest, state, current check, elapsed
time, immutable log locations, and a structured failure kind. The UI must show
queued, running, passed, failed, and cancelled states while work continues.

Recommended defaults:

- Run deterministic checks after a managed agent completes and the worktree is
  unchanged for 15 seconds.
- Coalesce duplicate runs for the same input digest.
- Start automatic agent findings for managed WTS agents when Automatic review
  is enabled. Keep this opt-in because it can use network and model capacity.
- For an agent observed in an external editor, show Review ready and offer Run
  agent review unless the user enabled a preferred review agent.
- Keep agent findings labeled Agent reported.
- Never add an agent-proposed check without user approval.
- Suppress automatic jobs while the workspace is Parked.

Let a user add context to a failed check. Examples include an expected local
failure, a missing service, or a known environment limit. Store this as a
verification review thread.

## My Time and Notifications

My time replaces Daily review in the global interface.

Add a persisted summary schedule with:

- Enabled state.
- Interval in hours.
- Quiet period.
- Last successful watermark.
- Bounded summary history.

Recommended default: every four hours while WTS is open, with catch-up after
the next launch. Store sanitized summaries only. Do not store raw window
titles, URLs, prompts, transcripts, terminal output, or file paths.

Send native notifications for:

- Agent needs approval.
- Agent asks a question.
- Review is ready.
- Verification fails.
- A scheduled summary is ready.

Do not notify for every passing check. Add notification settings and a quiet
period. True scheduling while WTS is closed requires a later macOS background
service and is not part of this release.

## Data and API Foundation

Keep the existing workspace record and immutable intent unchanged. Add
additive database migrations for:

- Work item links and external-effect receipts.
- Workflow state and transition events.
- Review threads and comments.
- Jobs, verification runs, and immutable run logs.
- Summary schedules and sanitized summary snapshots.

Add matching HTTP and Tauri contracts. Use enum-addressed planning files. A
planning write must include the expected digest and use atomic replacement.
Reject traversal, symlinks, unknown files, non-UTF-8 content, and oversized
content.

## Delivery Plan

### Phase 0: Contract freeze

- Define shared types, state transitions, error contracts, and migrations.
- Add stable test selectors, request instrumentation, and desktop fixtures.
- Add migration and service contract tests.
- Keep the existing workspace record compatible.

### Phase 1: Visible shell fixes

- Rebuild the card action row.
- Simplify global navigation and add My time beside New workspace.
- Show all workflow states.
- Add the change-summary endpoint and fast initial selection.
- Repair sticky change navigation and keyboard behavior.

### Phase 2: Review foundation

- Add review threads and agent review inbox.
- Add Plans & Kanban read, edit, and feedback.
- Add code comments, agent questions, and review completion.

### Phase 3: Jira lifecycle

- Add link, refresh, and unlink for an existing issue.
- Add preview and approval for Jira creation.
- Add uncertain-outcome recovery and WTS-owned agent context.

### Phase 4: Automatic verification

- Add jobs, live progress, immutable logs, and cancellation.
- Add deterministic automatic checks.
- Add a reviewed local CI/CD preflight for the selected repository revision.
- Use local GitLab Runner when the repository defines a GitLab pipeline.
- Report jobs that require unsupported services, secrets, or runner executors.
- Add optional automatic agent findings.
- Add failure feedback.

### Phase 5: My time and notifications

- Add interval schedules, startup catch-up, summary history, and privacy tests.
- Add native notification permission and preferences.

### Phase 6: Integration and polish

- Run accessibility, responsive layout, keyboard, restart, and performance
  tests.
- Test the complete create, work, review, Jira, park, and resume flows in the
  desktop app.

## Parallel Work After Approval

The root agent owns shared contracts, migrations, integration, and final
validation. After Phase 0, use three subagents in parallel:

1. Board shell, card, global navigation, and workflow state UI.
2. Plans & Kanban, Jira linking, and Jira creation UI.
3. Changes performance, review feedback, and verification progress.

In a later wave, use parallel work for My time, notifications, accessibility,
and end-to-end tests.

## Required Automated Validation

- Card component and responsive layout tests at 320, 768, and 1440 pixels.
- Navigation tests for WTS to Spaces and My time from the Spaces toolbar.
- Exact roving-focus tests for lists, lanes, source cards, tabs, and dialogs.
- Keyboard tests that confirm editors and code views keep their arrow keys.
- Workflow transition, persistence, restart, and park-preflight tests.
- Migration tests from the current database schema.
- Jira preview, approval digest, idempotency, timeout, and reconciliation tests.
- Planning file boundary, revision conflict, atomic save, and stale thread tests.
- Change entry test with one summary request and one selected-diff request.
- Change request cancellation and selected-worktree isolation tests.
- Initial diff payload tests that exclude the review graph and full-file data.
- Sticky navigator mouse and keyboard end-to-end tests.
- Job queue, duplicate coalescing, cancellation, restart, and log boundary tests.
- Verification live-state and failure-feedback UI tests.
- Local CI/CD tests for pipeline discovery, job selection, runner absence,
  command construction, exit status, and sanitized logs.
- Schedule, catch-up, non-overlap, privacy, and notification preference tests.
- Full desktop smoke test for each primary flow.

## Deferred Scope

- CodeRabbit integration.
- A complete merge-request screen.
- Automatic Jira creation without confirmation.
- Automatic rewriting of user planning files.
- Scheduled work while WTS is closed.
- Arbitrary workspace files in the planning editor.

## Approval Defaults

Unless the user changes them, implementation uses these defaults:

1. All four workspace states are always visible.
2. Deterministic checks run automatically after a 15-second quiet period.
3. Automatic agent review is opt-in.
4. My time creates a summary every four hours while WTS is open.
5. Planning files support safe editing and separate review threads.
6. All Jira writes require a final confirmation.
