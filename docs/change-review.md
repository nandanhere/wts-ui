# Review workspace changes

WTS provides a full-screen change review for each repository in a materialized
workspace. The screen keeps review separate from the Workbench. It does not
open as a card or a modal.

## Open the review

1. Open a materialized workspace in the Workbench.
2. Find a repository that has local changes.
3. Select its **Review changes** action.

WTS opens this route:

```text
/sessions/<workspace-id>/changes?repository=<repository-id>
```

Use the back action to return to the Workbench. Use **Open in VS Code** when
you want to work in the generated multi-root workspace instead.

## Review the patch

The **Code** filter is active by default. It hides test files so that the main
implementation path stays visible. Select **Tests** to inspect only tests, or
select **All** to inspect the complete patch.

Select a changed file to move to its patch. Use the unified or split control to
change the patch layout. Line wrapping is optional.

Command-click an identifier on macOS, or Control-click it on other platforms,
to inspect changed references. Select a changed reference to move to that file.
The context rail also shows related changed tests.

## Graphify context

The review works without Graphify. In that state, reference navigation and
test suggestions use the changed patch only.

When the workspace has a trusted Graphify snapshot, WTS validates its evidence
digest before it reads graph data. It then:

- keeps nodes that belong to the selected repository.
- returns at most 4,000 nodes and 12,000 links.
- reports when the graph context was truncated.
- uses graph relationships to add repository references and related tests.

Graph results outside the changed patch appear as context. They do not replace
the patch and are not yet direct file-opening actions. Re-index the workspace
from **Workspace actions** when the graph snapshot is missing or stale.

## Trust boundary

The browser sends a workspace ID and repository ID. Rust resolves the trusted
workspace and repository paths. The browser does not send an arbitrary file
path as authority.

The diff and graph responses are bounded. Invalid graph evidence does not
silently become review context. WTS returns the patch without graph context and
keeps the deterministic review available.
