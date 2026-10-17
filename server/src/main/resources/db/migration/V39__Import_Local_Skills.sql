-- Source-only distribution: schema retained; seed/imported records omitted.

ALTER TABLE skills ADD COLUMN import_key TEXT;

CREATE UNIQUE INDEX idx_skills_import_key ON skills(import_key) WHERE import_key IS NOT NULL;

SET LOCAL standard_conforming_strings = on;
