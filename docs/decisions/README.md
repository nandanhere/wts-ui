# Development decision log

This directory records durable product and engineering decisions for WTS.
It is intentionally lighter than a full architecture-decision-record process:
the goal is to preserve why a direction was chosen without turning routine
implementation details into permanent policy.

## Statuses

- **Proposed** — under discussion and not yet binding.
- **Accepted** — the current direction for implementation and documentation.
- **Superseded** — retained for history, with a link to its replacement.
- **Deprecated** — still present temporarily but should not guide new work.

## When to add a record

Add or update a record when a decision changes product terminology, navigation,
system boundaries, persistence, security authority, supported platforms, or the
canonical development workflow. Tests and implementation details belong in
their normal source locations unless they explain an important consequence.

## Records

| Record | Status | Summary |
| --- | --- | --- |
| [0001 — Current WTS product and engineering direction](./0001-current-wts-direction.md) | Accepted | Canonical architecture, workspace UX, imports, trust boundaries, documentation, and cleanup policy |
