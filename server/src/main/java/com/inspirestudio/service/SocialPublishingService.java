package com.inspirestudio.service;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.TypeReference;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.common.JsonData;
import com.inspirestudio.common.SensitiveDataCrypto;
import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.dto.SocialPublishingDtos;
import com.inspirestudio.entity.SocialPublishingRecords;
import com.inspirestudio.repository.SocialPublishingRepository;
import com.inspirestudio.security.CurrentUserProvider;
import java.net.URI;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** 抖音、小红书和微信视频号统一发布业务。 */
@Service
@RequiredArgsConstructor
@Slf4j
public class SocialPublishingService {

    private static final Set<String> PLATFORMS = Set.of("douyin", "xiaohongshu", "wechat_channels", "toutiao");
    private static final Set<String> MEDIA_TYPES = Set.of("video", "images");
    private static final Set<String> MODES = Set.of("dry_run", "draft", "publish");
    private static final Set<String> VISIBILITIES = Set.of("public", "private", "fans");

    private final SocialPublishingRepository repository;
    private final CurrentUserProvider currentUserProvider;
    private final InspireProperties properties;
    private final PublisherClient publisherClient;
    private final JsonData jsonData;
    private final Map<String, PendingQrLogin> pendingQrLogins = new ConcurrentHashMap<>();

    public Mono<List<SocialPublishingDtos.AccountItem>> listAccounts() {
        return currentUserProvider.currentUserId()
                .flatMapMany(repository::listAccounts)
                .map(this::toAccountItem)
                .collectList();
    }

    public Mono<SocialPublishingDtos.AccountItem> saveAccount(SocialPublishingDtos.SaveAccountRequest request) {
        String platform = platform(request.platform());
        String displayName = required(request.displayName(), "账号名称不能为空");
        boolean enabled = request.enabled() == null || request.enabled();
        return currentUserProvider.currentUserId().flatMap(userId -> {
            if (request.id() == null) {
                return Mono.error(invalid("请使用扫码登录添加账号"));
            }
            return repository.findAccount(userId, request.id())
                    .switchIfEmpty(Mono.error(notFound("发布账号不存在")))
                    .flatMap(existing -> {
                        String encrypted = existing.getCredentialsEncrypted();
                        if (StringUtils.hasText(request.credentials())) {
                            encrypted = encrypt(requiredCredentials(request.credentials()));
                        }
                        SocialPublishingRecords.AccountRecord record = accountRecord(userId, request.id(), platform,
                                displayName, encrypted, enabled);
                        return repository.updateAccount(record)
                                .flatMap(rows -> rows > 0 ? repository.findAccount(userId, request.id())
                                        : Mono.error(notFound("发布账号不存在")));
                    }).map(this::toAccountItem);
        });
    }

    public Mono<Void> deleteAccount(long id) {
        if (id <= 0) return Mono.error(invalid("账号ID不合法"));
        return currentUserProvider.currentUserId().flatMap(userId -> repository.deleteAccount(userId, id)
                .flatMap(rows -> rows > 0 ? Mono.<Void>empty() : Mono.error(notFound("发布账号不存在"))));
    }

    public Mono<SocialPublishingDtos.AccountItem> checkAccount(long id) {
        if (id <= 0) return Mono.error(invalid("账号ID不合法"));
        return currentUserProvider.currentUserId().flatMap(userId -> repository.findAccount(userId, id)
                .switchIfEmpty(Mono.error(notFound("发布账号不存在")))
                .flatMap(account -> publisherClient.check(account.getPlatform(), decrypt(account.getCredentialsEncrypted()))
                        .flatMap(result -> {
                            boolean valid = Boolean.TRUE.equals(result.get("ok"));
                            String status = valid ? "valid" : "invalid".equals(result.get("status")) ? "invalid" : "error";
                            String message = PublisherClient.safeMessage(stringValue(result.get("message"), valid ? "登录态可用" : "登录检查未完成，请重试"));
                            return repository.updateAccountCheck(userId, id, status, message)
                                    .then(repository.findAccount(userId, id)).map(this::toAccountItem);
                        })
                        .onErrorResume(error -> {
                            String message = errorMessage(error);
                            return repository.updateAccountCheck(userId, id, "error", message)
                                    .then(Mono.error(error));
                        })));
    }

