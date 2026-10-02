# Session Jira focus PRD

## Overview

WTS accepts a Jira issue key or a trusted Jira issue URL when a user links a
work item. WTS also shows which linked issue each agent session reports as its
current focus.

Issue focus belongs to a session, not to the workspace. Several sessions in one
workspace can work on different linked issues, the same linked issue, or no
linked issue. Workspace Jira links remain user-owned context. An agent focus
claim is agent-reported context that WTS validates against those links.

This feature extends the compact **Work items panel**, the workspace **Agent
sessions** panel, the global agent-session list, and the existing workspace-card
aggregate. It does not add another workspace tab or summary panel.

## Product decisions

1. Accept a Jira key or a configured Jira issue URL in the same input.
2. Treat a pasted URL only as a key carrier. Do not store or open the pasted
   URL.
3. Resolve the browser URL from the configured Jira integration.
4. Keep confirmed workspace links separate from session focus.
5. Allow one current focus claim per session in the first release.
6. Allow several sessions to claim the same linked issue.
7. Preserve focus transitions in session history.
8. Never infer `Working on` from ordinary agent prose.
9. Do not let a focus claim change the workspace lane, issue role, verification
   state, or Jira state.
10. Sort all managed and observed sessions by their own latest activity time.

## User needs

1. Paste either `PLATFORM-42` or its Jira URL when linking an issue.
2. Link several Jira issues to one workspace.
3. See which issue each active agent session is working on.
4. Distinguish direct work from work that is only related to an issue.
5. See when an agent did not report an issue or cannot report one.
6. Keep concurrent sessions and their issue associations independent.
7. See how many active sessions relate to each linked issue.
8. Keep useful session history after an issue is unlinked.
9. Open Jira only through a URL that WTS derives from trusted configuration.

## User stories

- As a developer, I want to paste a Jira key or URL so that linking is quick.
- As a developer, I want each session to show its current issue so that I can
  understand parallel work.
- As a developer, I want two sessions to use different issues without one
  replacing the other.
- As a developer, I want several sessions to use the same issue when they work
  on separate parts of it.
- As a developer, I want WTS to label agent claims so that I do not confuse them
  with Jira facts.
- As a developer, I want an unlinked claim to remain visible as history without
  remaining actionable.
- As a developer, I want WTS to say when a provider cannot report focus instead
  of guessing.

## Screens and flows

1. **Compact Work items panel** shows linked issues and active-session counts.
2. **Link Jira issue dialog** accepts a key or URL and keeps preview-before-link.
3. **Workspace agent sessions** shows one focus association on every session.
4. **New background task** can start another session and optionally assign an
   initial issue.
5. **Global agent sessions** shows the same per-session association across
   workspaces.
6. **Workspace card aggregate** shows issue and session counts without listing
   every issue.
7. **Unlink confirmation** explains the effect on active session claims.

## Primary flow

```text
User links several Jira issues
        |
        v
WTS publishes canonical linked-issue context for agents
        |
        v
One or more sessions start in the workspace
        |
        v
Each supported session reports working-on, related, or none
        |
        v
WTS binds each claim to that exact session and workspace
        |
        +---- Key is linked ------> Show current focus
        |
        +---- Key was unlinked ---> Show no-longer-linked history
        |
        +---- Invalid claim ------> Reject and show a safe state
        |
        +---- Provider unsupported > Show reporting unavailable
        |
        v
Work items show active-session counts; session rows remain independent
```

## Compact Work items panel

Keep the resting panel full-width and short. Move the link form and issue
preview into a dialog so an add action does not increase the overview height.

```text
Work items · 3 linked                                      [Add Jira] [...]

+ Jira  PLATFORM-42  Primary -------------------------------------+
| Prevent incorrect server classification · In Progress             |
| 2 active sessions                              Open Jira      [...]|
+--------------------------------------------------------------------+

+ Jira  PAY-1842  Related ------------------------------------------+
| Add retry telemetry · In Review                                   |
| 1 active session                               Open Jira      [...]|
+--------------------------------------------------------------------+
```

At wide widths, keep the current responsive card grid. Put the session count in
the existing metadata line. Do not add a new section.

