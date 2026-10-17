package com.inspirestudio.ai;

import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.dto.AiTaskDtos;
import com.inspirestudio.dto.PersistenceDtos;
import com.inspirestudio.service.PersistenceService;
import java.util.Base64;
import java.io.ByteArrayInputStream;
import javax.imageio.ImageIO;
import javax.imageio.stream.MemoryCacheImageInputStream;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import reactor.core.publisher.Mono;

/**
 * @title        AiMediaSupport.java
 * @description  AI媒体引用解析和结果存储支持
 * @createTime   2026-06-24 20:35:00
 */
@Component
@Slf4j
public class AiMediaSupport {

    /** AI HTTP客户端 */
    private final AiHttpClient aiHttpClient;

    /** 业务持久化服务 */
    private final PersistenceService persistenceService;

    /** 音频裁剪派生服务 */
    private final AudioClipService audioClipService;

    /** 注入媒体解析和音频派生依赖。 */
    @Autowired
    public AiMediaSupport(AiHttpClient aiHttpClient, PersistenceService persistenceService, InspireProperties properties,
                          AudioClipService audioClipService) {
        this.aiHttpClient = aiHttpClient;
        this.persistenceService = persistenceService;
        this.audioClipService = audioClipService;
    }

    /** 保留原有测试和内部调用方的三参数构造方式。 */
    public AiMediaSupport(AiHttpClient aiHttpClient, PersistenceService persistenceService, InspireProperties properties) {
        this(aiHttpClient, persistenceService, properties, new AudioClipService(aiHttpClient, persistenceService, properties));
    }

