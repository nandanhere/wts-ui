# Workspace delivery tracking PRD

## Overview

WTS tracks the delivery state of each repository in a workspace after local
work becomes a pushed branch and one or more pull requests or merge requests.
The agent can report a change request as a discovery hint. WTS owns the Git
observation, provider verification, persisted status, safe browser link, and UI
summary.

This feature extends the repository table and the agent-assisted commit flow.
It does not add a new workspace tab or a large summary panel.

## Product decisions

1. Track delivery per repository. A workspace can contain many repositories.
2. Allow many PRs or MRs for one repository and branch.
3. Treat agent-reported URLs and status as unverified hints.
4. Derive local push state from the trusted worktree and tracking ref.
5. Verify PR or MR state with the matching GitHub or GitLab provider.
6. Keep the last verified state when a provider is unavailable and mark it out
   of date.
7. Do not push a branch or create a PR or MR without a separate reviewed user
   action.
8. Do not add another permanent workspace summary section.
9. Prepare one change request at a time. Repository targets, work items, and
   review rules can differ.
10. Let the forge create the change request. WTS prepares and opens a reviewed
    form. It does not claim that opening the form created a request.

## User needs

1. See which repository branches still need a push.
2. See every PR or MR associated with the workspace.
3. Distinguish agent-reported information from WTS-verified information.
4. See review, check, draft, merged, and closed state without opening each forge.
5. Open a PR or MR through a safe link derived from the trusted repository.
6. Keep useful last-known state during network or authentication failures.
7. Understand which delivery event most recently changed the workspace.

## User stories

- As a developer, I want each repository row to show its push and review state.
- As a developer, I want WTS to track several PRs or MRs in one workspace.
- As a developer, I want the agent to report a new PR or MR after it creates one.
- As a developer, I want WTS to verify that report before it shows a trusted link.
- As a developer, I want merged and closed requests to remain available as history.
- As a developer, I want a recent delivery update to move an unpinned workspace card
  to the top without changing its lane.

## Authority model

### Agent-owned hint

The agent can publish:

- repository ID
- branch name
- exact local head commit ID
- PR or MR URL

The agent cannot establish pushed, open, merged, review, or check state. It
cannot supply a browser target that WTS opens directly.

### WTS-owned Git facts

WTS re-inspects the trusted worktree and supplies:

- current branch and head commit
- configured upstream ref
- local and cached upstream commit relationship
- ahead and behind counts
- push observation freshness

An offline observation means that the branch matches the last fetched tracking
ref. Only an explicit refresh can claim current remote state.

### Provider-owned facts

An authenticated GitHub or GitLab adapter supplies:

- PR or MR number and title
- open, draft, merged, closed, or unknown state
- source branch and head commit when the provider exposes them
- review summary
- check summary
- provider update time

WTS validates and bounds all provider text before storage or display.

## Main flow

```text
Agent pushes a repository branch and creates or finds a PR/MR
        |
        v
Agent publishes repository ID, branch, head commit, and URL
        |
        v
WTS validates the hint against trusted repository metadata
        |
        +---- Invalid or stale ----> Ignore hint and show a bounded warning
        |
        v
WTS derives cached push state and refreshes the matching provider
        |
        v
WTS stores a verified delivery observation
        |
        v
Repository row shows the aggregate; card activity time advances
        |
        v
User opens the repository delivery dialog for full history
```

## Workspace repository table

Rename the current **Changes** column to **Work**. Keep the local-change summary
as the first line. Add one compact delivery summary as the second line.

```text
REPOSITORIES — Managed worktrees

Repository       Base          Work                         Verification
checkout-api     main          2 commits ahead              8 checks passed
                               2 PRs · 1 needs review  >

ledger-worker    release/26    Clean                        5 checks passed
                               Pushed · No MR

search-index     main          Clean                        Not run
                               Push pending
```

Selecting the delivery summary opens the repository delivery dialog. Do not
add another section below the repository table.

## Repository delivery dialog

```text
+--------------------------------------------------------------------+
| Change requests for checkout-api                        [Refresh] X |
+--------------------------------------------------------------------+
| feature/retries -> origin/feature/retries                          |
| Pushed · Verified 4 minutes ago                                    |
+--------------------------------------------------------------------+
| PR #184  Prevent duplicate captures                         OPEN   |
| Review requested · Checks 8/9 · Updated 4 minutes ago     [Open]   |
|                                                                    |
| PR #177  Retry metrics                                    MERGED   |
| Merged Aug 10                                             [Open]   |
+--------------------------------------------------------------------+
| Merged or closed (1)                                          [v]  |
+--------------------------------------------------------------------+
```

