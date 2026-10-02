# WTS full-stack lab

This lab creates two small Git repositories and uses the real Rust
`LocalWtsService` to materialize three independent issue workspaces:

| Issue | Workspace scope | Expected source change |
| --- | --- | --- |
| `UI-101` | `storefront-ui` | Frontend only |
| `API-202` | `checkout-api` | Backend only |
| `PAY-303` | Both repositories | Frontend and backend contract |

Every scenario follows the same observable lifecycle:

1. Create a WTS record and real Git worktree(s).
2. Inject a scenario-specific acceptance test and prove it fails.
3. Write `.wts-task.md` as provider-neutral agent context.
4. Build `graphify-out/graph.json` from that workspace only.
5. Apply a deterministic reference fix or delegate the task to one agent.
6. Prove the acceptance-test files were not edited.
7. Run the complete repository test commands and prove they pass.

## Run the deterministic reference flow

From the WTS repository root:

```bash
cargo run -p wts-app --example fullstack_lab
```

The command prints its generated lab root under the operating system's
temporary directory and leaves all repositories, workspaces, graphs, task
briefs, branches, and reports in place for inspection. Each invocation gets a
fresh output directory, so rerunning it also exercises workspace recreation
without branch or target collisions.

Use an explicit empty output directory when a stable path is useful:

```bash
cargo run -p wts-app --example fullstack_lab -- \
  --root /tmp/my-wts-fullstack-lab
```

## Run with an agent

Replace the reference executor with any adapter supported by WTS:

```bash
cargo run -p wts-app --example fullstack_lab -- --executor hermes
cargo run -p wts-app --example fullstack_lab -- --executor codex
cargo run -p wts-app --example fullstack_lab -- --executor opencode
```

The executable must already be installed and authenticated. WTS invokes one
agent per workspace with the workspace root as its working directory. The agent
is told to read `.wts-task.md` and `graphify-out/graph.json`, stay inside the
selected repositories, preserve acceptance tests, and run the listed checks.
No LLM is used for repository setup, worktree creation, graph extraction, or
verification.

The generated `lab-report.json` is suitable for automated regression checks.

## Add or validate scenarios

Scenarios are versioned JSON manifests in `scenarios/`. They declare selected
repositories, acceptance-file injections, direct executable/argument checks,
deterministic reference replacements, and the exact tracked source files that
may change. Paths are relative and validated, repository references must be in
scope, and checks are restricted to the lab's supported direct executables.
No manifest command is passed through a shell.

Validate every manifest without creating repositories or workspaces:

```bash
cargo run -p wts-app --example fullstack_lab -- --validate-only
```

An alternate scenario pack can be supplied with
`--scenario-dir /absolute/path/to/scenarios`. Its parent directory is treated
as the lab root for brief and acceptance-file paths.
