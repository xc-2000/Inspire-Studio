-- Source-only distribution: schema retained; seed/imported records omitted.

CREATE INDEX idx_platform_ai_channels_status_created_at
    ON platform_ai_channels(status, created_at DESC, id DESC);
