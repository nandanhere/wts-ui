# My Reviews PRD

## Status

Aligned on 2026-08-14.

This PRD follows the approved Workspace Review Loop information architecture.
It adds a global review surface. It does not add a workspace tab.

## Overview

My reviews shows open GitHub pull requests that explicitly request a review
from the current user. WTS includes only repositories that belong to a saved
WTS workspace.

The first release is read-only. WTS checks GitHub through the authenticated
`gh` CLI and opens a trusted pull request page when the user selects **Review**.
WTS does not approve, comment on, merge, or change a pull request.

## Product Decisions

1. Add **My reviews** beside **My time** in the Spaces toolbar.
2. Keep My reviews separate from the Workspace, Plans & Kanban, Changes, and
   Verification workspace tabs.
3. Support GitHub.com in the first release.
4. Include open pull requests with an explicit individual review request for
   the current authenticated user.
5. Exclude team review requests, assignments, mentions, subscriptions, and
   authored pull requests without an explicit review request.
6. Include only repositories linked to at least one saved WTS workspace.
7. Show one pull request once when several workspaces link the same repository.
8. Use the `gh` CLI authentication state for the first release.
9. Put `gh` behind a provider adapter. A later release can use another GitHub
   authentication method without changing the UI contract.
10. Keep the WTS action read-only. **Review** opens GitHub through a WTS-owned
    trusted browser target.
11. Keep cached results after a restart. Mark them out of date until WTS
    completes a new refresh.
12. Keep successful repository results when another repository fails.

## Authority Model

### GitHub authority

GitHub supplies:

- the authenticated user login
- the open pull request identity
- the pull request title and author
- draft state
- the individual review request
- the GitHub update time

WTS treats this data as provider-reported state. WTS validates and bounds all
fields before it stores or shows them.

### WTS authority

WTS supplies:

- the saved workspace and repository allowlist
- the trusted GitHub host, owner, and repository identity
- the cached refresh state
- the mapping from one repository to its WTS workspaces
- the private browser target for the **Review** action

WTS never opens a URL returned by GitHub or `gh`.

### User authority

The user selects **My reviews**, starts a refresh, and selects **Review**.
GitHub owns all review actions after the browser opens.

## User Needs

1. See every open code review that explicitly requests my review.
2. See the review list without opening each repository on GitHub.
3. Know which WTS workspace and repository contain the requested review.
4. Distinguish current results from cached or incomplete results.
5. Open the correct pull request through a safe action.
6. Know when GitHub CLI authentication blocks the refresh.
7. Keep useful results when one repository cannot be checked.
8. Use the review list with a keyboard and at a narrow window width.

## User Stories

- As a developer, I want one personal review list so that I can find work that
  needs my response.
- As a developer, I want only explicit individual requests so that the list has
  a clear meaning.
- As a developer, I want WTS workspace context so that I can connect a review
  to my local work.
- As a developer, I want a trusted **Review** action so that an untrusted URL
  cannot control the browser target.
- As a developer, I want cached results to remain visible during refresh so
  that the list does not disappear.
- As a developer, I want partial errors to preserve successful results so that
  one repository does not block the full list.
- As a developer, I want direct authentication instructions so that I can fix a
  missing GitHub CLI session.

## Screens and Flows

1. **Spaces toolbar entry** shows the current unique review count.
2. **My reviews** shows the global list for all linked GitHub repositories.
3. **Initial load** shows a stable skeleton when no cache exists.
4. **Refresh with cache** keeps the list visible and shows refresh status.
5. **Empty state** explains that no explicit review requests exist.
6. **Authentication state** explains how to authenticate the GitHub CLI.
7. **Out-of-date state** keeps cached reviews and offers a refresh.
8. **Partial error state** keeps successful reviews and identifies unchecked
   repositories.
9. **Review handoff** rebuilds a trusted GitHub pull request target and opens
   it in the default browser.

## Primary Flow

```text
User opens Spaces
        |
        v
WTS reads the cached My reviews snapshot
        |
        +---- Cache exists ------> Show cached reviews as out of date
        |
        +---- No cache ----------> Show the initial loading state
        |
        v
WTS resolves GitHub repositories from saved workspaces
        |
        v
WTS checks `gh` and the current GitHub identity
        |
        +---- No authentication -> Show the authentication state
        |
        v
WTS requests open pull requests for the linked repository allowlist
        |
        v
WTS keeps only individual requests for the current user
        |
        +---- Some repositories fail -> Keep valid results and show partial error
        |
        v
WTS stores a bounded snapshot and shows My reviews
        |
        v
User selects Review
        |
        v
WTS resolves the stored repository identity and pull request number
        |
        v
WTS opens the trusted GitHub pull request page
```

