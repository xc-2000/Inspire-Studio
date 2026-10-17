-- Source-only distribution: schema retained; seed/imported records omitted.

CREATE TABLE IF NOT EXISTS new_api_channel_migrations (
    channel_id VARCHAR(100) PRIMARY KEY,
    original_config_encrypted TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
