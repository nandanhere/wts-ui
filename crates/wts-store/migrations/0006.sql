CREATE TABLE workspace_review_threads (
    thread_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL
        REFERENCES workspace_created_events(workspace_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    target_kind TEXT NOT NULL CHECK (target_kind = 'planning_document'),
    target_document_id TEXT NOT NULL
        CHECK (target_document_id IN ('readme', 'plan', 'findings', 'kanban', 'programBacklog')),
    target_document_sha256 TEXT NOT NULL
        CHECK (
            length(target_document_sha256) = 71
            AND substr(target_document_sha256, 1, 7) = 'sha256:'
            AND substr(target_document_sha256, 8) NOT GLOB '*[^0-9a-f]*'
        ),
    target_line INTEGER
        CHECK (target_line IS NULL OR (target_line >= 1 AND target_line <= 1000000)),
    state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
    updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= created_at_unix_ms),
    resolved_at_unix_ms INTEGER
        CHECK (resolved_at_unix_ms IS NULL OR resolved_at_unix_ms >= created_at_unix_ms),
    CHECK (
        (state = 'open' AND resolved_at_unix_ms IS NULL)
        OR (state = 'resolved' AND resolved_at_unix_ms IS NOT NULL)
    )
) STRICT;

CREATE TABLE workspace_review_comments (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL
        REFERENCES workspace_review_threads(thread_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    author TEXT NOT NULL CHECK (author IN ('user', 'agent')),
    body TEXT NOT NULL CHECK (length(body) > 0),
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0)
) STRICT;

CREATE INDEX workspace_review_threads_by_workspace
    ON workspace_review_threads(workspace_id, state, updated_at_unix_ms DESC, thread_id);

CREATE INDEX workspace_review_comments_by_thread
    ON workspace_review_comments(thread_id, sequence);

CREATE TRIGGER workspace_review_threads_anchor_immutable
BEFORE UPDATE OF
    workspace_id, target_kind, target_document_id, target_document_sha256,
    target_line, created_at_unix_ms
ON workspace_review_threads
BEGIN
    SELECT RAISE(ABORT, 'workspace review thread anchors are immutable');
END;

CREATE TRIGGER workspace_review_threads_no_delete
BEFORE DELETE ON workspace_review_threads
BEGIN
    SELECT RAISE(ABORT, 'workspace review threads cannot be deleted');
END;

CREATE TRIGGER workspace_review_comments_no_update
BEFORE UPDATE ON workspace_review_comments
BEGIN
    SELECT RAISE(ABORT, 'workspace review comments are append-only');
END;

CREATE TRIGGER workspace_review_comments_no_delete
BEFORE DELETE ON workspace_review_comments
BEGIN
    SELECT RAISE(ABORT, 'workspace review comments are append-only');
END;