Use the issue overflow menu for unlink. If active sessions claim the issue,
show this confirmation:

```text
Unlink PLATFORM-42?

2 active sessions report this issue.
Unlinking keeps the session history, but the issue will no longer be linked.

                                             [Cancel] [Unlink Jira]
```

## Link Jira issue dialog

Reuse the existing preview and confirmation behavior in a focused dialog.

```text
+ Link a Jira issue --------------------------------------------- [x] +
|                                                                  |
| Jira issue key or URL                                            |
| +--------------------------------------------------------------+ |
| | PLATFORM-42 or https://jira.example/browse/PLATFORM-42   | |
| +--------------------------------------------------------------+ |
|                                                                  |
| Relationship    (*) Primary    ( ) Related      [Preview issue]  |
|                                                                  |
| Jira  PLATFORM-42 · In Progress                                |
| Prevent incorrect server classification                          |
| Bounded issue preview from the configured Jira connection.       |
|                                                                  |
|                                      [Cancel] [Link Jira issue]   |
+------------------------------------------------------------------+
```

Behavior:

1. Accept a trimmed, case-insensitive key.
2. Accept an HTTPS URL from a configured Jira registration.
3. Require the configured base path followed by exactly
   `/browse/<ISSUE-KEY>`.
4. Reject credentials, ports, queries, fragments, encoded path separators,
   extra path segments, and unconfigured hosts.
5. Extract and canonicalize only the key.
6. Discard the pasted URL.
7. Fetch the preview through the selected configured Jira registration.
8. Replace the input with the canonical key after a successful preview.
9. Bind the registration identity, canonical key, role, and snapshot to the
   preview digest.
10. Confirm through the existing idempotent link operation.

Use these messages:

- `Enter a Jira issue key or URL.`
- `Enter a configured Jira URL that ends with /browse/ISSUE-123.`
- `This Jira issue is already linked to the workspace.`

When two configured Jira sites can contain the same key, a URL selects the
exact site. A key uses the configured default site. WTS must include a stable,
non-secret registration ID in identity and uniqueness rules before it supports
duplicate keys across sites.

## Workspace agent sessions

Merge managed and observed sessions into one newest-first list. Show one
session-scoped focus row on every card.

```text
Agent sessions                                  3 active      [Refresh]

+ Codex is working ------------------------------------------ 10:42 +
| VS Code · Edits files                                             |
| Working on  PLATFORM-42  Prevent incorrect classification       |
| Agent reported                                                    |
| Latest update  Updated the server classification checks.          |
+-------------------------------------------------------------------+

+ Codex is working ------------------------------------------ 10:39 +
| WTS background · Runs tests                              [Stop]    |
| Working on  PAY-1842  Add retry telemetry                         |
| Agent reported                                                    |
+-------------------------------------------------------------------+

+ GitHub Copilot is open in VS Code ------------------------- 10:31 +
| Issue reporting unavailable                                       |
+-------------------------------------------------------------------+
```

Association states:

| Condition | Active session | Ended session |
| --- | --- | --- |
| Linked direct claim | `Working on PAY-1842` | `Worked on PAY-1842` |
| Linked related claim | `Related to PAY-1842` | `Related to PAY-1842` |
| Claim is being checked | `Checking reported issue...` | Same |
| Agent reports an unlinked key | `Reported OPS-42 · Not linked` | Same |
| Issue was later unlinked | `PAY-1842 · No longer linked` | Same |
| Supported provider reports none | `No linked issue reported` | `No linked issue was reported` |
| Observation is stale | `Last reported PAY-1842` | Same |
| Claim is invalid | `Issue report was not accepted` | Same |
| Provider has no claim channel | `Issue reporting unavailable` | Same |

Rules:

- A focus claim never replaces the session activity time.
- A later declaration replaces only the current focus for the same session.
- Keep earlier declarations in the session event history.
- Let several sessions claim the same issue.
- Open Jira through the stored linked-item snapshot, never through agent data.
- Show the claim as agent-reported context.
- Do not treat `No report` as proof that the work is unrelated.

## New background task

Allow more than one managed background task in a workspace. Replace global
start and stop state with state keyed by session ID.