## Information Architecture

Use the approved global and workspace structure:

```text
Spaces
  [Search] [All workspaces]       [My reviews 3] [My time] [+ New workspace]

Workspace
  Workspace | Plans & Kanban | Changes | Verification
```

My reviews is a global personal queue. It is not a fifth workspace tab.

The Review workspace lane continues to describe WTS workspace state. A GitHub
review request does not move a workspace to another lane in the first release.

## ASCII Designs

### Spaces toolbar

```text
┌ Spaces ───────────────────────────────────────────────────────────────────┐
│ [Search] [All workspaces 7]        [My reviews 3] [My time] [+ New workspace]│
└───────────────────────────────────────────────────────────────────────────┘
```

Show no count when the count is zero. Keep the accessible name **My reviews**.
The count includes unique pull requests, not workspace mappings.

### Loaded

```text
┌ My reviews ────────────────────────────────────────────────────────────────┐
│ [← Spaces]  3 review requests                    Updated 2 minutes ago [↻] │
│ Explicit requests for you in WTS-linked GitHub repositories.              │
├───────────────────────────────────────────────────────────────────────────┤
│ checkout-api                                                              │
│                                                                           │
│ #184  Prevent duplicate captures                              [Review →]  │
│ Maya Chen · Review requested · main ← fix/capture                          │
│ Checkout reliability · Updated 8 minutes ago                              │
│                                                                           │
│ #179  Add retry telemetry                                      DRAFT       │
│ Alex Smith · Review requested · main ← retry-metrics          [Review →]  │
│ Checkout reliability · Updated yesterday                                  │
├───────────────────────────────────────────────────────────────────────────┤
│ ledger-worker                                                             │
│                                                                           │
│ #72  Bound the settlement retry loop                         [Review →]   │
│ Priya Rao · Review requested · release/26 ← retry-bound                    │
│ Ledger repair · Payments hardening · Updated 2 days ago                    │
└───────────────────────────────────────────────────────────────────────────┘
```

Group rows by repository. Sort repositories by the first actionable row. Sort
non-draft rows before draft rows. Within each group, show the oldest observed
request first. Use the GitHub update time as a secondary sort key.

When one repository belongs to several workspaces, show at most two workspace
names. Show the remaining count as `+N workspaces`.

### Initial loading

```text
┌ My reviews ────────────────────────────────────────────────────────────────┐
│ [← Spaces]  My reviews                                           [↻]      │
│ Checks linked GitHub repositories…                                        │
├───────────────────────────────────────────────────────────────────────────┤
│ ███████████                                                               │
│ ████████████████████████████████                                          │
│ ███████████████                                                           │
│                                                                           │
│ █████████                                                                 │
│ ██████████████████████████                                                │
│ █████████████                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

Use the skeleton only when WTS has no cached snapshot. Set `aria-busy` on the
review region. Do not announce each skeleton row.

### Refresh with cached results

```text
┌ My reviews ────────────────────────────────────────────────────────────────┐
│ [← Spaces]  3 review requests                    Checks GitHub… [Refresh] │
├───────────────────────────────────────────────────────────────────────────┤
│ Existing review rows remain visible.                                      │
│ The refresh control is unavailable until the current request ends.        │
└───────────────────────────────────────────────────────────────────────────┘
```

Do not clear cached rows when a refresh starts. Ignore an obsolete response
when the user leaves My reviews or starts a newer refresh.

### Empty

```text
┌ My reviews ────────────────────────────────────────────────────────────────┐
│ [← Spaces]  My reviews                                Updated just now [↻] │
├───────────────────────────────────────────────────────────────────────────┤
│                         No reviews request your response                   │
│                                                                           │
│ WTS checked 8 linked GitHub repositories.                                 │
│ Team requests and mentions are not included.                              │
│                                                    [Refresh]              │
└───────────────────────────────────────────────────────────────────────────┘
```

If no saved workspace has a GitHub repository, use this message:

```text
No linked GitHub repositories

