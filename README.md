# WTS

WTS is a local workspace supervisor for developers who work across several Git
repositories. It creates one isolated, issue-scoped workspace with linked Git
worktrees, opens the result in VS Code, and keeps review, verification, agents,
and delivery status in one desktop application.

WTS is local-first. Rust owns repository discovery, paths, Git operations,
process launch, and persistent state. The React interface sends stable IDs and
reviewed effect digests. It does not supply arbitrary paths, commands, or forge
URLs as authority.

> **Project status:** WTS is an early preview. Use it with repositories that
> have a backup and review each Git effect before you apply it. The macOS QA
> build is ad-hoc signed. It is not notarized and is not a public release.

## What WTS does

- Creates one workspace from a repository set, Jira issue, OpenProject work
  package, saved WTS plan, or VS Code workspace file.
- Resolves repositories only from configured local trust roots or an explicit,
  reviewed clone action.
- Creates a matching linked worktree for each selected repository.
- Opens the generated multi-root workspace in VS Code.
- Reviews committed and tracked working-tree changes without modifying them.
- Runs bounded, repository-owned verification commands and stores local
  evidence.
- Opens Codex, OpenCode, or Hermes in a trusted workspace directory.
- Tracks GitLab merge requests for the current branch.
- Lists direct GitHub review requests for repositories known to WTS.
- Checks and installs signed local QA updates automatically. The user controls
  when WTS restarts.

WTS does not upload repository contents to a WTS service. Provider tools such
as GitHub CLI, GitLab CLI, Jira MCP, OpenProject, ActivityWatch, and agent CLIs
have their own data and authentication boundaries.

## Main interface

- **Spaces** shows saved plans and materialized workspaces.
- **Workspace** shows repositories, branches, status, and actions.
- **Plans & Kanban** shows workspace planning files.
- **Changes** opens the repository review flow.
- **Verification** runs trusted repository checks.
- **My reviews** shows GitHub pull requests that request your review directly.
- **Updates** shows the configured automatic desktop update feed.
- **Environment & integrations** shows local tools, repositories, and provider
  connections. Open it from the gear button or press <kbd>Command</kbd>+<kbd>,</kbd>.

Read [How to use WTS](./docs/how-to-use-wts.md) for complete workflows and
troubleshooting.

## Requirements

Core development:

- Node.js and npm
- Rust 1.85 or later
- Git

Desktop development:

- macOS on Apple Silicon for the current QA packaging script
- Xcode command-line tools
- Tauri CLI 2.11.4
- The `aarch64-apple-darwin` Rust target

Optional tools:

- VS Code for generated workspaces
- GitHub CLI (`gh`) for **My reviews**
- GitLab CLI (`glab`), already configured for repository and merge-request access
- Codex, OpenCode, Hermes, Graphify, Jira MCP, OpenProject, or ActivityWatch
  for their corresponding integrations

## Start from source

Install dependencies:

```bash
npm ci
npm ci --prefix ui
```

Start the Tauri desktop development build:

```bash
npm run desktop:dev
```

WTS discovers existing local repositories below its configured trust roots.
Set the roots before startup when the defaults do not match your machine:

```bash
export WTS_REPOSITORY_ROOTS="/absolute/path/to/repositories:/another/trusted/root"
export WTS_WORKSPACE_ROOT="/absolute/path/to/generated-workspaces"
export WTS_DATA_DIR="/absolute/path/to/wts-data"
npm run desktop:dev
```

`WTS_REPOSITORY_ROOTS` uses the platform path separator. Use `:` on macOS and
Linux, and `;` on Windows. `WTS_REPOSITORY_ROOT` remains available for one
root. WTS does not follow symlinks during discovery.

## Build the macOS QA application

Build an ad-hoc signed Apple Silicon application and updater artifact:

```bash
npm run build:macos:qa
```

Build and install the verified application in `/Applications`:

```bash
npm run install:macos:qa
```

Closing the WTS window hides it. Open WTS again from the Dock or Applications.
Use **WTS → Quit WTS** or <kbd>Command</kbd>+<kbd>Q</kbd> to stop it.

The QA artifact is for local testing only. See the
[macOS application guide](./docs/macos-app.md) for signing, update, and public
distribution limits.

## Run the loopback browser host

Build the current React interface:

