# Workspace attention and performance

Status: Complete. See [the validation report](REPORT.md).

Goal: Open WTS, see what needs attention, and resume the exact task with one action.

## User outcomes

- The existing board shows completed agent results, failed checks, and unread MR threads for each workspace.
- Each action opens the exact result, check, or thread. Navigation preserves drafts and saved view state.
- Cached items stay visible during refresh. The board shows the last successful check and source failures.
- Read threads and reviewed results leave active attention. History remains available.
- Old responses cannot restore resolved items. A new comment, result, or failed check can need attention again.
- The feedback chat keeps one review entry per result and one retry action for a failed turn.
- The composer remains visible while users scroll through messages. Secondary actions and failure details stay collapsed.

## Delivery

1. Add a bounded attention store and revision-aware history. Reuse the current read markers and source APIs.
2. Add compact actions to workspace cards and source status to the board.
3. Connect actions to the existing transcript, Changes, and Verify views.
4. Measure cold board load, warm workspace navigation, refresh requests, and concurrent requests with 5, 30, and 100 workspaces.
5. Fix measured slow paths. Keep repeatable browser measurements and deterministic request budgets.

## Validation

- Five workspaces contain separate agent, verification, and MR items. Users can identify and open each item from the board.
- Tests cover exact targets, saved drafts, stale responses, partial source failure, offline refresh, read changes, and newer activity.
- Passing a different check cannot clear a prior failed check.
- Performance reports separate fixture timings from native application measurements.
- Tests use isolated data. No real agent requests, GitLab replies, cleanup, or pushes.
- Browser checks cover a long transcript, menu keyboard controls, saved drafts, queue actions, and narrow screens.

## Known source limits

The existing agent list returns pending conversations and the 50 newest completed conversations. The board must state this limit. It cannot claim a complete historical inventory.
