# Nested planning folders

Plans and Kanban now discovers files below the planning home. A folder tree retains the directory structure, and search matches full relative paths. Files with the same name remain separate documents. Folder state survives a workspace return.

Relative Markdown links open known files in the current viewer. Navigation preserves unsaved edits and feedback. A linked file becomes visible when a filter or collapsed folder hid it. Local document actions cannot open an invalid browser route through auxiliary clicks.

Nested reads and saves use opaque IDs derived from the full relative path. Existing root IDs remain unchanged. On Unix, each path component rejects symbolic links. Saves check the source digest and parent directory before they publish the replacement.

## Validation

| Check | Result |
| --- | --- |
| Planning component, folder, and path tests | 100 passed |
| Filesystem boundary tests | 10 passed |
| Service integration tests | 2 passed |
| Chromium at 1440px and 375px | 2 passed |
| UI TypeScript and production build | Passed |
| App Clippy, all targets, warnings denied | Passed |
| Desktop debug build | Passed |
| Changed-file whitespace check | Passed |

Regression tests failed before the fixes. They cover missing nested files, path identity, relative navigation, filter visibility, and filesystem replacement checks. The browser tests use the real HTTP client with isolated responses. They check the exact file ID and digest in each save request.

The local desktop app restarted with the rebuilt executable. Its window opened successfully. Hash checks confirmed unchanged saved conversation messages and feedback. This pass made no real planning document writes, provider requests, or pushes.

## Limits

Discovery checks eight directory levels and at most 4,096 entries. It lists up to 100 generated documents beyond the fixed starter files. Each file can contain up to 256 KiB. Supported extensions are `.md`, `.txt`, `.csv`, `.mmd`, and `.mermaid`.

The non-Unix fallback did not receive runtime tests in this pass. Cross-document section scrolling is not part of this change. The production build still reports dependency chunks above 500 kB.
