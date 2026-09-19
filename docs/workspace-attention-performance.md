# Workspace attention performance

The browser benchmark checks board startup, local search, background refresh, and returns to five saved workspaces.
It uses the full app with 5, 30, and 100 materialized workspace records.

## Run the benchmark

Run these commands from the repository root:

```bash
cd ui
npm run test:performance
```

Use Node.js 22 or later.
The test starts its own Vite server and Chromium browser.
Every API request uses fixture data with an 80 ms delay.
The fixture rejects writes. It does not read user workspaces or send provider messages.

Each test writes `workspace-performance.json` under `ui/test-results/workspace-performance/`.
The report includes request counts, peak concurrency, interaction samples, long tasks, layout shifts, DOM counts, and heap size.

## Request budgets

- Board requests have a peak concurrency of at most 12, including global startup reads.
- Board startup and refresh do not request materialization, full evidence, or test-run details.
- Search uses the loaded records and sends no API requests.
- The idle board checks attention every 60 seconds. The test rejects an extra refresh after 31 seconds.
- Ten cached returns make at most 5 MR reads, 15 session reads, and 55 total reads.
- Cached workspace facts appear before a held materialization response completes.

These gates test the actual browser transport. They do not count mock function calls.
The concurrency and MR reuse gates fail against the source snapshot from before this goal.
`WTS_PERFORMANCE_BASELINE=1` disables the new request budgets for a baseline run. The behavior checks still run.

The attention cache keeps results fresh for 30 seconds. A return within that period can reuse the results.
The 60-second polling interval preserves the existing idle MR refresh rate.

The pull-request gate runs the attention browser flows and these request budgets after the directed feedback flows.
Shell contract tests check their order and make sure that a failure stops later checks.

## Saved verification summaries

The board reads `/api/v1/workspaces/{id}/verification/summary` instead of full evidence.
This route reads the saved materialization receipt, context, verification plan, current result, and bounded result history.
It does not run Git, read graph contents, read agent runs, or change evidence files.

The summary shows saved results. It does not prove that the current worktree passes its checks.
The Verify view retains its authoritative evidence read.

Seven filesystem and process tests cover workspace identity, symlinks, file-size limits, history, and the absence of Git calls.
HTTP, native command, and client contract tests cover the serialized response.

## Measurement limits

The fixture uses Chromium, Vite development modules, and one test worker.
The browser runs with React StrictMode. Global startup reads can occur twice in this mode.
Timing includes browser automation and two animation frames. It is an upper-bound observation, not a native paint measurement.
The fixture has no agent sessions or merge-request comments. Detailed transcript and diff costs require separate measurements.
The first test includes cold Vite transforms. Later tests share the warm server.
Do not compare the first test with later tests as a workspace-count scaling result.

The 100-workspace case is a stress test. The attention collector reads at most 96 workspaces in one refresh.
The interface shows the unchecked source state for records beyond that limit.
