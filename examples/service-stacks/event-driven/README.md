# Event-driven integration fixture

This fixture models a small command/query split:

1. `command-api` validates an order and atomically writes an immutable event.
2. `projector` polls the instance event directory and creates an idempotent
   read projection.
3. `read-api` serves only projected state.

| Process | Port environment | Responsibility |
| --- | --- | --- |
| `command-api` | `COMMAND_API_PORT` | Accept order commands |
| `projector` | `PROJECTOR_PORT` | Convert events into projections |
| `read-api` | `READ_API_PORT` | Query eventual state |

There is no broker or database. Each event and projection is a bounded JSON
file inside the injected `WTS_STATE_DIR`, which makes persistence and isolation
visible while keeping the fixture cheap.

```bash
node run-stack.mjs \
  --manifest event-driven/wts-stack.json \
  --instance orders-1 \
  --base-port 47200 \
  --state-dir /tmp/wts-orders-1 \
  --smoke \
  --exit-after-smoke
```

The collaboration scenario gives command validation, projection, and query
representation to three independent agents. Their common contract is validated
only after all three workstreams finish.
