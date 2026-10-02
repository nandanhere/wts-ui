CREATE TABLE workspace_lifecycle_projection (
    workspace_id TEXT PRIMARY KEY
        REFERENCES workspace_projection(workspace_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    workspace_record_version INTEGER NOT NULL CHECK (workspace_record_version > 0),
    materialization_state TEXT NOT NULL
        CHECK (materialization_state IN (
            'not_materialized',
            'materialized',
            'needs_attention'
        )),
    worktree_count INTEGER NOT NULL CHECK (worktree_count >= 0),
    observed_at_unix_ms INTEGER NOT NULL CHECK (observed_at_unix_ms >= 0)
) STRICT;

CREATE INDEX workspace_lifecycle_materialization
    ON workspace_lifecycle_projection(materialization_state, observed_at_unix_ms DESC);
