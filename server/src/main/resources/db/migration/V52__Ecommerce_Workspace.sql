-- Source-only distribution: schema retained; seed/imported records omitted.

CREATE TABLE ecommerce_projects (
    id VARCHAR(100) PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    platform VARCHAR(20) NOT NULL CHECK (platform IN ('taobao', 'jd', 'pinduoduo', 'douyin', 'xiaohongshu')),
    title VARCHAR(200) NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (id, user_id)
);

CREATE INDEX ecommerce_project_owner_idx ON ecommerce_projects(user_id, platform, updated_at DESC);

CREATE TABLE ecommerce_jobs (
    id VARCHAR(100) PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    project_id VARCHAR(100) NOT NULL,
    request_id VARCHAR(100) NOT NULL,
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('copy', 'detail-copy', 'image', 'video-script', 'video')),
    variant VARCHAR(20) NOT NULL DEFAULT '',
    platform VARCHAR(20) NOT NULL,
    request_data JSONB NOT NULL,
    task_id VARCHAR(100),
    failure_message VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id, user_id) REFERENCES ecommerce_projects(id, user_id) ON DELETE CASCADE,
    UNIQUE (user_id, project_id, request_id),
    UNIQUE (task_id)
);

CREATE INDEX ecommerce_job_project_idx ON ecommerce_jobs(user_id, project_id, created_at DESC);

ALTER TABLE user_credit_transactions DROP CONSTRAINT ck_user_credit_transactions_generation_source;

ALTER TABLE user_credit_transactions ADD CONSTRAINT ck_user_credit_transactions_generation_source
    CHECK (generation_source IS NULL OR generation_source IN ('imagePage', 'videoPage', 'canvas', 'storyboard', 'ecommerce'));

COMMENT ON COLUMN user_credit_transactions.generation_source IS '生成来源：imagePage、videoPage、canvas、storyboard、ecommerce；历史流水为空';
