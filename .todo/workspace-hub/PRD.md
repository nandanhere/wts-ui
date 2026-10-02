# Workspace Hub PRD

## Overview

The Hub is the understanding layer inside the existing workspace Kanban. It
helps a developer decide where attention is needed before opening the real
workspace to work on the machine.

The Hub combines two kinds of information without confusing their authority:

- WTS-owned facts such as materialization, Git state, verification, and managed
  agent lifecycle.
- Agent-reported understanding such as the current objective, important
  findings, unresolved decisions, and a concise recommendation.

The Hub is not a task manager, code editor, chat transcript, or replacement for
VS Code and Terminal.

## User Needs

1. Understand the state of every active workspace in one place.
2. See which workspace needs a human decision or review.
3. Understand what an agent has learned without reading its transcript.
4. Distinguish trusted machine state from agent interpretation.
5. Open the correct local workspace when implementation work is needed.
6. Keep quiet workspaces compact while making important changes visible.

## User Stories

- As a developer, I want to see which workspace needs me so that I can direct my
  attention quickly.
- As a developer, I want a short agent brief so that I can understand the work
  without reading a long conversation.
- As a developer, I want decisions separated from findings so that I know when
  the agent is blocked on me.
- As a developer, I want verification and Git state to remain WTS-owned so that
  an agent cannot overstate progress.
- As a developer, I want one clear action to open the local workspace so that I
  can continue the real work in my normal tools.

## Product Model

Each existing Kanban workspace card gains a compact Hub brief. WTS determines
the lane, card shell, trusted status, and available actions. The latest valid
agent report may contribute a bounded brief and at most one primary decision
request.

The Hub answers three questions:

1. What is happening?
2. Does this need me?
3. Where should I open the workspace to continue?

## Hub States

| State | Authority | Meaning |
| --- | --- | --- |
| Needs decision | User and agent report | The agent has asked one bounded question that blocks or changes the work. |
| Agent active | WTS process state or local observer | A compatible agent session is connecting, running, or stopping. |
| Ready to review | Agent report plus WTS facts | The agent has published a conclusion or change summary. Trusted verification remains separate. |
| Needs attention | WTS | Git drift, setup failure, failed verification, or another trusted problem exists. |
| Ready | WTS | The workspace can be opened and has no higher-priority state. |
| Parked | User | The user has intentionally removed the workspace from active attention. |

Trusted WTS attention always outranks an agent-reported state. An agent cannot
hide failed verification, Git drift, or setup problems.

## Primary Screen

The current Kanban lanes remain the navigation and sorting model. Hub content
appears inside the cards and expands only when understanding or a decision needs
more room.

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ My workspaces                                              [+ New workspace]│
│ Understand what needs attention, then open the workspace to continue.      │
│                                                                            │
│ [Needs me 2] [Agents active 1] [Ready to review 1] [All 7]    [Search]     │
├────────────────────────────────────────────────────────────────────────────┤
│ NEEDS ME                                                                   │
│                                                                            │
│ PAY-482  Refunds stuck in processing                         Needs decision │
│ Agent understanding                                                         │
│ Provider response 409 may mean the refund was already accepted.            │
│                                                                            │
│ Decision: Should WTS treat an already-accepted refund as success?           │
│                                                 [Review decision] [Open ↗]  │
│ Agent report · 4m ago       Verification: 12 passed       Git: clean        │
├────────────────────────────────────────────────────────────────────────────┤
│ IN PROGRESS                                                                │
│                                                                            │
│ AUTH-91  Intermittent session expiry                         Agent running  │
│ Tracing refresh-token rotation across api and web.                         │
│ Coverage: 2 of 4 flows reviewed                              [Open ↗]       │
│ Managed Codex · 7m          Verification: not run           Git: 1 changed  │
├────────────────────────────────────────────────────────────────────────────┤
│ READY TO REVIEW                                                            │
│                                                                            │
│ WEB-317  Checkout accessibility                               Review ready  │
│ Agent found two keyboard traps and prepared a bounded fix summary.         │
│                                      [Review understanding] [Open ↗]        │
│ Agent report · 12m ago      Verification: 18 passed         Git: 3 changed  │
└────────────────────────────────────────────────────────────────────────────┘
```

## Card Hierarchy

Every expanded card follows the same order:

1. Workspace identity and highest-priority state.
2. One agent-reported understanding sentence when available.
3. One decision or review prompt when available.
4. WTS-owned verification, Git, and agent-process facts.
5. A primary **Open** action that launches the normal local workspace.

The agent does not select arbitrary components or layouts. It supplies bounded
content for known slots. WTS decides whether each slot is safe and relevant to
show.

## What Users See While an Agent Is Working

The default card stays compact. It shows a live state when WTS owns the agent
process or when a compatible read-only observer has current lifecycle evidence.
It may also show the latest bounded understanding the agent intentionally
published. It does not stream chat, chain-of-thought, token counts, or terminal
output.

```text
AUTH-91  Intermittent session expiry                         Agent working  ●
Tracing refresh-token rotation across API and web.

