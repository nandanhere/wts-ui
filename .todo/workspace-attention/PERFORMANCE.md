# Workspace attention performance results

Date: 2026-09-19.

Ten cached returns across five workspaces now make 31 API reads instead of 130, a 76% decrease in this fixture.
The cached content median stays at 63 ms. The changes reduce repeated work without a new loading delay.

## Conditions

The host uses an Apple M1 Pro, 10 logical CPUs, 16 GiB of memory, and macOS 15.7.3.
The run used Node.js 22.13.1 and Chromium 149.0.7827.55 with one browser worker.
The full app ran through Vite development modules with React StrictMode.
Every API read had an 80 ms fixture delay. Writes failed at the fixture boundary.

The test used separate source snapshots for the baseline and final runs.
It did not read user workspaces, run a provider, or send GitLab messages.

## Cached returns

Five workspaces opened once before ten cached returns. Each workspace opened twice in the return sample.

| Measurement | Baseline | Final |
| --- | ---: | ---: |
| Total API reads | 130 | 31 |
| MR list reads | 60 | 0 |
| Agent session reads | 40 | 1 |
| Work item reads | 20 | 20 |
| Materialization reads | 10 | 10 |
| Cached content median, 10 samples | 63 ms | 63 ms |
| Cached content maximum | 95 ms | 66 ms |

The fixture held each materialization response until the cached workspace facts appeared.
The test checks this order directly. It does not use a timing threshold to infer cache reuse.
Authoritative materialization reads remain in the selected workspace flow.

## Board cost

| Materialized records | Baseline peak requests | Final peak requests | Final board ready | Final attention ready |
| --- | ---: | ---: | ---: | ---: |
| 5 | 10 | 10 | 3,881 ms | 3,941 ms |
| 30 | 31 | 10 | 1,199 ms | 2,551 ms |
| 100 | 101 | 10 | 1,488 ms | 5,918 ms |

The first case includes cold Vite transforms. Later cases share the warm server.
These timings do not show a scaling comparison between the first and later cases.
The board stays visible while the attention queue completes its reads.

Attention reads at most 96 workspaces in one refresh. The 100-record case therefore observes 96 workspaces.
Records beyond the limit show an unchecked source state. The limit does not hide or remove their cards.

Attention adds one cheap saved verification read per observed materialized workspace.
The final refresh reads 5, 30, or 96 verification summaries and the same number of MR lists.
Total startup reads increase because the feature supplies more information. Request concurrency remains bounded.
Board startup and refresh make no materialization, full evidence, or test-run detail requests.
Search causes no API requests after the current refresh completes.

## Intermediate render defect

The first attention implementation sent a subscriber update for each completed source.
At 100 records, that capture recorded 75 long tasks with 6.94 seconds of total task time before refresh completed.
A search during that work took 1.45 seconds.

The final implementation batches notifications per animation frame and isolates card subscriptions.
Two final captures recorded 7–8 long tasks with 1.24–1.36 seconds of total task time through a complete refresh.
The baseline recorded 8 long tasks with 1.24 seconds of total task time.
Final search samples at 100 records were 58 ms and 126 ms after refresh.

The intermediate and final captures have different completion points. Use these observations to identify the render defect, not as a CPU speed claim.

## Gates and evidence

Run the browser gate from `ui/`:

```bash
npm run test:performance
```

The request budgets and fixture limits are in [the benchmark guide](../../docs/workspace-attention-performance.md).
The [measurement record](PERFORMANCE.json) retains the counts, timings, browser samples, and machine details.

| Check | Result | Log or report |
| --- | --- | --- |
| Baseline browser behavior | 4 passed | `/tmp/wts-workspace-performance-baseline.log` |
| New budgets against the preceding source | 2 failed as expected | `/tmp/wts-workspace-performance-budget-red.log` |
| Final browser flow and return budgets | 4 passed | `/tmp/wts-workspace-performance-final.log` |
| Complete background refresh queues | 3 passed | `/tmp/wts-workspace-performance-final-refresh.log` |
| Verification filesystem and process boundary | 7 passed | `/tmp/wts-verification-summary-app-final.log` |
| Verification HTTP route | 1 passed | `/tmp/wts-verification-summary-http.log` |
| Verification native command and permission | 1 passed | `/tmp/wts-verification-summary-native.log` |
| Verification client contracts | 22 passed | `/tmp/wts-verification-summary-contract-green.log` |
| App, server, and desktop Clippy | Passed with warnings denied | `/tmp/wts-verification-summary-clippy.log` |

The preceding source exceeded the concurrency budget and issued 60 MR reads during the cached-return sample.
The new client contract had 22 failures before the summary method existed.
The process test uses a Git wrapper to reject subprocess calls during the saved summary read.
It then proves that the authoritative evidence read still reaches Git.

Full browser artifacts remain under the matching `/tmp/wts-workspace-performance-*` directories.

## Final idle refresh cadence

The final board checks attention every 60 seconds while it stays visible and idle.
The freshness cache remains 30 seconds. A return can reuse fresh data without another read.
A new deterministic browser check found extra reads after 31 seconds in the preceding 30-second implementation.
The final implementation makes no MR or summary read at that point. It completes one refresh after 61 seconds.

The focused cadence check passed. Its timing does not enter the comparison because the full UI suite ran at the same time.
Evidence: `/tmp/wts-workspace-performance-cadence-red.log` and `/tmp/wts-workspace-performance-cadence-green.log`.

The pull-request script now runs attention and performance browser configs after the directed browser flows.
Three shell contract tests failed before this wiring. They check command order and stop later checks on either failure.
Evidence: `/tmp/wts-attention-performance-gate-red.log` and `/tmp/wts-attention-performance-gate-green.log`.

## Scope limits

The browser timings include automation and two animation frames. They are upper-bound observations, not native paint measurements.
The benchmark has no agent session records or MR comments. Large transcripts, diffs, and repositories need separate profiles.
The cheap summary checks the saved context and receipt. It does not prove that current local files pass verification.
The Verify view keeps the full authoritative evidence path.
Native command tests cover transport and permissions. They do not measure WebView memory or native frame timing.
