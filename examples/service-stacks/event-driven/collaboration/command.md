# Command API workstream

Extend `createOrderEvent` with a three-letter `currency` supplied by the
command.

- When supplied, require a string matching three ASCII letters, normalize it
  to uppercase, and add it to the event.
- An omitted currency must preserve the existing event shape.
- Preserve all existing validation.
- Edit only `src/order.mjs`.
- Run `npm test --silent`.

The projection and read agents are implementing the same contract in parallel.
