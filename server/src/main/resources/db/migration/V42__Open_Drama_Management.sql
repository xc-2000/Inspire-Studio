-- Source-only distribution: schema retained; seed/imported records omitted.

CREATE TABLE open_drama_settings (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    allow_fork BOOLEAN NOT NULL DEFAULT TRUE,
    maintenance_message VARCHAR(500) NOT NULL DEFAULT '',
    updated_by BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE open_drama_project_settings (
    project_id BIGINT PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    featured BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL DEFAULT 1000 CHECK (sort_order >= 0),
    display_name VARCHAR(200) NOT NULL DEFAULT '',
    display_description TEXT NOT NULL DEFAULT '',
    updated_by BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_open_drama_project_settings_status_sort
    ON open_drama_project_settings(enabled, featured DESC, sort_order, project_id);

COMMENT ON TABLE open_drama_settings IS '开源短剧全局运营配置';

COMMENT ON TABLE open_drama_project_settings IS '开源短剧项目启停、推荐、排序及展示覆盖配置';

-- Required empty-installation system setting; no existing account or business records.
INSERT INTO open_drama_settings(id, enabled, allow_fork, maintenance_message) VALUES (1, TRUE, TRUE, '');