Now: Running verification · 18s
Coverage: 2 of 4 flows reviewed

Managed Codex · active 7m        Git: 3 changed        Verification: running
                                                    [Stop]       [Open ↗]
```

The activity line uses a small fixed vocabulary: **Reading**, **Editing**,
**Running a command**, **Verifying**, **Delegating**, or **Waiting**. It may
include a safe target such as a repository or test suite, but never raw command
arguments or output. The elapsed time describes the observed activity. It is
not a speculative completion estimate.

The card changes in place as the agent moves through the lifecycle:

```text
Connecting -> Working -> Waiting for approval -> Working -> Ready to review
                         |
                         +-> Waiting for decision
                         |
                         +-> Failed / Stopped
```

- **Waiting for approval** brings one approval action to the card and keeps
  **Open** available.
- **Waiting for decision** moves the card to **Needs me** and shows the bounded
  question, not the whole conversation.
- **Ready to review** replaces live activity with the published conclusion and
  current WTS-owned Git and verification facts.
- **Failed** explains the actionable failure in one sentence and offers Retry
  only when retry is safe.
- **Stop** is shown only for a WTS-managed agent. Opening the workspace never
  stops the agent.
- **Reconnecting** replaces **Working** when managed events become stale. If
  recovery fails, the card shows **Connection lost** and the last observed
  event. It warns that the provider may still be working until WTS confirms
  termination.

For a compatible Codex session inside VS Code, WTS can show observed lifecycle
state without requiring an agent publication:

```text
AUTH-91  Intermittent session expiry                    Agent working  ●
Now: Using tools · last event 4s ago

Codex in VS Code · observed locally    Git: 3 changed   Verification: not run
                                                               [Open ↗]
