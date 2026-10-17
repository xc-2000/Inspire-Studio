-- Source-only distribution: schema retained; seed/imported records omitted.

ALTER TABLE skills
    DROP CONSTRAINT ck_skills_target_type;

ALTER TABLE skills
    ADD CONSTRAINT ck_skills_target_type
        CHECK (target_type IN ('image', 'video', 'canvasSettingGraph'));

COMMENT ON COLUMN skills.target_type IS '适用生成类型：image图片，video视频，canvasSettingGraph画布设定图';