    public Mono<SocialPublishingDtos.QrLoginResponse> startQrLogin(SocialPublishingDtos.QrLoginStartRequest request) {
        pendingQrLogins.entrySet().removeIf(entry -> entry.getValue().expiresAt() > 0
                && entry.getValue().expiresAt() < System.currentTimeMillis());
        String requestedPlatform = platform(request.platform());
        boolean requestedEnabled = request.enabled() == null || request.enabled();
        return currentUserProvider.currentUserId().flatMap(userId -> {
            Mono<PendingQrLogin> pending;
            if (request.accountId() == null) {
                String displayName = required(request.displayName(), "请填写账号名称");
                pending = Mono.just(new PendingQrLogin(userId, null, requestedPlatform, displayName, requestedEnabled, 0));
            } else {
                pending = repository.findAccount(userId, request.accountId())
                        .switchIfEmpty(Mono.error(notFound("发布账号不存在")))
                        .map(account -> {
                            if (!requestedPlatform.equals(account.getPlatform())) throw invalid("扫码平台与账号平台不一致");
                            String displayName = StringUtils.hasText(request.displayName())
                                    ? request.displayName().trim() : account.getDisplayName();
                            return new PendingQrLogin(userId, account.getId(), account.getPlatform(), displayName,
                                    request.enabled() == null ? Boolean.TRUE.equals(account.getEnabled()) : requestedEnabled, 0);
                        });
            }
            return pending.flatMap(info -> publisherClient.startQrLogin(info.platform())
                    .flatMap(result -> {
                        String sessionId = stringValue(result.get("sessionId"), "");
                        if (!StringUtils.hasText(sessionId)) throw invalid("发布服务没有返回扫码会话");
                        Long expiresAt = longValue(result.get("expiresAt"));
                        PendingQrLogin current = new PendingQrLogin(info.userId(), info.accountId(), info.platform(),
                                info.displayName(), info.enabled(), expiresAt == null ? 0 : expiresAt);
                        List<String> supersededSessions;
                        synchronized (pendingQrLogins) {
                            supersededSessions = pendingQrLogins.entrySet().stream()
                                    .filter(entry -> entry.getValue().userId() == info.userId())
                                    .map(Map.Entry::getKey)
                                    .filter(id -> !id.equals(sessionId))
                                    .toList();
                            supersededSessions.forEach(pendingQrLogins::remove);
                            pendingQrLogins.put(sessionId, current);
                        }
                        return Flux.fromIterable(supersededSessions)
                                .concatMap(id -> publisherClient.cancelQrLogin(id)
                                        .onErrorResume(error -> {
                                            log.debug("取消已替换的扫码会话失败: sessionId={}", id, error);
                                            return Mono.empty();
                                        }))
                                .then(Mono.fromSupplier(() -> qrLoginResponse(result, null)));
                    }));
        });
    }

    public Mono<SocialPublishingDtos.QrLoginResponse> qrLoginStatus(String sessionId) {
        String id = required(sessionId, "扫码会话不能为空");
        return currentUserProvider.currentUserId().flatMap(userId -> {
            PendingQrLogin pending = pendingQrLogins.get(id);
            if (pending == null || pending.userId() != userId) return Mono.error(notFound("扫码会话不存在或已过期"));
            return publisherClient.qrLoginStatus(id).flatMap(result -> {
                String status = stringValue(result.get("status"), "failed");
                if (!"confirmed".equals(status)) {
                    if (Set.of("failed", "expired", "cancelled").contains(status)) pendingQrLogins.remove(id, pending);
                    return Mono.just(qrLoginResponse(result, null));
                }
                String credentials = requiredCredentials(stringValue(result.get("credentials"), ""));
                if (!pendingQrLogins.remove(id, pending)) return Mono.error(notFound("扫码会话已完成"));
                return saveQrAccount(pending, credentials)
                        .map(account -> qrLoginResponse(result, account));
            });
        });
    }

    public Mono<Void> cancelQrLogin(String sessionId) {
        String id = required(sessionId, "扫码会话不能为空");
        return currentUserProvider.currentUserId().flatMap(userId -> {
            PendingQrLogin pending = pendingQrLogins.get(id);
            if (pending == null) return Mono.empty();
            if (pending.userId() != userId) return Mono.error(notFound("扫码会话不存在"));
            pendingQrLogins.remove(id, pending);
            return publisherClient.cancelQrLogin(id).onErrorResume(error -> Mono.empty());
        });
    }

    public Mono<Void> qrLoginAction(SocialPublishingDtos.QrLoginActionRequest request) {
        return currentUserProvider.currentUserId().flatMap(userId -> {
            PendingQrLogin pending = pendingQrLogins.get(request.sessionId());
            if (pending == null || pending.userId() != userId) return Mono.error(notFound("扫码会话不存在或已过期"));
            return publisherClient.qrLoginAction(request.sessionId(), request.action()).then();
        });
    }

