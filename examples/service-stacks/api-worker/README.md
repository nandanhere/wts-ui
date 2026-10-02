# API + worker fixture

This stack models asynchronous work without requiring a queue server. The API
writes one bounded JSON file per job into its instance state directory. The
worker claims jobs with an atomic rename, writes an atomic result file, and
serves its own health endpoint.

| Process | Port environment | Responsibility |
| --- | --- | --- |
| `jobs-api` | `JOBS_API_PORT` | Submit jobs and query their status |
| `jobs-worker` | `JOBS_WORKER_PORT` | Claim and execute queued jobs |

Every workspace copy must receive a distinct `WTS_STATE_DIR`. No process scans
outside that directory, and the queue is bounded to 128 pending jobs.

```bash
node run-stack.mjs \
  --manifest api-worker/wts-stack.json \
  --instance jobs-1 \
  --base-port 47100 \
  --state-dir /tmp/wts-jobs-1 \
  --smoke \
  --exit-after-smoke
```

The collaboration scenario evolves the request and worker contract to support
a `square` operation. API validation and worker execution can be implemented
by two Codex agents in parallel.
