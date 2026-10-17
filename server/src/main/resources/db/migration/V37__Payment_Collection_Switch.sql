-- Source-only distribution: schema retained; seed/imported records omitted.

CREATE TABLE payment_collection_settings (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    enabled BOOLEAN,
    updated_by BIGINT REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Required empty-installation system setting; no existing account or business records.
INSERT INTO payment_collection_settings(id, enabled) VALUES (1, NULL);
