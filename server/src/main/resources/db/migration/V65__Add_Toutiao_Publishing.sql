-- Source-only distribution: schema retained; seed/imported records omitted.

ALTER TABLE social_publish_accounts DROP CONSTRAINT ck_social_publish_account_platform;

ALTER TABLE social_publish_accounts ADD CONSTRAINT ck_social_publish_account_platform
    CHECK (platform IN ('douyin', 'xiaohongshu', 'wechat_channels', 'toutiao'));

ALTER TABLE social_publish_tasks DROP CONSTRAINT ck_social_publish_task_platform;

ALTER TABLE social_publish_tasks ADD CONSTRAINT ck_social_publish_task_platform
    CHECK (platform IN ('douyin', 'xiaohongshu', 'wechat_channels', 'toutiao'));
