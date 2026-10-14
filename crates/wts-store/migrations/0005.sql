CREATE TABLE workspace_workflow_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL
        REFERENCES workspace_created_events(workspace_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (event_type = 'workspace.workflow-transitioned.v1'),
    from_state TEXT NOT NULL
        CHECK (from_state IN ('ready', 'active', 'review', 'parked')),
    to_state TEXT NOT NULL
        CHECK (to_state IN ('ready', 'active', 'review', 'parked')),
    workflow_revision INTEGER NOT NULL CHECK (workflow_revision > 1),
    event_json TEXT NOT NULL,
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
    UNIQUE (workspace_id, workflow_revision)
) STRICT;

CREATE TABLE workspace_workflow_projection (
    workspace_id TEXT PRIMARY KEY
        REFERENCES workspace_projection(workspace_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    state TEXT NOT NULL
        CHECK (state IN ('ready', 'active', 'review', 'parked')),
    workflow_revision INTEGER NOT NULL CHECK (workflow_revision > 0),
    updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= 0)
) STRICT;

INSERT INTO workspace_workflow_projection (
    workspace_id, state, workflow_revision, updated_at_unix_ms
)
SELECT workspace_id, 'ready', 1, updated_at_unix_ms
FROM workspace_projection;

CREATE INDEX workspace_workflow_state
    ON workspace_workflow_projection(state, updated_at_unix_ms DESC);

CREATE TRIGGER workspace_workflow_events_no_update
BEFORE UPDATE ON workspace_workflow_events
BEGIN
    SELECT RAISE(ABORT, 'workspace workflow events are append-only');
END;

CREATE TRIGGER workspace_workflow_events_no_delete
BEFORE DELETE ON workspace_workflow_events
BEGIN
    SELECT RAISE(ABORT, 'workspace workflow events are append-only');
END;
