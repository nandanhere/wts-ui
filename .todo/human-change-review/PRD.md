# Human Change Review PRD

## Overview

Make Changes the place where a person reviews all workspace code before the
workspace is accepted. WTS first opens a repository that has a local change.
It does not start on a clean repository.

## User Needs

1. Start with code that needs review.
2. Review agent work in a clear order.
3. See agent questions before a decision is hidden in code.
4. Add comments that stay with a file, hunk, or line.
5. Know what code is still not reviewed.

## User Stories

- As a reviewer, I want WTS to open the first repository with changes.
- As a reviewer, I want a review order that starts with behavior changes.
- As a reviewer, I want to answer an agent question near the related change.
- As a reviewer, I want to add a comment to a changed line.
- As a reviewer, I want to know when I reviewed all changed code.

## Screens and Flows

1. Change entry selects the first repository with a patch or untracked file.
2. Review brief shows the suggested order, risks, and agent questions.
3. Diff review lets a reviewer add and resolve comments.
4. Review summary shows reviewed files, open questions, and open comments.

## ASCII Design

```text
┌ Changes ──────────── Repository: scheduler ▾ ─ Graph ready ┐
│ Human review                                                │
│ Review 1 of 4: request path → state update → tests          │
│ Agent questions: 1 open                                     │
├─────────────────────────────────────────────────────────────┤
│ Review plan                                                  │
│ 1  api.go          Validate the behavior and error path      │
│ 2  scheduler.go    Check state and retry rules               │
│ 3  api_test.go     Confirm the test proves the behavior      │
│ Question: Is a retry safe after this state change? [Answer]  │
├───────────────┬───────────────────────────────┬─────────────┤
│ Files         │ Diff                          │ Comments    │
│ api.go        │ @@ request handler             │ 1 open      │
│ scheduler.go  │ + update state                 │ Add comment │
│ api_test.go   │                                │             │
└───────────────┴───────────────────────────────┴─────────────┘
```

## Component Reuse

- Use RepositoryReviewScreen for repository selection and review status.
- Use RepositoryPatchViewer for files, hunks, keyboard navigation, and line
  selection.
- Use existing WTS buttons, Glyph icons, semantic colors, and focus styles.

## API and Data

- The current release probes local repository diffs to select the first
  repository with changes.
- Add a durable review record before comments or agent questions are saved.
- The record must store a workspace ID, repository ID, patch base and head,
  file path, hunk or line range, author, state, and text.
- Add structured agent review output later. Do not infer agent questions from
  a diff and present them as agent output.

## Deferred Scope

- CodeRabbit findings and merge-request style review threads are deferred.
- External review findings must map to the same durable comment anchors.
