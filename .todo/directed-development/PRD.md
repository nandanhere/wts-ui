# WTS directed development

## Goal

Direct software work through the running product. Use WTS improving WTS as the first complete experience.

A user selects a region, describes an outcome, and continues to work. WTS retains the request and its context. Agents prepare source changes. The user reviews the actual changes, checks, and preview from the same conversation.

## User needs

1. Describe several changes without managing separate chats or waiting for an agent.
2. Keep each request attached to its UI region, review thread, repository, and source version.
3. Know what changed during a task and what the host actually checked.
4. Inspect the result in a working preview and return to the original context.
5. Try alternatives and restore checkpoints without discarding unrelated work.

The shared conversation remains the main interface. Details appear only when the user requests them. New features must preserve the current queue, saved drafts, unread routing, and workspace cache.

## Delivery stages

| Stage | Deliverable | Completion evidence |
| --- | --- | --- |
| 1. Complete one change | A real selected-context request starts or queues, produces source changes, and opens its own result and preview. | Real provider trial in an isolated repository, durable per-turn change evidence, UI/HTTP/native contracts, browser inspection. |
| 2. Review and recover | Host-run checks attach to an exact source state. Checkpoints support conditional restoration and clear conflicts. | Filesystem and process tests preserve earlier drafts, index state, later edits, and restart recovery. |
| 3. Coordinate work | Independent tasks use isolated workspaces. Dependencies and review steps control when work can proceed. | Queue/dependency tests, competing-writer tests, cancellation and recovery, one user conversation. |
| 4. Compare alternatives | Related tasks can prepare separate implementations with comparable previews and evidence. | Isolated branch/worktree effects, explicit selection, checked integration, retained alternatives. |
| 5. Retain decisions | Accepted outcomes, rejected alternatives, and reasons form a source-linked project history. | Durable records, provenance, source-state checks, explicit user decisions, retrieval boundaries. |

This is one active goal. A passing first stage does not complete the later stages.

## First complete flow

Select region → describe change → start or queue → observe work → review result → inspect preview → continue or recover.

```text
+--------------------------------------------------------------+
| Agent feedback                         1 active · 2 queued    |
|                                                              |
| You · Imported description                                   |
| Render the imported issue description as readable Markdown.   |
|                                                              |
| Codex · Finished                                             |
| Explanation of the change and any remaining limits.           |
| [Review changes] [Open live preview] [Return to selection]     |
|                                                              |
| > Changes observed during this task                          |
|   2 files · Verification has not run                         |
|   Original source state → Recorded result                    |
|   [File list and exact patch]                                |
|                                                              |
| Queue                                                        |
| Next · Workspace navigation                  [Edit] [Cancel]  |
|                                                              |
| [Selected context]                             [Saved drafts] |
| [Describe another change                                   ] |
|                                            [Queue request]   |
+--------------------------------------------------------------+
```

The result review belongs to that task. Opening an earlier result cannot change the composer target or replace its draft. The current workspace diff remains a separate action.

## Host-authored evidence

Capture a private source checkpoint immediately before process dispatch. Capture the result before releasing the workspace writer lease. Compare the two states. Pre-existing dirty files form part of the baseline.

Bind each receipt to the conversation, request, session, verified workspace, repository, and source-context digest. Read receipts through a lazy endpoint. Do not attach source contents to every conversation list response.

The host reports observed file changes. Another editor can modify files during a task, so the receipt does not attribute every edit to the agent. The agent's explanation and claimed tests remain separate from host-observed checks.

A bounded exact patch belongs to the recorded task. Opening it must not substitute later cumulative changes. Unsupported files, capture limits, and recovered sessions need explicit states.

## States and recovery

| State | User experience | Next action |
| --- | --- | --- |
| New selection | Context and a saved draft, with no agent side effect | Describe and send |
| Queued | Durable position and target | Edit, cancel, or add work |
| Active | Current process status with retained context | Continue work or stop |
| Finished | Agent reply and separate host evidence | Review changes or preview |
| Partial evidence | Retained result with the exact capture limit | Inspect available files and current workspace |
| Failed process | Cause, retained changes, and original request | Retry or inspect changes |
| Missing old receipt | Explain that this older task has no saved comparison | Inspect current local changes |
| Conflicted restore | Show which paths changed after the checkpoint | Keep later work and inspect the conflict |
| Restart | Restore accepted work and saved records | Continue without resending accepted requests |

## Existing components

Reuse UiCallouts for selection, AgentFeedbackBubble for the transcript and queue, and RepositoryPatchViewer for diffs. Reuse the current workspace navigation and source editor. The host owns source roots and preview URLs.

The frontend is Vite/React. Native Rust changes need a rebuilt executable. Supported UI changes use live reload. Any required restart must retain conversations and drafts.

## Validation and operating limits

Add a behavioral or trusted-boundary regression for every new feature or bug fix. Keep real provider tests opt-in and isolated from user workspaces. Check actual file effects and complete final answers. Test request identity, source scope, failure recovery, and repeated actions.

The current checkout contains earlier local work. Preserve it. Do not push, publish provider comments, or restore user files during validation. Checkpoint tests use temporary repositories. A user restore action must first show the specific files and current conflicts.

A model's final message is not proof that the source or tests are correct. WTS controls execution order, isolation, evidence, checks, checkpoints, and publication permissions.

## Progress

All five stages are implemented and validated. The rebuilt desktop app is running locally. See [Progress](PROGRESS.md) for evidence and limits, and [Work through WTS](GUIDE.md) for the user flow.
