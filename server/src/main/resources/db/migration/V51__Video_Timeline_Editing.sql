-- Source-only distribution: schema retained; seed/imported records omitted.

ALTER TABLE video_composition_tasks ADD COLUMN editing_options JSONB NOT NULL DEFAULT '{}';