```

The observer can show **Working**, **Idle**, **Completed**, **Interrupted**, or
**Stale** from lifecycle records. It can map tool types to broad activity such
as **Using tools** or **Searching**. It cannot show Stop control because WTS
does not own the process. It must not read prompts, reasoning, tool arguments,
tool output, or assistant text for passive observation.

## Decision Review

```text
┌──────────────────────────────────────────────────────────────────────┐
│ PAY-482 · Decision                                              [×] │
├──────────────────────────────────────────────────────────────────────┤
│ Provider response 409 may mean the refund was already accepted.     │
│                                                                      │
│ Why this matters                                                     │
│ Treating it as a failure leaves the local refund in processing.      │
│                                                                      │
│ Evidence                                                             │
│ payments-api/src/refunds/retry.ts:84                                 │
│ Provider response mapping · agent-reported                           │
│                                                                      │
│ What should happen?                                                  │
│ ( ) Treat an already-accepted refund as success                      │
│ ( ) Preserve the current failure behavior                            │
│ ( ) I need more investigation                                        │
│                                                                      │
│ [Open workspace]                              [Record decision]      │
└──────────────────────────────────────────────────────────────────────┘
```

Recording a decision stores the user's choice as durable workspace context. It
does not edit code or automatically authorize implementation. The next agent
session can read the decision from the bounded workspace context.

## Empty and Degraded States

### No agent understanding

Show trusted workspace facts and the Open action. Do not invent a summary.

```text
OPS-14  Update local development certificates                     Ready
No agent understanding has been published yet.
Verification: not run · Git: clean                         [Open ↗]
```

### Stale agent understanding

Keep the brief visible, label it as stale, and prioritize current WTS facts.
Offer **Refresh understanding** only when an agent can be started safely.

### Agent report failure

Keep the workspace card usable. Show `Understanding unavailable` as secondary
status and retain the Open action.

### Empty Hub

Explain the Hub in one sentence and provide **New workspace** as the only
primary action.

## Agent Contribution Contract

Extend the existing bounded agent report rather than creating a new transcript
or model-owned database. A Hub contribution contains:

- `headline`: one concise understanding sentence.
- `phase`: `investigating`, `blocked`, `conclusionReady`, or `quiet`.
- `decision`: an optional question with two or three bounded choices, rationale,
  and evidence references.
- `reviewSummary`: an optional concise conclusion for human review.
- `coverage`: optional reviewed and total flow counts.

The existing scope, graph digest, repository IDs, flow IDs, findings, evidence,
and next actions remain the source for validation. All content is
agent-reported. WTS verifies schema and scope, not truth.

The provider event stream is not the agent's Hub brief. Events establish live
activity. The agent publishes understanding through a WTS-owned tool such as
`publish_workspace_brief` or through the existing validated report helper.
This keeps raw reasoning and transcripts out of the Hub.

## Provider Observation Feasibility

WTS can observe structured activity through owned transports, supported local
APIs, and version-gated read-only adapters for local session artifacts. It must
not scrape terminal text or private reasoning.

| Provider | Preferred integration | Observable signals |
| --- | --- | --- |
| WTS-managed Codex | `codex app-server` over local JSONL stdio | Thread and turn status, item lifecycle, command and tool activity, file changes, approvals, completion, interruption, and failure. |
| WTS-managed OpenCode | `opencode serve` on an authenticated loopback port plus `/event` SSE | Session status, messages, tool activity, questions, permissions, todo changes, diffs, errors, idle, and completion. |
| WTS-managed Hermes | Authenticated loopback Runs API plus run-event SSE | Run status, tool progress, approvals, token deltas, subagent lifecycle, completion, failure, cancellation, and stop reconciliation. |
| Codex inside VS Code | Read-only tail of Codex rollout JSONL plus extension-process health | Session source and working directory, task start and completion, tool lifecycle categories, interruption, subagents, and last event time. |
| Copilot inside VS Code | Read-only VS Code workspace chat-session metadata | Pending request count, last response state, last message time, pending edits, and session identity. This is a weaker compatibility adapter. |
| Standalone OpenCode | Read-only SQLite event/session adapter when no server is available | Session directory, update time, event sequence, session status, todos, and diff summary. |
| Standalone Hermes | Read-only session and log adapter when no Runs API is available | Best-effort session activity and failure state. Prefer hooks or the supported API when enabled. |

Codex also supports `codex exec --json` for JSONL events, but app-server is the
better Hub integration because it supports persistent threads, streamed events,
approvals, interruption, and status reads. OpenCode and Hermes also expose ACP
servers. ACP is useful as a shared fallback, but their native local server
interfaces provide stronger reconnect and polling behavior for a long-lived
Hub.

WTS normalizes provider-specific events into a small observation contract:

- `connecting`
- `working`, with a bounded activity type such as reading, editing, running a
  command, testing, or delegating
- `waitingForApproval`
- `waitingForDecision`
- `completed`
- `failed`
- `stopping`
- `stopped`

The normalized record includes provider session identity, workspace path, last
observed event time, adapter confidence, and an optional safe activity label.
It does not persist raw reasoning, full command output, token deltas, prompts,
assistant messages, or transcripts.

### Local observer evidence

The local Codex VS Code installation writes append-only rollout JSONL under the
user's Codex data directory. Current records identify `codex_vscode`, the
working directory, task start and completion, tool-call lifecycle, subagent
activity, interruption, and timestamps. The VS Code Codex log also confirms
that the extension launches `codex app-server` over its own standard streams.
WTS cannot attach to those private streams, but it can follow the persisted
lifecycle records.

VS Code also stores workspace-scoped chat-session metadata. Current records
contain `pendingRequests`, `lastResponseState`, `lastMessageDate`,
`hasPendingEdits`, and session IDs. WTS may use these fields as a compatibility
signal for Copilot and other VS Code chat providers. It must not read request or
response content.

OpenCode persists sessions and typed events in a local SQLite database. Hermes
persists sessions and logs. These adapters are useful fallbacks when their
supported local servers are not active.

These artifact formats are not stable public contracts. Each adapter must be
version-gated, read-only, opt-in, and covered by fixture tests. An unknown
schema disables that adapter and shows **Agent observation unavailable**. It
must never guess from an unrecognized record.

### Semantic Hub updates

Observation alone cannot reliably answer what the agent believes is important.
WTS should expose the same local MCP reporting tools to Codex, OpenCode, and
Hermes:

- `publish_workspace_brief`
- `request_workspace_decision`
- `clear_workspace_decision`
- `publish_review_summary`

These tools accept the same bounded workspace IDs, repository IDs, evidence
references, and graph digest used by the agent-report boundary. The provider
can decide when an understanding has changed enough to publish. WTS validates
and renders the result inside the existing Kanban card.

### Publication cost and cadence

An explicit Hub publication is a tool call from the agent's point of view. The
command is local and deterministic and does not call an LLM itself. It normally
adds a tool round-trip to the agent loop. WTS must therefore request updates
only at meaningful transitions.

The protocol separates two update sources:

- Managed provider events and compatible local observers update connection
  state and safe activity automatically. They do not require the agent to call
  `wts` after every tool.
- Semantic changes use a bounded `wts hub publish` command or equivalent MCP
  tool. These include a new understanding, a user decision request, or a review
  summary.

The expected publication points are:

1. After the agent has enough context to state what it is investigating.
2. When its understanding changes materially.
3. When it needs a user decision.
4. When it is ready for review, has failed, or has stopped.

WTS coalesces repeated publications and rate-limits noisy clients. The agent
does not publish heartbeats, token progress, every command, or speculative
completion percentages.

The current `wts-report` helper remains the full structured analysis boundary.
The Hub command is a smaller versioned update boundary. A later full report may
replace or enrich the same card without erasing trusted WTS facts.

Passive observation supplies lifecycle and coarse activity, not semantic
understanding. A compatible IDE session may therefore show `Agent working`
without a publication. The headline remains empty until the agent publishes a
brief or the user explicitly enables a content-reading integration. Managed
agents combine the same semantic publication with their owned live state.

## Agent Connection Modes

The Hub must label how each state was obtained.

### Managed

WTS launched the provider and owns its structured transport. The card may show
live activity, waiting states, stop control, and the last provider event.

### Locally observed

The user works with a compatible agent inside VS Code or another local client.
WTS follows allowlisted lifecycle metadata from that provider's local session
artifacts. The card may show live activity with an **Observed locally** label,
but it does not offer process control.

### Protocol connected

The agent has read the WTS protocol and completed a valid handshake or
publication. It can publish Hub briefs or decisions through the WTS helper or
MCP tools. Protocol connection adds semantic understanding. It is independent
of whether WTS can observe the agent lifecycle.

### Workspace observed

No agent has connected to WTS. The card shows only trusted filesystem, Git,
verification, and workspace facts. It may say `Agent state unavailable`.

Opening VS Code alone is not an activity signal. A current allowlisted session
record matched to the workspace is sufficient for **Locally observed**. A
valid protocol handshake or publication is required for **Protocol connected**.

## WTS Protocol Evolution

`WTS.md` is the human-readable entry point for agents. New WTS releases must be
able to update it without losing the current user-reviewed objective.

The durable design separates source data from its generated projection:

```text
WTS-owned structured state
    +-- workspace identity and repository boundary
    +-- current user-reviewed objective
    +-- protocol version and capabilities
    +-- reporting endpoint metadata
               |
               v
          generate atomically
               |
               +-- WTS.md
               +-- .wts/protocol.json