```text
+ New background task ----------------------------------------------+
| Work item  [Agent reports the issue v]                             |
|            PLATFORM-42 · Prevent incorrect classification       |
|            PAY-1842 · Add retry telemetry                          |
|                                                                    |
| Task                                                               |
| +----------------------------------------------------------------+ |
| | Add regression coverage for retry telemetry.                   | |
| +----------------------------------------------------------------+ |
|                                     [Run Codex in background]      |
+--------------------------------------------------------------------+
```

The default is **Agent reports the issue**. A selected linked issue is a user
assignment and is authoritative for the session until the user changes it. An
agent claim is testimony and does not override the user assignment. The session
may still report other issues as related in its event history.

## Workspace card aggregate

Do not list each issue on the board card.

```text
Codex is working
Edits files · PLATFORM-42
VS Code session · 3 active · 2 issues
```

Use the newest session ping for board ordering. Derive headline, attention,
active-session count, and linked-issue count as explicit aggregate fields. Do
not combine the headline from one session with the timestamp from another.
Issue focus does not change the lane or pinned position.

## Authority model

### User and WTS authority

- Confirmed workspace Jira links
- Primary or related workspace role
- Optional issue assignment for a WTS-launched session
- Trusted Jira registration and browser origin
- Session and workspace identity

### Agent-reported context

- One current issue key
- `workingOn`, `related`, or explicit `none`
- Optional bounded reason
- Declaration time

### Provider capability

WTS-managed sessions use a structured session-bound reporting channel. WTS
binds the channel to the opaque session ID that it created.

An observed editor session can report focus only when its provider telemetry
contains an explicit structured declaration that WTS can bind to the exact
observed session. WTS must not scan ordinary prose and infer intent. Providers
without this contract show **Issue reporting unavailable**. A later provider
bridge can add the same contract without changing the UI model.

## Data model

Keep workspace links and session focus separate.

```text
AgentSessionWorkItemFocus
  sessionId
  workspaceId
  issueKey
  relationship       workingOn | related | none
  source             userAssigned | agentReported
  reason?
  declaredAtUnixMs
  validity           linked | noLongerLinked | unlinked | invalid
```

The service resolves `issueKey` to the current link and adds canonical display
data. Do not accept an agent-supplied URL or link ID as authority.

For managed sessions, persist current focus with the durable session ledger and
append focus transitions to bounded session history. An optional field keeps
older session records compatible. If full history must survive restarts, use a
separate versioned session-focus event file keyed by workspace and session.

For observed sessions, keep the provider observation and claim source explicit.
Do not persist a transient claim as managed-session authority.

## Agent context and reporting

The managed launch prompt must include confirmed links as bounded metadata:

```text
Linked Jira work items
- PLATFORM-42 · Primary · Prevent incorrect classification
- PAY-1842 · Related · Add retry telemetry

Report one current focus only when the task directly works on or supports a
linked issue. Report none when no linked issue applies. Update the declaration
when the focus changes.
```

Include only key, workspace role, and bounded summary. Do not include the full
Jira description or browser URL in this reporting instruction. Keep Jira keys
found only in planning files in a separate **unconfirmed local hints** section.

The structured declaration contains only:

```json
{
  "schemaVersion": 1,
  "issueKey": "PAY-1842",
  "relationship": "workingOn",
  "reason": "Implements the retry acceptance criteria."
}
```

Reject unknown fields, control characters, invalid keys, unbounded reasons,
wrong workspace or session identity, and claims outside the current workspace.

## Backend and API

1. Add trusted key-or-URL normalization to `wts-integrations`. Match URLs to a
   configured Jira registration before issue lookup.
2. Keep `issueKey` on the first compatible preview request if needed, but define
   it as a reference until the service normalizes it. A later clean schema can
   rename it to `reference`.
3. Keep confirm and open-preview on the canonical key and trusted preview
   digest.
4. Add optional session focus to managed and observed session presentation
   contracts.
5. Add a session-bound focus event to the managed agent adapter and detail
   parser.
6. Validate every claim against the current workspace link list when sessions
   are listed.
7. Add a launch request field for an optional user-selected work-item link.
8. Add a user operation to change or clear a managed session assignment with a
   revision check.
