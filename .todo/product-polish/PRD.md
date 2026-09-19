# WTS product polish

## Goal

Bring WTS to a polished, reliable, and fast daily-use product standard.

Review the whole app. Prioritize workspace navigation, MR and local changes, conversations, agent feedback and its queue, Plans, and error recovery. Improve visual coherence, responsiveness, purposeful motion, complete flows, and dependable agent work. Keep changes local. Do not push.

## Acceptance checks

1. Use consistent surfaces, text sizes, spacing, controls, and focus states. Keep primary actions distinct from secondary actions.
2. Keep text readable in light and dark themes. Support normal desktop windows, narrow windows, and keyboard navigation.
3. Preserve cached content, selected workspaces and files, scroll positions, and unsent drafts. Keep useful content visible during refresh.
4. Measure input response and navigation before and after changes under the same conditions. Report the device, sample count, and network conditions.
5. Use short motion for feedback and state changes. Respect reduced motion. Keep automatic updates from moving actions under a repeated click.
6. Check normal, empty, busy, failed, disconnected, and recovery states. Explain each blocker and supply a valid next action.
7. Keep one agent transcript and queue. Preserve the request target and context. Prevent duplicate sends and unrelated actions.
8. Add a behavior or boundary regression for each fix. Inspect the running app and save comparison screenshots. Separate local tests from live provider checks.
9. Leave WTS running with the verified changes. Keep all existing local work.

## Review coverage

Every row needs a source review and relevant automated checks. Visual rows also need browser inspection. An unavailable external check must name the boundary that remains unverified.

| Flow | Primary checks | Status |
| --- | --- | --- |
| Spaces and workspace navigation | Loading, empty board, selection, refresh, cached return, scroll, keyboard | Source review and automated flow checks complete. See final evidence below. |
| Workspace creation and import | Input retention, source selection, validation, pending work, retry, setup handoff | Source review and automated flow checks complete. See final evidence below. |
| Workspace status and repositories | Long paths, status refresh, local changes, blocked actions, recovery links | Source review and automated flow checks complete. See final evidence below. |
| Changes and MR comparison | File navigation, local work after MR, refresh, selection, diff scroll, editor saves | Source review and automated flow checks complete. See final evidence below. |
| MR conversations | Unread counts, thread navigation, reply drafts, empty and failed reads, agent handoff | Source review and automated flow checks complete. See final evidence below. |
| Agent feedback and queue | Transcript, composer, queued work, retries, cancellation, retained context, reload | Source review and automated flow checks complete. See final evidence below. |
| Plans | Readable Markdown, document navigation, editor drafts, save races, failed reads | Source review and automated flow checks complete. See final evidence below. |
| Verification | Start, progress, cancellation, completion, failures, retained run state | Scope races fixed. 33 focused tests pass. The final HTTP host gate is recorded below. |
| Agent sessions | Activity, results, stale observations, stop, provider setup | Overlapping reads fixed. 19 focused tests pass. |
| My reviews and My time | Empty, partial provider failure, filters, navigation, retained work | Source and existing recovery tests reviewed. Browser review inbox checked. |
| Environment and integrations | Tabs, connection states, setup, failure recovery, theme, keyboard | Account scope and focus return fixed. Theme screenshots captured. |
| Workspace removal | Blocked paths, actionable recovery, focus, overflow, confirmation | Existing recovery routes reviewed. 12 dialog and shell tests pass. |
| Updates, help, and command palette | Opening, closing, focus return, missing capabilities, recovery | Palette, setup, creation, and help focus/motion checks pass. Late update events preserve the completed result. |

## Measurement protocol

Record the current source before edits. Use the same data and browser conditions for each comparison. Measure from the input event to the first useful rendered state. Separate a cached return from a first visit and a completed network request.

Use at least 15 samples for each reported navigation timing. Report the median and p95. Target a useful cached view within 200 ms on this development machine. The target is not a claim about remote provider speed.

Use delayed responses to check that refresh does not replace existing content with a loading screen. Check actual scroll offsets and selected values after navigation. Screenshots alone cannot prove state retention or speed.

Inspect 1440 by 900, 1024 by 768, and 375 by 640 browser windows. Check both themes and reduced motion. Use content with long paths, long messages, multiple repositories, and multiple queued requests.

## Baseline

The baseline contains the complete dirty UI source before this pass. The local snapshot path is recorded in `/tmp/wts-product-polish-baseline-path`. It uses the installed dependencies from this checkout.

The root reviewer started an isolated WTS HTTP host on `127.0.0.1:43217`. It uses temporary repositories and a separate data directory. It does not use the user's saved workspaces.

Native computer-use startup failed during the initial check. Direct Chrome inspection worked through the Services step, then its connection became unavailable. Isolated browser tests remain available. Native window behavior and external accounts need separate evidence.

## Findings

