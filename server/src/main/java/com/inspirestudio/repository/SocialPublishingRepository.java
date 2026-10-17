package com.inspirestudio.repository;

import com.inspirestudio.entity.SocialPublishingRecords;
import io.r2dbc.spi.Row;
import lombok.RequiredArgsConstructor;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** 内容发布数据库访问。 */
@Repository
@RequiredArgsConstructor
public class SocialPublishingRepository {

    private final DatabaseClient databaseClient;

    public Flux<SocialPublishingRecords.AccountRecord> listAccounts(long userId) {
        return databaseClient.sql("""
                SELECT id, user_id, platform, display_name, credentials_encrypted, enabled,
                       last_check_status, last_check_message, last_checked_at, created_at, updated_at
                FROM social_publish_accounts WHERE user_id = :userId
                ORDER BY platform ASC, id ASC
                """).bind("userId", userId).map((row, metadata) -> mapAccount(row)).all();
    }

    public Mono<SocialPublishingRecords.AccountRecord> findAccount(long userId, long id) {
        return databaseClient.sql("""
                SELECT id, user_id, platform, display_name, credentials_encrypted, enabled,
                       last_check_status, last_check_message, last_checked_at, created_at, updated_at
                FROM social_publish_accounts WHERE user_id = :userId AND id = :id
                """).bind("userId", userId).bind("id", id).map((row, metadata) -> mapAccount(row)).one();
    }

    public Mono<Long> createAccount(SocialPublishingRecords.AccountRecord record) {
        return databaseClient.sql("""
                INSERT INTO social_publish_accounts(user_id, platform, display_name, credentials_encrypted, enabled)
                VALUES (:userId, :platform, :displayName, :credentials, :enabled)
                RETURNING id
                """).bind("userId", record.getUserId()).bind("platform", record.getPlatform())
                .bind("displayName", record.getDisplayName()).bind("credentials", record.getCredentialsEncrypted())
                .bind("enabled", record.getEnabled()).map((row, metadata) -> row.get("id", Long.class)).one();
    }

    public Mono<Long> updateAccount(SocialPublishingRecords.AccountRecord record) {
        return databaseClient.sql("""
                UPDATE social_publish_accounts
                SET platform = :platform, display_name = :displayName, credentials_encrypted = :credentials,
                    enabled = :enabled, last_check_status = 'unchecked', last_check_message = NULL,
                    last_checked_at = NULL, updated_at = CURRENT_TIMESTAMP
                WHERE user_id = :userId AND id = :id
                """).bind("id", record.getId()).bind("userId", record.getUserId())
                .bind("platform", record.getPlatform()).bind("displayName", record.getDisplayName())
                .bind("credentials", record.getCredentialsEncrypted()).bind("enabled", record.getEnabled())
                .fetch().rowsUpdated();
    }

    public Mono<Long> deleteAccount(long userId, long id) {
        return databaseClient.sql("DELETE FROM social_publish_accounts WHERE user_id = :userId AND id = :id")
                .bind("userId", userId).bind("id", id).fetch().rowsUpdated();
    }

    public Mono<Void> updateAccountCheck(long userId, long id, String status, String message) {
        DatabaseClient.GenericExecuteSpec spec = databaseClient.sql("""
                UPDATE social_publish_accounts SET last_check_status = :status, last_check_message = :message,
                    last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE user_id = :userId AND id = :id
                """).bind("status", status).bind("userId", userId).bind("id", id);
        spec = message == null ? spec.bindNull("message", String.class) : spec.bind("message", message);
        return spec.fetch().rowsUpdated().then();
    }

    public Mono<SocialPublishingRecords.TaskRecord> createTask(SocialPublishingRecords.TaskRecord record) {
        DatabaseClient.GenericExecuteSpec spec = databaseClient.sql("""
                INSERT INTO social_publish_tasks(id, user_id, account_id, platform, media_type, title, description,
                    media_urls_json, cover_url, topics_json, settings_json, publish_mode, status)
                VALUES (:id, :userId, :accountId, :platform, :mediaType, :title, :description,
                    :mediaUrls, :coverUrl, :topics, :settings, :publishMode, 'queued')
                RETURNING created_at
                """).bind("id", record.getId()).bind("userId", record.getUserId()).bind("accountId", record.getAccountId())
                .bind("platform", record.getPlatform()).bind("mediaType", record.getMediaType())
                .bind("title", record.getTitle()).bind("description", record.getDescription())
                .bind("mediaUrls", record.getMediaUrlsJson()).bind("topics", record.getTopicsJson())
                .bind("settings", record.getSettingsJson()).bind("publishMode", record.getPublishMode());
        spec = record.getCoverUrl() == null ? spec.bindNull("coverUrl", String.class) : spec.bind("coverUrl", record.getCoverUrl());
        return spec.map((row, metadata) -> {
            record.setStatus("queued");
            record.setCreatedAt(row.get("created_at", java.time.OffsetDateTime.class));
            return record;
        }).one();
    }

