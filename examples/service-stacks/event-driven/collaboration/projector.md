# Projector workstream

Extend `projectOrder` so the event's normalized `currency` is present in the
projection.

- Preserve every existing projection field.
- Preserve the existing projection shape when currency is omitted.
- Reject a supplied currency unless it is three uppercase ASCII letters.
- Edit only `src/projection.mjs`.
- Run `npm test --silent`.

The command and read agents are implementing the same contract in parallel.
