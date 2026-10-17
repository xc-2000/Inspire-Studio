package com.inspirestudio.entity;

import java.time.OffsetDateTime;
import lombok.Data;

/** 社交平台账号与发布任务持久化记录。 */
public final class SocialPublishingRecords {

    private SocialPublishingRecords() {
    }

    @Data
    public static class AccountRecord {
        private Long id;
        private Long userId;
        private String platform;
        private String displayName;
        private String credentialsEncrypted;
        private Boolean enabled;
        private String lastCheckStatus;
        private String lastCheckMessage;
        private OffsetDateTime lastCheckedAt;
        private OffsetDateTime createdAt;
        private OffsetDateTime updatedAt;
    }

    @Data
    public static class TaskRecord {
        private String id;
        private Long userId;
        private Long accountId;
        private String platform;
        private String mediaType;
        private String title;
        private String description;
        private String mediaUrlsJson;
        private String coverUrl;
        private String topicsJson;
        private String settingsJson;
        private String publishMode;
        private String status;
        private String resultData;
        private String errorMessage;
        private OffsetDateTime createdAt;
        private OffsetDateTime startedAt;
        private OffsetDateTime finishedAt;
    }
}

