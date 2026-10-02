# Integration verification

After both workstreams finish:

1. Ensure the injected acceptance tests were not edited.
2. Run `npm test --silent` in both repositories.
3. Start the stack with isolated ports and state.
4. Run `node collaboration/smoke.mjs` from the stack root.
5. Confirm every process stops and releases its port.