Rules:

- Use **PR** for GitHub and **MR** for GitLab.
- Sort active requests before terminal requests.
- Sort each group by provider update time, newest first.
- Collapse merged and closed requests when an active request exists.
- Build external links from a re-inspected trusted remote and a validated
  numeric PR or MR identifier.
- Disable the external action while an agent hint is not verified.

## Publish receipt and change-request preparation

Replace an unstructured agent message such as `Pushed successfully` with a
WTS-owned publish receipt. Do not parse terminal prose. Do not open a URL that
the agent supplies.

```text
Agent finishes the repository task
        |
        v
User reviews the changes and creates a commit
        |
        v
User reviews and publishes the branch
        |
        v
WTS verifies remote branch HEAD == reviewed local HEAD
        |
        v
Publish receipt
  checkout-api
  feat/SRETOOLS-7197
  1cd3076
  upstream/feat/SRETOOLS-7197
  Remote matches · Worktree clean

                   [Done] [Prepare merge request]
                                      |
                                      v
WTS prepares a repository-scoped draft from trusted facts
                                      |
                                      v
User reviews target, work items, agent input, title, and description
                                      |
                                      v
WTS revalidates the branch, remote commit, and draft digest
                         +------------+------------+
                         |                         |
                       stale                    current
                         |                         |
                         v                         v
                  Refresh required        [Continue in GitLab]
                                                   |
                                                   v
                              GitLab opens the prefilled form
                                                   |
                                                   v
                                WTS checks for the new request
```

Use **Prepare merge request** or **Prepare pull request** for the first action.
Use **Continue in GitLab** or **Continue in GitHub** for the handoff. Do not use
**Create merge request** because the provider completes that action.

### Publish receipt contract

```text
WorkspaceRepositoryPublishReceipt
  receiptId
  revision
  workspaceId
  repositoryId
  sourceRemoteName
  sourceRemoteHost
  sourceRepositoryPath
  sourceBranchName
  localHeadCommitOid
  remoteHeadCommitOid
  pushedAtUnixMs
  verifiedAtUnixMs
  worktreeClean
  targetRemoteName
  targetRemoteHost
  targetRepositoryPath
  suggestedTargetBranch
  verificationRevision?
  commitReceiptIds[]
```

A receipt is current only when WTS observes the exact remote branch commit. A
cached remote-tracking ref can say **Matches last fetched state**. It cannot say
**Remote matches now**. The source remote and target remote are separate fields
because a fork can publish to one project and merge into another.

### Prepare request and draft contract

```text
PrepareWorkspaceChangeRequest
  workspaceId
  repositoryId
  publishReceiptId
  expectedPublishReceiptRevision
  targetRef?
  selectedWorkItemLinkIds[]
  selectedAgentSessionId?

WorkspaceChangeRequestDraft
  draftId
  revision
  workspaceId
  repositoryId
  forge
  sourceProject
  sourceBranch
  sourceHeadCommitOid
  targetProject
  targetBranch
  title
  body
  selectedWorkItems[]
  agentContribution?
  verificationSummary
  commitReceiptIds[]
  providerOptions
  warnings[]
  effectDigest
```

At browser handoff, WTS must re-inspect the repository identity, branch, local
HEAD, source and target remotes, remote branch HEAD, selected work-item
revisions, verification revision, and existing open request for the same source
and target. A stale check opens nothing.

### Preparation dialog

```text
+------------------------------------------------------------------+
| Prepare merge request · checkout-api                         [x] |
+------------------------------------------------------------------+
| Source       upstream/feat/SRETOOLS-7197 · 1cd3076 · Published  |
| Target       [upstream/main                                  v]  |
|                                                                  |
| Work items                                                       |
| [x] SRETOOLS-7197  Validate PPEC state before admission          |
| [ ] PLATFORM-42  Add PPEC audit telemetry                      |
|                                                                  |
| Agent input  [Codex session · 4 minutes ago                   v] |
|              Agent-proposed content                              |
|                                                                  |
| Title                                                            |
| [SRETOOLS-7197: Validate PPEC state before FixRoutine admission] |
|                                                                  |
| Description                                                      |
| [## Summary                                                   ]  |
| [- Validate PPEC state before admission                       ]  |
| [                                                             ]  |
|                                                                  |
| Options      [ ] Draft     Template [Default v]                  |
+------------------------------------------------------------------+
| WTS opens the form. GitLab creates the merge request.             |
|                              [Cancel] [Continue in GitLab]         |
+------------------------------------------------------------------+
```

Use this default description structure:

