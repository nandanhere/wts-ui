CREATE TABLE workspace_work_item_links (
    link_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL
        REFERENCES workspace_created_events(workspace_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    provider TEXT NOT NULL CHECK (provider = 'jira'),
    issue_key TEXT NOT NULL,
    role TEXT NOT NULL
        CHECK (role IN ('primary', 'related', 'created_from_workspace')),
    summary TEXT,
    status TEXT,
    content TEXT NOT NULL,
    browser_url TEXT,
    fetched_at_unix_ms INTEGER NOT NULL CHECK (fetched_at_unix_ms >= 0),
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
    updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= created_at_unix_ms),
    UNIQUE (workspace_id, provider, issue_key)
) STRICT;

CREATE UNIQUE INDEX workspace_work_item_links_one_primary
    ON workspace_work_item_links(workspace_id)
    WHERE role = 'primary';

CREATE INDEX workspace_work_item_links_by_workspace
    ON workspace_work_item_links(workspace_id, created_at_unix_ms, link_id);

CREATE TABLE workspace_work_item_link_confirmations (
    idempotency_key TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL
        REFERENCES workspace_created_events(workspace_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    preview_digest TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0)
) STRICT;

CREATE TABLE workspace_work_item_link_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL
        REFERENCES workspace_created_events(workspace_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    link_id TEXT NOT NULL,
    event_type TEXT NOT NULL
        CHECK (event_type IN ('workspace.work-item-linked.v1', 'workspace.work-item-unlinked.v1')),
    link_revision INTEGER NOT NULL CHECK (link_revision > 0),
    event_json TEXT NOT NULL,
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0)
) STRICT;

CREATE INDEX workspace_work_item_link_events_by_workspace
    ON workspace_work_item_link_events(workspace_id, sequence);

CREATE TRIGGER workspace_work_item_link_confirmations_no_update
BEFORE UPDATE ON workspace_work_item_link_confirmations
BEGIN
    SELECT RAISE(ABORT, 'workspace work-item link confirmations are append-only');
END;

CREATE TRIGGER workspace_work_item_link_confirmations_no_delete
BEFORE DELETE ON workspace_work_item_link_confirmations
BEGIN
    SELECT RAISE(ABORT, 'workspace work-item link confirmations are append-only');
END;

CREATE TRIGGER workspace_work_item_link_events_no_update
BEFORE UPDATE ON workspace_work_item_link_events
BEGIN
    SELECT RAISE(ABORT, 'workspace work-item link events are append-only');
END;

CREATE TRIGGER workspace_work_item_link_events_no_delete
BEFORE DELETE ON workspace_work_item_link_events
BEGIN
    SELECT RAISE(ABORT, 'workspace work-item link events are append-only');
END;
