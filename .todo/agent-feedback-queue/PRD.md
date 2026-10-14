# Agent feedback queue

## Outcome

A user can submit several UI fixes or review requests while an agent is active. WTS keeps each request and its source context. Requests in one workspace run in order. Separate workspaces can run independently.

## User needs

- Submit the next fix without waiting for the current task.
- See active tasks, queued requests, saved drafts, and results.
- Change or cancel a queued request before it starts.
- Switch regions or review threads without losing text or images.
- Continue after navigation, a reload, or a host restart.

## Flow

Select a region or thread → write a request → send → inspect the queue → select another region or thread.

```text
+-----------------------------------------------------------+
| Agent feedback                         1 active · 2 queued |
|                                                           |
| You · Plan description                                    |
| Render this description as Markdown.                      |
|                                                           |
| Codex                                                     |
| The description now shows paragraphs and lists.            |
|                                                           |
| Queue                                                     |
| Next · Workspace title             [Edit] [Cancel]         |
| Then · MR !16 comment              [Edit] [Cancel]         |
|                                                           |
| [Selected context]                          [Saved drafts] |
| [Describe another change                                ] |
|                                              [Send]       |
+-----------------------------------------------------------+
```

One transcript replaces the separate chat list. A context label on each request identifies its UI region or review thread. The queue stays above one composer. A compact saved drafts menu preserves unfinished text without creating separate chat sections.

**Retry** submits a continuation in one click. It uses the failed response's original target and a stable request ID. A busy workspace queues the continuation. An unrelated composer draft remains unchanged. Repeated clicks and reload recovery cannot create duplicate continuations.

## States and recovery

| State | Behavior | Next action |
| --- | --- | --- |
| Draft | Save text and selected context without a send | Edit, send, or discard |
| Submit | Preserve the exact request ID until the host confirms acceptance | Continue to another draft |
| Queued | The host saves the request before acknowledgement | Edit or cancel |
| Active | One agent owns the workspace | Add another request or stop the current task |
| Complete | Keep the result and links to local changes | Inspect the result |
| Failed | Keep the request, error, and agent output | Select Retry to start or queue a continuation |
| Cancelled | Keep a record and exclude the request from execution | Submit a new request if needed |
| Uncertain result | Preserve the operation ID and text | Retry the same operation |
| Edit after start | Reject the change to the active request and retain the edit text | Read the current state |

Unsent drafts never start automatically. Accepted requests start automatically when their workspace is available. A failed request does not retry itself. Stopping the current task does not cancel other queued requests.

## Trusted boundaries

The host owns queue order, workspace ownership, and process dispatch. Each accepted request has a durable identity. An edit checks the queued message body before it changes the request. Cancellation applies only before dispatch. The host checks the current worktree and GitLab account before execution.

Queued messages do not enter an earlier turn's prompt. The next turn receives its complete current input and bounded recent terminal feedback for the same workspace, repository, and provider. Included history retains each request's source context. Omitted older turns are reported explicitly. Process leases still exclude an orphan agent after a host restart.

Local draft storage keeps separate records for each selection. Image storage must not exhaust the text storage budget. A failed image write gives a clear text-only fallback.

## Validation

Tests exercise send acceptance while another turn is active, FIFO dispatch, separate workspaces, duplicate delivery, queued edits, cancellation, and restart recovery. Tests also cover context switching, multiple saved drafts, late responses, and failed storage. Process tests use temporary repositories and fake agent executables.
