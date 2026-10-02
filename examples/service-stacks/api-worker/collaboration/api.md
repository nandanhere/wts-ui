# API workstream

Update `normalizeJob` to accept `operation: "square"` as well as the existing
default `double` operation.

- Preserve the existing ID and input validation.
- Reject every operation other than `double` or `square`.
- Return the selected operation in the normalized job.
- Edit only `src/job.mjs`.
- Run `npm test --silent`.

The worker agent is implementing the matching execution behavior in parallel.
