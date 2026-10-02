# GitLab merge request tracking PRD

## Overview

WTS discovers open GitLab merge requests that the current GitLab user authored
for WTS-linked managed repositories. WTS matches each merge request to the
trusted project and the managed source branch.

This feature closes the gap after **Continue in GitLab**. The repository row
replaces **Prepare MR** with a verified merge request status after GitLab
returns a match. GitLab remains the authority for merge request creation and
state.

## Product decisions

1. Make this feature GitLab-first. Keep the provider adapter replaceable.
2. Use the identity from the authenticated `glab` CLI session.
3. Check only WTS-linked managed repositories with trusted GitLab origins.
4. Discover merge requests authored by the current GitLab user.
5. Match by trusted GitLab host, project, and current managed source branch.
6. Do not treat **Continue in GitLab** as proof that a merge request exists.
7. Replace **Prepare MR** only after GitLab returns a verified match.
8. Keep the last successful snapshot when GitLab is unavailable.
9. Open a merge request only through a server-owned operation.
10. Keep the repository table as the main surface. Do not add a workspace tab.
11. Do not add billing. This local read-only provider check has no billable use.

## User needs

1. Know when a merge request exists for a managed repository branch.
2. Avoid preparing a second merge request for the same branch.
3. See the merge request number, state, and title without opening GitLab.
4. Open the correct merge request from the repository row.
5. Understand when WTS is checking GitLab or showing old information.
6. Recover when `glab` is missing, signed out, or unavailable.
7. Trust that agent text and WebView data cannot choose an external URL.

## User stories

- As a developer, I want WTS to find an MR that I created in GitLab.
- As a developer, I want **Prepare MR** to change to the current MR status.
- As a developer, I want WTS to check the exact managed source branch.
- As a developer, I want to open the verified MR with one action.
- As a developer, I want cached status to remain visible during a provider error.
- As a developer, I want clear setup instructions when `glab` is not ready.
- As a security reviewer, I want Rust to derive every project and browser target.

## Screens and flows

1. **Managed repository row** shows discovery, matched, setup, stale, and error
   states.
2. **Merge request details dialog** shows all active matches when GitLab returns
   more than one match.
3. **Existing change request dialog** keeps the reviewed GitLab handoff.
4. **Repository notice** reports refresh and browser-open results.

## Main flow

```text
User opens a workspace with a managed GitLab repository
        |
        v
WTS re-inspects the trusted worktree and Git origin
        |
        +---- Not GitLab ----------> Keep existing non-GitLab behavior
        |
        +---- No source branch ----> Show the existing local branch state
        |
        v
WTS asks the GitLab adapter for authored MRs in the trusted project
        |
        +---- glab needs setup ----> Show Provider sign-in required
        |
        +---- Provider fails ------> Show cached status or Status unavailable
        |
        v
WTS matches trusted project + exact source branch + current author
        |
        +---- No open match -------> Show Prepare MR
        |
        +---- One open match ------> Show MR !418 · Open or Draft
        |
        +---- Several matches -----> Show 2 MRs · Open >
        |
        v
User selects the verified MR status
        |
        v
Rust re-inspects the repository and opens /-/merge_requests/{iid}
```

## Handoff and discovery flow

```text
Repository row shows Prepare MR
        |
        v
User reviews the existing preparation dialog
        |
        v
User selects Continue in GitLab
        |
        v
Rust revalidates the draft and opens the trusted GitLab form
        |
        v
Repository row shows GitLab opened · Check again
        |
        +---- User did not create an MR ----> Check again keeps Prepare MR
        |
        v
User creates the MR in GitLab and returns to WTS
        |
        v
WTS refreshes once when the WTS window receives focus
        |
        +---- Provider has not indexed it --> No MR found · Check again
        |
        v
Repository row shows MR !418 · Open
```

WTS must not poll GitLab while the provider form remains open. WTS can refresh
once when its window receives focus. The user can always select **Check again**.

