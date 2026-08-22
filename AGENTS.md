<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes. Its APIs, conventions, and file structure can differ from your training data.

Read the applicable guide in `node_modules/next/dist/docs/` before you write code. Follow all deprecation notices.
<!-- END:nextjs-agent-rules -->

# Validation rule

Add an automated validation test for each bug fix and feature.

The test must exercise the affected user behavior or trusted boundary. The test must fail against the preceding implementation.

A construction-only assertion is not sufficient for a defect at an integration boundary. Test the closest deterministic boundary instead.

This boundary can be a serialized contract, transport, filesystem effect, process effect, or adapter.

If an external application prevents automation, add the strongest deterministic contract test. Also document an optional integration check.

# Writing rule

Follow [the project writing style](docs/writing-style.md) for all prose.

Use strict Simplified Technical English for interface instructions, agent statuses, procedures, warnings, errors, and safety text.

Use STE-flavored English for other technical documentation.

Do not apply the writing rules to code, identifiers, commands, serialized fields, or quoted interface text.

# UI callout contract

Read [the UI callout guide](docs/ui-callouts.md) before you add or change a callout.

Pair each `data-ui` machine ID with a short `data-ui-label` spoken label.
Keep machine IDs stable. Use natural labels that work in voice messages.
