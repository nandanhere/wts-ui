CREATE TABLE workspace_created_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL UNIQUE,
    record_version INTEGER NOT NULL CHECK (record_version > 0),
    event_type TEXT NOT NULL CHECK (event_type = 'workspace.created.v1'),
    event_json TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0)
) STRICT;

CREATE TABLE workspace_projection (
    workspace_id TEXT PRIMARY KEY
        REFERENCES workspace_created_events(workspace_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    record_version INTEGER NOT NULL CHECK (record_version > 0),
    record_json TEXT NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= 0)
) STRICT;

CREATE INDEX workspace_projection_updated
    ON workspace_projection(updated_at_unix_ms DESC, workspace_id ASC);

CREATE TRIGGER workspace_created_events_no_update
BEFORE UPDATE ON workspace_created_events
BEGIN
    SELECT RAISE(ABORT, 'workspace events are append-only');
END;

CREATE TRIGGER workspace_created_events_no_delete
BEFORE DELETE ON workspace_created_events
BEGIN
    SELECT RAISE(ABORT, 'workspace events are append-only');
END;
