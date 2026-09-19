# Contextual agent feedback

## Outcome

A user can select a WTS region or a GitLab review thread and ask an agent to change the related source. The chat remains available while the user continues to use WTS.

## Entry points

| Entry | Context | Agent workspace |
| --- | --- | --- |
| Option or Alt plus click | Region image when available, visible text, UI ID, route, controls | Configured WTS source workspace |
| Ask agent to fix | Full MR conversation, original file position, local repository identity | Existing project workspace |

## Flow

Select a region or thread → inspect the context → describe the change → send → read the result → inspect local changes → send a follow-up.

The bubble shows the selected region or thread in its header. It keeps context separate from messages. The footer contains the message field, provider selector, and send action. Saved chats remain accessible from the bubble header.

## States and recovery

| State | Behavior | Next action |
| --- | --- | --- |
| New selection | Show context without an agent side effect | Enter a request |
| Image unavailable | Preserve text context | Send the request |
| Draft | Keep the text in local storage | Send or discard |
| Active request | Show accepted messages and agent state | Continue to use WTS or stop the agent |
| Uncertain send | Keep the request ID and body | Retry the same request |
| Agent failure | Keep the result and source context | Correct the cause and send a follow-up |
| Restart | Load accepted conversations from disk | Resume a chat |
| Source unavailable | Explain the source setup requirement | Configure the WTS source checkout |

A request cannot silently replace an unsent draft. A response for another conversation or workspace cannot replace the current chat. Review comments remain separate from GitLab replies.

## Existing components

UiCallouts selects a stable semantic region. GitlabDiscussionsPanel and CodeReviewFeedbackPanel expose the review action. AgentFeedbackBubble owns the shared chat surface. The existing Markdown renderer displays agent replies. LocalWorkspace opens the exact repository in Changes without a page reload.

## Durable contract

The host creates, lists, reads, and appends to conversations. Each create or send request has a stable request ID. Repeated requests return the existing result. One conversation permits one active turn. The store preserves complete messages and source artifacts in the local WTS data directory.

The existing agent process adapter executes each turn in the selected worktree. Follow-up turns receive earlier messages and the source context. Original MR positions remain evidence from the published version. The agent reads current files before it edits.

## Live changes

The host chooses the WTS source checkout. A matching workspace preserves existing local edits. The Vite server applies supported frontend changes. Native changes need a new build. Conversation persistence supports that restart.

## Acceptance

Tests must exercise keyboard selection, privacy, image bounds, transport identity, process execution, retries, full output, restart recovery, and workspace navigation. Visual checks cover both themes and a narrow viewport. Live checks must not send provider comments or start an agent that edits user data.