```markdown
## Summary

- <bounded agent-proposed summary>

## Changes

- <WTS-derived commit or reviewed-change summary>

## Verification

- `<check>` — Passed

## Work items

- SRETOOLS-7197 — Validate PPEC state before admission
```

The title starts with a selected linked Jira key and summary. If no Jira issue
is selected, use the reviewed commit subject. Mark agent summary and risk text
as agent-proposed. Derive changes from trusted commit receipts. Include only
current WTS verification results and selected, still-linked work-item snapshots.

Several sessions can supply proposals for the same repository. Bind each
proposal to the session, repository, and exact head commit:

```text
AgentChangeRequestProposal
  agentSessionId
  repositoryId
  expectedHeadCommitOid
  reportRevision
  titleSuggestion?
  summaryBullets[]
  riskNotes[]
  suggestedWorkItemLinkIds[]
```

If several valid proposals exist, show a source selector and preselect the most
recent proposal. Do not combine agent prose automatically. A proposal cannot
select an unlinked Jira issue or another repository's publish receipt.

### Provider handoff

WTS builds a private browser target from verified fields. GitHub supports a
compare URL with `quick_pull=1`, `title`, and `body`. GitLab supports a new merge
request URL with source branch, target branch, title, and description fields.
Fork-specific project identifiers require a provider lookup.

For both providers:

- require HTTPS and a trusted forge host
- validate repository paths and branch refs
- encode each form field with a URL library
- reject credentials, ports, fragments, raw query input, and control characters
- do not return or log the generated URL
- cap the encoded URL length
- open a branches-only form and offer **Copy description** when the content is
  too large for a safe URL.

Opening a provider form is not proof that a PR or MR exists. WTS tracks the
request only after the provider returns it or verifies a bounded agent hint.

### Multiple repositories

```text
Repository       Published branch             Change request
checkout-api     feat/SRETOOLS-7197 · Ready    Prepare MR
checkout-web     feat/SRETOOLS-7198 · Ready    MR !418 · Open
ledger-worker    Not published                 Publish branch
```

Each repository row has an independent action. Do not add **Create all MRs**.
Before WTS prepares a draft, check for an existing open request with the same
source project, source branch, target project, and target branch. Show **Open MR
!418** or **Open PR #184** when WTS verifies a match.

### Preparation states

| Condition | Action or state |
| --- | --- |
| Exact remote commit verified | `Published · Ready` |
| Draft is current | `Published · Draft prepared` |
| Head, remote, or selected context changed | `Draft changed · Refresh required` |
| Matching request exists | `MR !418 · Open` or `PR #184 · Draft` |
| Authentication is missing | `Provider sign-in required` |
| Target cannot be resolved | `Target repository is ambiguous` |
| Remote and local commits differ | `Remote branch does not match local HEAD` |
| Branch is local only | `Branch is not published` |
| Forge cannot accept a handoff | `Forge is not supported` |
| Encoded content exceeds the limit | `Prefill is too large · Copy description` |
| Provider form was opened | `GitLab opened · Checking for the merge request` |
| Provider does not find it | `No request found · Check again` |

## Workspace card

Add only an optional aggregate to the existing card footer:

```text
VS Code session · 2 open PRs
```

Omit the aggregate when there is no active request. Keep the whole card as the
navigation target. Do not add nested PR or MR buttons to the card.

A verified delivery observation updates the workspace activity timestamp. This
moves an unpinned card through the newest-first board ordering. It does not move
the workspace to another lane. Agent attention can still trigger the existing
lane-follow behavior.

## UI states

| Condition | Repository row |
| --- | --- |
| Refresh in progress | `Checking...` |
| No upstream | `Local only` |
| Local head is ahead | `Push pending` |
| Cached upstream contains local head | `Pushed · Last fetched state` |
| Provider confirms the branch head | `Pushed · Verified now` |
| Pushed without a request | `Pushed · No PR` or `Pushed · No MR` |
| Active requests | `2 PRs · 1 needs review` |
| Hint awaits verification | `Reported · Verifying` |
| Cached provider state is old | Last summary plus `Out of date` |
| Provider fails with cached state | Keep cached state and mark it out of date |
| Provider fails without cached state | `Status unavailable` and **Retry** |
| Unsupported forge | `Pushed · Tracking unavailable` |
| Terminal requests only | `2 merged` or `1 closed` |

## Agent report contract

Add a bounded optional `changeRequests` list to the existing agent report.

```json
{
  "changeRequests": [
    {
      "repositoryId": "repo_checkout_api",
      "branchName": "feature/payment-retry",
      "headCommitOid": "1111111111111111111111111111111111111111",
      "url": "https://github.com/acme/checkout-api/pull/184"
    }
  ]
}
```

