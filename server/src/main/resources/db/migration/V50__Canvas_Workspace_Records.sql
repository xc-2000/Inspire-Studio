-- Source-only distribution: schema retained; seed/imported records omitted.

CREATE TABLE canvas_workspace_records (
    id VARCHAR(100) PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('template', 'version', 'run')),
    project_id VARCHAR(100) NOT NULL DEFAULT '',
    title VARCHAR(200) NOT NULL,
    visibility VARCHAR(20) NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
    revision INTEGER NOT NULL DEFAULT 1,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX canvas_workspace_owner_idx ON canvas_workspace_records(user_id, kind, project_id, updated_at DESC);

CREATE UNIQUE INDEX canvas_workspace_active_run_idx ON canvas_workspace_records(user_id, project_id) WHERE kind='run' AND data->>'status'='running';