```

### `WTS.md`

The generated file starts with a stable bootstrap section:

```text
WTS protocol: 2.1
Workspace: <opaque workspace id>

1. Read `.wts/protocol.json` for the machine-readable contract.
2. Use only capabilities listed by that document.
3. Publish understanding through the advertised helper or MCP tools.
4. Do not treat an unsupported capability as available.
```

It then contains the current objective, repository boundary, evidence rules,
and provider-neutral reporting instructions. It must not contain provider-only
commands in the shared protocol section.

### `.wts/protocol.json`

The machine-readable contract contains:

- `protocolVersion`, with independently comparable major and minor numbers
- `generatedByVersion`
- `workspaceId`
- `capabilities`
- bounded helper commands and local MCP discovery metadata
- paths to the current context, graph manifest, verification plan, and report
  schema
- the digest of the generated `WTS.md`

An unknown major version is incompatible. An agent may use capabilities from a
known major version and ignore unknown optional fields from a newer minor
version.

### Upgrade behavior

- WTS checks the protocol when materializing, reconciling, or opening a
  workspace.
- WTS stores the user-reviewed objective separately from generated Markdown.
- WTS atomically regenerates `WTS.md` and `.wts/protocol.json` from structured
  state when the bundled protocol is newer.
- The materialization receipt records the generated digest. If `WTS.md` no
  longer matches that digest, WTS does not overwrite it silently. The Hub shows
  **Protocol update available** and offers a reviewed regeneration action.
- Legacy workspaces without a version are treated as protocol version 1 and can
  be upgraded without changing repository worktrees.

### Release-to-agent exchange

Each WTS application release bundles:

- the current protocol version
- the oldest compatible protocol version
- generated `WTS.md` and `AGENTS.md` templates
- machine-readable schemas
- explicit migrations from older structured workspace state

When the new application opens, it compares each workspace's active protocol
generation with the bundled version. It does not need to rewrite repository
worktrees.

```text
new WTS application starts
          |
          v
