# Frontend + backend fixture

This stack models a browser-facing frontend that depends on a JSON backend.
Both services are deliberately tiny, but the frontend health check is only
healthy when the backend is reachable. That makes startup order observable
without forcing the runner to serialize process launch.

| Process | Port environment | Endpoints |
| --- | --- | --- |
| `backend` | `BACKEND_PORT` | `/health`, `/api/greeting?name=Ada` |
| `frontend` | `FRONTEND_PORT` | `/health`, `/`, `/api/greeting?name=Ada` |

The frontend proxies the greeting request rather than importing backend code,
so `frontend/` and `backend/` can be initialized as independent Git
repositories in a WTS workspace.

Run it from the parent fixture directory:

```bash
node run-stack.mjs \
  --manifest frontend-backend/wts-stack.json \
  --instance greeting-1 \
  --base-port 47000 \
  --state-dir /tmp/wts-greeting-1 \
  --smoke \
  --exit-after-smoke
```

`agent-collaboration.json` describes a two-agent contract evolution exercise.
The backend and frontend changes can be developed in parallel, then the
integration probe validates the shared contract.