9. Publish updated `.wts/work-items.json` after link or unlink. Keep this file as
   context, not agent write authority.
10. Add HTTP and Tauri contracts for assignment changes and new optional session
    fields.

## Component reuse

- Preserve `work-items.panel`, `work-items.link-form`, and
  `work-items.linked-list` callouts.
- Move the existing link form and preview into `WorkspaceJiraLinkDialog` while
  keeping the stable `work-items.link-form` ID on the dialog content.
- Reuse current Radix dialog, preview, error, focus-return, status, and overflow
  menu patterns.
- Extend `LinkSummary` with an active-session count.
- Reuse `AgentStatePrototype` session cards, but replace global mutation state
  with state keyed by session ID.
- Build one discriminated managed-and-observed session view sorted by last ping.
- Extend the global `AgentSessionsPanel` with the same focus presentation.
- Extend `WorkspaceAgentSnapshot` with aggregate counts, not one arbitrary
  session claim.
- Add stable repeated callouts based on source kind and session ID. Never use a
  render index.

## Edge cases

- A key exists on two configured Jira sites. A URL selects a site. A key uses
  the configured default or requires site selection.
- A linked issue is removed during active work: retain the session claim and
  label it **No longer linked**.
- An agent changes focus: update that session only and append one history event.
- Two sessions report the same issue: show both sessions and one aggregate count.
- A user assignment conflicts with an agent claim: keep the user assignment as
  current and show the agent claim only in history.
- A session ends without a claim: retain the explicit no-report or unavailable
  state.
- A stale or malformed observed session record: fail closed and do not attach an
  issue.
- Jira is unavailable. Keep linked snapshots and focus associations. Disable
  operations that require a fresh remote preview.

## First release

Include:

- key-or-trusted-URL Jira linking
- full-width compact Work items panel with dialog-based linking
- several linked Jira issues per workspace
- several concurrent managed sessions per workspace
- optional user assignment on managed launch
- structured per-session focus for WTS-managed Codex sessions
- per-session current focus and bounded history
- active-session counts on linked issue cards
- unified newest-first session lists
- safe unavailable states for observed providers without structured reporting
- compact workspace-card aggregates

Exclude:

- NLP inference from agent prose
- automatic Jira linking from an agent claim
- automatic Jira status changes, comments, or worklogs
- automatic workspace lane changes from issue focus
- multiple simultaneous primary focuses within one session
- unsupported provider claims without an explicit session-bound protocol

## Validation plan

- Jira parser tests prove that a key and equivalent trusted URL normalize to the
  same site and canonical key.
- Jira parser tests reject HTTP, credentials, ports, queries, fragments,
  traversal, extra paths, and unconfigured hosts.
- Service tests prove the pasted URL is not persisted, returned as the trusted
  browser URL, or sent to the launcher.
- Preview tests prove registration identity and canonical issue data are bound
  to the digest.
- Link tests preserve the existing idempotent retry behavior.
- Managed-session tests prove two concurrent sessions can claim different
  issues and that one update does not change the other.
- Managed-session tests prove two sessions can claim the same issue.
- Restart tests prove managed current focus remains bound to the correct
  session.
- Observer tests prove only explicit structured declarations create claims.
- Tests prove unsupported Copilot sessions show reporting unavailable.
- Unlink tests prove a current claim becomes no-longer-linked without rebinding.
- Invariant tests prove a claim cannot change link role, workspace intent,
  workflow lane, board placement, verification, or Jira state.
- API and client tests prove optional focus fields fail closed on malformed
  payloads.
- UI tests cover the dialog, canonical input, duplicate link, focus states,
  active-session counts, concurrent start and stop, and newest-first sorting.
- Board tests prove aggregate counts do not disturb pinned position or lane.
- Accessibility tests prove dialog focus return, keyboard operation, unique
  repeated callouts, and phone-width layout.

## Open questions

1. Which provider-native event can carry an observed Codex VS Code focus claim
   without displaying protocol text in the conversation?
2. Should a direct key require a site selector as soon as WTS detects more than
   one configured Jira registration?
3. How long should terminal-session focus history remain after session pruning?
4. Should users be able to assign an issue to an already observed editor session,
   or only to WTS-managed sessions?
