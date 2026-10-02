# WTS UI validation — September 29, 2026

The updated web build runs at http://127.0.0.1:18990/time. The server uses a copy of the desktop workspace registry in `/tmp/wts-real/data-real`. ActivityWatch and agent observations use real local data. The first five passes used the web build. The desktop follow-up below uses the installed app.

## Delivered changes

- A persistent shell links Spaces, Agents, My time, and My reviews. Search includes agent sessions. Refresh reaches the active view.
- The dark theme uses Slate surfaces, Inter text, and JetBrains Mono for technical values. The narrow header uses two rows.
- Agent cards show provider, recorded model, workspace, state, work time, recent activity, and logs. Managed sessions support an explicit stop action.
- My time combines user and agent time. Long logs retain earlier work. Interrupted turns end at their last activity. Recorded input pauses do not count as work.
- Weekly summaries read bounded daily windows. Scheduled summaries remain separate from the Today cache. Summary export saves Markdown.
- Feedback opens from the header. Results support thumbs, stars, corrections, and saved lessons. New feedback requests include those lessons.

## Five QA passes

These are self-review scores. The independent reviewer could not start because its provider returned HTTP 429.

| Pass | Usability | Functionality | Aesthetics | Findings and action |
| --- | --- | --- | --- | --- |
| 1 | 7 | 6 | 7 | Added the shell, agent cards, theme, and feedback drawer. |
| 2 | 7 | 5 | 8 | Real logs exposed lost start events and inconsistent agent totals. Added an incremental reader. |
| 3 | 8 | 6 | 8 | Found orphaned turns and a partial summary labeled Today. Fixed both data boundaries. |
| 4 | 8 | 7 | 7 | Added weekly reads, export, and input-pause accounting. Found overlapping header controls at 390 pixels. |
| 5 | 8 | 7 | 8 | Fixed the narrow header and completed the checks below. External publishing and session pause remain incomplete. |

The functionality target of 8 is not met. The five-pass limit ends this iteration.

## Validation evidence

- The broad frontend run covered 198 tests. It passed 196 tests. The two failed expectations concerned the revised summary cache and tooltip text.
- The corrected expectations passed in a focused rerun. The final changed-feature run passed 60 tests.
- All 12 agent-observation tests passed. They cover large logs, partial writes, file replacement, orphaned turns, model metadata, and input pauses.
- TypeScript, Vite, and the Rust server and desktop builds passed. Vite still reports a bundle-size warning.
- The browser layout check passed at widths of 390, 900, and 1440 pixels. Navigation and controls do not overlap.
- Live browser checks covered the working filter, log expansion, feedback open and close, cadence choices, and a summary download.
- The download created `/Users/nandan.herekar/Downloads/wts-time-2026-09-29.md`.

The reproducible layout check is `ui/e2e/wts-shell-layout.mjs`. Test logs and screenshots are in `/tmp/wts-real/` and `/tmp/wts-real/qa-pass3/`.

## Remaining scope

- Export creates a Markdown file. Direct Jira, GitHub, and Slack publishing is not implemented.
- Observed IDE sessions have no pause or stop control through the current adapter. Managed sessions can stop.
- Overlap shows activity windows. Short idle gaps can remain inside those windows. The UI does not infer whether the user prompted an agent.
- Spaces remains the workspace board. My time contains the combined time overview and summary history. My reviews remains the code-review inbox.
- Saved lessons stay in browser storage and apply to new feedback requests. They do not yet apply to every planning or review launch.
- The desktop follow-up replaces the installed application. The browser build remains available for development.

## Desktop follow-up

The old installed app could not read the current workspace registry. A fresh release bundle opens all 16 workspaces from the existing desktop data directory. The previous app is backed up at `/tmp/wts-real/desktop-pass/WTS-before.app`.

Two time-review defects were fixed in this pass:

- The first visit showed no user time although ActivityWatch was connected. Opening My time now reads today automatically when no daily snapshot exists.
- A successful time refresh followed by a Jira failure left the previous interval selected. The selection and update timestamp now follow the time result independently of Jira.

The selection regression test failed before the fix. All 22 time-panel tests and 15 related tests pass. TypeScript and the release UI build pass. The new first-visit test checks the ActivityWatch request starts at local midnight.

Native checks use real data and cover workspace loading, navigation, the working-agent filter, log expansion, Cmd+K, feedback open and close, and Markdown export. The export created `~/Downloads/wts-time-2026-09-29 (1).md`. At 21:35, My time showed 6h 54m of user time and about 4h 59m of agent time. These are a dated observation, not fixed sample values.

Self-review scores remain 8 for usability, 7 for full requested functionality, and 8 for aesthetics. The external publishing and agent-control limits listed above still apply. This pass does not claim that the entire original scope is complete.

Build logs, test results, and desktop screenshots are in `/tmp/wts-real/desktop-pass/`. The release bundle uses local ad-hoc signing. It is a local QA build.

Final desktop receipt: `/Applications/WTS.app` version `0.1.1790698129` matches the built executable SHA-256 `911bd26f107c88c4608c18605e6ff7615ef10268cfc665cd87880aeebd33168f`. Code-signature validation passed. `~/Desktop/WTS.app` links to this installed app. The final app opened all 16 workspaces and restored My time. A native Refresh at 21:43 showed 7h 3m of user time and 5h 7m of agent time. The final screenshot is `/tmp/wts-real/desktop-pass/final-time.jpg`.