    /**
     * 从图片接口结果中读取二进制内容
     *
     * @param item JSONObject 图片结果项
     * @return Mono<GeneratedBinary> 图片二进制
     */
    public Mono<GeneratedBinary> imageBinary(JSONObject item) {
        String base64 = AiTaskParameterReader.firstNonEmpty(item.getString("b64_json"));
        if (StringUtils.hasText(base64)) {
            return Mono.fromSupplier(() -> new GeneratedBinary(Base64.getDecoder().decode(base64), "image/png"));
        }
        String url = AiTaskParameterReader.firstNonEmpty(item.getString("url"));
        if (StringUtils.hasText(url)) {
            if (isDataUrl(url)) {
                return Mono.fromSupplier(() -> dataUrlBinary(url, "image/png"));
            }
            return aiHttpClient.downloadRemoteBinary(url, "image/png");
        }
        return Mono.error(new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "图片接口未返回b64_json或url"));
    }

    /**
     * 保存图片接口结果项
     *
     * @param userId Long 用户ID
     * @param item JSONObject 图片结果项
     * @param width Integer 宽度
     * @param height Integer 高度
     * @param durationMs Integer 时长毫秒
     * @return Mono<UploadedMediaResponse> 媒体响应
     */
    public Mono<PersistenceDtos.UploadedMediaResponse> storeGeneratedImageItem(Long userId, JSONObject item, Integer width, Integer height, Integer durationMs) {
        // All generated images must be persisted before exposing a successful result.
        return imageBinary(item)
                .doOnError(error -> log.warn("生成图片下载失败: userId={}", userId, error))
                .onErrorMap(error -> generatedResultStorageError("图片已生成，但无法下载渠道返回的图片，尚未保存到对象存储。请检查渠道图片地址是否可访问。"))
                .flatMap(binary -> storeGeneratedMedia(userId, AiTaskTypes.IMAGE, "generated.png", binary, width, height, durationMs)
                        .doOnError(error -> log.warn("生成图片转存失败: userId={}", userId, error))
                        .onErrorMap(error -> generatedResultStorageError("图片已生成，但保存到对象存储失败，请检查默认存储配置和网络。")));
    }

    private AiProviderException generatedResultStorageError(String message) {
        return new AiProviderException(new AiErrorDetails("task", "network", "download", null,
                "generated_media_storage_failed", null, null, message, true, false));
    }

    /**
     * 解析参考媒体可访问URL
     *
     * @param userId Long 用户ID
     * @param reference AiTaskMediaReference 参考媒体
     * @return Mono<String> 可访问URL
     */
    public Mono<String> resolveReferenceUrl(Long userId, AiTaskDtos.AiTaskMediaReference reference) {
        if (reference == null) {
            return Mono.error(new BusinessException(ErrorCode.PARAM_INVALID, "参考媒体不能为空"));
        }
        if (StringUtils.hasText(reference.storageKey())) {
            return persistenceService.getMediaInfoForUser(userId, reference.storageKey().trim())
                    .switchIfEmpty(Mono.error(new BusinessException(ErrorCode.RESOURCE_NOT_FOUND, "参考媒体不存在或不属于当前用户")))
                    .flatMap(media -> audioClipService.resolveReferenceUrl(userId, reference, media))
                    .flatMap(this::validateReferenceUrl);
        }
        if (StringUtils.hasText(reference.url())) {
            if (reference.trimStartMs() != null || reference.trimEndMs() != null) {
                return Mono.error(new BusinessException(ErrorCode.PARAM_INVALID, "带裁剪区间的参考音频必须提供storageKey"));
            }
            return validateReferenceUrl(reference.url().trim());
        }
        return Mono.error(new BusinessException(ErrorCode.PARAM_INVALID, "参考媒体必须提供storageKey或url"));
    }

    /**
     * 解析参考媒体二进制
     *
     * @param userId Long 用户ID
     * @param reference AiTaskMediaReference 参考媒体
     * @param defaultMimeType String 默认MIME类型
     * @return Mono<GeneratedBinary> 参考媒体二进制
     */
    public Mono<GeneratedBinary> resolveReferenceBinary(Long userId, AiTaskDtos.AiTaskMediaReference reference, String defaultMimeType) {
        String mimeType = AiTaskParameterReader.firstNonEmpty(reference.mimeType(), defaultMimeType);
        return resolveReferenceUrl(userId, reference).flatMap(url -> {
            if (isDataUrl(url)) {
                return Mono.fromSupplier(() -> dataUrlBinary(url, mimeType));
            }
            if (isHttpUrl(url)) {
                // Only retry fetching the input; no generation request has been submitted yet.
                return Mono.defer(() -> aiHttpClient.downloadRemoteBinary(url, mimeType))
                        .retryWhen(reactor.util.retry.Retry.backoff(1, java.time.Duration.ofSeconds(1))
                                .filter(error -> reactor.core.Exceptions.unwrap(error) instanceof java.io.IOException)
                                .onRetryExhaustedThrow((spec, signal) -> signal.failure()))
                        .onErrorMap(error -> error instanceof java.io.IOException || error instanceof AiProviderException,
                                error -> new AiProviderException(new AiErrorDetails(
                                "task", "network", "download", null, "reference_media_unavailable", null, null,
                                "无法读取参考图片，原图地址暂时不可用。尚未提交生成请求，请稍后重试或重新上传原图。",
                                false, false)));
            }
            return Mono.error(new BusinessException(ErrorCode.PARAM_INVALID, "参考媒体URL必须是http、https或data URL"));
        });
    }

    /**
     * 校验参考媒体URL协议。
     *
     * @param url String 参考媒体地址
     * @return Mono<String> 规范化地址
     */
    private Mono<String> validateReferenceUrl(String url) {
        String normalized = StringUtils.hasText(url) ? url.trim() : "";
        if (isHttpUrl(normalized) || isDataUrl(normalized)) {
            return Mono.just(normalized);
        }
        return Mono.error(new BusinessException(ErrorCode.PARAM_INVALID, "参考媒体URL必须是http、https或data URL"));
    }

    /**
     * 保存AI生成媒体
     *
     * @param userId Long 用户ID
     * @param kind String 媒体类型
     * @param fileName String 文件名
     * @param binary GeneratedBinary 媒体二进制
     * @param width Integer 宽度
     * @param height Integer 高度
     * @param durationMs Integer 时长毫秒
     * @return Mono<UploadedMediaResponse> 媒体响应
     */
    public Mono<PersistenceDtos.UploadedMediaResponse> storeGeneratedMedia(Long userId, String kind, String fileName, GeneratedBinary binary, Integer width, Integer height, Integer durationMs) {
        // Persist the file's real dimensions, never the requested resolution or provider metadata.
        if (AiTaskTypes.IMAGE.equals(kind)) {
            try (var input = new MemoryCacheImageInputStream(new ByteArrayInputStream(binary.data()))) {
                var readers = ImageIO.getImageReaders(input);
                if (readers.hasNext()) {
                    var reader = readers.next();
                    try {
                        reader.setInput(input, true, true);
                        int actualWidth = reader.getWidth(0);
                        int actualHeight = reader.getHeight(0);
                        if (actualWidth > 0 && actualHeight > 0) {
                            width = actualWidth;
                            height = actualHeight;
                        }
                    } finally {
                        reader.dispose();
                    }
                }
            } catch (java.io.IOException | RuntimeException ignored) {
                // Unsupported formats still retain the existing metadata and can be stored.
            }
        }
        return persistenceService.storeGeneratedMediaForUser(userId, kind, fileName, binary.mimeType(), binary.data(), width, height, durationMs);
    }

    /**
     * 将AI生成媒体URL下载并转存到全站默认对象存储，不直接返回供应商临时地址。
     *
     * @param userId Long 用户ID
     * @param kind String 媒体类型
     * @param sourceUrl String 第三方返回的媒体URL
     * @param mimeType String MIME类型
     * @param width Integer 宽度
     * @param height Integer 高度
     * @param durationMs Integer 时长毫秒
     * @return Mono<UploadedMediaResponse> 媒体响应
     */
    public Mono<PersistenceDtos.UploadedMediaResponse> registerGeneratedMediaUrl(Long userId, String kind, String sourceUrl, String mimeType, Integer width, Integer height, Integer durationMs) {
        if (!isHttpUrl(sourceUrl)) {
            return Mono.error(new BusinessException(ErrorCode.PARAM_INVALID, "生成媒体URL必须是http或https地址"));
        }
        String trimmedUrl = sourceUrl.trim();
        String resolvedMimeType = AiTaskParameterReader.firstNonEmpty(mimeType,
                AiTaskTypes.VIDEO.equals(kind) ? "video/mp4" : "image/png");
        String fileName = "generated." + fileExtension(resolvedMimeType, "bin");
        // Stream videos through a temporary file so large results do not fill the JVM heap.
        return Mono.usingWhen(
                Mono.fromCallable(() -> java.nio.file.Files.createTempFile("generated-media-", ".tmp"))
                        .subscribeOn(reactor.core.scheduler.Schedulers.boundedElastic()),
                file -> aiHttpClient.downloadRemoteMediaToFile(trimmedUrl, resolvedMimeType, file, 524_288_000L)
                        .flatMap(download -> persistenceService.storeGeneratedMediaFileForUser(
                                userId, kind, fileName, resolvedMimeType, file, width, height, durationMs)),
                file -> Mono.fromRunnable(() -> {
                    try {
                        java.nio.file.Files.deleteIfExists(file);
                    } catch (java.io.IOException exception) {
                        log.warn("生成媒体临时文件清理失败", exception);
                    }
                }).subscribeOn(reactor.core.scheduler.Schedulers.boundedElastic()).then());
    }

    /**
     * 解析base64格式data URL
     *
     * @param url String data URL
     * @param defaultMimeType String 默认MIME类型
     * @return GeneratedBinary 二进制内容
     */
    public GeneratedBinary dataUrlBinary(String url, String defaultMimeType) {
        int commaIndex = url.indexOf(',');
        if (commaIndex < 0 || !url.substring(0, commaIndex).contains(";base64")) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "data URL必须是base64格式");
        }
        String header = url.substring(5, commaIndex);
        String mimeType = AiTaskParameterReader.firstNonEmpty(header.split(";")[0], defaultMimeType);
        return new GeneratedBinary(Base64.getDecoder().decode(url.substring(commaIndex + 1)), mimeType);
    }

    /**
     * 根据MIME类型获取扩展名
     *
     * @param mimeType String MIME类型
     * @param defaultExtension String 默认扩展名
     * @return String 扩展名
     */
    public String fileExtension(String mimeType, String defaultExtension) {
        if (!StringUtils.hasText(mimeType) || !mimeType.contains("/")) {
            return defaultExtension;
        }
        return mimeType.substring(mimeType.indexOf('/') + 1).replace("jpeg", "jpg").replace("mpeg", "mp3");
    }

    /**
     * 判断是否为HTTP媒体地址
     *
     * @param url String 媒体地址
     * @return boolean 是否为HTTP地址
     */
    public boolean isHttpUrl(String url) {
        if (!StringUtils.hasText(url)) return false;
        String normalized = url.trim().toLowerCase(java.util.Locale.ROOT);
        return normalized.startsWith("http://") || normalized.startsWith("https://");
    }

    /**
     * 判断是否为data URL。
     *
     * @param url String 媒体地址
     * @return boolean 是否为data URL
     */
    private boolean isDataUrl(String url) {
        return StringUtils.hasText(url) && url.regionMatches(true, 0, "data:", 0, 5);
    }

}