Validation must:

1. Require a repository ID from `.wts/context.json`.
2. Require the current branch and exact head commit.
3. Accept only HTTPS GitHub or GitLab request URLs.
4. Match the normalized host and repository path to a configured trusted remote.
5. Reject user information, ports, queries, fragments, encoded traversal,
   unsupported schemes, and arbitrary hosts.
6. Extract only a bounded numeric PR or MR identifier.
7. Preserve the report label **agent-reported, not verified**.

The report list is a discovery inbox. Replacing the report must not delete
WTS-owned delivery history.

## WTS delivery contract

```text
WorkspaceRepositoryDelivery
  repositoryId
  branchName
  localHeadCommitOid
  upstreamFullRef?
  remoteHeadCommitOid?
  ahead
  behind
  pushState
  pushFreshness
  observedAtUnixMs
  changeRequests[]

WorkspaceChangeRequest
  forge
  host
  repositoryPath
  number
  title
  state
  reviewSummary
  checkSummary
  providerUpdatedAtUnixMs?
  verification
  verifiedAtUnixMs?
```

`pushState` is one of `noUpstream`, `unpushed`, `pushed`, `remoteAhead`,
`diverged`, or `unknown`. `verification` is one of `agentReported`, `verified`,
or `stale`.

Use forge, host, repository path, and request number as request identity. GitLab
request numbers are project-scoped.

## Backend design

1. Extend `AgentReportDocument` in `crates/wts-app/src/evidence.rs` with a
   default empty change-request list and bounded validation.
2. Extend `GitWorktreeService` in `crates/wts-git` with a read-only upstream
   relationship observation after the existing trusted-worktree validation.
3. Add GitHub and GitLab delivery adapters in `crates/wts-integrations`. Use
   bounded requests, explicit authentication state, timeouts, response limits,
   and secret-free errors.
4. Generalize the trusted forge parsing in `crates/wts-app/src/launcher.rs` and
   add a private change-request browser target.
5. Add WTS-owned delivery observation events and a current projection in the
   SQLite store. Persist verified state and history, not agent authority.
6. Add read and explicit refresh service methods, server routes, Tauri commands,
   client types, and strict client normalization.
7. Refresh after a valid agent hint, after an explicit user refresh, and at a
   bounded configured interval. Do not start an authenticated network request on
   every render.
8. Add a private `ChangeRequestDraftTarget` beside `RepositoryBaseTarget`.
   Reconstruct every provider handoff from re-inspected repository facts.
9. Persist publish receipts, accepted session proposals, draft revisions, and
   handoff observations. Keep them separate from replaceable agent reports.

Fork workflows need special handling. Resolve the push remote through configured
Git precedence and accept the provider target only when it matches a configured
trusted remote for the worktree.

## Component reuse

- Extend the repository table in `DraftOverviewPanel`.
- Add `RepositoryDeliveryDialog.tsx` instead of growing
  `LocalWorkspace.tsx` further.
- Reuse the existing dialog, status-dot, tooltip, stale-data, and repository
  notice patterns.
- Extend `WorkspaceCard` with an optional delivery aggregate.
- Add a provider-neutral merge-request glyph only if existing branch and
  external-link glyphs do not communicate the state.
- Add stable callouts for the dialog and repeated repository delivery regions
  according to `docs/ui-callouts.md`.

## First release

Include:

- cached local push-state observation
- bounded agent PR or MR hints
- explicit GitHub and GitLab refresh
- durable verified request state and history
- multiple requests per repository
- repository-row aggregate and compact detail dialog
- optional board-card aggregate
- stale, offline, unsupported, and invalid-hint states
- safe provider link construction
- a reviewed publish receipt after an explicit branch publish
- a reviewed PR or MR preparation dialog and provider-prefilled handoff

Exclude:

- automatic push
- direct or automatic PR or MR creation
- merge, close, approve, or comment actions
- provider webhooks
- automatic lane transitions from delivery state
- a workspace-wide delivery dashboard

## Validation plan

- Git boundary tests cover pushed, unpushed, remote-ahead, diverged, and
  no-upstream states.
- Report CLI tests accept valid GitHub and nested GitLab hints.
- Report CLI tests reject cross-repository, stale-commit, arbitrary-host,
  credential-bearing, and traversal URLs.
- Store tests prove several requests persist for one repository and report
  replacement does not erase history.
- Provider adapter tests bound response size, time, authentication errors, and
  untrusted text.
- Service tests prove only trusted repository identities reach Git and provider
  adapters.
