-- Source-only distribution: schema retained; seed/imported records omitted.

ALTER TABLE platform_ai_model_configs
    ADD COLUMN new_model BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE platform_ai_model_configs ALTER COLUMN new_model SET DEFAULT TRUE;

COMMENT ON COLUMN platform_ai_model_configs.new_model IS '是否展示NEW标记，新增模型默认开启，可由管理员关闭';
