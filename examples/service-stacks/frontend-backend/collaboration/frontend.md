# Frontend workstream

Extend `greetingApiPath` with a second `tone` argument and include the encoded
`tone` query parameter. Extend `renderGreeting` to add
`data-tone="PAYLOAD_TONE"` when a tone is present while preserving HTML
escaping. Calls and payloads without a tone must keep their existing exact
output.

- Pass the incoming `tone` query parameter to `greetingApiPath` in
  `src/server.mjs`.
- Edit only `src/client.mjs` and `src/server.mjs`.
- Preserve the existing default call behavior.
- Run `npm test --silent`.

The backend agent is implementing the formal-tone contract in parallel.