    private Mono<SocialPublishingDtos.AccountItem> saveQrAccount(PendingQrLogin pending, String credentials) {
        SocialPublishingRecords.AccountRecord record = accountRecord(pending.userId(), pending.accountId(),
                pending.platform(), pending.displayName(), encrypt(credentials), pending.enabled());
        Mono<Long> accountId;
        if (pending.accountId() == null) {
            accountId = repository.createAccount(record);
        } else {
            accountId = repository.updateAccount(record).flatMap(rows -> rows > 0
                    ? Mono.just(pending.accountId()) : Mono.error(notFound("发布账号不存在")));
        }
        return accountId.flatMap(id -> repository.updateAccountCheck(pending.userId(), id, "valid", "扫码登录成功")
                .then(repository.findAccount(pending.userId(), id))).map(this::toAccountItem);
    }

    private SocialPublishingDtos.QrLoginResponse qrLoginResponse(Map<String, Object> result,
                                                                  SocialPublishingDtos.AccountItem account) {
        return new SocialPublishingDtos.QrLoginResponse(
                stringValue(result.get("sessionId"), ""),
                stringValue(result.get("platform"), ""),
                stringValue(result.get("status"), "failed"),
                stringValue(result.get("message"), "扫码登录状态未知"),
                stringValue(result.get("qrCodeDataUrl"), null),
                longValue(result.get("expiresAt")), account);
    }

    public Mono<SocialPublishingDtos.TaskItem> createTask(SocialPublishingDtos.CreateTaskRequest request) {
        validateTask(request);
        return currentUserProvider.currentUserId().flatMap(userId -> repository.findAccount(userId, request.accountId())
                .switchIfEmpty(Mono.error(notFound("发布账号不存在")))
                .flatMap(account -> {
                    if (!Boolean.TRUE.equals(account.getEnabled())) return Mono.error(invalid("发布账号已停用"));
                    String mode = normalize(request.publishMode());
                    if ("draft".equals(mode) && !Set.of("wechat_channels", "toutiao").contains(account.getPlatform())) {
                        return Mono.error(invalid("当前平台不支持保存草稿"));
                    }
                    SocialPublishingRecords.TaskRecord record = buildTaskRecord(userId, account, request);
                    String credentials = decrypt(account.getCredentialsEncrypted());
                    return repository.createTask(record).doOnNext(task -> startTask(task, request, credentials)).map(this::toTaskItem);
                }));
    }

    public Mono<SocialPublishingDtos.TaskListResponse> listTasks(int page, int pageSize) {
        int safePage = Math.max(1, page);
        int safePageSize = Math.min(100, Math.max(1, pageSize));
        return currentUserProvider.currentUserId().flatMap(userId -> Mono.zip(
                        repository.listTasks(userId, safePage, safePageSize).map(this::toTaskItem).collectList(),
                        repository.countTasks(userId))
                .map(result -> new SocialPublishingDtos.TaskListResponse(result.getT1(), result.getT2())));
    }

    public Mono<List<SocialPublishingDtos.TaskStatusItem>> taskStatuses(List<String> ids) {
        if (ids == null || ids.size() > 100) return Mono.error(invalid("每次最多查询100个任务"));
        List<String> taskIds = ids.stream().filter(StringUtils::hasText).map(String::trim).distinct().toList();
        if (taskIds.stream().anyMatch(id -> id.length() > 100)) return Mono.error(invalid("任务ID不合法"));
        return currentUserProvider.currentUserId().flatMap(userId -> taskIds.isEmpty() ? Mono.just(List.of())
                : repository.findTaskStatuses(userId, taskIds)
                    .map(record -> new SocialPublishingDtos.TaskStatusItem(record.getId(), record.getStatus(),
                            parseMap(record.getResultData()), record.getErrorMessage(),
                            format(record.getStartedAt()), format(record.getFinishedAt())))
                    .collectList());
    }