Add a GitHub repository to a WTS workspace. My reviews checks only linked
repositories.
```

### GitHub CLI authentication required

```text
┌ My reviews ────────────────────────────────────────────────────────────────┐
│ [← Spaces]  My reviews                                                    │
├───────────────────────────────────────────────────────────────────────────┤
│ GitHub CLI sign-in is required                                            │
│                                                                           │
│ WTS uses your GitHub CLI session to read review requests.                  │
│ Run this command in a terminal:                                           │
│                                                                           │
│ gh auth login                                                   [Copy]    │
│                                                                           │
│ WTS does not read or store your GitHub token.                              │
│                                                    [Check again]          │
└───────────────────────────────────────────────────────────────────────────┘
```

If `gh` is not installed, show `GitHub CLI is not installed`. Link to the
existing environment setup surface when one exists. Do not start an
interactive authentication process inside the WTS service.

### Out-of-date cache

```text
┌ My reviews ────────────────────────────────────────────────────────────────┐
│ [← Spaces]  3 cached review requests                         [Refresh]    │
│ Results are out of date. WTS has not checked GitHub in this app session.  │
├───────────────────────────────────────────────────────────────────────────┤
│ Cached review rows remain visible with an Out of date label.               │
└───────────────────────────────────────────────────────────────────────────┘
```

Mark a restored snapshot out of date until a refresh succeeds. Also mark the
snapshot out of date after a failed full refresh. Do not remove cached rows
because authentication or the network failed.

### Partial error

```text
┌ My reviews ────────────────────────────────────────────────────────────────┐
│ [← Spaces]  2 review requests                     Partly updated [Retry]  │
│ WTS could not check 2 of 8 repositories.                                 │
├───────────────────────────────────────────────────────────────────────────┤
│ checkout-api                                                              │
│ #184  Prevent duplicate captures                              [Review →]  │
│                                                                           │
│ ledger-worker                                                             │
│ #72  Bound the settlement retry loop                         [Review →]   │
│                                                                           │
│ ▸ Repositories not checked · 2                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

The disclosure lists bounded repository names and direct error categories.
Use categories such as `Access denied`, `Repository not found`, `Timed out`,
and `Response was not valid`. Do not show command output or credentials.

### Review handoff failure

```text
┌ My reviews ────────────────────────────────────────────────────────────────┐
│ Could not open PR #184                                                    │
│ WTS could not confirm the linked GitHub repository.                       │
│                                                                           │
│                                        [Dismiss] [Refresh reviews]         │
└───────────────────────────────────────────────────────────────────────────┘
```

Keep the row and return focus to its **Review** action after dismissal.

## Interaction Rules

- Up and Down move between review rows in the current repository group.
- Left and Right move between repository groups when the row list has focus.
- Home and End move to the first and last review row.
- Enter opens the selected review through the trusted action.
- Escape returns focus to **My reviews** in the Spaces toolbar.
- Do not intercept arrow keys in search fields or native controls.
- Keep one normal-flow action per review row.
- Keep draft state visible but secondary to the review request.
- Do not show pull request bodies, comments, diffs, or review threads in v1.

## Freshness and Persistence

WTS stores one bounded current snapshot and a small refresh receipt history.
The snapshot survives an app restart.

Store:

- the provider and host
- the current reviewer login
- repository identity
- pull request number, title, author, draft state, and update time
- first observed and last observed times
- linked workspace and repository IDs
- the last successful refresh time
- per-repository refresh status

Do not store:

- GitHub tokens
- raw `gh` output
- pull request bodies
- comments or review text
- diffs or file lists
- provider URLs
- command environment values

A restored snapshot is out of date until WTS completes a refresh. A partial
refresh updates successful repositories and retains the last valid data for
failed repositories with an out-of-date label.

## Data Contract

```text
MyReviewsSnapshot
  schemaVersion
  revision
  state                 ready | authRequired | partial | unavailable
  reviewer?
  reviews[]
  repositories[]
  refreshedAtUnixMs?
  restoredFromCache

MyReviewsReviewer
  provider              github
  host                  github.com
  login

MyReviewRequest
  reviewRequestId
  provider              github
  host                  github.com
  owner
  repository
  pullRequestNumber
  title
  authorLogin
  draft
  baseRefName
  headRefName
  providerUpdatedAtUnixMs
  firstObservedAtUnixMs
  lastObservedAtUnixMs
  workspaceIds[]
  repositoryIds[]
  freshness             current | outOfDate

MyReviewsRepositoryStatus
  owner
  repository
  workspaceIds[]
  state                 current | outOfDate | failed | unsupported
  errorKind?
```

`reviewRequestId` uses a versioned WTS-owned opaque ID. The UI must not build
an ID from a provider URL.

## Provider Contract

Add a replaceable provider boundary:

```text
GitHubReviewProvider
  authentication_status(host)
  current_user(host)
  list_individual_review_requests(host, repositories, reviewer)
```

