# Workspace attention and performance

Status: Complete.

The Spaces board now shows agent results that need review, failed checks, and unread MR conversations.
Each item opens its saved result, check run, or thread. Opening an item does not mark an agent result as reviewed.
Users can mark a result as reviewed from its card or record a review decision in the result dialog.

## Behavior

Cached items remain visible during a refresh. Source details show the last successful read and any connection error.
A failed source has a retry action. Read threads and reviewed results move to history.
A newer result, failed check, or unread reply can need attention again.

The board uses the existing Changes, Verify, and agent transcript views.
Navigation preserves the selected composer, saved drafts, and queued edits.
Old responses cannot restore resolved items. Passing one check cannot clear a different failed check.
Exact check history remains available when the current plan has no checks.

The feedback chat also has fewer controls after the screenshot review.
Terminal responses retain one review entry and a retry action when needed.
Secondary navigation stays in the review dialog. The provider becomes plain text when the conversation fixes its value.
The current draft does not appear as another saved draft.
The composer stays visible while messages scroll. One Details disclosure holds each failed turn’s diagnostic information.

## Performance

Ten cached workspace returns used 31 API reads instead of 130 in the controlled browser fixture.
The median time to show cached content remained 63 ms. Peak requests fell from 101 to 10 at 100 workspaces.

The board reads saved verification summaries without Git subprocesses.
The Verify view still uses the full evidence path. A saved pass does not prove that current files pass.
Card subscriptions and frame batching prevent each source response from rendering the full board.
The board checks attention every 60 seconds while visible. Explicit refresh bypasses the cache.

[Performance results](PERFORMANCE.md) include baseline measurements, request budgets, conditions, and limits.
[Repeatable checks](../../docs/workspace-attention-performance.md) describe the browser gate.
The PR gate now includes attention and performance browser checks.

## Source and storage limits

- Agent discovery includes active conversations and the 50 newest completed conversations.
- Each refresh reads up to 96 materialized workspaces. Other cards show an unchecked source state.
- The store retains up to 1,024 item records and shows up to 128 history entries.
- Separate review markers retain up to 4,096 explicit review choices and 512 exact session decisions.
- Metadata bounds include 4,096 thread records, 4,096 conversation watermarks, and 8,192 check watermarks.

These limits bound local memory and storage. The saved conversation and verification records remain the authoritative history.
Attention storage does not contain comment bodies, result bodies, or screenshots.

## Validation

| Check | Final result |
| --- | --- |
| Attention data and component boundaries | 42 passed |
| Workspace operations, exact check navigation, and capacity regressions | 56 passed |
| Feedback and result review units | 94 passed |
| Full-app attention browser cases | 4 passed |
| Feedback browser cases | 24 passed |
| Performance browser cases | 4 passed |
| Complete background refresh queues | 3 passed |
| Idle refresh cadence | 1 passed |
| Verification summary boundaries | 31 passed |
| PR gate invocation and failure contracts | 26 passed |
| Source and browser TypeScript | Passed |
| UI production build and native debug build | Passed |
| App, server, and desktop Clippy | Passed with warnings denied |
| Diff whitespace check | Passed |

The full UI run recorded 1,779 passes and three failures before the final fixes.
One failure exposed stale MR discovery after a browser handoff. The handoff now forces a fresh read.
The other two were new exact-check regression cases that ran before their fixes.
The affected suites passed in the 56-test follow-up. The final feedback changes also passed the separate 94-test gate.

Red tests reproduced the previous behavior at component, storage, transport, process, and browser boundaries.
The fixed-composer browser test first placed Send below the viewport after a scroll through earlier messages.
The final cases check physical scrolling, narrow layouts, menu keyboard access, and exact retry identities.

Native screenshot checks confirmed the board and feedback layout in WTS.
The UI changes reached the running native window through Vite updates.
Hashes confirmed unchanged messages in three conversations and unchanged content in three saved drafts.
The same 21 sessions remained, with no active provider session.
No provider requests, GitLab replies, destructive actions, commits, or pushes occurred during validation.

The production build retains notices for chunks above 500 kB.
These measurements cover board reads and cached navigation. They do not measure large diffs, transcripts, or native frame timing.

Prose lint: 0.40 violations per 100 words.
