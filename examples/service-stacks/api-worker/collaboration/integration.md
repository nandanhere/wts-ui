# Integration verification

After both parallel workstreams finish, run both package test suites. Then
start the stack with isolated ports and state and run
`node collaboration/smoke.mjs`. Preserve the injected acceptance tests and
verify the worker process releases its health port after shutdown.
