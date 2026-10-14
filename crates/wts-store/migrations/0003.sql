CREATE TABLE workspace_tombstone_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL UNIQUE
        REFERENCES workspace_created_events(workspace_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (event_type = 'workspace.removed.v1'),
    event_json TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    effect_digest TEXT NOT NULL CHECK (length(effect_digest) = 71),
    result_json TEXT NOT NULL,
    removed_at_unix_ms INTEGER NOT NULL CHECK (removed_at_unix_ms >= 0)
) STRICT;

CREATE INDEX workspace_tombstone_removed
    ON workspace_tombstone_events(removed_at_unix_ms DESC, workspace_id ASC);

CREATE TRIGGER workspace_tombstone_events_no_update
BEFORE UPDATE ON workspace_tombstone_events
BEGIN
    SELECT RAISE(ABORT, 'workspace tombstones are append-only');
END;

CREATE TRIGGER workspace_tombstone_events_no_delete
BEFORE DELETE ON workspace_tombstone_events
BEGIN
    SELECT RAISE(ABORT, 'workspace tombstones are append-only');
END;