    public Mono<Void> markTaskRunning(String id) {
        return databaseClient.sql("UPDATE social_publish_tasks SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = :id AND status = 'queued'")
                .bind("id", id).fetch().rowsUpdated().then();
    }

    public Mono<Void> finishTask(String id, String status, String resultData, String errorMessage) {
        DatabaseClient.GenericExecuteSpec spec = databaseClient.sql("""
                UPDATE social_publish_tasks SET status = :status, result_data = :resultData,
                    error_message = :errorMessage, finished_at = CURRENT_TIMESTAMP WHERE id = :id
                """).bind("id", id).bind("status", status);
        spec = resultData == null ? spec.bindNull("resultData", String.class) : spec.bind("resultData", resultData);
        spec = errorMessage == null ? spec.bindNull("errorMessage", String.class) : spec.bind("errorMessage", errorMessage);
        return spec.fetch().rowsUpdated().then();
    }

    public Flux<SocialPublishingRecords.TaskRecord> listTasks(long userId, int page, int pageSize) {
        return databaseClient.sql("""
                SELECT id, user_id, account_id, platform, media_type, title, description, media_urls_json,
                       cover_url, topics_json, settings_json, publish_mode, status, result_data, error_message,
                       created_at, started_at, finished_at
                FROM social_publish_tasks WHERE user_id = :userId
                ORDER BY created_at DESC LIMIT :limit OFFSET :offset
                """).bind("userId", userId).bind("limit", pageSize).bind("offset", (page - 1) * pageSize)
                .map((row, metadata) -> mapTask(row)).all();
    }

    public Mono<Long> countTasks(long userId) {
        return databaseClient.sql("SELECT COUNT(1) AS total FROM social_publish_tasks WHERE user_id = :userId")
                .bind("userId", userId).map((row, metadata) -> row.get("total", Long.class)).one().defaultIfEmpty(0L);
    }

    public Flux<SocialPublishingRecords.TaskRecord> findTaskStatuses(long userId, java.util.List<String> ids) {
        return databaseClient.sql("""
                SELECT id, status, result_data, error_message, started_at, finished_at
                FROM social_publish_tasks WHERE user_id = :userId AND id IN (:ids)
                """).bind("userId", userId).bind("ids", ids).map((row, metadata) -> {
                    var record = new SocialPublishingRecords.TaskRecord();
                    record.setId(row.get("id", String.class));
                    record.setStatus(row.get("status", String.class));
                    record.setResultData(row.get("result_data", String.class));
                    record.setErrorMessage(row.get("error_message", String.class));
                    record.setStartedAt(row.get("started_at", java.time.OffsetDateTime.class));
                    record.setFinishedAt(row.get("finished_at", java.time.OffsetDateTime.class));
                    return record;
                }).all();
    }

    private SocialPublishingRecords.AccountRecord mapAccount(Row row) {
        SocialPublishingRecords.AccountRecord record = new SocialPublishingRecords.AccountRecord();
        record.setId(row.get("id", Long.class));
        record.setUserId(row.get("user_id", Long.class));
        record.setPlatform(row.get("platform", String.class));
        record.setDisplayName(row.get("display_name", String.class));
        record.setCredentialsEncrypted(row.get("credentials_encrypted", String.class));
        record.setEnabled(row.get("enabled", Boolean.class));
        record.setLastCheckStatus(row.get("last_check_status", String.class));
        record.setLastCheckMessage(row.get("last_check_message", String.class));
        record.setLastCheckedAt(row.get("last_checked_at", java.time.OffsetDateTime.class));
        record.setCreatedAt(row.get("created_at", java.time.OffsetDateTime.class));
        record.setUpdatedAt(row.get("updated_at", java.time.OffsetDateTime.class));
        return record;
    }

    private SocialPublishingRecords.TaskRecord mapTask(Row row) {
        SocialPublishingRecords.TaskRecord record = new SocialPublishingRecords.TaskRecord();
        record.setId(row.get("id", String.class));
        record.setUserId(row.get("user_id", Long.class));
        record.setAccountId(row.get("account_id", Long.class));
        record.setPlatform(row.get("platform", String.class));
        record.setMediaType(row.get("media_type", String.class));
        record.setTitle(row.get("title", String.class));
        record.setDescription(row.get("description", String.class));
        record.setMediaUrlsJson(row.get("media_urls_json", String.class));
        record.setCoverUrl(row.get("cover_url", String.class));
        record.setTopicsJson(row.get("topics_json", String.class));
        record.setSettingsJson(row.get("settings_json", String.class));
        record.setPublishMode(row.get("publish_mode", String.class));
        record.setStatus(row.get("status", String.class));
        record.setResultData(row.get("result_data", String.class));
        record.setErrorMessage(row.get("error_message", String.class));
        record.setCreatedAt(row.get("created_at", java.time.OffsetDateTime.class));
        record.setStartedAt(row.get("started_at", java.time.OffsetDateTime.class));
        record.setFinishedAt(row.get("finished_at", java.time.OffsetDateTime.class));
        return record;
    }
}

