# Security policy

WTS has direct access to local repositories, Git, selected developer tools,
and application data. Treat reports about path authority, command execution,
credential exposure, repository mutation, update verification, or loopback
authentication as security reports.

## Report a vulnerability

Use the repository host's private vulnerability reporting feature. Do not open
a public issue and do not include a real token, private key, repository, or
personal file in a report.

Include:

- the affected version or commit
- the operating system and architecture
- the smallest safe reproduction
- the expected and observed trust boundary
- the potential impact
- a suggested mitigation, if available

Use a temporary test repository and replace private values with reserved
examples. The maintainers should acknowledge the report within seven days and
provide a status update within fourteen days. These targets are not a promise
of a fix date.

## Supported versions

WTS is an early preview. Security fixes apply to the latest source revision and
the latest available preview build. Older preview builds are not supported.

## Security boundaries

- The Rust service owns filesystem, Git, process, and browser-launch authority.
- The WebView supplies stable IDs and bounded intent, not arbitrary commands or
  paths.
- Browser-host mode binds to loopback only and uses a per-process session.
- Provider CLIs own their credentials. WTS does not return provider tokens to
  the interface.
- Desktop updates require signature, size, and digest verification before
  installation.

See [Rust architecture](./docs/rust-architecture.md) for more detail.
