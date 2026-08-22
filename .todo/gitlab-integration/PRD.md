# GitLab CLI integration

## Status

- Product design: aligned with the implemented thin slice
- Release: first local desktop release
- Owner: WTS
- Billing: not applicable

## Overview

WTS uses an existing GitLab CLI configuration to discover merge requests for
managed GitLab repositories. The user installs and configures `glab` outside
WTS. WTS does not start sign-in, collect tokens, select accounts, or change CLI
configuration.

The setup or settings screen is the only place that shows GitLab CLI readiness.
Workspace repository rows show merge-request results only. They do not show
sign-in, connection, retry, or CLI setup controls.

## Product decisions

1. Treat an installed and configured `glab` as a prerequisite.
2. Derive GitLab hosts and projects from trusted managed repositories.
3. Use the active CLI account for each repository host.
4. Show CLI and account status only in **Environment & integrations**.
5. Keep repository rows focused on discovered merge requests.
6. Show **Prepare MR** only after a fresh provider result confirms that no
   matching merge request exists.
7. Do not show **Prepare MR** after an authentication, provider, transport, or
   stale-cache result.
8. Do not expose a WTS-owned GitLab sign-in command over HTTP or Tauri.
9. Do not add a token field, OAuth client, embedded provider page, or account
   selector.

## User needs

- Know whether the configured CLI can access the active workspace hosts.
- See the active CLI username for each trusted host.
- See an existing merge request without repeated setup controls in each row.
- Get a clear Terminal instruction when the prerequisite is not ready.
- Trust that WTS does not receive or manage GitLab credentials.

## Main flow

```text
User installs and configures glab in Terminal
                       |
                       v
WTS opens a workspace and re-inspects managed repositories
                       |
                       v
WTS derives trusted host + project + source branch
                       |
                       v
WTS asks glab for the active user and matching open merge requests
          +------------+-------------+
          |                          |
          v                          v
Matching MR exists            Fresh result has no MR
Show MR !N · Open             Show Prepare MR
```

## Settings flow

```text
Environment & integrations
  GitLab
    CLI missing       Install and configure glab in Terminal
    Host not ready    Configure glab for this host in Terminal
    Host ready        Signed in as <username>
    Check failed      Show safe diagnostic detail
    [Check connection]
```

The manual check reads status again. It does not start authentication.

## Repository-row behavior

| Provider result | Repository-row behavior |
| --- | --- |
| Matching open or draft MR | Show the trusted MR action |
| Fresh and no matching MR | Show **Prepare MR** |
| Loading | Show no GitLab action |
| CLI missing or not configured | Show no GitLab action |
| Provider or transport error | Show no GitLab action |
| Stale cached result | Show cached MR actions only |

The row does not show **Sign in**, **Check MR**, **Check connection**, or CLI
instructions. These controls and instructions belong only in settings.

## Trusted boundary

1. The WebView sends only a workspace ID for status and discovery.
2. Rust reloads the workspace materialization and repository catalog.
3. Rust re-inspects each managed worktree.
4. Rust resolves the remote that tracks the planned base branch. The remote
   name can be `origin`, `upstream`, or another valid Git remote name.
5. Rust derives and validates the GitLab host, project, current source branch,
   and current HEAD.
6. Rust resolves `glab` from fixed system locations and `PATH`.
7. Provider commands have a 10-second timeout and a 256 KiB output limit.
8. Results are limited to 20 repositories, 20 merge requests per repository,
   and 50 merge requests per response.
9. No token, credential, executable path, provider URL, or command crosses the
   WebView boundary.
10. Merge-request browser targets are reconstructed from re-inspected trusted
    repository state.

## Contracts

```text
GET /api/v1/workspaces/{workspaceId}/integrations/gitlab
get_gitlab_integration_status(workspaceId)

GitlabIntegrationStatus {
  schemaVersion: 1
  cliState: ready | missing
  accounts: Array<{
    host: string
    state: signedIn | signedOut | error
    username?: string
  }>
  detail: string
}
```

There is no sign-in route or Tauri command.

## Validation

- Prove that a managed worktree with no `origin` remote still resolves the
  planned base branch tracking remote.
- Prove that an existing MR for the exact trusted project and source branch is
  returned.
- Prove that repository rows never render GitLab setup controls.
- Prove that settings reports ready, missing, signed-out, and error states.
- Prove that **Check connection** only refreshes status.
- Prove that HTTP and Tauri do not expose a GitLab sign-in operation.
- Run one optional integration check with a configured `glab` account and an
  existing MR on a non-`origin` tracking remote.

## Deferred scope

- GitLab CLI installation
- GitLab authentication and account switching
- sign-out and credential mutation
- reviewer and assignee inboxes
- fork merge-request discovery
- merge, approve, comment, or edit actions
- background checks while WTS is closed
- persistent provider response cache
