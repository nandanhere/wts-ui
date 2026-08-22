CREATE TABLE workspace_work_item_observations (
    workspace_id TEXT NOT NULL
        REFERENCES workspace_created_events(workspace_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    issue_key TEXT NOT NULL,
    source_file TEXT NOT NULL,
    observed_at_unix_ms INTEGER NOT NULL CHECK (observed_at_unix_ms >= 0),
    PRIMARY KEY (workspace_id, issue_key, source_file)
) STRICT;

CREATE INDEX workspace_work_item_issue
    ON workspace_work_item_observations(issue_key, workspace_id);
