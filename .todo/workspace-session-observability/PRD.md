# Workspace Session Observability PRD

## Overview

WTS must show every supported agent session for a workspace. Managed runs must
show bounded live activity, model authority, task context, and the final agent
update. Editor sessions must show their provider, surface, model, and current
state without exposing private reasoning or tool arguments.

## User Needs

1. Know which agent sessions exist in a workspace.
2. Distinguish a WTS background run from a VS Code session.
3. See the model and reasoning effort when the provider reports them.
4. See current activity before a managed run finishes.
5. Inspect the submitted task and the final agent update.
6. Stop a WTS-owned run from the same session detail.
7. See Codex and Copilot sessions without inferring them from process names.
8. Know when a provider does not expose reliable session telemetry.
9. Keep hidden reasoning, secrets, tool arguments, and raw command output private.

## User Stories

- As a developer, I want a session list so that I can see all agent work in one workspace.
- As a developer, I want live activity so that I can decide whether a run is healthy.
- As a developer, I want exact model metadata so that I can understand run behavior.
- As a developer, I want the task and final update so that I can review the outcome.
- As a developer, I want clear source labels so that I do not confuse VS Code with a WTS process.
- As a developer, I want honest capability states so that WTS does not invent Copilot activity.

## Screens and Flows

1. **Workspace sessions** lists all managed and detected sessions for one workspace.
2. **Session detail** shows metadata, task context, live activity, and the final update.
3. **New background task** starts a separate managed process after clear disclosure.
4. **My Workspaces roll-up** shows an active-session count and links to session detail.
5. **Global sessions** groups all supported sessions by workspace and source.
6. **Unavailable telemetry** explains why WTS cannot inspect a provider or format.

## ASCII Designs

### Workspace sessions

```text
┌ Sessions in this workspace ──────────────────────────────────────────────┐
│ 2 active · 1 recent                         [New background task]        │
├──────────────────────────────┬────────────────────────────────────────────┤
│ ● Codex · WTS background     │ Codex · WTS background          [Stop]    │
│   Runs a command · 12:44     │ Model     gpt-5.6-sol                      │
│                              │ Effort    Medium                            │
│ ● Codex · VS Code            │ Started   12:40                             │
│   Edits files · 12:43        │                                            │
│                              │ Task                                       │
│ ○ Copilot · VS Code          │ Review the workspace changes.              │
│   Last task finished         │                                            │
│                              │ Activity                                   │
│ Recent                       │ 12:44  Runs a command                       │
│ ○ Codex · Completed          │ 12:43  Updates the plan                     │
│                              │ 12:42  Reviews the task                     │
│                              │                                            │
│                              │ Latest agent update                        │
│                              │ Added the tests and started validation.     │
└──────────────────────────────┴────────────────────────────────────────────┘
```

### New background task

```text
┌ New background task ──────────────────────────────────────────────┐
│ This starts a separate process. It does not continue VS Code.     │
│                                                                   │
│ Provider  [Codex ▾]    Model [Provider default ▾]                 │
│ Effort    [Default ▾]                                             │
│                                                                   │
│ Task                                                              │
│ ┌───────────────────────────────────────────────────────────────┐ │
│ │ Review the current workspace changes.                         │ │
│ └───────────────────────────────────────────────────────────────┘ │
│                                                                   │
│ WTS shows safe activity summaries and agent-authored updates.     │
│ WTS does not show hidden reasoning or raw tool arguments.         │
│                                            [Cancel] [Start task]  │
└───────────────────────────────────────────────────────────────────┘
```

### Telemetry unavailable

```text
┌ Copilot · VS Code ────────────────────────────────────────────────┐
│ WTS found Copilot, but it cannot read this session format.        │
│ Update WTS or open the session in VS Code.                        │
└───────────────────────────────────────────────────────────────────┘
```

## Component Reuse

- Reuse the session rows and status treatment from `AgentSessionsPanel`.
- Replace the isolated `AgentStatePrototype` body with workspace session list and detail regions.
- Keep the workspace-card roll-up compact and link it to workspace sessions.
- Use current WTS tokens, focus rings, button sizes, and responsive breakpoints.
- Keep the existing Stop action for WTS-owned processes only.

## API and Backend

- Keep the durable agent ledger lifecycle-only and transcript-free.
- Add a bounded in-memory detail store for active and recent managed runs.
- Add `AgentSessionDetail` with task, model authority, effort, events, final update, and truncation state.
- Parse Codex JSONL while the process runs.
- Expose only safe event types and summaries.
- Never expose raw reasoning text, tool arguments, environment values, commands, or raw stderr.
- Add a detail endpoint and equivalent Tauri command.
- Parse model and effort from trusted Codex VS Code rollout metadata.
- Add a bounded VS Code chat observer for Copilot session metadata.
- Attribute editor sessions only through a trusted workspace-storage mapping.
- Fail closed on unknown, oversized, malformed, or symlinked session data.

## Event Contract

Managed events use a monotonic sequence and one of these kinds:

- `status`
- `analysis`
- `command`
- `fileChange`
- `tool`
- `search`
- `agentUpdate`
- `result`
- `diagnostic`

Each event contains a timestamp and a bounded summary. An `analysis` event can
say `Codex reviews the task`. It cannot contain private reasoning text.

## Validation

1. A fake Codex process emits delayed JSONL events before it exits.
2. WTS exposes safe events before process completion.
3. WTS never exposes reasoning text, tool arguments, commands, secrets, or raw stderr.
4. WTS reports explicit model selection or `Provider default` without guessing.
5. WTS keeps the durable ledger free of prompt and transcript content.
6. The workspace session list shows all managed and detected sessions.
7. The global session list does not drop detected sessions.
8. Codex rollout metadata supplies the exact model and effort when present.
9. Copilot fixtures map through trusted VS Code workspace storage.
10. Unknown Copilot storage formats report unavailable telemetry.

## Open Questions

- WTS can expose safe progress summaries. It cannot expose hidden chain-of-thought.
- Provider-default model selection is not an exact model name. WTS must label that authority clearly.
- Copilot storage is an internal VS Code contract. WTS must keep its parser versioned and fail closed.
- A future provider bridge can replace local storage parsing without changing the session view model.
