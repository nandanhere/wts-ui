# Read API workstream

Extend `publicOrder` so the public response contains the projection's
three-letter uppercase `currency`.

- Preserve the stable allow-list behavior. Do not spread internal fields.
- Preserve the existing response shape when currency is omitted.
- Reject a supplied currency unless it is valid.
- Edit only `src/public-order.mjs`.
- Run `npm test --silent`.

The command and projection agents are implementing the same contract in
parallel.
