# Open-source release readiness

This document defines the work required before WTS moves to a public source
repository. It separates source publication from public binary distribution.

## Current assessment

| Area | State | Release action |
| --- | --- | --- |
| Current source secrets | Pass | Run `npm run audit:public` before each public push. |
| Personal and private fixtures | Pass after cleanup | Keep fixtures on reserved example paths and domains. |
| Generated local data | Protected | Keep `graphify-out/`, `.wts/`, agent state, build output, and update artifacts ignored. |
| README and user guide | Ready for preview | Recheck commands on a clean machine. |
| Contribution guide | Ready | Keep the trusted-boundary and test requirements. |
| Security policy | Ready | Enable private vulnerability reporting on the public host. |
| Open-source license | **Blocked** | Select a license, add `LICENSE`, and update Cargo and package metadata. |
| Git history | **Blocked for a full-history push** | Publish a reviewed clean snapshot or sanitize history before it becomes public. |
| Git remote | **Blocked for a public push** | Add a new public destination after the clean-snapshot decision. Keep the existing private remote separate. |
| macOS public binary | **Blocked** | Use Developer ID signing, notarization, stapling, and an HTTPS update feed. |
| Continuous integration | Needs release setup | Run format, test, build, documentation, and public-source audit gates. |

## Private-artifact scope

The public tree must not contain:

- credentials, private keys, cookies, or environment files
- personal usernames, home-directory paths, machine names, or email addresses
- private organization, Jira, GitLab, or repository hostnames
- private issue keys, repository names, or screenshots
- local databases, logs, traces, ActivityWatch data, agent transcripts, or
  generated workspaces
- Graphify output, build output, application bundles, disk images, updater
  artifacts, or signing keys

Use IANA-reserved examples in tests and documentation. Preferred values are
`example.com`, `example.test`, `example.invalid`, `/Users/example`, and
`/home/example`.

## Automated source audit

Run:

```bash
npm run audit:public
npm run test:public-audit
```

The audit checks tracked and non-ignored files. It rejects common private or
generated paths, personal home-directory paths, private key material, and
high-confidence credential prefixes. It reports only the file, line, and rule.
It does not print a detected value.

This check is a guard, not proof that the repository is safe. Review images,
fixtures, documentation, repository metadata, and diffs manually.

## History decision

Deleting a value from the current tree does not remove it from Git history.
The existing development history contains author metadata and earlier private
fixture values. Do not push the full history to a public remote without a
separate, reviewed history-sanitization operation.

The safest first publication is a new public repository or orphan release
branch made from the audited source snapshot. This keeps development history
private. If project provenance requires the full history, use a dedicated
history-rewrite tool, review every rewritten ref, and coordinate the force
push with all contributors. Do not perform that operation as part of a normal
feature change.

## License decision

The root Cargo workspace currently declares `license = "Proprietary"`. The
repository is not open source until the copyright owner selects a license and
grants redistribution rights.

Common options are:

- **Apache-2.0** for an explicit patent grant and notice requirements
- **MIT** for a short, permissive license
- **Apache-2.0 OR MIT** when contributors and downstream Rust users may choose
  either license

After the decision:

1. Add the exact license text as `LICENSE` or the required license files.
2. Update `Cargo.toml` and every published package manifest.
3. Add repository and license metadata to package manifests.
4. Add any required copyright and notice files.
5. Run the complete test and public-source audit gates.

## Public source release gate

1. Start from a clean clone or reviewed clean snapshot.
2. Confirm that only intended files are present with `git status`.
3. Run `npm ci` and `npm ci --prefix ui`.
4. Run `npm run audit:public`.
5. Run `bash scripts/test-pr.sh`.
6. Review binary and image metadata.
7. Review the staged diff and repository host settings.
8. Confirm the license and security-reporting route.
9. Push to a new private remote first and inspect its rendered contents.
10. Make the repository public only after a second-person review.

## Public binary release gate

Source publication does not make the current macOS artifact suitable for
download. A public desktop release also requires:

- an organization-owned bundle identifier
- Developer ID signing with hardened runtime
- Apple notarization and stapling
- a clean-machine Gatekeeper check
- a protected release signing environment
- a stable HTTPS update feed with key-rotation and rollback procedures
- published checksums and release notes

See [the macOS application guide](./macos-app.md).