    private void startTask(SocialPublishingRecords.TaskRecord task, SocialPublishingDtos.CreateTaskRequest request, String credentials) {
        Map<String, Object> settings = parseMap(task.getSettingsJson());
        String visibility = stringValue(settings.get("visibility"), "public");
        boolean allowDownload = Boolean.TRUE.equals(settings.get("allowDownload"));
        boolean transcode = Boolean.TRUE.equals(settings.get("transcode"));
        repository.markTaskRunning(task.getId())
                .then(publisherClient.publish(task.getPlatform(), credentials, task.getMediaType(), task.getTitle(),
                        task.getDescription(), parseList(task.getMediaUrlsJson()), task.getCoverUrl(),
                        parseList(task.getTopicsJson()), task.getPublishMode(), visibility, allowDownload, transcode))
                .flatMap(result -> repository.finishTask(task.getId(), "success", jsonData.stringify(result), null))
                .onErrorResume(error -> repository.finishTask(task.getId(), "failed", null, errorMessage(error)))
                .subscribe(ignored -> { }, error -> log.error("更新内容发布任务失败: taskId={}", task.getId(), error));
    }

    private void validateTask(SocialPublishingDtos.CreateTaskRequest request) {
        if (request.accountId() == null || request.accountId() <= 0) throw invalid("账号ID不合法");
        String mediaType = normalize(request.mediaType());
        if (!MEDIA_TYPES.contains(mediaType)) throw invalid("素材类型只支持视频或图片");
        String mode = normalize(request.publishMode());
        if (!MODES.contains(mode)) throw invalid("发布方式不合法");
        if (request.mediaUrls() == null || request.mediaUrls().isEmpty() || request.mediaUrls().size() > 20) {
            throw invalid("请选择1至20个素材");
        }
        if ("video".equals(mediaType) && request.mediaUrls().size() != 1) throw invalid("视频发布只能选择一个视频");
        request.mediaUrls().forEach(this::validateUrl);
        if (StringUtils.hasText(request.coverUrl())) validateUrl(request.coverUrl());
        String visibility = normalizeDefault(request.visibility(), "public");
        if (!VISIBILITIES.contains(visibility)) throw invalid("可见范围不合法");
    }

    private SocialPublishingRecords.TaskRecord buildTaskRecord(long userId, SocialPublishingRecords.AccountRecord account,
                                                                SocialPublishingDtos.CreateTaskRequest request) {
        String mediaType = normalize(request.mediaType());
        if ("xiaohongshu".equals(account.getPlatform()) && !StringUtils.hasText(request.title())) {
            throw invalid("小红书发布必须填写标题");
        }
        if ("toutiao".equals(account.getPlatform())) {
            int titleLength = trim(request.title()).codePointCount(0, trim(request.title()).length());
            if (titleLength < 5 || titleLength > 30) throw invalid("头条标题需填写5至30个字");
            if (!"public".equals(normalizeDefault(request.visibility(), "public"))) throw invalid("头条暂只支持公开发布，未完成的内容可保存草稿");
            if (normalizeTopics(request.topics()).size() > 5) throw invalid("头条最多支持5个话题");
            String description = trim(request.description());
            if ("video".equals(mediaType) && (description.codePointCount(0, description.length()) > 200 || StringUtils.hasText(request.coverUrl()))) {
                throw invalid("头条视频简介最多200字，封面由平台自动提取");
            }
        }
        if ("wechat_channels".equals(account.getPlatform()) && "video".equals(mediaType)
                && !StringUtils.hasText(request.coverUrl())) {
            throw invalid("视频号视频必须设置封面");
        }
        SocialPublishingRecords.TaskRecord record = new SocialPublishingRecords.TaskRecord();
        record.setId(UUID.randomUUID().toString());
        record.setUserId(userId);
        record.setAccountId(account.getId());
        record.setPlatform(account.getPlatform());
        record.setMediaType(mediaType);
        record.setTitle(trim(request.title()));
        record.setDescription(trim(request.description()));
        record.setMediaUrlsJson(jsonData.stringify(request.mediaUrls()));
        record.setCoverUrl(StringUtils.hasText(request.coverUrl()) ? request.coverUrl().trim() : null);
        record.setTopicsJson(jsonData.stringify(normalizeTopics(request.topics())));
        record.setSettingsJson(jsonData.stringify(Map.of(
                "visibility", normalizeDefault(request.visibility(), "public"),
                "allowDownload", Boolean.TRUE.equals(request.allowDownload()),
                "transcode", Boolean.TRUE.equals(request.transcode()))));
        record.setPublishMode(normalize(request.publishMode()));
        return record;
    }

    private SocialPublishingRecords.AccountRecord accountRecord(long userId, Long id, String platform, String displayName,
                                                                 String credentials, boolean enabled) {
        SocialPublishingRecords.AccountRecord record = new SocialPublishingRecords.AccountRecord();
        record.setId(id);
        record.setUserId(userId);
        record.setPlatform(platform);
        record.setDisplayName(displayName);
        record.setCredentialsEncrypted(credentials);
        record.setEnabled(enabled);
        return record;
    }