## Managed repository row

Reuse the current four-column repository table. Keep the local work summary as
the first line in the **Work** cell. Use the second line for delivery.

### Open merge request

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Repository       Base                    Work                  Verification  │
├──────────────────────────────────────────────────────────────────────────────┤
│ senzu ↗          develop                 ● 3 commits ahead     ● Review checks│
│                  51fcd9c2  ↻ Sync        ◉ MR !418 · Open  >                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

Selecting **MR !418 · Open** opens the verified MR. The visible title appears in
the accessible description and tooltip when the row cannot show it.

### Draft merge request

```text
│ senzu ↗          develop                 ● 3 commits ahead     ● Review checks│
│                  51fcd9c2  ↻ Sync        ◌ MR !418 · Draft >                  │
```

### No merge request

```text
│ senzu ↗          develop                 ● 3 commits ahead     ● Review checks│
│                  51fcd9c2  ↻ Sync        ⎇ Prepare MR                         │
```

### Initial check

```text
│ senzu ↗          develop                 ● 3 commits ahead     ● Review checks│
│                  51fcd9c2  ↻ Sync        ◌ Checking GitLab…                   │
```

Keep the row height stable while WTS checks GitLab.

### Form opened

```text
│ senzu ↗          develop                 ● 3 commits ahead     ● Review checks│
│                  51fcd9c2  ↻ Sync        GitLab opened · Check again          │
```

**Check again** starts an explicit refresh for this repository.

### Cached result

```text
│ senzu ↗          develop                 ● 3 commits ahead     ● Review checks│
│                  51fcd9c2  ↻ Sync        MR !418 · Open · Out of date  >      │
└──────────────────────────────────────────────────────────────────────────────┘
  GitLab is unavailable. WTS shows the last verified status.       [Retry]
```

Keep the trusted open action available for a cached match. Rust still
revalidates the repository and numeric MR identifier before it opens GitLab.

### Setup required

```text
│ senzu ↗          develop                 ● 3 commits ahead     ● Review checks│
│                  51fcd9c2  ↻ Sync        Provider sign-in required            │
└──────────────────────────────────────────────────────────────────────────────┘
  Sign in with glab to let WTS check GitLab merge requests.        [Check again]
```

Use these setup steps in help text:

```text
1. Install the GitLab CLI (`glab`).
2. Run `glab auth login --hostname <trusted-host>`.
3. Select Check again in WTS.
```

Do not show a token field in WTS.

### No cached result and provider error

```text
│ senzu ↗          develop                 ● 3 commits ahead     ● Review checks│
│                  51fcd9c2  ↻ Sync        Status unavailable                   │
└──────────────────────────────────────────────────────────────────────────────┘
  WTS could not check GitLab.                                      [Retry]
```

Keep **Prepare MR** available only when WTS has a successful current result
with no open match. An unknown provider result must not encourage a duplicate
merge request.

### Source head differs

```text
│ senzu ↗          develop                 ● 1 commit ahead       ● Review checks│
│                  51fcd9c2  ↻ Sync        MR !418 · Open · New local work  >   │
```

An MR remains the branch match when its provider head differs from local HEAD.
WTS must not show **Prepare MR** in this state.

### Several active matches

```text
│ senzu ↗          develop                 ● 3 commits ahead     ● Review checks│
│                  51fcd9c2  ↻ Sync        2 MRs · Open  >                      │
```

Selecting the summary opens the merge request details dialog.

## Merge request details dialog

Reuse the current Radix dialog shell, overlay, close action, status dots,
buttons, and typography.

