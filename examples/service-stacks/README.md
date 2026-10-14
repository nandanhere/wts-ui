# WTS service-stack fixtures

These fixtures exercise simultaneous local runtimes without requiring
containers, package installation, databases, or network access. They are small
enough to run several workspace copies on a laptop while still representing
useful service relationships.

| Stack | Processes per copy | Shape exercised |
| --- | ---: | --- |
| `frontend-backend` | 2 | Browser-facing service with an upstream API |
| `api-worker` | 2 | Request API with asynchronous background work |
| `event-driven` | 3 | Command API, event projector, and read API |

All processes:

- use only Node.js built-ins.
- bind to `127.0.0.1`.
- receive ports through environment variables.
- use a per-instance `WTS_STATE_DIR`.
- expose a JSON `/health` endpoint.
- stop cleanly on `SIGINT` or `SIGTERM`.
- avoid file watchers and unbounded in-memory queues.

The manifests are intentionally data-only. `run-stack.mjs` executes each
process directly with `shell: false`, waits for all health checks, and can run
the stack's end-to-end smoke probe. Every process declares its logical
`dependencies`. Processes may still start concurrently because dependency
health is observed rather than encoded as an arbitrary startup sleep.

## Run one stack

From this directory:

```bash
node run-stack.mjs \
  --manifest frontend-backend/wts-stack.json \
  --instance ui-api-1 \
  --base-port 47000 \
  --state-dir /tmp/wts-ui-api-1
```

Add `--smoke` to run the stack's smoke probe after it becomes healthy. Add
`--exit-after-smoke` to stop it immediately after the probe:

```bash
node run-stack.mjs \
  --manifest api-worker/wts-stack.json \
  --instance jobs-1 \
  --base-port 47100 \
  --state-dir /tmp/wts-jobs-1 \
  --smoke \
  --exit-after-smoke
```

`--base-port` reserves a ten-port slot. The manifest maps named ports onto
offsets inside that slot. Callers must give concurrently running copies
different base ports.

## Run simultaneous copies

The smoke harness starts every configured process in parallel, waits for
health, runs all integration probes in parallel, then proves they can be
stopped:

```bash
node smoke-many.mjs --copies 2 --base-port 48000
```

Two copies of each stack produce six isolated workspaces and fourteen service
processes. Four copies produce twelve workspaces and twenty-eight processes:

```bash
node smoke-many.mjs \
  --copies 4 \
  --base-port 48000 \
  --output /tmp/wts-simultaneous-stacks.json
```

Add `--hold-ms 5000` to leave healthy stacks running briefly for an external
process, CPU, or RSS sample before smoke checks and cleanup.

Use `--stack frontend-backend`, `--stack api-worker`, or
`--stack event-driven` to select one shape.

## Validate the fixtures

The data-only manifests and initial red phase of every collaboration task can
be checked without opening ports:

```bash
node verify-fixtures.mjs
```

The runtime cleanup probe intentionally breaks one process, checks that the
already-started sibling is stopped, then starts a healthy stack on the same
ports and checks successful shutdown too:

```bash
node verify-runtime-cleanup.mjs 49700
```

## Using the fixtures for agent collaboration

Each stack contains `agent-collaboration.json` plus focused Markdown briefs.
The manifest separates independently editable workstreams from the final
integration check. A WTS collaboration test can create one worktree workspace,
send the workstreams to Codex agents in parallel, and reserve the integration
brief for a final verifier.

The collaboration manifests are fixture metadata, not a promise of a public
WTS configuration API. They are versioned so the runtime experiment can evolve
without silently changing old test cases.
