# WTS agent workspace design lab

This is an interactive design study. Agent runs, models, reviews, and times are simulated. Workspace names give familiar context. The installed desktop app is unchanged.

Open `http://127.0.0.1:18992/agent-lab.html` while the local demo server runs. To restart it, run these commands from the repository root:

```sh
cd ui
npx vite --host 127.0.0.1 --port 18992
```

## Design choice

Keep the workspace as the main context. Show the task, result, and next action first. Use a compact nested list to inspect the coordinator and its workers. Put questions and failures in a visible queue. Keep detailed action logs one click away.

Three connected views explore this choice:

- **Spaces:** workstreams grouped by Working, Needs you, and Ready to review. pin buttons at the top of each card.
- **Workspace:** agent hierarchy beside the selected task, question, action log, or review diff.
- **Time & capacity:** user activity and separate agent lanes, with total agent work, elapsed time, parallelism, and peak concurrency.

A wall of agent cards is easy to scan with three agents but wastes space with twenty. A node graph can explain complex dependencies but makes routine questions harder to reach. The nested task list is the default recommendation. A dependency graph can be a later detail view.

## Ten research and design passes

These are focused research and design passes, not ten independent user studies.

| Pass | Reference and observation | Decision for WTS |
| --- | --- | --- |
| 1 | [Excited's Dribbble dashboard](https://dribbble.com/shots/27561937-AI-Agent-Management-Dashboard) uses restrained surfaces, compact cards, and small status accents. | Use neutral surfaces and reserve strong color for attention and selected items. |
| 2 | [AgentOps on Dribbble](https://dribbble.com/shots/27664692-AgentOps-Web-Template) explores a dark agent management dashboard. This is visual inspiration, not proof of a working product. | Compare light and dark appearances in the same prototype. Avoid decorative charts without a decision they support. |
| 3 | [Cursor subagents](https://prod.cursor.com/docs/subagents) and [multi-agent work](https://prod.cursor.com/help/ai-features/multi-agent) separate agent contexts and expose parallel work. | Show a worker's role, provider, model, own time, and result within the workspace. |
| 4 | [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) distinguish peer teams from parent-led subagents and offer ways to inspect individual workers. | Preserve parent links. Do not label every concurrent session a subagent. Keep worker selection compact. |
| 5 | [Linear agent interaction](https://linear.app/developers/agent-interaction) defines session states. [Inbox](https://linear.app/docs/inbox) separates attention from routine updates. | Make Needs you actionable. Answering a question clears its attention state in the demo. |
| 6 | [Google Antigravity](https://antigravity.google/blog/introducing-google-antigravity) describes agent management, workspaces, and reviewable artifacts. | Put results and review actions before the detailed action log. |
| 7 | [Langfuse trace guidance](https://langfuse.com/faq/all/what-does-a-good-trace-look-like) connects observations, traces, and sessions. | Use stable execution identity and drill down from a task to its actions. Do not mix a parent aggregate with its own work. |
| 8 | [GitHub Actions visualization](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph) connects job status, dependencies, and logs. | Scope retry and stop actions to the selected execution. Make stopping descendants an explicit choice. |
| 9 | [W3C disclosure guidance](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/) defines an accessible expand/collapse control. | Use native buttons and nested lists. Do not claim a full ARIA tree without its keyboard behavior. |
| 10 | Prototype synthesis and stress checks: six agents, twenty agents, a failed child, an empty workspace, and a 390 px viewport. | Keep filtering, scoped actions, and empty states. Fix page overflow by containing the wide timeline. |

## Try the demo

1. Open the highlighted decision. Use the suggested response, then send the demo response.
2. Select the test coordinator. Expand its browser worker, then inspect its action log.
3. Select the failed-browser scenario. Retry the failed execution.
4. Select the twenty-agent scenario. Search for an agent by task or role.
5. Open Time & capacity. Select a time block to inspect its agent.
6. Open Spaces. Toggle a pin, switch workspaces, and compare light and dark appearances.
7. Open a review diff. Save a simulated comment draft. No GitLab request is made.

## Metrics and production contract

The fixture contains 77 minutes of agent work within 30 elapsed minutes, with a peak of four active agents. These are example values, not measurements from the laptop. Parallelism is 77 / 30, or about 2.6. It does not measure output quality or equivalent human effort.

Production ingestion needs workspace ID, task ID, execution ID, parent execution ID, provider session ID, role, state, timestamps, and a source for each event. Keep independent agents as roots. Preserve retries as separate attempts. Store results and review comments with file and commit references. See [the metrics plan](../multi-agent-metrics-plan.md).

Count unique own-work intervals for each execution. Exclude waiting time. Compute elapsed activity from the union of intervals. Provider usage may already include child usage. record that scope before adding totals. Show missing model, cost, and token data as unavailable. Do not invent values.

Implement in this order:

1. Persist execution identity, parent links, state events, and result references.
2. Read those records into the workspace list and Needs you queue.
3. Connect provider actions to cancellation and retry receipts.
4. Connect review findings to the existing diff viewer and editable GitLab drafts.
5. Compute time and usage from recorded events, with coverage and source labels.

## Validation and limits

The prototype has automated behavior tests for interval accounting, duplicate identity, stop scope, questions, filtering, retry, empty state, pins, review navigation, and workspace isolation. Type checking and a separate production bundle validate the standalone entry point.

Browser checks cover the response flow, desktop and mobile timeline widths, light appearance, and the twenty-agent filter. A mobile timeline overflow defect was found and fixed.

Self-review target for this prototype: usability 8/10, demo functionality 8/10, and appearance 8/10. These are design judgments, not user-study results or a production-readiness score.

Remaining limits: board columns are illustrative snapshots. the attention count follows the selected workspace. comments only show a draft confirmation. activity and model values are fixtures. state resets on reload. No live provider, GitLab, ActivityWatch, or process control is connected. The production metrics engine still needs interval normalization and durable provider events.
