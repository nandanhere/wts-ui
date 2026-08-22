# UI callouts

UI callouts let a user name a visible WTS region in written or spoken feedback.
The user does not need to know a React component name or a source file.

## User flow

1. Press `Command+Shift+L` on macOS.
2. Press `Ctrl+Shift+L` on Windows or Linux.
3. Hover over the region that needs a change.
4. Read or say the visible label, such as `Spaces toolbar`.
5. Press `Escape` to close callout mode.

The label remains visible for 1.2 seconds after the pointer leaves the region.
This delay gives the user time to start a voice message.

Callout mode uses pointer coordinates to select the deepest annotated region.
An annotated child takes priority over its annotated parent.

## Markup contract

Add both attributes to a stable semantic region:

```tsx
<div
  data-ui="spaces.toolbar"
  data-ui-label="Spaces toolbar"
>
```

`data-ui` is the stable machine ID. Use lowercase dot-separated words.
Do not change this ID during a visual refactor.

`data-ui-label` is the spoken label. Use short natural words that are easy to
say and transcribe. Use sentence case. Do not show implementation terms in the
label.

Each rendered screen must use each machine ID and spoken label only once.
Annotate meaningful regions, not layout wrappers or decorative elements.

For a repeated item, derive both values from a stable product identity:

```tsx
<article
  data-ui={`spaces.card.${workspace.id}`}
  data-ui-label={`Workspace card ${workspace.key}`}
>
```

Do not use an array index or a temporary render order as identity.

## Coverage rules

Annotate each complete page, dialog, sheet, and major panel. Within each one,
annotate the regions that a user can reasonably resize, move, simplify, or
restyle as a unit.

Typical regions include a header, toolbar, navigation area, summary, list,
form, viewer, action area, and footer. Do not annotate each text node, icon,
field, or button. A user can name those controls from their visible text.

## Naming examples

| Machine ID | Spoken label | Example feedback |
| --- | --- | --- |
| `wts.top-bar` | `Top bar` | “The top bar feels crowded.” |
| `spaces.toolbar` | `Spaces toolbar` | “Make the Spaces toolbar shorter.” |
| `spaces.lanes` | `Workspace columns` | “The workspace columns need more space.” |
| `workspace.tab-content` | `Workspace content` | “The workspace content is too wide.” |

Prefer a product name over a code name. Use `Spaces toolbar`, not
`boardToolbar` or `toolbar div`.

## Agent resolution

Treat the spoken label as the primary user contract. Search it first:

```bash
rg -ni --fixed-strings 'data-ui-label="Spaces toolbar"' ui/src
```

If transcription changes a word, list the available labels:

```bash
rg -n 'data-ui-label=' ui/src
```

Compare the words, the current screen, and the requested change. Ask the user
only when two regions remain plausible. After resolution, use `data-ui` as the
stable reference in code and tests.

## Implementation and validation

The overlay is in `ui/src/components/UiCallouts.tsx`. Initial annotations are
in `ui/src/variants/local-workspace/LocalWorkspace.tsx`.

`UiCallouts.test.tsx` verifies the keyboard, hover, nesting, and linger
behavior. `UiCallouts.contract.test.ts` checks that each source annotation has
a unique machine ID and spoken label.

Run these checks after a callout change:

```bash
cd ui
npx vitest run src/components/UiCallouts.test.tsx src/components/UiCallouts.contract.test.ts
npm run build
```