read workspace protocol version and generated digests
          |
          +-- current ----------------------------> no change
          |
          +-- older + inactive + WTS-owned ------> migrate atomically
          |
          +-- older + active agent --------------> mark update pending
          |
          +-- generated file modified -----------> request user review
```

The migration renders a complete candidate generation before changing the
active files. WTS validates the candidate, stores the previous generation for
recovery, writes temporary files, and commits the new protocol document last as
the generation marker. Startup reconciliation completes or rolls back an
interrupted migration. An incomplete mixture of versions is never advertised
to an agent as current.

### Active session pinning

Each managed or cooperative session records the protocol generation it first
used. WTS does not replace that generation while the session is active.

- Existing sessions continue using their pinned capabilities.
- The Hub shows **Protocol update pending** when a newer generation is ready.
- A new session starts on the latest active generation.
- A user may explicitly ask an active cooperative agent to refresh, but WTS
  never assumes that it reread the files.

### Capability negotiation

Agents should depend on advertised capabilities rather than comparing WTS
application versions.

```text
agent reads root AGENTS.md
       |
       v
agent reads WTS.md and .wts/protocol.json
       |
       v
agent calls `wts protocol hello` or the equivalent MCP tool
       |
       +-- compatible -> session is bound to this generation
       |
       +-- incompatible -> WTS returns supported versions and no write access
```

The handshake returns the workspace ID, active generation ID, protocol version,
and currently available capabilities. It does not return secrets or filesystem
authority beyond the existing workspace context.

Every Hub publication includes the workspace ID, generation ID, and protocol
version. WTS rejects a publication from another workspace or an incompatible
generation. A compatible older generation may remain accepted for a bounded
grace period so an active session can finish honestly.

### Version policy

- Patch changes correct wording or validation without changing capability
  meaning. WTS may apply them automatically to inactive, unmodified workspaces.
- Minor changes add optional capabilities or fields. Older agents can continue
  using the capabilities they understand.
- Major changes alter meanings, remove capabilities, or change authority. They
  require a reviewed workspace migration and start a new agent generation.

The application version, protocol version, report schema version, and
verification schema version remain separate. Updating WTS does not force every
contract to change together.

## Portable Instruction Composition

The primary discovery mechanism is a small `AGENTS.md` at the generated WTS
workspace root. It is a protocol bootstrap, not a replacement for the user's
instructions.

```text
personal agent instructions                   unchanged
               +
WTS workspace root/AGENTS.md                  generated bootstrap
               +
repository worktree/AGENTS.md                 unchanged repository rules
               |
               v
