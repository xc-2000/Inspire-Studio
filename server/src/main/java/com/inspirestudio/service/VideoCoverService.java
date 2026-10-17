package com.inspirestudio.service;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.dto.PersistenceDtos;
import com.inspirestudio.entity.PersistenceRecords;
import com.inspirestudio.repository.PersistenceRepository;
import com.inspirestudio.security.CurrentUserProvider;
import com.inspirestudio.task.VideoCoverMediaProcessor;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/** 视频封面按源媒体身份缓存；失败不修改原视频或资产。 */
@Service
@RequiredArgsConstructor
@Slf4j
public class VideoCoverService {
    private static final String COVER_VERSION = "1";
    private final CurrentUserProvider currentUserProvider;
    private final PersistenceRepository repository;
    private final PersistenceService persistenceService;
    private final VideoCoverMediaProcessor processor;
    private final ConcurrentMap<String, Mono<PersistenceDtos.VideoCoverResponse>> inFlight = new ConcurrentHashMap<>();

    public Mono<PersistenceDtos.VideoCoverResponse> getOrCreate(String storageKey) {
        return getOrCreate(storageKey, false);
    }

    public Mono<PersistenceDtos.VideoCoverResponse> getOrCreateTail(String storageKey) {
        return getOrCreate(storageKey, true);
    }

    private Mono<PersistenceDtos.VideoCoverResponse> getOrCreate(String storageKey, boolean tail) {
        if (!StringUtils.hasText(storageKey)) {
            return Mono.error(new BusinessException(ErrorCode.PARAM_MISSING, "视频媒体存储键不能为空"));
        }
        // 每次请求都先校验源媒体归属，缓存与并发共享均不能绕过该校验。
        return currentUserProvider.currentUserId().flatMap(userId -> repository.getMedia(userId, storageKey.trim())
                .switchIfEmpty(Mono.error(new BusinessException(ErrorCode.RESOURCE_NOT_FOUND, "视频媒体不存在")))
                .flatMap(source -> {
                    if (!"video".equals(source.getKind())) {
                        return Mono.error(new BusinessException(ErrorCode.PARAM_INVALID, "封面来源必须是视频媒体"));
                    }
                    String coverKey = tail ? derivedStorageKey(userId, source).replace("video-cover:", "video-tail:") : derivedStorageKey(userId, source);
                    return Mono.defer(() -> inFlight.computeIfAbsent(coverKey, key ->
                            findOrCreate(userId, source, key, tail)
                                    // 删除放在cache上游，单个浏览器取消请求不会提前释放共享任务。
                                    .doOnTerminate(() -> inFlight.remove(key))
                                    .cache()));
                }));
    }

    private Mono<PersistenceDtos.VideoCoverResponse> findOrCreate(Long userId, PersistenceRecords.MediaFileRecord source, String coverKey, boolean tail) {
        return repository.getMedia(userId, coverKey)
                .flatMap(record -> {
                    JSONObject metadata = StringUtils.hasText(record.getMetadata()) ? JSON.parseObject(record.getMetadata()) : null;
                    int width = metadata == null ? 0 : metadata.getIntValue("sourceWidth");
                    int height = metadata == null ? 0 : metadata.getIntValue("sourceHeight");
                    if (!StringUtils.hasText(record.getObjectStorageUrl()) || width < 1 || height < 1) return Mono.empty();
                    return Mono.just(new PersistenceDtos.VideoCoverResponse(record.getObjectStorageUrl(), coverKey, width, height));
                })
                .switchIfEmpty(Mono.defer(() -> createAndStore(userId, source.getStorageKey(), coverKey, tail)));
    }

    private Mono<PersistenceDtos.VideoCoverResponse> createAndStore(Long userId, String sourceKey, String coverKey, boolean tail) {
        return Mono.usingWhen(
                Mono.fromCallable(() -> Files.createTempDirectory("inspire-video-cover-"))
                        .subscribeOn(Schedulers.boundedElastic()),
                directory -> {
                    Path input = directory.resolve("source.video");
                    Path output = directory.resolve("cover.jpg");
                    return persistenceService.downloadVideoMediaToFileForUser(userId, sourceKey, input, java.time.Duration.ofSeconds(90))
                            .switchIfEmpty(Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR, "视频下载没有返回文件")))
                            .flatMap(download -> Mono.fromCallable(() -> tail ? processor.extractTail(input, output) : processor.extract(input, output))
                                    .subscribeOn(Schedulers.boundedElastic()))
                            .flatMap(result -> {
                                JSONObject metadata = new JSONObject();
                                metadata.put("sourceStorageKey", sourceKey);
                                metadata.put("sourceWidth", result.width());
                                metadata.put("sourceHeight", result.height());
                                metadata.put("videoCoverVersion", COVER_VERSION);
                                metadata.put("framePosition", tail ? "tail" : "cover");
                                return persistenceService.storeDerivedMediaFileForUser(
                                        userId, coverKey, "image", "video-cover.jpg", "image/jpeg", output,
                                        result.coverWidth(), result.coverHeight(), null, metadata)
                                        .filter(stored -> StringUtils.hasText(stored.url()))
                                        .switchIfEmpty(Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR, "视频封面保存后没有返回地址")))
                                        .map(stored -> new PersistenceDtos.VideoCoverResponse(stored.url(), stored.storageKey(), result.width(), result.height()));
                            });
                },
                this::cleanup,
                (directory, error) -> cleanup(directory),
                this::cleanup);
    }

    private Mono<Void> cleanup(Path directory) {
        return Mono.fromRunnable(() -> {
            try (var paths = Files.walk(directory)) {
                paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                    try { Files.deleteIfExists(path); }
                    catch (IOException exception) { log.warn("清理视频封面临时文件失败: {}", path); }
                });
            } catch (IOException exception) { log.warn("清理视频封面临时目录失败: {}", directory); }
        }).subscribeOn(Schedulers.boundedElastic()).then();
    }

    /** 包含用户与源对象身份，源视频被替换后不会复用旧封面。 */
    static String derivedStorageKey(Long userId, PersistenceRecords.MediaFileRecord source) {
        String identity = userId + "\n" + source.getStorageKey() + "\n" + source.getObjectStorageKey() + "\n"
                + source.getObjectStorageUrl() + "\n" + source.getSourceUrl() + "\n" + source.getBytes() + "\n" + COVER_VERSION;
        try {
            return "image:video-cover:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(identity.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
    }
}