- Launcher tests prove the browser target is reconstructed from trusted fields.
- Server, Tauri, and client tests prove the exact serialized contract.
- UI tests cover aggregates, dialog sorting, refresh, stale cache, errors,
  unsupported forges, several repositories, and several requests.
- Board tests prove a delivery event updates unpinned recency but does not change
  lane or pinned position.
- UI callout contract tests cover the new dialog and repeated delivery regions.
- GitHub and nested GitLab tests verify exact prefilled URL construction.
- Fork tests cover different source and target remotes, including remotes that
  are not named `origin`.
- Encoding tests cover slashes, spaces, `#`, `?`, Unicode, and line breaks.
- Boundary tests reject arbitrary hosts, credentials, ports, traversal, stale
  local HEAD, stale remote HEAD, and raw provider URLs.
- Concurrent-session tests prove that agent proposals cannot overwrite or merge
  into one another.
- Multi-repository tests prove that one draft cannot use another repository's
  receipt, issue, session, or target.
- Existing-request tests prevent a duplicate handoff for the same source and
  target.
- Long-description tests use the branches-only and copy fallback.

## Follow-on releases

1. Add provider webhooks or background polling when WTS has a durable connector
   authentication model.
2. Add explicit authenticated provider actions for reviewers, labels,
   milestones, and projects. Do not hide these mutations in description text.

## Implemented first slice

The first implementation provides a reviewed, same-repository handoff:

- WTS re-inspects the managed worktree and cached tracking ref.
- Preparation requires a clean worktree and an exact local/remote commit match.
- WTS derives the source remote, source branch, target branch, commit subject,
  linked Jira context, and available verification summary.
- The repository row opens an editable preparation dialog.
- WTS re-runs preparation and compares the trusted effect digest before handoff.
- Rust constructs a private, encoded GitLab or GitHub create-form URL.
- Desktop and HTTP transports use strict typed requests and never return the URL.

This slice does not claim fresh network verification. It uses the cached
tracking ref and must say so when that distinction is shown in the repository
status. Fork handoff, persisted publish receipts, agent-session proposals,
provider discovery after submission, and durable MR or PR tracking remain in
the later delivery-tracking work above.

## Agent-driven preparation correction

The workspace Jira list is an allowlist, not the scope of a change request.
WTS must not add every linked issue to every request.

One agent session can propose a change request for one repository and exact
HEAD commit. The proposal contains:

- repository ID
- source HEAD commit ID
- title
- description
- only the linked Jira keys that the agent says the change serves
- an agent-reported verification status and bounded summary

The agent does not supply the authoritative commit or file inventory. WTS reads
the complete inventory from the trusted worktree between the repository base
commit and the proposed HEAD. WTS rejects a proposal when its session belongs
to another workspace, its repository is not present, its HEAD is stale, or one
of its Jira keys is not linked to the workspace.

The preparation dialog must not reuse the workspace-wide verification verdict.
That verdict can cover unrelated repositories or checks. Show the proposal's
verification as **Agent verification** with `passed`, `partial`, `failed`, or
`not reported`. Use `partial` when targeted checks pass but another intended
check cannot complete. This claim remains agent testimony.

Multiple sessions can hold independent proposals in one workspace. Preparing a
request selects the newest proposal whose repository and HEAD match the current
published branch. A proposal update replaces only the proposals from that
session.

```text
Agent session completes and pushes repository work
        |
        v
Agent emits a bounded change-request proposal
  repository + exact HEAD + title + body + relevant Jira keys
        |
        v
WTS attaches the proposal to that session
        |
        v
User selects Prepare MR/PR for the repository
        |
        v
WTS validates session, repository, HEAD, push state, and Jira allowlist
        |
        +---- invalid or stale ----> Explain why the agent proposal cannot be used
        |
        v
WTS adds the complete trusted commit and file inventory
        |
        v
┌──────────────────────────────────────────────────────────────┐
│ Agent proposal · Codex session                               │
│ 3 commits · 12 files · PAY-1842                              │
├──────────────────────────────────────────────────────────────┤
│ Commits                                                      │
│ 1cd3076  Validate PPEC admission                             │
│ …                                                            │
│ Files                                                        │
│ M src/admission.rs                                           │
│ A tests/admission.test.rs                                    │
├──────────────────────────────────────────────────────────────┤
│ Title and description proposed by the agent                  │
│                                              [Continue]       │
└──────────────────────────────────────────────────────────────┘
```

The provider form receives the reviewed agent title and description. The user
can edit both fields. WTS revalidates the proposal and Git state before it
opens the form.
