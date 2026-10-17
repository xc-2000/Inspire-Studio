-- Source-only distribution: schema retained; seed/imported records omitted.

CREATE TABLE credit_payment_orders (
    order_no VARCHAR(32) PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    request_id UUID NOT NULL,
    package_id VARCHAR(64) NOT NULL,
    description VARCHAR(127) NOT NULL,
    amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
    credits INTEGER NOT NULL CHECK (credits > 0),
    status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','CLOSED')),
    code_url TEXT,
    transaction_id VARCHAR(64) UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    paid_at TIMESTAMPTZ,
    last_checked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, request_id)
);

CREATE INDEX idx_payment_user ON credit_payment_orders(user_id, created_at DESC);

CREATE INDEX idx_payment_pending ON credit_payment_orders(last_checked_at NULLS FIRST) WHERE status = 'PENDING';

ALTER TABLE user_credit_transactions DROP CONSTRAINT ck_user_credit_transactions_type;

ALTER TABLE user_credit_transactions ADD CONSTRAINT ck_user_credit_transactions_type CHECK
 (transaction_type IN ('initial_grant','task_charge','task_refund','admin_adjustment','card_redeem','invitation_reward','daily_check_in','credit_expired','wechat_pay'));