The first adapter is `GhCliGitHubReviewProvider`.

The adapter uses typed process arguments without a shell. It checks `gh auth`
for `github.com`, resolves the current login, and requests bounded GraphQL
data through `gh api graphql`.

The adapter must verify each result:

1. Match the host, owner, and repository to the WTS allowlist.
2. Accept only open pull requests.
3. Inspect the review request nodes.
4. Accept only a `User` node whose login matches the current user.
5. Reject `Team` nodes, even when the current user belongs to the team.
6. Bound all strings, lists, page counts, and response sizes.
7. Reject malformed, incomplete, or cross-repository results.

The service can batch allowlisted repositories when the provider supports it.
It must preserve a repository-specific result so one failure can remain local.

## API and Backend

Add three read-only operations:

```text
get_my_reviews()
  -> MyReviewsSnapshot

refresh_my_reviews(expectedRevision?)
  -> MyReviewsSnapshot

open_my_review(reviewRequestId, expectedSnapshotRevision)
  -> OpenMyReviewResult
```

Expose the same contracts through loopback HTTP and Tauri.

### `get_my_reviews`

Return the cached snapshot without a network request. On first use, return an
empty loading-compatible contract when no snapshot exists.

### `refresh_my_reviews`

1. Read the current saved workspace registry.
2. Resolve trusted repository origins through Rust.
3. Keep only GitHub.com repositories.
4. Deduplicate repositories by normalized host, owner, and repository.
5. Check the provider authentication state.
6. Resolve the current reviewer identity.
7. Request individual review requests for the allowlist.
8. Validate each provider result.
9. Merge successful and failed repository results.
10. Store the new snapshot atomically.

Coalesce concurrent refreshes for the same registry revision and reviewer.
Cancel or ignore obsolete work after the registry or reviewer changes.

### `open_my_review`

Rust resolves the opaque review ID from the current stored snapshot. Rust then
re-resolves the linked repository identity from trusted WTS state.

Rust constructs this target from trusted fields:

```text
https://github.com/<owner>/<repository>/pull/<number>
```

The browser adapter keeps the target private. The operation returns only the
provider, repository identity, pull request number, and accepted handoff state.
It does not return the URL.

The operation rejects an unknown ID, stale snapshot revision, removed
repository, invalid repository identity, unsupported host, or invalid pull
request number.

## Authentication

The first release depends on a working `gh` CLI session for GitHub.com.

WTS runs only read operations. WTS does not request, print, copy, persist, or
return a GitHub token. WTS does not parse authentication files directly.

Authentication states:

| State | UI result |
| --- | --- |
| `gh` is not installed | Show **GitHub CLI is not installed**. |
| No GitHub.com session | Show **GitHub CLI sign-in is required**. |
| Session is valid | Refresh review requests. |
| Session lacks access to one repository | Keep other results and show a partial error. |
| Session changes user | Mark the old snapshot out of date and refresh for the new user. |

The provider interface must not expose `gh` details to the UI contract. A later
OAuth or app-based adapter must return the same normalized snapshot.

## Security and Privacy

- Resolve repositories only from saved WTS state.
- Treat repository origin strings as untrusted input until Rust validates them.
- Allow only HTTPS GitHub.com browser targets in v1.
- Reject credentials, ports, query strings, fragments, control characters,
  encoded traversal, and extra path segments.
- Use typed command arguments. Do not use a shell.
- Use a fixed executable name or a trusted configured executable path.
- Set a timeout for every `gh` process.
- Cap stdout, stderr, GraphQL pages, repositories, and review requests.
- Parse only the expected JSON schema.
- Sanitize all errors before they reach logs, storage, HTTP, Tauri, or the UI.
- Never log command environments, tokens, raw provider responses, or browser
  targets.
- Do not accept a provider URL as browser authority.
- Do not let the UI supply an owner, repository, host, or pull request number
  to the open operation.
- Keep the snapshot free of pull request bodies, comments, diffs, and file
  paths.
- Fail closed when the authenticated user or repository mapping is uncertain.

## Component Reuse

- Extend the existing Spaces toolbar in `LocalWorkspace.tsx`.
- Keep **My reviews** beside the existing **My time** action.
- Reuse the current Spaces heading, toolbar, back action, loading skeleton,
  recovery message, and live status patterns.
- Reuse React Aria buttons and the existing `Glyph` icons.
- Reuse repository grouping and compact metadata patterns from the current
  repository tables.
- Reuse the existing trusted forge parsing and browser launcher in
  `crates/wts-app/src/launcher.rs`.