    private SocialPublishingDtos.AccountItem toAccountItem(SocialPublishingRecords.AccountRecord record) {
        return new SocialPublishingDtos.AccountItem(record.getId(), record.getPlatform(), record.getDisplayName(),
                Boolean.TRUE.equals(record.getEnabled()), StringUtils.hasText(record.getCredentialsEncrypted()),
                record.getLastCheckStatus(), record.getLastCheckMessage() == null ? null : PublisherClient.safeMessage(record.getLastCheckMessage()), format(record.getLastCheckedAt()),
                format(record.getCreatedAt()), format(record.getUpdatedAt()));
    }

    private SocialPublishingDtos.TaskItem toTaskItem(SocialPublishingRecords.TaskRecord record) {
        return new SocialPublishingDtos.TaskItem(record.getId(), record.getAccountId(), record.getPlatform(),
                record.getMediaType(), record.getTitle(), record.getDescription(), parseList(record.getMediaUrlsJson()),
                record.getCoverUrl(), parseList(record.getTopicsJson()), record.getPublishMode(), record.getStatus(),
                parseMap(record.getResultData()), record.getErrorMessage(), format(record.getCreatedAt()),
                format(record.getStartedAt()), format(record.getFinishedAt()));
    }

    private List<String> normalizeTopics(List<String> topics) {
        if (topics == null) return List.of();
        return topics.stream().filter(StringUtils::hasText).map(String::trim).map(value -> value.replaceFirst("^#+", ""))
                .filter(StringUtils::hasText).distinct().limit(20).toList();
    }

    private void validateUrl(String value) {
        try {
            URI uri = URI.create(value.trim());
            if (!("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme())) || uri.getHost() == null) {
                throw invalid("素材地址必须是可访问的HTTP(S)地址");
            }
        } catch (IllegalArgumentException exception) {
            throw invalid("素材地址格式不合法");
        }
    }

    private String platform(String value) {
        String normalized = normalize(value);
        if (!PLATFORMS.contains(normalized)) throw invalid("发布平台不支持");
        return normalized;
    }

    private String requiredCredentials(String value) {
        String result = required(value, "请填写账号登录态");
        if (result.length() < 10) throw invalid("账号登录态内容不完整");
        if (result.length() > 2_000_000) throw invalid("账号登录态内容过大");
        return result;
    }

    private String encrypt(String value) {
        return SensitiveDataCrypto.encrypt(value, properties.getApp().getSecretKey());
    }

    private String decrypt(String value) {
        return SensitiveDataCrypto.decrypt(value, properties.getApp().getSecretKey());
    }

    private String required(String value, String message) {
        if (!StringUtils.hasText(value)) throw invalid(message);
        return value.trim();
    }

    private String normalize(String value) {
        return value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
    }

    private String normalizeDefault(String value, String fallback) {
        String normalized = normalize(value);
        return normalized.isBlank() ? fallback : normalized;
    }

    private String trim(String value) {
        return value == null ? "" : value.trim();
    }

    private String format(OffsetDateTime value) {
        return value == null ? null : DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(value);
    }

    private String stringValue(Object value, String fallback) {
        return value instanceof String text && StringUtils.hasText(text) ? text.trim() : fallback;
    }

    private Long longValue(Object value) {
        if (value instanceof Number number) return number.longValue();
        try {
            return value == null ? null : Long.parseLong(String.valueOf(value));
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private String errorMessage(Throwable error) {
        return PublisherClient.safeMessage(error.getMessage());
    }

    private List<String> parseList(String value) {
        if (!StringUtils.hasText(value)) return List.of();
        try {
            return JSON.parseObject(value, new TypeReference<List<String>>() { });
        } catch (Exception ignored) {
            return List.of();
        }
    }

    private Map<String, Object> parseMap(String value) {
        if (!StringUtils.hasText(value)) return Map.of();
        try {
            return JSON.parseObject(value, new TypeReference<Map<String, Object>>() { });
        } catch (Exception ignored) {
            return Map.of();
        }
    }

    private BusinessException invalid(String message) {
        return new BusinessException(ErrorCode.PARAM_INVALID, message);
    }

    private BusinessException notFound(String message) {
        return new BusinessException(ErrorCode.RESOURCE_NOT_FOUND, message);
    }

    private record PendingQrLogin(long userId, Long accountId, String platform, String displayName, boolean enabled,
                                  long expiresAt) {
    }
}
