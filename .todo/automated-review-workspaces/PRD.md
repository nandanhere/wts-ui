# Automated review workspaces PRD

## Overview

WTS creates a review workspace directly from an assigned GitLab merge request. The workspace opens the exact change and starts an initial Codex review.

This flow supersedes the generic review-workspace creation flow. A review workspace has one reviewed repository, merge request context, an agent review, and code review tools.

## User needs

1. Start a review without repeating merge request data in a generic workspace wizard.
2. Review the exact source branch against the target branch.
3. See an initial agent review without writing a prompt.
4. Read review notes and inspect code in clearly named views.
5. Select another application after WTS creates the workspace.
6. Recover when repository setup needs a local decision.

## User stories

- As a reviewer, I want one action on an assigned review card so that I can start the review quickly.
- As a reviewer, I want WTS to use only the merge request repository so that unrelated repositories do not enter the review.
- As a reviewer, I want WTS to derive issue context from merge request metadata so that I do not repeat the issue reference.
- As a reviewer, I want Codex to write an initial review into the planning home so that I have a durable review record.
- As a reviewer, I want a code review view so that I can inspect files, discussions, and the patch.
- As a reviewer, I want an Open with action so that I can continue in another supported application.
- As a reviewer, I want a clear setup recovery state so that WTS does not hide a branch or worktree conflict.

## Screens and flows

1. Assigned review card. The primary action creates or opens the review workspace. The secondary action opens the merge request in GitLab.
2. Review setup state. The card shows progress. An inline error stays on the card if WTS cannot prepare or save the review.
3. Review workspace. WTS opens Code review after successful setup. Review context and Agent review remain adjacent views.
4. Setup recovery. WTS opens Review when preflight returns a blocker. The existing trusted setup controls resolve the blocker.

```text
[Assigned review card]
          |
          +-- Open MR ------------------------------> [GitLab]
          |
          +-- Start review
                  |
                  +-- prepare fails ----------------> [Inline retry error]
                  |
                  +-- save plan
                         |
                         +-- preflight blocked -----> [Review: setup decision]
                         |
                         +-- materialize
                                |
                                +-- start Codex ----> [Code review]
                                                       [Agent review updates]
```

## ASCII designs

### Assigned review card

```text
+--------------------------------------------------+
| acme/checkout-api                         MR !17 |
| Review checkout delivery                         |
| bob  feat/review-checkout -> main   3 comments  |
|                                                  |
| [Open MR]                          [Start review] |
+--------------------------------------------------+
```

While WTS creates the workspace, the primary action reads `Starts review...` and is disabled. If an operation fails, the existing inline card error shows the failure and allows a retry.

### Review workspace

```text
+----------------------------------------------------------------+
| Review acme/checkout-api !17       Ready        [Open with...]  |
|                                                                |
| [Review] [Agent review] [Code review]                           |
+----------------------------------------------------------------+
| Code review                                                    |
| checkout-api   feat/review-checkout -> main                     |
|                                                                |
| Files and commits              Patch and discussions            |
| ...                            ...                              |
+----------------------------------------------------------------+
```

`Review` contains merge request identity, status, issue context, and setup recovery. `Agent review` contains durable planning documents and the initial Codex result. `Code review` contains the existing repository review screen.

### Setup recovery

```text
+----------------------------------------------------------------+
| Review acme/checkout-api !17                    Needs attention |
|                                                                |
| [Review] [Agent review]                                         |
+----------------------------------------------------------------+
| WTS needs one repository decision.                              |
|                                                                |
| checkout-api                                                    |
| Requested source: feat/review-checkout                          |
| [Fetch branches] [Select another source]                        |
+----------------------------------------------------------------+
```

## Component reuse

- Reuse `AssignedReviewCard` and its stable `spaces.review.<id>` callout.
- Reuse the workspace registry create, preflight, and materialize client methods.
- Reuse `DraftOverviewPanel` for merge request context and setup recovery.
- Reuse `PlanningDocumentsPanel` as the Agent review record.
- Reuse `RepositoryReviewScreen` as Code review.
- Reuse `WorkspaceActionsMenu` for Open with.
- Do not use `NewWorkspaceDialog` for an assigned review.

## API and backend

The first version needs no new endpoint. The UI composes these trusted operations:

1. `prepareGitlabReviewRepository`
2. `createWorkspace`
3. `preflightWorkspace`
4. `materializeWorkspace`
5. `launchAgentSession`

The create request contains one repository. It selects the merge request source branch and enables the planning home. The agent prompt identifies the merge request, source branch, target branch, and repository.

WTS can detect one exact Jira key in the merge request title or source branch. WTS must use the existing Jira preview and confirmation boundary before it saves a link. A later GitLab contract can include linked issue data and the merge request description.

No billing or recurring job applies to this local desktop flow.

## States

- Empty: The Ready lane has no assigned merge requests.
- Preparing: WTS prepares the reviewed repository.
- Saving: WTS saves one review workspace plan.
- Checking: WTS validates exact local Git effects.
- Blocked: WTS opens Review and shows the trusted setup decision.
- Creating: WTS creates the isolated worktree.
- Reviewing: Codex reads the change and writes the initial review.
- Ready: Code review opens and Agent review shows durable notes.
- Error: The review card shows the operation error and supports retry.

## Open questions

- The GitLab inbox contract does not include a merge request description or linked issues. Add these fields before WTS imports richer issue context.
- A future preference can select the default review agent. The first version uses Codex.
- A future run history can compare agent reviews after new commits arrive.