```text
┌────────────────────────────────────────────────────────────────────┐
│ DELIVERY                                                           │
│ Merge requests · senzu                              [Check again] [×]│
├────────────────────────────────────────────────────────────────────┤
│ feat/SRETOOLS-7197                                      GitLab.com │
│ Current HEAD 51fcd9c2                                              │
├────────────────────────────────────────────────────────────────────┤
│ MR !418  Track the current delivery state                  OPEN    │
│ Updated 4 minutes ago · Head 51fcd9c2                    [Open ↗]  │
│                                                                    │
│ MR !412  Earlier delivery experiment                       DRAFT   │
│ Updated yesterday · Different target                    [Open ↗]  │
└────────────────────────────────────────────────────────────────────┘
```

Rules:

- Sort open before draft only when update times are equal.
- Otherwise sort by GitLab update time, newest first.
- Show at most 20 matches for one repository.
- Keep titles to 256 Unicode scalar values.
- Show source and target branches as bounded text.
- Use **Open** for the external action.
- Return focus to the repository delivery summary after close.
- Escape closes the dialog.
- Tab and Shift+Tab stay inside the dialog.

## UI state table

```text
                         first check
                             |
                             v
                    [Checking GitLab…]
                             |
          +------------------+------------------+
          |                  |                  |
        match              no match           failure
          |                  |                  |
          v                  v                  +---- cache ----> [Out of date]
 [MR !418 · Open]       [Prepare MR]            |
          |                                     +---- no cache -> [Unavailable]
          +---- head differs -> [New local work]
          |
          +---- user opens --> [Open in GitLab]

[Prepare MR] -> [GitLab form opened] -> [Check again]
                                           |
                           +---------------+---------------+
                           |                               |
                         found                          not found
                           |                               |
                           v                               v
                  [MR !418 · Open]             [No MR found · Check again]

Any state + trusted branch change -> clear branch result -> [Checking GitLab…]
Any state + missing glab/auth      -> [Setup required]
```

| Condition | Repository delivery state | Action |
| --- | --- | --- |
| First provider request runs | `Checking GitLab…` | Disabled |
| Refresh runs with cached data | Keep the MR summary plus `Checking…` | Open remains available |
| Current open match exists | `MR !418 · Open` | Open |
| Current draft match exists | `MR !418 · Draft` | Open |
| Several active matches exist | `2 MRs · Open` | Show details |
| Current result has no match | `Prepare MR` | Prepare |
| GitLab form was opened | `GitLab opened · Check again` | Check again |
| MR is not indexed yet | `No MR found · Check again` | Check again |
| Provider head differs | `MR !418 · Open · New local work` | Open |
| Source branch changed | Start a new check for the new branch | Disabled during check |
| Cached match and refresh fails | Cached summary plus `Out of date` | Open and Retry |
| No cache and provider fails | `Status unavailable` | Retry |
| `glab` is missing | `GitLab CLI required` | Check again |
| `glab` needs authentication | `Provider sign-in required` | Check again |
| Repository origin is not trusted | Keep existing unsupported-forge state | None |
| Worktree identity changes | Clear the result and re-inspect | Disabled |
| Browser open fails | Keep the summary and show an alert | Retry open |

## Match rules

WTS accepts a provider record only when all these rules pass:

1. The record comes from the authenticated GitLab host for a catalog-owned
   repository.
2. The provider project matches the normalized trusted origin project.
3. The merge request author matches the authenticated `glab` user.
4. The source branch equals the current managed worktree branch.
5. The merge request state is open.
6. The merge request IID is a positive bounded integer.

Draft is an open merge request property. A different provider head commit is a
freshness signal, not a failed match. This rule prevents a duplicate MR after
the developer adds local commits.

The first release supports same-project source branches. Fork merge requests
need verified source-project lookup and remain deferred.

## Provider authority and security

### Provider-owned facts

The authenticated GitLab API owns:

- current user identity
- merge request IID and global ID
- title
- open and draft state
- source and target branch
- source head commit when available
- author
- provider update time

### WTS-owned facts

Rust owns:

- repository ID
- trusted GitLab host and project path
- current managed worktree branch and HEAD
- project and branch match decision
- cached freshness state
- external browser target

