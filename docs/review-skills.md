# Review skills

A review skill tells the WTS AI code review which rules to use. WTS reads the
skill, gives it to the review agent with the patch, and shows the result in
the diff viewer. You can use the Raptik skill, a team skill, or your own skill.
Select the skill in the **Skill** menu of the AI code review.

WTS never runs the scripts in a skill. The agent runs in a read-only sandbox.
WTS posts a comment to GitLab only when you select **Post to GitLab**.

## Add a skill

1. Make a directory for the skill, for example `~/.agents/skills/team-review`.
2. Write the rules in `SKILL.md` in that directory.
3. Optional: add a `wts-review.toml` manifest. See the next section.
4. Open the AI code review, then select the refresh button next to the model
   source. The skill shows in the **Skill** menu.

WTS looks for skills in these places, in this order:

1. Each path in `WTS_REVIEW_SKILL_DIRS`. Separate paths with `:`.
2. The path in `WTS_RAPTIK_SKILL_DIR`. This is the earlier override.
3. `$CODEX_HOME/skills`.
4. `~/.codex/skills`, `~/.agents/skills`, `~/.claude/skills`, and
   `~/.copilot/skills`.

A path can be one skill directory or a directory of skills. When two skills
have the same directory name, WTS uses the first one. WTS reads at most 40
skills.

A directory without a manifest is a review skill only when its name, its
`name` field, or its `description` field contains "review". Add a manifest to
show any other skill.

## Manifest

`wts-review.toml` is optional. Every field is optional. WTS rejects a manifest
with an unknown field.

```toml
schema = 1
label = "Team rules"            # The name in the Skill menu and the badge
reviewer = "Asha"               # Shows as "Asha said this before"
references = ["playbook.md"]    # At most 4 Markdown files, 16 KB each
precedents = "comments.jsonl"   # Past review comments
size_gate_lines = 500           # WTS stops before the agent for larger changes
strict_repositories = ["payments", "auth"]
```

Paths are relative to the skill directory. WTS ignores absolute paths and
paths with `..`.

The `precedents` file has one JSON object on each line:

```json
{"body": "Add a timeout to this call.", "file": "internal/client.go", "url": "https://gitlab.example.com/team/api/-/merge_requests/4#note_1"}
```

WTS matches each finding with the closest past comment. The finding then shows
the earlier comment and its link. The agent does not search the file.

WTS includes a built-in manifest for `raptik-review`: the playbook, Pratik's
comments, a 500-line gate, and strict review for senzu, pious, and coredhcp.

## Input to the agent

WTS builds one prompt with these parts, in this order:

1. Rules for the WTS sandbox. The agent must not post comments, edit files, or
   run skill scripts.
2. `<skill>`: the text of `SKILL.md`, at most 16 KB.
3. `<reference file="...">`: each reference file.
4. `<task>`: the workspace intent.
5. `<repository label base mode changedLines mergeRequest head>`: one patch for
   each repository. `mode` is `strict` or `normal`. `mergeRequest` shows when
   the review covers the published code of an MR.
6. The output contract.

The skill does not need its own report format. WTS replaces it with the output
contract.

## Output from the agent

The agent must return one JSON object:

```json
{
  "intent": "What the change is meant to do",
  "scope": "matches ticket",
  "summary": "One short paragraph",
  "findings": [
    {
      "label": "blocking | issue | question | suggestion | nit | praise",
      "repository": "api",
      "filePath": "internal/client.go",
      "line": 42,
      "side": "additions",
      "alsoLines": [55],
      "title": "Unbounded wait",
      "why": "slow server -> the request hangs",
      "code": "resp, err := http.Get(url)",
      "suggestedComment": "Issue: add a timeout to this call.",
      "fix": "client := &http.Client{Timeout: 5 * time.Second}"
    }
  ],
  "suggestedTests": ["A slow server test"],
  "notChecked": ["The Jira ticket"]
}
```

WTS shows each finding on its changed line. A finding that is not on a changed
line shows in the AI review panel.

Use `question` when the agent cannot confirm a suspicion from the code. WTS
lists these findings under **Questions for you**. You can answer a question
yourself, or post `suggestedComment` to the MR author.

## Post a finding to GitLab

In an MR workspace, open **Changes → Code**, then select **AI review**. WTS
reviews the published code of the MR, so each line refers to the MR version
on GitLab. Findings show on the lines of the **In the MR** view.

Select **Post to GitLab** on a finding to post its suggested comment:

- A finding on a changed line becomes a line comment. WTS sends the MR version
  that the agent reviewed. GitLab rejects the comment when the MR changed after
  the review. Run the review again in that case.
- Other findings become MR comments.

The button is off until WTS checks the MR with GitLab. Select **Refresh
conversations** when GitLab was offline.