```bash
npm --prefix ui run build
```

Start the Rust host with explicit local directories:

```bash
export WTS_REPOSITORY_ROOT=/absolute/path/to/repositories
export WTS_WORKSPACE_ROOT=/absolute/path/to/generated-workspaces
export WTS_DATA_DIR=/absolute/path/to/wts-data
export WTS_ADDR=127.0.0.1:4300
cargo run -p wts-server
```

Open `http://127.0.0.1:4300/`. The server rejects non-loopback listener
addresses. Do not expose it directly to a network or the public internet.

For an x86_64 Linux host, see [Docker deployment](./DOCKER.md).

## Create your first workspace

1. Start WTS.
2. Open **Environment & integrations** from the gear button.
3. Open **Repositories** and confirm that WTS found the required repositories.
4. Select **New workspace**.
5. Choose **Repository set** for the simplest local flow.
6. Select the repositories and base branches.
7. Review the service proposals and save the plan.
8. Open the saved workspace and select **Review setup**.
9. Review the exact branches, commits, and target paths.
10. Select **Create workspace**.
11. Select **Open in VS Code**.

Preflight is read-only. Creation rechecks the reviewed digest before it writes
Git state. If one repository fails, WTS rolls back effects that it can prove
belong to that attempt.

## Provider sign-in

WTS does not include a token input.

- GitHub review discovery uses the active GitHub CLI account. Run
  `gh auth login` in a terminal before you open **My reviews**.
- GitLab merge-request discovery uses the existing GitLab CLI configuration.
  Install and configure `glab` in a terminal before you start WTS.
  **Environment & integrations → Integrations** reports CLI readiness for the
  active workspace. WTS does not start GitLab sign-in or manage credentials.

WTS never returns provider tokens to the WebView. It reconstructs browser
targets from re-inspected, catalog-owned repository origins.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `WTS_REPOSITORY_ROOTS` | Trusted repository roots as a platform path list | Unset |
| `WTS_REPOSITORY_ROOT` | One trusted repository root | `WTS_WORKSPACE_ROOT` |
| `WTS_WORKSPACE_ROOT` | Parent directory for managed workspaces | `$HOME/cd` |
| `WTS_DATA_DIR` | SQLite registry and application data | Platform data directory |
| `WTS_ADDR` | Browser-host loopback listener | `127.0.0.1:3000` |
| `WTS_UI_DIR` | Compiled interface directory | `ui/dist` |
| `WTS_OPENPROJECT_URL` | OpenProject instance origin | Unset |
| `WTS_OPENPROJECT_TOKEN` | OpenProject API token, read by Rust only | Unset |

Never commit real environment files or tokens. Copy documented example values
into your local runtime environment.

## Architecture

```text
React + TypeScript + Vite
       │
       ├── Tauri IPC on macOS
       └── authenticated loopback HTTP in a browser
                         │
                         ▼
                Rust LocalWtsService
        SQLite · repository catalog · Git worktrees
     verification · integrations · trusted process launch
```

The Rust service is the trusted boundary. It re-inspects repository identity,
origin, branch, and path before a Git mutation or external handoff. The desktop
and HTTP transports expose bounded, secret-free contracts.

See [Rust architecture](./docs/rust-architecture.md) and the
[testing strategy](./docs/testing-strategy.md).

## Development checks

Run the fast local gate:

```bash
bash scripts/test-fast.sh
```

Run the pull-request gate:

```bash
bash scripts/test-pr.sh
```

Run the main checks separately:

```bash
npm run audit:public
npm run lint:docs
npm --prefix ui test
npm --prefix ui run build
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

Install Playwright Chromium once before browser tests:

```bash
npm --prefix ui run test:e2e:install
```

## Documentation

- [How to use WTS](./docs/how-to-use-wts.md)
- [Open-source release readiness](./docs/open-source-readiness.md)
- [Contributing](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)
- [Review workspace changes](./docs/change-review.md)
- [Testing strategy](./docs/testing-strategy.md)
- [macOS application guide](./docs/macos-app.md)
- [Performance and capacity](./docs/performance-and-capacity.md)

## License status

No open-source license has been selected yet. The workspace metadata remains
`Proprietary` until the copyright owner chooses and adds a license. Do not
redistribute this repository as open source before that release blocker is
resolved.
