# Workspace agent and subagent metrics

Status: proposed. This document defines the next implementation. It does not change the current build.

## Objective

Show all agents that work in a workspace, including independent agents, coordinators, and nested subagents. Let the user see who is working, what needs input, and which results belong to each task.

## Current boundary

- `AgentSession` and `ObservedAgentSession` in `ui/src/lib/wtsClient.ts` have workspace IDs but no parent execution ID.
- `crates/wts-app/src/agent_observation.rs` accepts Codex records with the VS Code origin and source. Its metadata reader keeps only a string source. Subagent discovery needs a separate adapter path and fixture evidence.
- `hybridTime.ts` already separates summed agent time from the union of agent activity windows. The UI mainly shows the summed value.
- Observations are incomplete evidence. The current in-memory observer retains at most 200 work periods. It cannot serve as the full historical metrics store.

## Identity and adapter contract

Use a versioned, provider-neutral execution contract. Keep provider-specific parsing in adapters.

| Field | Meaning |
| --- | --- |
| executionId | Stable internal ID for one execution attempt |
| sourceIdentity | Provider, local account or installation scope, and provider session ID; no credentials |
| parentExecutionId | Optional direct parent, supported by provider metadata or a recorded launch |
| rootExecutionId | Derived from validated parent links |
| taskId / attemptId | Logical task and its attempt; retries remain separate executions |
| role | Independent agent, coordinator, subagent, or unknown |
| workspaceId / repositoryId / worktree | Work attribution, with its source and effective time |
| provider / model | Actual provider metadata; model changes have timestamps |
| capabilities | Available logs, usage, cost, parent links, stop, and pause controls |
| coverage | Complete, partial, or unknown for each metric and time range |

Use execution segments if an agent changes workspace or task. Attribute each segment once. Inherit workspace context from a verified parent only when the child has no stronger attribution. Keep conflicts and unknown parents visible; do not guess from titles or matching prompts. Reject hierarchy cycles. Handle children that arrive before their parent.

A managed session and a discovered log can describe the same execution. Merge them only with an explicit provider ID or launch receipt. Keep uncertain matches separate and exclude them from a claimed complete aggregate.

## Event and storage boundary

Persist normalized events with execution ID, source event ID, occurrence time, ingestion time, and schema version. Events cover start, state change, delegation, usage, result, and end.

States distinguish own work, waiting for a child, waiting for a user, queued, completed, failed, cancelled, and unknown. A coordinator waiting for children is not idle and is not doing confirmed own work. A parent may also work while children run.

Deduplicate replayed events. Accept out-of-order events and correct derived intervals. Close stale live estimates at a bounded last-signal limit. Keep terminal states stable across restarts. Store the normalized ledger locally so completed children remain visible after provider logs rotate. Keep raw transcripts out of metrics records.

Adapters must state whether an interval or usage counter describes only this execution or includes descendants. Unknown scope stays unknown. Do not add a parent's inclusive counter to the same children's counters.

## Metrics and counting rules

Calculate metrics in one backend service for the workspace header, Agents, My time, and exports. Clip intervals to the selected range before aggregation. Union duplicate or overlapping own-work intervals within each execution, then sum across distinct executions.

| Metric | Rule |
| --- | --- |
| Working now | Count distinct executions doing own work; show waiting coordinators separately |
| Total agent time | Sum confirmed own-work duration across distinct executions, including children |
| Agent elapsed time | Union of all agent work intervals in the workspace |
| Parallelism | Total agent time divided by agent elapsed time; unknown when the denominator is zero |
| Peak concurrency | Maximum number of distinct executions working at once |
| Time together | Intersection of user and agent windows; label approximate when user blocks contain idle gaps |
| Combined active time | User active duration plus total agent time; this is not elapsed time or work quality |
| Task outcomes | Completed, failed, cancelled, and retried tasks; do not count every child as a delivered task |
| Waiting time | Separate waiting for input, waiting for children, and queue time |
| Usage and cost | Provider-reported counters and actual cost when available; unknown is not zero |

Keep separate direct and subtree values for each coordinator. Sum a subtree's executions once, regardless of nesting depth. Workspace totals must not sum overlapping subtree totals. If the parent interval includes unknown delegation wait, show its recorded turn window separately from confirmed own-work time.

Example: three distinct agents each work for 20 minutes at the same time. Total agent time is 60 minutes, elapsed time is 20 minutes, parallelism is 3, and peak concurrency is 3. A coordinator that only waits adds no own-work time. This does not establish a threefold productivity gain.

For cost and token counters, record scope and whether values are cumulative or incremental. Prevent replay and reset errors. Do not infer token usage from log size. Add estimated cost later with a dated price source and an explicit estimate label.

## UI flow

1. Workspace cards show a compact status such as “3 working · 1 needs input”. Open it to inspect this workspace's agents.
2. The workspace Agents view groups independent executions by task. A coordinator expands into its child tree. Each row shows role, provider/model, current action, own time, state, and last signal.
3. The summary shows total agent time, elapsed time, peak concurrency, and task outcomes. Explain parallelism in a tooltip. Show coverage beside partial metrics.
4. My time keeps the user lane and adds collapsible agent lanes under each workspace/task. Expanding a coordinator reveals its children. Selecting a block opens timestamps, logs, task context, and results.
5. Show supported controls only. Distinguish stopping one execution from stopping its descendants. Require an explicit choice for a subtree stop. A missing adapter capability must not produce a dead button.
6. Keep finished children available in history. Separate task results from process status: a clean exit alone does not prove a successful result.

## Delivery sequence

1. **Identity and collection:** add the versioned contract, normalized local ledger, migration, capability flags, and fixtures from supported providers. Preserve existing session responses during migration.
2. **Metrics:** add one aggregation service with hierarchy validation, deduplication, direct/subtree scope, time-range filtering, and coverage. Compare results against the existing single-agent totals.
3. **Workspace UI:** add task groups, expandable children, compact workspace status, detail views, and agent timeline lanes.
4. **Operational metrics:** add outcome receipts, retries, waiting time, and supported usage/cost data. Add controls only after each adapter can enforce their exact scope.

## Acceptance tests

- One agent retains the current supported single-agent totals.
- Three concurrent 20-minute agents produce 60 agent-minutes, 20 elapsed minutes, and peak concurrency 3.
- Nested children and a waiting coordinator do not duplicate duration or inclusive usage.
- A coordinator that works while its children run contributes only its own confirmed work interval.
- Managed and observed records for the same execution count once when identity is proven.
- Duplicate events, out-of-order events, retries, restarts, and rotated logs retain correct totals.
- Orphan children, hierarchy cycles, conflicting workspace attribution, and unknown interval scope produce visible partial coverage.
- Midnight and daylight-saving boundaries clip durations correctly. No denominator produces an infinite ratio.
- Late child results remain accessible when the parent has finished.
- Workspace totals, My time, agent details, and export agree for the same time range and snapshot.
- Native desktop checks use a real workspace with two independent agents and one coordinator with children. Check expansion, logs, keyboard navigation, updates, and history. Do not launch extra paid agents only to populate a screenshot.