### Untrusted facts

Agent reports, UI input, WebView responses, GitLab titles, and GitLab web URLs
are untrusted. They can help display or discover data. They cannot choose a
project query or browser destination.

### Security requirements

1. Derive every provider scope from the re-inspected catalog repository.
2. Accept HTTPS origins or validated Git SSH origins for Git discovery.
3. Reject credentials, ports that do not match the trusted origin, control
   characters, traversal, malformed project paths, and unsupported schemes.
4. Group provider requests by the trusted GitLab host.
5. Pass the host to `glab`. Do not let the client pass a host or project.
6. Use a 10-second command timeout and a 256 KiB output limit.
7. Check at most 20 repositories and return at most 50 merge requests per
   workspace refresh.
8. Bound every provider string before it enters a response or cache.
9. Remove tokens, command output, and generated URLs from errors and logs.
10. Never execute a shell. Pass command arguments directly to the runner.
11. Open only a reconstructed `https://<trusted-host>/<trusted-project>/-/merge_requests/<iid>`
    target.
12. Re-inspect repository identity before each open operation.
13. Do not return the reconstructed browser URL to the UI.

## Replaceable `glab` adapter

Add a `GitlabMergeRequestsAdapter` in `crates/wts-integrations`. Follow the
existing `GithubReviewsAdapter` boundary.

Inject these dependencies:

- `CommandRunner`
- `PathResolver`
- bounded in-memory cache

Adapter operations:

```text
GitlabMergeRequestsProvider
  current_user(host) -> GitlabIdentity
  list_authored_open(host, trusted_projects[]) -> GitlabMergeRequestInbox
```

The first implementation uses `glab auth status` and bounded `glab api`
commands. A future direct HTTP or OAuth adapter can implement the same provider
contract without changing the service, HTTP, Tauri, or client contracts.

The adapter must query project paths supplied by Rust. It must not accept raw
query fragments from the UI. Use one bounded request per trusted project when a
cross-project query cannot preserve exact project authority.

## Data contracts

```text
GitlabMergeRequestInboxState
  fresh | stale | auth | error

GitlabMergeRequestDiagnosticCode
  glabMissing
  authenticationRequired
  providerTimedOut
  providerOutputTooLarge
  providerFailed
  providerResponseInvalid

GitlabMergeRequest
  id
  repositoryId
  projectPath
  iid
  title
  authorUsername
  sourceBranch
  targetBranch
  sourceHeadCommitOid?
  updatedAt
  draft

GitlabMergeRequestInbox
  schemaVersion: 1
  state
  mergeRequests[]
  fetchedAtUnixMs?
  detail
  diagnosticCode?

OpenGitlabMergeRequestResult
  repositoryId
  iid
  accepted
```

Do not include a provider URL in the client contract. Rust needs only the
trusted repository and numeric IID to reconstruct the browser target.

## Service contract

Add these `LocalWtsService` operations:

```text
gitlab_merge_requests(workspace_id) -> GitlabMergeRequestInbox
open_gitlab_merge_request(repository_id, iid) -> OpenGitlabMergeRequestResult
```

`gitlab_merge_requests` must:

1. Load the workspace materialization.
2. Resolve its repository IDs against the current repository catalog.
3. Re-inspect each managed worktree.
4. Keep only trusted GitLab repositories with a current branch.
5. Ask the adapter for authored open merge requests.
6. Match and return rows with WTS repository IDs.

`open_gitlab_merge_request` must re-resolve and re-inspect the repository. It
must build a private `GitlabMergeRequestTarget` from the trusted origin and IID.

## HTTP contract

```text
GET  /api/v1/workspaces/{workspace_id}/merge-requests/gitlab
POST /api/v1/repositories/{repository_id}/merge-requests/gitlab/{iid}/open
```

The GET route accepts no host, project, author, or branch query parameters. The
server derives the full scope.

