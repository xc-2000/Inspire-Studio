-- Source-only distribution: schema retained; seed/imported records omitted.

ALTER TABLE open_drama_project_settings
    ADD COLUMN deleted BOOLEAN NOT NULL DEFAULT FALSE;

DROP INDEX IF EXISTS idx_open_drama_project_settings_status_sort;

CREATE INDEX idx_open_drama_project_settings_status_sort
    ON open_drama_project_settings(deleted, enabled, featured DESC, sort_order, project_id);

COMMENT ON COLUMN open_drama_project_settings.deleted IS '项目是否已由管理员删除';
