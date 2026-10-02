CREATE TABLE workspace_code_review_threads (
    thread_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL
        REFERENCES workspace_created_events(workspace_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    target_kind TEXT NOT NULL CHECK (target_kind = 'code_change'),
    target_repository_id TEXT NOT NULL CHECK (
        length(target_repository_id) >= 1 AND length(target_repository_id) <= 512
    ),
    target_base_commit_oid TEXT NOT NULL CHECK (
        length(target_base_commit_oid) IN (40, 64)
        AND target_base_commit_oid NOT GLOB '*[^0-9A-Fa-f]*'
    ),
    target_head_commit_oid TEXT NOT NULL CHECK (
        length(target_head_commit_oid) IN (40, 64)
        AND target_head_commit_oid NOT GLOB '*[^0-9A-Fa-f]*'
    ),
    target_patch_sha256 TEXT NOT NULL CHECK (
        length(target_patch_sha256) = 71
        AND substr(target_patch_sha256, 1, 7) = 'sha256:'
        AND substr(target_patch_sha256, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    target_file_path TEXT NOT NULL CHECK (
        length(target_file_path) >= 1 AND length(target_file_path) <= 4096
    ),
    target_side TEXT NOT NULL CHECK (target_side IN ('additions', 'deletions')),
    target_line INTEGER NOT NULL CHECK (target_line >= 1 AND target_line <= 1000000),
    state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
    updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= created_at_unix_ms),
    resolved_at_unix_ms INTEGER CHECK (
        resolved_at_unix_ms IS NULL OR resolved_at_unix_ms >= created_at_unix_ms
    ),
    CHECK (
        (state = 'open' AND resolved_at_unix_ms IS NULL)
        OR (state = 'resolved' AND resolved_at_unix_ms IS NOT NULL)
    )
) STRICT;

CREATE TABLE workspace_code_review_comments (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL
        REFERENCES workspace_code_review_threads(thread_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    author TEXT NOT NULL CHECK (author IN ('user', 'agent')),
    body TEXT NOT NULL CHECK (length(body) > 0),
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0)
) STRICT;

CREATE INDEX workspace_code_review_threads_by_workspace
    ON workspace_code_review_threads(workspace_id, state, updated_at_unix_ms DESC, thread_id);

CREATE INDEX workspace_code_review_comments_by_thread
    ON workspace_code_review_comments(thread_id, sequence);

CREATE TRIGGER workspace_code_review_threads_anchor_immutable
BEFORE UPDATE OF
    workspace_id, target_kind, target_repository_id, target_base_commit_oid,
    target_head_commit_oid, target_patch_sha256, target_file_path, target_side,
    target_line, created_at_unix_ms
ON workspace_code_review_threads
BEGIN
    SELECT RAISE(ABORT, 'workspace code review thread anchors are immutable');
END;

CREATE TRIGGER workspace_code_review_threads_no_delete
BEFORE DELETE ON workspace_code_review_threads
BEGIN
    SELECT RAISE(ABORT, 'workspace code review threads cannot be deleted');
END;

CREATE TRIGGER workspace_code_review_comments_no_update
BEFORE UPDATE ON workspace_code_review_comments
BEGIN
    SELECT RAISE(ABORT, 'workspace code review comments are append-only');
END;

CREATE TRIGGER workspace_code_review_comments_no_delete
BEFORE DELETE ON workspace_code_review_comments
BEGIN
    SELECT RAISE(ABORT, 'workspace code review comments are append-only');
END;
