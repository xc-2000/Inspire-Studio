-- Source-only distribution: schema retained; seed/imported records omitted.

CREATE TABLE ecommerce_skills (
    id VARCHAR(100) PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    name VARCHAR(100) NOT NULL,
    description VARCHAR(600) NOT NULL DEFAULT '',
    type VARCHAR(10) NOT NULL CHECK (type IN ('text', 'image', 'video')),
    platforms JSONB NOT NULL CHECK (jsonb_typeof(platforms) = 'array' AND jsonb_array_length(platforms) > 0),
    output_types JSONB NOT NULL CHECK (jsonb_typeof(output_types) = 'array' AND jsonb_array_length(output_types) > 0),
    system_prompt TEXT NOT NULL,
    status SMALLINT NOT NULL DEFAULT 1 CHECK (status IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    deleted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ecommerce_skill_catalog_idx ON ecommerce_skills(deleted, status, type, sort_order, id);

ALTER TABLE ecommerce_jobs ADD COLUMN skill_id VARCHAR(100);

ALTER TABLE ecommerce_jobs ADD COLUMN skill_name VARCHAR(100);

ALTER TABLE ecommerce_jobs ADD COLUMN skill_revision INTEGER;
