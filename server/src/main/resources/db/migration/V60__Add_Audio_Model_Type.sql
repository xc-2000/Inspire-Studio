-- Source-only distribution: schema retained; seed/imported records omitted.

ALTER TABLE platform_ai_model_configs DROP CONSTRAINT IF EXISTS ck_platform_ai_model_configs_type;

ALTER TABLE platform_ai_model_configs
    ADD CONSTRAINT ck_platform_ai_model_configs_type CHECK (model_type IN ('image', 'video', 'text', 'audio'));

COMMENT ON COLUMN platform_ai_model_configs.model_type IS '模型类型：image、video、text、audio';

ALTER TABLE user_ai_model_configs DROP CONSTRAINT IF EXISTS ck_user_ai_model_configs_type;

ALTER TABLE user_ai_model_configs
    ADD CONSTRAINT ck_user_ai_model_configs_type CHECK (model_type IN ('image', 'video', 'text', 'audio'));

COMMENT ON COLUMN user_ai_model_configs.model_type IS '模型类型：image、video、text、audio';
