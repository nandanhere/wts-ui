# 0001 — Current WTS product and engineering direction

- **Status:** Accepted
- **Date:** 2026-08-01
- **Related implementation:** `5c34ec9` (`Simplify workspace navigation and launch flows`)
- **Related plans:**
  - `/.todo/workspace-navigation-simplification/PRD.md`
  - `/.todo/workbench-ia-simplification/PRD.md`
  - `/.todo/wts-ui-polish/PRD.md`

## Context

WTS has evolved from an earlier Next.js application toward a local-first Rust
service with a React/Vite interface. Recent work also simplified workspace
creation, issue imports, repository selection, workbench navigation, and agent
handoff. These decisions were previously distributed across implementation,
tests, PRDs, and conversation history.

This record establishes the current baseline. It does not authorize deletion
of legacy source or uncommitted work.

## Accepted decisions

### Canonical application architecture

- Rust is the trusted application core.
- React, TypeScript, and Vite provide the canonical user interface.
- The interface is exposed through either the Tauri desktop host or the
  authenticated loopback HTTP server.
- The older tracked Next.js application may be legacy, but removing it requires
  a separate explicit decision and migration review.

### Trust and effect boundaries

- Rust owns trusted filesystem paths, repository discovery, Git commands,
  effect validation, persistence, and external-process launch authority.
- The UI sends typed identifiers, reviewed selections, and approved effect
  digests. It does not grant authority by submitting arbitrary local paths or
  commands.
- User-visible success must reflect an accepted trusted-boundary response, not
  an optimistic assumption about an external tool.

### Workspace creation

- Users can move backward and forward through workspace-creation steps without
  losing reviewed repository, branch, service, or port choices.
- If the selected source repositories change, forward steps become stale until
  their dependent decisions have been reviewed again.
- Branch and source selection controls should use consistent, durable UI
  patterns rather than ad hoc per-row interactions.

### Issue imports and repository correlation

- Jira and OpenProject imports visibly show the imported title, status, project
  context, readable content, and recommended repositories.
- Repository recommendations include evidence and rationale rather than only a
  silent list of selected repositories.
- Correlation is currently deterministic and evidence-based. LLM-assisted
  correlation is a future enhancement and must expose its reasoning, retain a
  deterministic fallback, and avoid silently expanding filesystem authority.

### Workbench navigation and terminology

- The workbench has two destinations: **Workspace** and **Verification**.
- CLI and agent launch are actions, not navigation destinations.
- The saved preferred editor or agent is directly accessible. Alternatives are
  available through **Open with…**.
- Maintenance operations such as refresh, revision, and removal live under
  **More**.
- The internal `repositorySet` intent is presented as **Repositories**. The UI
  describes its source as repositories selected by the user rather than using
  the internal word “Set”.
- Legacy `/overview`, `/agent`, and `/cli` workspace routes resolve safely to
  the current Workspace destination.

### Verification, Graphify, and agent handoff

- Graphify is optional context, not a prerequisite for opening a workspace.
- Graph creation, rebuilding, and graph-informed coverage work live under
  Verification.
- Preparing a verification brief stays inside Verification. An editor or agent
  opens only after an explicit user action.
- Prepared briefs are saved as workspace-owned `WTS.md` files before an agent
  is allowed to rely on them.

### Documentation and generated artifacts

- Important product, architecture, operational, testing, and user documentation
  is retained even when build artifacts are cleaned.
- Canonical documentation must describe the current Workspace/Verification
  model. Older PRDs may remain as historical records but should not override an
  accepted decision.
- Generated build directories, dependency installations, test reports, and
  regenerable graph output are disposable. This includes `target`, `.next`,
  dependency `node_modules` directories, `.tools`, compiled UI output, test
  reports, and stale `graphify-out` output.
- Important uncommitted Rust, Tauri, deployment, testing, example, and
  documentation source must be preserved and committed before broad cleanup.
- Confidential invention notes remain local or move to controlled storage.
  Ordinary cleanup must not delete them.

## Consequences

- New work should not reintroduce Overview, CLI, or Agent as peer workbench
  tabs.
- UI tests must continue to cover visible terminology, reversible navigation,
  legacy-route compatibility, trusted launch responses, and prepared-brief
  behavior.
- Documentation containing old navigation language needs updating or an
  explicit historical label.
- Cleaning generated artifacts can recover substantial disk space without
  changing source, but source cleanup must be reviewed independently.

## Follow-up decisions still required

- Whether and when to remove the tracked legacy Next.js application.
- Whether repository correlation should add an LLM-assisted ranking layer.
- Which older PRDs should be archived after canonical documentation is updated.
- What release and retention policy should apply to generated desktop binaries.