- Follow the existing HTTP and Tauri transport parity in `wtsClient.ts`,
  `wts-server`, and `src-tauri`.
- Reuse the current focus return, roving focus, narrow layout, and reduced
  motion behavior.
- Do not reuse `WorkspaceChangeRequestDialog`. That dialog prepares a remote
  write handoff and has a different authority model.

## UI Copy

Use these exact primary labels:

- **My reviews**
- **Review**
- **Refresh**
- **Check again**
- **GitHub CLI sign-in is required**
- **GitHub CLI is not installed**
- **No reviews request your response**
- **Results are out of date**
- **Some repositories could not be checked**

Do not use **Assigned to me** or **Mentioned** in v1. Those labels describe
states that the first release does not include.

## Automated Validation

Every implementation change must add a test that fails against the preceding
implementation.

### Provider adapter tests

- Use a fake `gh` executable. Do not require network access.
- Prove that a valid authenticated user produces normalized review requests.
- Prove that only an explicit matching `User` review request is accepted.
- Prove that a `Team` review request is excluded.
- Prove that an assignment, mention, subscription, or authored pull request is
  excluded without an individual review request.
- Prove that closed pull requests are excluded.
- Prove that a result outside the repository allowlist is rejected.
- Prove that malformed JSON, oversized output, timeout, and nonzero exit map to
  bounded error kinds.
- Prove that no token, raw output, or command environment reaches an error.

### Service and persistence tests

- Prove that the service reads repositories only from saved WTS workspaces.
- Prove that duplicate repository links and duplicate pull requests produce
  one review row.
- Prove that one review row keeps all linked workspace IDs.
- Prove that a partial refresh updates successful repositories and retains
  out-of-date data for failed repositories.
- Prove that a restored snapshot starts out of date.
- Prove that a changed GitHub login does not reuse the old current snapshot.
- Prove that concurrent equivalent refreshes coalesce.
- Prove that an obsolete refresh cannot replace a newer snapshot.
- Prove that storage contains no token, raw response, body, comment, diff, file
  path, or provider URL.

### Trusted open tests

- Prove that the service builds the GitHub target from stored trusted identity
  and a bounded pull request number.
- Prove that the UI cannot supply a host, owner, repository, number, or URL.
- Reject stale revisions, removed repositories, unsupported hosts, credentials,
  ports, queries, fragments, traversal, and invalid numbers.
- Prove that HTTP and Tauri results do not return the browser target.

### Transport tests

- Prove exact request and response parity for HTTP and Tauri.
- Prove strict client normalization for all enums and bounded fields.
- Prove that malformed optional data fails closed.
- Prove that the desktop command manifest and permissions include only the new
  read and open commands.

### UI behavior tests

- Prove that **My reviews** appears beside **My time** in Spaces.
- Prove that the count uses unique pull requests.
- Cover loaded, initial loading, cached refresh, empty, no repository,
  authentication, missing CLI, out-of-date, partial error, and open failure
  states.
- Prove that a refresh keeps cached rows visible.
- Prove that **Review** calls only the opaque trusted open operation.
- Prove that draft state and multiple workspace mappings remain clear.
- Prove exact focus return and keyboard movement.
- Prove that the surface fits at 320, 768, and 1440 pixels.
- Prove that My reviews does not add a workspace tab or change a workspace lane.

### Integration check

Run one opt-in desktop or self-hosted check with a fake `gh` executable. Prove
that authentication, refresh, partial failure, cache restore, and browser
handoff use the same persisted snapshot.

## First Release

Include:

- a global My reviews surface
- a unique count in the Spaces toolbar
- GitHub.com
- explicit individual review requests
- WTS-linked repositories
- GitHub CLI authentication
- a replaceable provider adapter
- cached and partial results
- a read-only trusted **Review** action
- HTTP and Tauri parity
- keyboard and narrow-width support

## Deferred Scope

- GitLab merge requests
- GitHub Enterprise Server
- team review requests
- repository or organization team membership lookup
- assignee-based review queues
- `@mention` discovery
- subscriptions and notifications from GitHub
- pull requests outside WTS-linked repositories
- authored pull requests that need follow-up
- review comments, approvals, change requests, merges, labels, and assignments
- pull request body, diff, file, comment, or thread rendering inside WTS
- automatic workspace lane changes
- native notifications for new provider review requests
- background refresh while WTS is closed
- OAuth, GitHub App, or direct token authentication
- automatic agent review

## Open Questions

None for the first release.