The POST route accepts no URL. The route path supplies only the opaque WTS
repository ID and numeric IID.

Use the existing protected request, admission, error, and JSON patterns. The
desktop and self-hosted transports must return the same serialized contract.

## Tauri contract

```text
get_gitlab_merge_requests(workspaceId)
open_gitlab_merge_request(repositoryId, iid)
```

Add generated allow and deny permissions. Add both allow permissions to the
default desktop capability. Keep stable error codes for missing CLI,
authentication, provider failure, changed repository identity, and browser
failure.

## Client contract

Add these methods to `WorkspaceClient`:

```text
getGitlabMergeRequests(workspaceId): Promise<GitlabMergeRequestInbox>
openGitlabMergeRequest(repositoryId, iid): Promise<OpenGitlabMergeRequestResult>
```

The client must normalize the full response. Reject unknown states, unknown
diagnostic codes, malformed timestamps, empty repository IDs, invalid IIDs,
invalid commit IDs, excessive arrays, and overlong provider text.

The UI must call `openGitlabMergeRequest(repositoryId, iid)`. The UI must never
call `window.open` with provider data.

## Cache and refresh

Follow the first-release My reviews cache pattern.

- Keep one bounded in-memory snapshot per trusted host and project.
- Replace a project snapshot only after a complete valid provider response.
- Return cached rows as `stale` after an adapter failure.
- Clear a row when a successful current response has no open match.
- Do not clear a row because of a timeout or malformed response.
- Start a refresh when the workspace opens.
- Start one refresh when WTS receives focus after a GitLab form handoff.
- Start a refresh when the user selects **Check again** or **Retry**.
- Do not start a provider request on every render.
- Cancel or ignore an older response after a newer refresh starts.

The cache does not survive an application restart in the first release.

## Component reuse

- Extend `DraftOverviewPanel` repository delivery state.
- Reuse `WorkspaceChangeRequestDialog` without changing provider authority.
- Add `RepositoryMergeRequestsDialog.tsx` for several matches.
- Reuse the Radix dialog shell and existing button, glyph, status-dot, notice,
  focus, and responsive patterns.
- Reuse `WorkspaceClientError` and exact Rust payload normalization.
- Reuse the GitHub My reviews adapter runner, timeout, cache, and diagnostic
  patterns.
- Keep existing `data-ui` IDs stable. Add a spoken label for each new ID.

Suggested callouts:

```text
data-ui="workspace.repository-delivery"
data-ui-label="Repository delivery"

data-ui="workspace.merge-requests-dialog"
data-ui-label="Merge request details"
```

Read `docs/ui-callouts.md` before implementation. Do not reuse an ID for a
different semantic region.

## Responsive and accessibility behavior

- Keep all interface text at 12 px or larger.
- Preserve the current table behavior at desktop widths.
- At narrow widths, keep the delivery summary after the local work summary.
- Give each MR action an accessible name with repository, IID, and state.
- Announce refresh results through the existing status notice.
- Use an alert for setup, provider, normalization, and browser errors.
- Preserve visible focus on **Prepare MR**, **Check again**, MR summary, and
  **Open**.
- Do not communicate state by color alone.
- Respect reduced-motion settings.

## Automated validation

The implementation must add a behavior or trusted-boundary test for each new
case. A construction-only assertion does not satisfy the project validation
rule.

### Adapter tests

- Prove that only catalog-owned GitLab projects reach `glab`.
- Prove exact host grouping for GitLab.com and a self-managed host.
- Prove that the adapter uses the authenticated identity.
- Prove exact project and authored-open scope.
- Prove exact source-branch matching.
- Prove that a different local and provider head still matches the branch.
- Prove that another author, project, or branch is rejected.
- Prove missing CLI and authentication diagnostics.
- Prove timeout, oversized output, command failure, and malformed JSON states.
- Prove title, branch, author, repository, and result bounds.
- Prove cached results become stale and remain available after a failure.
- Prove a successful empty response clears a previous match.