agent reads WTS.md and .wts/protocol.json
```

The generated root file contains only stable guidance:

```text
This is a WTS-managed multi-repository workspace.
Read WTS.md and .wts/protocol.json before working.
Keep using the user's personal instructions and each repository's AGENTS.md.
Use only reporting capabilities advertised by the current WTS protocol.
```

WTS does not copy, merge, edit, or shadow personal instruction files. It does
not create instruction files inside repository worktrees because doing so would
dirty the user's branches. Repository-local `AGENTS.md` files continue to apply
through the agent's normal instruction discovery.

WTS launches supported tools with the generated workspace root as their project
or working directory. Editor adapters should expose that root as the workspace
context alongside the repository worktrees. Provider-specific instruction
settings may improve discovery, but they are optional adapters rather than the
protocol foundation.

The root `AGENTS.md` changes rarely. `WTS.md` and `.wts/protocol.json` carry the
versioned protocol and can be regenerated as WTS evolves. A future WTS release
therefore updates the protocol without rewriting the user's normal agent
preferences or repository guidance.

For a legacy workspace with a user-created root `AGENTS.md`, WTS must not
overwrite it. The Hub offers a reviewed **Add WTS bootstrap** action that shows
the exact small addition before applying it. WTS stores a digest only for files
it generated and never assumes ownership of an existing file.

## IDE Cooperative Bridge

IDE agents need a discovery path because `WTS.md` alone is not guaranteed to be
loaded automatically by every extension.

- The generated project opens at the WTS workspace root and includes the
  repository worktrees as working folders.
- A WTS adapter may advertise the generated root `AGENTS.md` through supported
  editor instruction settings.
- WTS may expose a local MCP server for publishing Hub briefs and decisions when
  the selected IDE agent supports workspace MCP configuration.
- `wts-report` remains the provider-neutral fallback when MCP is unavailable.
- WTS never reads private IDE chat history to infer understanding.

For Copilot in VS Code, repository instructions and `AGENTS.md` can supply
context, but the VS Code extension API does not grant another extension general
access to Copilot's active conversation. For the Codex extension, app-server is
the internal rich-client protocol, but WTS must not assume it can attach to an
extension-owned server unless OpenAI documents and exposes that connection.

## Sorting and Attention

Default order:

1. Trusted WTS failures and drift.
2. User decisions requested by a current agent report.
3. Managed or locally observed agents that are running or stopping.
4. Conclusions ready for review.
5. Ready workspaces.
6. Parked workspaces.

Users may pin or park a workspace. The agent cannot change either preference.

## Component Reuse

- Preserve the current Kanban lanes, search, filters, workspace card focus
  handling, and empty states. Add the Hub brief inside `WorkspaceCard`.
- Reuse the existing workspace open menu and preferred-provider behavior.
- Reuse managed Agent connection state from `AgentStatePrototype`.
- Reuse Verification summaries and agent-report evidence links.
- Reuse the current dialog shell for decision review.

## Backend and Persistence

- Extend the versioned agent-report document with an optional bounded Hub
  contribution.
- Validate decision evidence against the existing workspace and report scope.
- Store recorded user decisions separately from the agent-authored report.
- Add a portfolio projection that returns only compact Hub facts. It must not
  load transcripts, repository contents, or full verification artifacts.
- Recover managed process state before deriving Hub state after restart.
- Add provider observation adapters behind one normalized contract. Provider
  transports remain private to the Rust service.
- Bind each provider session to one WTS workspace and reject events that cannot
  be correlated to that session.
- Run local provider servers on loopback with generated per-process credentials
  where the provider supports them.

## Validation

- A valid report contributes a headline and decision to the correct workspace.
- A report cannot reference another workspace, repository, or flow.
- An agent cannot hide or downgrade a trusted WTS failure.
- A stale graph digest visibly marks the understanding as stale.
- Recording a decision persists the exact bounded choice without editing code.
- Opening a workspace uses the existing trusted launch boundary.
- A report failure leaves the Hub and Open action usable.
- Keyboard and screen-reader navigation preserve the current Board behavior.
- A portfolio of 30 workspaces remains cheap to scan and does not load deep
  evidence until requested.
- Provider event fixtures prove the same normalized states for Codex, OpenCode,
  and Hermes without making network calls.
- Disconnect and reconnect tests prove that polling recovers current state
  without inventing progress.

## Non-Goals

- Editing source code inside WTS.
- A general-purpose Kanban board.
- Agent chat or transcript streaming.
- Arbitrary agent-generated UI.
- Automatic implementation after a decision.
- Replacing VS Code, Terminal, or another local development tool.

## Resolved Product Decisions

- The Hub is integrated into the existing global Kanban, not presented as a
  separate destination.
- It focuses on understanding and high-level decisions.
- The user opens the real local workspace to perform implementation work.
- WTS owns system state and actions. The agent contributes bounded
  interpretation.

## Open Questions

- Whether a recorded decision should be appended to `WTS.md`, stored in a
  dedicated context document, or projected into both through one WTS-owned
  record.
- Whether a conclusion-ready workspace returns to `Ready` automatically after
  the user opens it or only after an explicit acknowledgement.
