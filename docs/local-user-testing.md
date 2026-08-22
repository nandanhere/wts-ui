# Local browser self-test infrastructure

WTS retains a small deterministic browser runner for developer and CI
self-tests without sending source, browser state, or traces to a hosted
service. It records ordered actions, assertions, screenshots, accessibility
state, console and network failures. The fixed WTS shell journey is not shown
as verification for every user workspace.

There is no Replay integration, account, subscription, remote browser, or
cloud evidence service. WTS is also not an instruction-level JavaScript
time-travel debugger: it records local evidence at user-action boundaries.

## Responsibility boundary

```text
Developer/CI self-test harness
      │ built-in journey ID + loopback origin
      ▼
Rust LocalWtsService
      │ validates plan, owns lifecycle and pass/fail
      ▼
fixed Playwright helper
      │ ephemeral Chromium, closed semantic action set
      ▼
.wts/test-runs/<run-id>/
      manifests, step evidence, screenshots, bounded diagnostics, digests
```

Rust is the trusted control plane. It validates the journey before launch,
starts the helper without a shell, enforces time and output limits, terminates
the helper process group, validates every returned artifact path, recomputes
artifact sizes and SHA-256 digests, writes manifests atomically, and applies
retention. The browser helper owns only browser automation and normalized
observation.

The retained built-in journey is a fixed deterministic 12-step check of WTS's
own Help and Preferences flow. It opens, checks, captures, and closes each
dialog in sequence. Neither a user nor an agent can edit it. Because it tests
WTS chrome rather than selected repository code, it is no longer mounted in
the per-workspace Verification view. Workspace-application journeys can use a
reviewed version of the same contract in a later slice.

## Closed journey language

The browser helper accepts only:

- navigation to an approved loopback origin.
- click by accessible role/name, label, exact text, or test ID.
- fill, select, check, and keyboard press.
- visible, text, and URL assertions.
- an explicit screenshot step.

It does not accept arbitrary JavaScript, CSS/XPath selectors, shell commands,
file uploads, downloads, persistent browser profiles, or navigation to a
different origin. Request and response bodies, cookies, and authorization
headers are not retained.

ARIA snapshots and screenshots necessarily contain what the tested page makes
visible. Do not run a journey through production credentials or secret form
values. WTS redacts common token patterns and request URL credentials/query
values, but visual evidence should still be treated as local sensitive data.

## Evidence and agent context

When the retained backend runner is invoked by development tooling, its
current storage contract still places each run beneath a materialized
workspace:

```text
.wts/test-runs/
└── <run-id>/
    ├── journey.json
    ├── driver-plan.json
    ├── driver-result.json
    ├── result.json
    ├── manifest.json
    ├── aria/
    ├── screenshots/
    ├── failure.png
    └── trace.zip
```

The screenshot and failure-only files are present only when the journey asks
for them or fails. The manifest is the durable source of truth. It records the
canonical journey, step outcomes, timestamps and duration, artifact paths,
sizes and digests, failure classification, and the Graphify digest that was
current when the run began.

WTS uses two integrity levels:

- Listing run history is intentionally shallow. It verifies the journey and
  result digests plus artifact metadata without reading every artifact byte.
- Immediately before the retained compatibility handoff prepares bounded
  failure context, WTS deep-reads that run and recomputes every artifact
  SHA-256 digest. Missing, replaced, or modified evidence blocks preparation.

That storage association does not mean the WTS shell self-test covers the
workspace or its graph. Separating self-test evidence into app-level
development data remains a follow-on migration. The retained development
component can form a bounded legacy draft from a validated failed result, but
that component is not mounted in the primary Workbench and is not the
Workspace CLI tab. The current Verification-to-CLI task uses workspace graph
context, not this self-test evidence.

A future self-test-to-CLI action must remain review-and-copy only: WTS should
never submit the task automatically. After native Terminal accepts a Workspace
CLI handoff, WTS cannot monitor output, status, or process exit. Any prepared
context must explicitly forbid changing the journey or evidence. Preventing a
same-user process from writing host files requires an OS sandbox and is not
claimed by this MVP.

An agent may propose a journey, explore a page, or diagnose recorded evidence,
but deterministic assertions remain the only authority allowed to declare a
run passed. A repair agent must not weaken or remove the journey that verifies
its own change.

On a 20–30 workspace Board, WTS does not load this self-test evidence for
cards or Verification. The Board's Workspace focus remains a no-model local
ranking.

## Local resource model

- no browser process while WTS is idle.
- one browser journey at a time in the initial service.
- one ephemeral Chromium context per run.
- bounded journey length, per-step timeout, total timeout, helper output, and
  artifact size.
- default retention of 8 runs and 128 MiB per materialized workspace, with
  96 MiB per run and 64 MiB per individual artifact.
- console and network evidence is normalized and bounded.
- passing and failing run retention is bounded per workspace.
- every owned descendant process is terminated on failure or timeout.
- a selected workspace reconciles an orphaned `running` manifest to
  `cancelled` after the short restart grace period, so a crashed host cannot
  leave the UI polling forever.

This model is compatible with 20–30 registered workspaces because inactive
workspaces consume disk metadata only. A user starts a browser and services
only for the workspace they are actively testing.

## Development setup

Install the UI packages, the browser-helper package, and the local Chromium
build once:

```bash
npm install
npm --prefix ui install
npm run test:browser-driver:install
```

For a source-checkout run, point the Rust host at the fixed helper:

```bash
export WTS_BROWSER_DRIVER=/absolute/path/to/wts/scripts/wts-browser-driver.mjs
export WTS_BROWSER_NODE=/absolute/path/to/node
```

Both paths must be absolute. `WTS_BROWSER_NODE` is optional when `node` can be
resolved from `PATH`. A packaged application should place the helper
beside the trusted WTS executable or set this value during application
bootstrap. Packaging Node and Chromium is a separate distribution concern.

Open **Preferences → General** to inspect the four retained browser-runner
checks: Node, the fixed helper, Playwright, and Chromium. These diagnostics
support developer self-tests. They do not add a fixed journey to workspace
Verification.

The WTS self-interface journey runs only when the UI itself is served by the
authenticated loopback browser host. It targets that single approved origin.
External and additional origins are blocked. A Tauri window is a WebView, not
a Chromium loopback target, so this journey cannot run against the current
native window. Native desktop journeys require an owned browser surface or a
separate native automation adapter.

## Optional VS Code handoff check

Use this check on macOS because automated tests must not open or focus an
external application:

1. Open a materialized workspace in VS Code.
2. Start a Codex task in that VS Code window.
3. Return to the WTS workspace board.
4. Select the workspace card that shows `Codex is working`.
5. Verify that macOS activates the matching VS Code workspace window.
6. Return to WTS and verify that WTS shows the same workspace detail.

## Delivery sequence

1. Deterministic local self-test and durable evidence.
2. Workspace service-stack targets and bounded service-log rings.
3. Read-only failure diagnosis using the pinned Graphify context.
4. Reviewed, workspace-specific agent-generated journey proposals followed by
   a deterministic compiler and runner.
5. Repository-scoped parallel repair agents followed by an immutable rerun.
6. A local evidence timeline and trace viewer with typed artifact access.

The sequence keeps test truth independent of provider availability. Runs must
produce the same pass/fail result with every agent integration disabled.
