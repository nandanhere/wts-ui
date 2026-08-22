# Backend workstream

Extend `greetingPayload` with a third `tone` argument.

- `tone=formal` must return `message: "Welcome, NAME."` and `tone: "formal"`.
- An omitted tone must preserve the existing payload exactly.
- Any other explicit tone must use the existing greeting and return
  `tone: "friendly"`.
- Preserve `instance`.
- Pass the request's `tone` query parameter from `src/server.mjs`.
- Edit only `src/greeting.mjs` and `src/server.mjs`.
- Run `npm test --silent`.

The frontend agent is implementing against this exact contract in parallel.