| ID | Evidence | Change and validation |
| --- | --- | --- |
| P01 | A Plans save acknowledgment replaced newer text. Returning before the acknowledgment also retained an old digest. | Preserve later edits and share the save result with the current panel. Deferred-response regressions pass. |
| P02 | Workspace tabs shared one scroll offset. Returning from Spaces lost that offset. | Store scroll by client, workspace, and tab. Browser baseline lost 180px. Current returns restore 180px. |
| P03 | A failed board move refreshed the registry and changed the selected workspace. | Retain a current workspace that remains in the registry. Deferred-response regression passes. |
| P04 | Routine navigation accumulated notices and falsely reported absent setup before its read completed. | Remove successful-read notices. Keep errors and explicit action results. |
| P05 | A pending rename retained its editor in another workspace and could close that workspace's new edit. | Scope the editor and response to the original workspace. Regression passes. |
| P06 | Markdown cleanup removed JSX, generic types, HTML examples, and blank lines inside code. | Clean parsed HTML nodes. Preserve inline and fenced code. Two red cases now pass. |
| P07 | Cached conversation notices disappeared and moved thread controls by 76px. | Place freshness and refresh state in a fixed toolbar. Browser controls remain at 93px before and after the refresh. |
| P08 | Reply did not focus its composer. | Focus only after an explicit Reply action. Preserve focus and drafts during refresh. |
| P09 | Local modified files appeared with an added-file marker. Local diffs repeated each file heading. | Use a truthful Local label and one WTS heading. File selection and real shadow-DOM checks pass. |
| P10 | Feedback repeated states and used large queue action labels. Queue edits and saved drafts had focus gaps. | Keep one transcript. Use compact actions, readable results, and explicit keyboard focus. 60 focused tests pass. |
| P11 | Services claimed success before analysis and repeated an empty result. Port counts included excluded services. | Use state-specific guidance, optional analysis details, and selected-service counts. 25 creation checks pass. |
| P12 | Feedback controls outside the app shell ignored reduced motion. Menus moved their options during animation. | Add shared motion tokens and a global reduced-motion rule. Fade menus at fixed positions. Browser checks pass. |
| P13 | Dialogs used inconsistent motion and some lost focus after Escape. | Fade entry and exit at fixed positions. Restore the opener after close. Six browser motion checks pass, including Help. |
| P14 | At 375px, the title overlapped the tabs by 13.83px. Plans file controls overlapped and compressed the filename. | Give tabs a separate row. Keep file controls at their natural width and separate the filename from actions. Browser geometry passes. The title ends at 84.64px and tabs start at 121.64px. |
| P15 | A slow GitLab check replaced the account for a new workspace or client. | Reject responses from the previous scope. Two scope regressions pass. |
| P16 | Session polling and Refresh could overlap and restore obsolete state. | Share the pending read. Timer and visible-refresh regression passes. |
| P17 | A late graph result or accepted verification proposal changed another workspace's evidence. | Require the original workspace scope for each continuation. Success, failure, and proposal regressions pass. |

## Additional findings

| ID | Evidence | Change and validation |
| --- | --- | --- |
| P18 | Help lost opener focus after close and contained obsolete navigation guidance. | Restore the opener and describe current actions. Guide and Updates share 11 passing tests. |
| P19 | A late native download event replaced a ready update with a progress state. | Accept progress only during the active download. Test the native event boundary. |
| P20 | Imported Jira descriptions displayed a JSON envelope and escaped newlines. | Extract a matching issue description when new planning files are written. Render existing generated descriptions as Markdown in Preview. Preserve Source, Edit, digest, and feedback references. Adapter, filesystem, and preview regressions pass. |
| P21 | Source text used Courier on macOS. | Use the available system code fonts. Chromium reports Menlo for the rendered glyphs. |
| P22 | At 1024px, three header children occupied two grid columns. Controls extended below the 52px header to 76px. | Keep the three columns. The same physical containment assertion passes after the CSS fix. |
| P23 | At 375×640, MR controls consumed the initial viewport and no code was visible. | Remove the single-choice MR selector and compact narrow controls. Exact unread routing remains. Visible code increases from 0 to 93px. Keyboard and horizontal file selection pass. |

## Completion evidence

The final gate results and comparison images are recorded in [the review report](REPORT.md). Supporting source reviews are in [reviews](reviews).

All 1169 UI tests pass across the full run and focused Board retest. All 11 real HTTP flows pass. All 10 full-App visual/interaction scenarios and six motion/focus cases pass across the recorded runs. The final production and native debug builds pass. The app unit tests, Jira adapter tests, strict Clippy, and diff check pass.

The updated native executable is running with the Vite development server. The Vite request returned HTTP 200. The temporary inspection host stopped after the checks. Direct native inspection remains unavailable because the computer-use service cannot start.

The measurements establish cached content retention and fixed controls. They do not prove every return meets the 200ms target or show a general speed increase. Live provider actions remain outside the automated evidence. The review report names each external limit.

