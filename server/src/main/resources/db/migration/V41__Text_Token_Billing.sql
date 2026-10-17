-- Source-only distribution: schema retained; seed/imported records omitted.

CREATE TABLE text_model_token_prices (
    model_config_id VARCHAR(64) PRIMARY KEY,
    official_model VARCHAR(100) NOT NULL DEFAULT '',
    currency VARCHAR(3) NOT NULL DEFAULT 'CNY' CHECK(currency IN ('CNY','USD')),
    exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1 CHECK(exchange_rate > 0),
    multiplier NUMERIC(18,6) NOT NULL DEFAULT 1 CHECK(multiplier >= 0),
    input_price NUMERIC(18,6) NOT NULL DEFAULT 0 CHECK(input_price >= 0),
    output_price NUMERIC(18,6) NOT NULL DEFAULT 0 CHECK(output_price >= 0),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE text_token_usage (
    call_id VARCHAR(100) PRIMARY KEY,
    user_id BIGINT NOT NULL,
    model_config_id VARCHAR(64) NOT NULL,
    input_tokens BIGINT NOT NULL CHECK(input_tokens >= 0),
    output_tokens BIGINT NOT NULL CHECK(output_tokens >= 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'CNY' CHECK(currency IN ('CNY','USD')),
    exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1 CHECK(exchange_rate > 0),
    multiplier NUMERIC(18,6) NOT NULL,
    input_price NUMERIC(18,6) NOT NULL,
    output_price NUMERIC(18,6) NOT NULL,
    credits INTEGER NOT NULL CHECK(credits >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_text_token_usage_user_created ON text_token_usage(user_id, created_at DESC);
