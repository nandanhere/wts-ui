# Contributing to WTS

Thank you for improving WTS. This project manages local repositories and
starts external developer tools, so changes must keep authority boundaries
explicit and testable.

## Before you start

1. Search existing issues and pull requests for related work.
2. Open an issue before a large behavior or contract change.
3. Keep one pull request focused on one problem.
4. Do not include repository data, tokens, personal paths, private hostnames,
   screenshots with private content, or generated local artifacts.

## Development setup

Install Node and Rust dependencies:

```bash
npm ci
npm ci --prefix ui
cargo fetch
```

Start the desktop development application:

```bash
npm run desktop:dev
```

Use only test repositories or repositories with a backup. Configure explicit
trust roots when you do not want WTS to use its default local directories.

## Make a change

- Keep filesystem, Git, process, browser, and credential authority in Rust.
- Send stable IDs and bounded user intent across the UI boundary.
- Re-inspect trusted state immediately before a mutation or external handoff.
- Do not accept a WebView path, URL, executable, or command as authority.
- Keep errors secret-free and useful.
- Follow [the writing style](./docs/writing-style.md) for interface and
  documentation text.
- Follow [the UI callout guide](./docs/ui-callouts.md) when you add or change a
  `data-ui` callout.

Add an automated validation test for every feature and defect fix. Test the
closest deterministic boundary. A construction-only assertion is not enough
for an integration boundary.

## Run checks

Run the fast gate while you work:

```bash
bash scripts/test-fast.sh
```

Run the full pull-request gate before you submit:

```bash
bash scripts/test-pr.sh
```

Run the public-source audit before every public push:

```bash
npm run audit:public
```

The main checks are also available separately:

```bash
npm run lint:docs
npm run lint:ui-copy
npm --prefix ui test
npm --prefix ui run build
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

## Pull requests

Describe:

- the user problem
- the trusted boundary that changed
- the expected behavior
- the validation that proves the behavior
- any manual or platform-specific check that remains

Do not attach production logs or private repository examples. Use reserved
domains such as `example.com`, `example.test`, and `example.invalid`. Use paths
such as `/Users/example/repositories` in fixtures.

## Security reports

Do not open a public issue for a suspected vulnerability. Follow
[the security policy](./SECURITY.md).
