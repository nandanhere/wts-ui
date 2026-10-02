CREATE TABLE workspace_board_placement_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL
        REFERENCES workspace_created_events(workspace_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (
        event_type IN (
            'workspace.board-placed.v1',
            'workspace.board-follow-agent.v1',
            'workspace.board-auto-transitioned.v1'
        )
    ),
    from_state TEXT NOT NULL
        CHECK (from_state IN ('ready', 'active', 'review', 'parked')),
    to_state TEXT NOT NULL
        CHECK (to_state IN ('ready', 'active', 'review', 'parked')),
    from_mode TEXT NOT NULL CHECK (from_mode IN ('automatic', 'pinned')),
    to_mode TEXT NOT NULL CHECK (to_mode IN ('automatic', 'pinned')),
    from_rank INTEGER NOT NULL CHECK (from_rank >= 0),
    to_rank INTEGER NOT NULL CHECK (to_rank >= 0),
    workflow_revision INTEGER NOT NULL CHECK (workflow_revision > 1),
    event_json TEXT NOT NULL,
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
    UNIQUE (workspace_id, workflow_revision)
) STRICT;

CREATE TABLE workspace_board_placement_projection (
    workspace_id TEXT PRIMARY KEY
        REFERENCES workspace_projection(workspace_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    mode TEXT NOT NULL CHECK (mode IN ('automatic', 'pinned')),
    lane_rank INTEGER NOT NULL CHECK (lane_rank >= 0),
    updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= 0)
) STRICT;

INSERT INTO workspace_board_placement_projection (
    workspace_id, mode, lane_rank, updated_at_unix_ms
)
SELECT
    workspace_id,
    'automatic',
    ROW_NUMBER() OVER (
        PARTITION BY state
        ORDER BY updated_at_unix_ms DESC, workspace_id
    ) - 1,
    updated_at_unix_ms
FROM workspace_workflow_projection;

CREATE INDEX workspace_board_placement_rank
    ON workspace_board_placement_projection(lane_rank, workspace_id);

CREATE TRIGGER workspace_board_placement_events_no_update
BEFORE UPDATE ON workspace_board_placement_events
BEGIN
    SELECT RAISE(ABORT, 'workspace board placement events are append-only');
END;

CREATE TRIGGER workspace_board_placement_events_no_delete
BEFORE DELETE ON workspace_board_placement_events
BEGIN
    SELECT RAISE(ABORT, 'workspace board placement events are append-only');
END;