### Service and launch tests

- Prove that a workspace can query only its materialized repository IDs.
- Prove that Rust re-inspects each worktree before provider discovery.
- Prove that untrusted and non-GitLab origins never reach the adapter.
- Prove that the trusted origin and numeric IID produce the exact GitLab target.
- Prove nested GitLab groups and `.git` origins normalize correctly.
- Prove credentials, unexpected ports, traversal, queries, and fragments fail.
- Prove that changed repository identity blocks the open action.
- Prove that the launcher does not expose the URL to the UI response.

### HTTP and Tauri tests

- Prove GET parity for fresh, stale, auth, and error payloads.
- Prove POST parity for accepted and rejected open operations.
- Prove that unknown request fields fail.
- Prove that the GET route cannot accept provider scope from the client.
- Prove stable error codes and generated permissions.
- Prove the default capability includes only the required allow permissions.

### Client contract tests

- Prove exact HTTP paths and Tauri command names.
- Prove that malformed state, diagnostic, IID, timestamp, commit, and text fail.
- Prove that excessive result arrays fail.
- Prove that the open method sends only repository ID and IID.
- Prove that no provider URL enters the trusted open call.

### UI behavior tests

- Cover checking, current empty, open, draft, several matches, form opened,
  not indexed, stale, missing CLI, authentication, full error, and open failure.
- Prove that a current empty result shows **Prepare MR**.
- Prove that an unknown result does not show **Prepare MR**.
- Prove that an open match replaces **Prepare MR**.
- Prove that a different provider head shows **New local work** and not
  **Prepare MR**.
- Prove that cached rows stay visible during refresh and provider failure.
- Prove that **Check again** refreshes only the selected workspace scope.
- Prove that returning from the GitLab handoff starts one bounded refresh.
- Prove that an older refresh cannot replace a newer result.
- Prove the UI calls only the opaque trusted open operation.
- Prove dialog focus return, Escape, and focus containment.
- Prove desktop and narrow-width layouts.
- Prove that the feature does not add a workspace tab or change a lane.

### Optional integration check

Run the desktop application with a fake `glab` executable. Prove authentication,
current-user lookup, project query, row replacement, stale cache, and trusted
browser handoff through one deterministic process boundary.

Run a manual check with a test GitLab project:

1. Open a WTS managed branch with no merge request.
2. Select **Prepare MR** and create the merge request in GitLab.
3. Return to WTS.
4. Confirm that the row shows the new MR IID and state.
5. Select the MR status.
6. Confirm that WTS opens the exact trusted merge request.

## Billing

Billing does not apply. The feature uses the user's local GitLab CLI session and
does not create a hosted WTS job, subscription, or metered action. Do not add a
PG Boss job or a recurring billing record.

## First release

Include:

- GitLab.com and trusted self-managed GitLab HTTPS hosts
- WTS-linked managed repositories
- the current managed source branch
- merge requests authored by the authenticated `glab` user
- open and draft merge requests
- same-project source branches
- repository row replacement for **Prepare MR**
- a details dialog for several active matches
- bounded in-memory stale cache
- explicit refresh and one focus refresh after provider handoff
- trusted Rust-owned browser handoff
- HTTP and Tauri parity
- replaceable `glab` adapter
- keyboard, screen-reader, and narrow-width behavior

## Deferred scope

- GitHub authored pull request discovery
- GitLab merge requests outside WTS-linked repositories
- fork merge requests and source-project lookup
- merge requests authored by another user
- assignee and reviewer queues
- merged and closed history
- approvals, comments, discussions, labels, and merge actions
- pipeline and detailed check rendering
- automatic merge request creation through the API
- direct OAuth or personal access token fields in WTS
- persistent cache across application restarts
- background refresh while WTS is closed
- native notifications
- automatic workspace lane changes
- automatic agent review

## Open questions

None for the first release.
