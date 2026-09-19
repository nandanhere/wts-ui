# WTS product review

The review fixes state loss, misleading status text, inaccessible controls, and unreadable imported content. Changes remain local. No pushes occurred.

## Changes

- Workspace returns preserve cached content, scroll, selection, and drafts. Late replies cannot change another workspace. Plans saves retain edits made during the request.
- Conversation refresh retains fixed controls and reply drafts. Replies focus the correct input. Local diffs use accurate file states and one heading.
- Agent feedback keeps one transcript and queue. Retry starts directly. Queue edits and cancellation retain their request context. Compact actions and focus rules improve keyboard use.
- Imported Jira descriptions render as Markdown. The adapter extracts new descriptions. Existing document previews retain the original source, saved digest, and feedback references.
- Creation states explain pending and empty results. Service and port counts include only selected services. Help, updates, settings, and dialogs preserve useful recovery actions.
- Narrow layouts keep titles, tabs, files, and actions separate. Shared fades keep controls fixed. Reduced motion also applies to menus and feedback outside the workspace shell.

The [finding register](PRD.md) links each defect to its behavior or boundary test. An [independent source review](reviews/independent-review.md) found no blocking regression. The [browser audit](reviews/browser-evidence.md) records the geometry and rendering checks. The [navigation review](reviews/navigation-and-recovery.md) and [review surfaces audit](reviews/reviews-feedback-and-plans.md) describe the detailed coverage.

## Comparison images

These images use the same full App and deterministic HTTP fixtures. They do not show live provider responses.

| Surface | Before | After |
| --- | --- | --- |
| Workspace navigation | [Before](evidence/workspace-before.png) | [After](evidence/workspace-after.png) |
| Conversations | [Before](evidence/conversations-before.png) | [After](evidence/conversations-after.png) |
| Agent feedback | [Before](evidence/feedback-before.png) | [After](evidence/feedback-after.png) |
| Narrow Plans | [Before](evidence/narrow-plans-before.png) | [After](evidence/narrow-plans-after.png) |
| Empty Services | [Before](evidence/empty-services-before.png) | [After](evidence/empty-services-after.png) |
| Medium header | [Before](evidence/medium-header-before.png) | [After](evidence/medium-header-after.png) |
| Narrow MR | [Before](evidence/narrow-mr-before.png) | [After](evidence/narrow-mr-after.png) |

Final dark-theme images: [Conversations](evidence/conversations-dark-after.png), [Feedback](evidence/feedback-dark-after.png), and [Plans](evidence/plans-dark-after.png).

## Responsiveness

The machine was an Apple M1 Pro with 10 logical CPUs and 16 GiB memory. The tests used macOS 24.6, Node 22.13.1, and Chromium 149.0.7827.55. The viewport was 1440×900. Before and after phases ran sequentially with other team tests idle.

Each view had 15 cached returns per phase. The fixture delayed each refresh by 1500ms. Every return showed cached content before the refresh finished.

| Cached view | Before median | After median | Before p95 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| Plans | 162.4ms | 160.8ms | 352.5ms | 203.4ms |
| Conversations | 100.6ms | 103.4ms | 287.1ms | 337.5ms |

The measurement starts at pointerdown and ends after a visibility observation plus two animation frames. It includes automation overhead. With 15 samples, nearest-rank p95 equals the observed maximum. These measurements do not show a general speed increase or prove every return meets the 200ms target. The [raw samples](evidence/navigation-timings.json) retain the outliers.

The physical scroll check improves from a lost 180px offset to a restored 180px offset. Cached conversation controls previously moved by 76px. They now stay at 93px before and after refresh. At 375×640, the MR view now shows 93px of code without vertical scrolling. It previously showed no code. The narrow MR pair captures the last layout correction within this pass.

## Validation

The final production build and native debug build pass. Strict Clippy and `git diff --check` pass.

- All 1169 UI tests pass across the full run and a focused Board retest. The full run passed 1167 tests. Two assertions expected the removed single-choice MR selector. After those assertions changed to the exact MR identity, all 45 Board tests passed. The comparison, approval, and lane checks remain.
- All 11 real HTTP end-to-end flows pass. They create temporary repositories and exercise materialization, verification, graph preparation, help/settings, responsive controls, and board actions.
- All 10 full-App visual and interaction scenarios pass across the main run and focused retries. Final layout checks also exercise real diff text and keyboard access.
- All six browser motion and focus cases pass.

The HTTP test now checks the compact risk indicator and the current Verify tab. It retains the code-area, file-navigation, and scrolling checks.

Completed targeted gates include six browser motion/focus cases, 196 app unit tests, 15 Jira adapter tests, and strict Clippy. One existing app test requires an unavailable Go toolchain and remains ignored. Jira preview tests exercise preserved source bytes, saved digests, and feedback line references.

The browser review covers light/dark themes, 1440/1024/375px layouts, keyboard actions, reduced motion, delayed reads, failed reads, drafts, queues, and physical scrolling. Two final scenarios encountered a host pause. Both unchanged cases passed on retry. No timeout was increased. The fixture recorded a 1500ms timer taking 1,038,177ms during that pause.

## Runtime and limits

The native app uses the updated debug executable. The process check found PID 45103 active, and the Vite request returned HTTP 200. The temporary inspection host stopped after the checks. Its Vite server remains available at `http://127.0.0.1:1420`. The restart occurred after a read-only check found no active or queued agent work.

Direct native inspection failed because the computer-use service could not start. Earlier direct Chrome inspection reached Services before that connection also failed. Browser tests and process checks remain separate from native visual evidence.

No live GitLab reply, provider agent turn, Jira request, ActivityWatch action, or external update installation was sent during this review. Deterministic adapter and transport checks cover those boundaries. They do not establish current provider availability.

The production build reports existing large dependency chunks. The browser timings use development modules and do not measure packaged startup. Unknown Jira document formats remain visible as source data. They are not silently discarded.
