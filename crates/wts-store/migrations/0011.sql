-- A Jira workspace intent proves the primary issue key. Older stores saved
-- that relationship only in the immutable workspace record. Project it into
-- the work-item link table without inventing Jira fields that were not saved.
INSERT INTO workspace_work_item_links (
    link_id, workspace_id, provider, issue_key, role, summary, status,
    content, browser_url, fetched_at_unix_ms, revision,
    created_at_unix_ms, updated_at_unix_ms
)
SELECT
    substr(workspace.workspace_id, 1, 14) || '8' || substr(workspace.workspace_id, 16),
    workspace.workspace_id,
    'jira',
    json_extract(workspace.record_json, '$.intent.issueKey'),
    CASE
        WHEN EXISTS (
            SELECT 1
            FROM workspace_work_item_links AS existing_primary
            WHERE existing_primary.workspace_id = workspace.workspace_id
              AND existing_primary.role = 'primary'
        ) THEN 'related'
        ELSE 'primary'
    END,
    NULL,
    NULL,
    '',
    NULL,
    0,
    1,
    created.created_at_unix_ms,
    created.created_at_unix_ms
FROM workspace_projection AS workspace
JOIN workspace_created_events AS created
  ON created.workspace_id = workspace.workspace_id
WHERE json_extract(workspace.record_json, '$.intent.type') = 'jira'
  AND NOT EXISTS (
      SELECT 1
      FROM workspace_work_item_links AS existing
      WHERE existing.workspace_id = workspace.workspace_id
        AND existing.provider = 'jira'
        AND existing.issue_key = json_extract(workspace.record_json, '$.intent.issueKey')
  );

-- The event records that the migration added the compatibility projection.
-- The derived version-8 UUID is stable for one immutable workspace identity.
INSERT INTO workspace_work_item_link_events (
    event_id, workspace_id, link_id, event_type, link_revision,
    event_json, created_at_unix_ms
)
SELECT
    link.link_id,
    link.workspace_id,
    link.link_id,
    'workspace.work-item-linked.v1',
    link.revision,
    json_object(
        'schemaVersion', 1,
        'eventId', link.link_id,
        'eventType', 'workspace.work-item-linked.v1',
        'link', json_object(
            'linkId', link.link_id,
            'workspaceId', link.workspace_id,
            'provider', 'jira',
            'role', CASE link.role
                WHEN 'created_from_workspace' THEN 'createdFromWorkspace'
                ELSE link.role
            END,
            'snapshot', json_object(
                'issueKey', link.issue_key,
                'content', link.content,
                'fetchedAtUnixMs', link.fetched_at_unix_ms
            ),
            'revision', link.revision,
            'createdAtUnixMs', link.created_at_unix_ms,
            'updatedAtUnixMs', link.updated_at_unix_ms
        )
    ),
    link.created_at_unix_ms
FROM workspace_work_item_links AS link
JOIN workspace_projection AS workspace
  ON workspace.workspace_id = link.workspace_id
WHERE link.link_id = substr(link.workspace_id, 1, 14) || '8' || substr(link.workspace_id, 16)
  AND link.provider = 'jira'
  AND link.issue_key = json_extract(workspace.record_json, '$.intent.issueKey')
  AND NOT EXISTS (
      SELECT 1
      FROM workspace_work_item_link_events AS existing
      WHERE existing.link_id = link.link_id
  );
