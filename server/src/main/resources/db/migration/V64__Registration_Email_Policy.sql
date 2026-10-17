-- Source-only distribution: schema retained; seed/imported records omitted.

CREATE TABLE registration_email_settings (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    allowed_domains TEXT[] NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Required empty-installation system setting; no existing account or business records.
INSERT INTO registration_email_settings(id) VALUES (1);
