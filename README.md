# workswitch

`wts` is a tmux-backed CLI for moving dev servers and other long-running processes between Git worktrees.

It discovers worktrees from Git, reads process targets from `.wts.yaml`, and lets you hand off a single process or a process group to the worktree you want to work in.

https://github.com/user-attachments/assets/5705d308-a176-412f-b80f-af519fdf76f1

The installed command is `wts`.

## Requirements

- Go `1.26+`
- `git`
- `tmux`

## Install

```bash
go install github.com/xrehpicx/wts@main
```

## Update

```bash
go install github.com/xrehpicx/wts@main
```

## Quick Start

```bash
cd my-project
wts init
wts
```

`wts` opens the worktree/process switcher. `wts init` generates `.wts.yaml` for the current repo. `wts tui` remains available as an explicit alias for the TUI.

Use `make airflow` before submitting changes. It checks formatting, dependencies,
static analysis, race-tested coverage, known vulnerabilities, and the production
build—the same verification performed on every GitHub push and pull request.
This development command requires GNU Make and a POSIX-compatible shell; on
Windows, `go test -shuffle=on ./...` runs the platform test suite directly.

## More

- [docs/detectors.md](docs/detectors.md)
- [CHANGELOG.md](CHANGELOG.md)
