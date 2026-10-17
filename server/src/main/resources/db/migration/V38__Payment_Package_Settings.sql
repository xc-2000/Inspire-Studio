-- Source-only distribution: schema retained; seed/imported records omitted.

ALTER TABLE payment_collection_settings ADD COLUMN packages_json JSONB;

ALTER TABLE payment_collection_settings ADD COLUMN packages_version INTEGER NOT NULL DEFAULT 0;
