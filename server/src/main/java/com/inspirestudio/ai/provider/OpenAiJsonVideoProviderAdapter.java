package com.inspirestudio.ai.provider;

import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.ai.AiErrorSupport;
import com.inspirestudio.ai.AiGenerationRetry;
import com.inspirestudio.ai.AiHttpClient;
import com.inspirestudio.ai.AiJsonUtils;
import com.inspirestudio.ai.AiMediaSupport;
import com.inspirestudio.ai.AiProviderException;
import com.inspirestudio.ai.AiProviderAdapter;
import com.inspirestudio.ai.AiRequestBodySupport;
import com.inspirestudio.ai.AiTaskExecutionContext;
import com.inspirestudio.ai.AiTaskParameterReader;
import com.inspirestudio.ai.AiTaskPollingSupport;
import com.inspirestudio.ai.AiTaskTypes;
import com.inspirestudio.ai.GeneratedBinary;
import com.inspirestudio.ai.VideoGenerationMode;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.dto.AiTaskDtos;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import javax.imageio.ImageIO;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * 使用JSON请求体的OpenAI兼容视频接口适配器。
 *
 * <p>该格式独立于通用OpenAI适配器，避免改变已有渠道依赖的multipart视频协议。</p>
 *
 * @date 2026-09-20 00:00
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class OpenAiJsonVideoProviderAdapter implements AiProviderAdapter {

    /** 最大轮询次数。 */
    private static final int MAXIMUM_POLLING_ATTEMPTS = 120;

    /** 上游短暂查不到已创建任务时，使用原任务ID继续查询的次数。 */
    private static final int MAXIMUM_MISSING_TASK_POLL_RETRIES = 2;

    /** Lumina原生图片上传接口的单文件限制。 */
    private static final int MAXIMUM_LUMINA_IMAGE_BYTES = 10 * 1024 * 1024;

    /** 任务处理中状态。 */
    private static final Set<String> PROCESSING_STATUSES = Set.of("queued", "in_progress", "processing", "pending", "running");

    /** 任务失败状态。 */
    private static final Set<String> FAILURE_STATUSES = Set.of("failed", "canceled", "cancelled", "expired");

    /** AI HTTP客户端。 */
    private final AiHttpClient aiHttpClient;

    /** AI媒体解析和对象存储支持。 */
    private final AiMediaSupport mediaSupport;

    /** 服务配置。 */
    private final InspireProperties properties;

    @Override
    public String apiFormat() {
        return "openai-video-json";
    }

    @Override
    public boolean supports(String taskType) {
        return AiTaskTypes.VIDEO.equals(taskType);
    }

    @Override
    public Mono<JSONObject> execute(AiTaskExecutionContext context) {
        if (!AiTaskTypes.VIDEO.equals(context.task().getTaskType())) {
            return Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR, "OpenAI视频JSON渠道只支持视频任务"));
        }
        List<AiTaskDtos.AiTaskMediaReference> imageReferences = AiTaskParameterReader.safeReferences(context.request().references());
        List<AiTaskDtos.AiTaskMediaReference> videoReferences = AiTaskParameterReader.safeReferences(context.request().videoReferences());
        List<AiTaskDtos.AiTaskMediaReference> audioReferences = AiTaskParameterReader.safeReferences(context.request().audioReferences());
        if (!videoReferences.isEmpty() || !audioReferences.isEmpty()) {
            return Mono.error(new BusinessException(ErrorCode.PARAM_INVALID, "OpenAI视频JSON渠道目前只支持图片参考素材"));
        }
        String existingTaskId = AiGenerationRetry.state(context).getString("openAiVideoTaskId");
        if (StringUtils.hasText(existingTaskId)) return resumeVideoTask(context, existingTaskId);
        return Flux.fromIterable(imageReferences)
                .concatMap(reference -> mediaSupport.resolveReferenceUrl(context.task().getUserId(), reference))
                .collectList()
                .flatMap(referenceUrls -> uploadLuminaReferenceImages(context, referenceUrls, imageReferences))
                .flatMap(referenceUrls -> submitVideoTask(context, referenceUrls, imageReferences));
    }

    /**
     * 将R2等公网参考图上传到Lumina原生媒体接口，并返回上游可识别的内部URI。
     *
     * <p>Seedance 2.x 的r2v记录把图片字段声明为uri。公网URL虽然可以通过OpenAI接口创建任务，
     * 但上游会在执行阶段失败。配置本地管理令牌后，在提交生成任务前完成一次媒体转换；
     * 已经是上游内部URI的值保持原样。</p>
     */
    private Mono<List<String>> uploadLuminaReferenceImages(AiTaskExecutionContext context, List<String> referenceUrls,
                                                            List<AiTaskDtos.AiTaskMediaReference> references) {
        String localApiToken = properties.getAi().getLumina().getLocalApiToken();
        if (!StringUtils.hasText(localApiToken) || referenceUrls == null || referenceUrls.isEmpty()) {
            return Mono.just(referenceUrls == null ? List.of() : referenceUrls);
        }
        String uploadUrl = luminaImageUploadUrl(context.channel().baseUrl());
        return Flux.range(0, referenceUrls.size())
                .concatMap(index -> {
                    String referenceUrl = referenceUrls.get(index);
                    if (!referenceUrl.matches("(?i)^https?://.+")) return Mono.just(referenceUrl);
                    AiTaskDtos.AiTaskMediaReference reference = index < references.size() ? references.get(index) : null;
                    String declaredMimeType = reference == null ? "" : reference.mimeType();
                    return aiHttpClient.downloadRemoteBinary(referenceUrl,
                                    AiTaskParameterReader.firstNonEmpty(declaredMimeType, "image/jpeg"))
                            .flatMap(binary -> {
                                if (binary.data().length > MAXIMUM_LUMINA_IMAGE_BYTES) {
                                    return Mono.error(new BusinessException(ErrorCode.PARAM_INVALID,
                                            "Lumina参考图不能超过10MB"));
                                }
                                LuminaReferenceImage image = prepareLuminaReferenceImage(binary, declaredMimeType);
                                if (image.data().length > MAXIMUM_LUMINA_IMAGE_BYTES) {
                                    return Mono.error(new BusinessException(ErrorCode.PARAM_INVALID,
                                            "Lumina参考图转换后不能超过10MB"));
                                }
                                String fileName = "reference-" + (index + 1) + luminaFileExtension(image.mimeType());
                                return aiHttpClient.uploadBinaryUrl(uploadUrl, localApiToken, image.mimeType(), fileName, image.data());
                            })
                            .map(response -> {
                                JSONObject payload = AiJsonUtils.responsePayload(response);
                                String uri = AiTaskParameterReader.firstNonEmpty(
                                        payload.getString("uri"), payload.getString("url"),
                                        response.getString("uri"), response.getString("url"));
                                if (!StringUtils.hasText(uri)) {
                                    throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR,
                                            "Lumina图片上传接口没有返回内部URI");
                                }
                                return uri;
                            });
                })
                .collectList();
    }

    /** 从OpenAI兼容Base URL构建Lumina原生媒体上传地址。 */
    static String luminaImageUploadUrl(String baseUrl) {
        String normalized = baseUrl == null ? "" : baseUrl.trim().replaceAll("/+$", "");
        if (!normalized.toLowerCase(Locale.ROOT).endsWith("/openai/v1")) {
            throw new BusinessException(ErrorCode.BUSINESS_ERROR,
                    "Lumina渠道Base URL必须以/openai/v1结尾才能上传参考图");
        }
        return normalized.substring(0, normalized.length() - "/openai/v1".length()) + "/v1/media/images";
    }

    /**
     * 依据真实文件头准备Lumina参考图，避免把前端的image/*通配类型误判为不支持。
     * ImageIO通过WebP插件解码短剧导入图片，按真实内容转成PNG后上传。
     */
    static LuminaReferenceImage prepareLuminaReferenceImage(GeneratedBinary binary, String declaredMimeType) {
        byte[] data = binary == null || binary.data() == null ? new byte[0] : binary.data();
        String detectedMimeType = detectLuminaImageMimeType(data);
        if (StringUtils.hasText(detectedMimeType)) {
            return new LuminaReferenceImage(data, detectedMimeType);
        }
        try (ByteArrayInputStream input = new ByteArrayInputStream(data);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            BufferedImage image = ImageIO.read(input);
            if (image != null && ImageIO.write(image, "png", output)) {
                return new LuminaReferenceImage(output.toByteArray(), "image/png");
            }
        } catch (Exception exception) {
            log.debug("Lumina参考图格式转换失败: declaredMimeType={}, responseMimeType={}",
                    declaredMimeType, binary == null ? "" : binary.mimeType(), exception);
        }
        throw new BusinessException(ErrorCode.PARAM_INVALID,
                "参考图无法转换为Lumina支持的JPEG、PNG或GIF，请重新上传有效图片");
    }

    /** 按文件签名识别Lumina支持的图片格式，不依赖可能为image/*的声明类型。 */
    private static String detectLuminaImageMimeType(byte[] data) {
        if (data == null) return "";
        if (data.length >= 8
                && (data[0] & 0xff) == 0x89 && data[1] == 0x50 && data[2] == 0x4e && data[3] == 0x47
                && data[4] == 0x0d && data[5] == 0x0a && data[6] == 0x1a && data[7] == 0x0a) {
            return "image/png";
        }
        if (data.length >= 3 && (data[0] & 0xff) == 0xff && (data[1] & 0xff) == 0xd8 && (data[2] & 0xff) == 0xff) {
            return "image/jpeg";
        }
        if (data.length >= 6 && data[0] == 'G' && data[1] == 'I' && data[2] == 'F'
                && data[3] == '8' && (data[4] == '7' || data[4] == '9') && data[5] == 'a') {
            return "image/gif";
        }
        return "";
    }

    /** 根据图片类型生成安全的ASCII扩展名。 */
    private static String luminaFileExtension(String mimeType) {
        return switch (mimeType) {
            case "image/png" -> ".png";
            case "image/gif" -> ".gif";
            default -> ".jpg";
        };
    }

    /** Lumina原生媒体上传使用的已校验图片。 */
    record LuminaReferenceImage(byte[] data, String mimeType) {
    }

    /** 提交视频任务并等待生成完成。 */
    private Mono<JSONObject> submitVideoTask(AiTaskExecutionContext context, List<String> referenceUrls,
                                              List<AiTaskDtos.AiTaskMediaReference> imageReferences) {
        Map<String, Object> payload = buildVideoRequestPayload(
                context.model(), context.request().prompt(), context.request().parameters(),
                context.request().videoGenerationMode(), referenceUrls,
                imageReferences.stream().map(AiTaskDtos.AiTaskMediaReference::role).toList());
        Map<String, Object> requestBody = AiRequestBodySupport.mergeCustomBodyParameters(payload, context.customBodyParameters());
        // Lumina会自行选择底层记录；外部传入这两个字段可能导致模式和素材映射错误。
        requestBody.remove("type");
        requestBody.remove("inference_type");
        String idempotencyKey = "inspire-video-" + context.task().getId();
        int submission = AiGenerationRetry.state(context).getIntValue("openAiVideoSubmission");
        if (submission > 0) idempotencyKey += "-retry-" + submission;
        return aiHttpClient.sendJsonRequest(context.channel(), "POST", "/videos", requestBody,
                        Map.of("Idempotency-Key", idempotencyKey))
                .map(AiJsonUtils::responsePayload)
                .flatMap(created -> {
                    String providerTaskId = AiTaskParameterReader.firstNonEmpty(created.getString("id"), created.getString("task_id"));
                    if (!StringUtils.hasText(providerTaskId)) {
                        return Mono.error(new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "OpenAI视频JSON接口没有返回任务ID"));
                    }
                    JSONObject checkpoint = AiGenerationRetry.state(context);
                    checkpoint.put("openAiVideoTaskId", providerTaskId);
                    context.task().setResultData(checkpoint.toJSONString());
                    return resumeVideoTask(context, providerTaskId);
                });
    }

    private Mono<JSONObject> resumeVideoTask(AiTaskExecutionContext context, String providerTaskId) {
        return context.updateRunningProgress(20)
                .then(pollVideoTask(context, providerTaskId))
                .flatMap(finished -> storeVideoResult(context, providerTaskId, finished));
    }

    /** 判断错误是否为Lumina创建账号离池后产生的任务404。 */
    static boolean isMissingProviderTask(Throwable error) {
        Throwable current = error;
        while (current != null) {
            if (current instanceof AiProviderException providerException
                    && providerException.getDetails() != null
                    && Integer.valueOf(404).equals(providerException.getDetails().httpStatus())) {
                String message = providerException.getDetails().message();
                String normalized = message == null ? "" : message.toLowerCase(Locale.ROOT);
                if (normalized.contains("not found")
                        && (normalized.contains("task") || normalized.contains("video"))) return true;
            }
            current = current.getCause();
        }
        return false;
    }

    /** 轮询视频任务直至完成。 */
    private Mono<JSONObject> pollVideoTask(AiTaskExecutionContext context, String providerTaskId) {
        Duration configuredInterval = AiTaskPollingSupport.pollingInterval(properties);
        Duration pollingInterval = configuredInterval.compareTo(Duration.ofSeconds(5)) < 0
                ? Duration.ofSeconds(5) : configuredInterval;
        String taskPath = "/videos/" + providerTaskId;
        AtomicInteger consecutiveMissingTaskResponses = new AtomicInteger();
        return Flux.range(0, MAXIMUM_POLLING_ATTEMPTS)
                .concatMap(attempt -> Mono.delay(pollingInterval)
                        .then(context.isCancelRequested())
                        .flatMap(cancelRequested -> Boolean.TRUE.equals(cancelRequested)
                                ? cancelRemoteTask(context, taskPath)
                                : aiHttpClient.sendJsonRequest(context.channel(), "GET", taskPath, null)
                                        .map(AiJsonUtils::responsePayload)
                                        .flatMap(response -> {
                                            consecutiveMissingTaskResponses.set(0);
                                            return processVideoStatus(context, providerTaskId, response, attempt);
                                        })
                                        .onErrorResume(error -> retryMissingProviderTask(
                                                context, providerTaskId, consecutiveMissingTaskResponses, error))))
                .next()
                .switchIfEmpty(Mono.error(AiErrorSupport.providerPollingTimeout("OpenAI视频JSON生成超时，请稍后重试")));
    }

    /**
     * 上游偶发404时仅重试查询原任务，绝不重新POST创建任务，避免重复生成和重复计费。
     */
    private Mono<JSONObject> retryMissingProviderTask(AiTaskExecutionContext context, String providerTaskId,
                                                       AtomicInteger consecutiveMissingTaskResponses,
                                                       Throwable error) {
        if (!isMissingProviderTask(error)) return Mono.error(error);
        int retry = consecutiveMissingTaskResponses.incrementAndGet();
        if (retry > MAXIMUM_MISSING_TASK_POLL_RETRIES) return Mono.error(error);
        log.warn("Lumina暂时查不到已提交任务，保留原任务ID继续查询: taskId={}, providerTaskId={}, retry={}/{}",
                context.task().getId(), providerTaskId, retry, MAXIMUM_MISSING_TASK_POLL_RETRIES);
        return Mono.empty();
    }

    /** 在本地取消时同步请求取消远端任务。 */
    private Mono<JSONObject> cancelRemoteTask(AiTaskExecutionContext context, String taskPath) {
        return aiHttpClient.sendJsonRequest(context.channel(), "DELETE", taskPath, null)
                .onErrorResume(error -> Mono.just(new JSONObject()))
                .then(Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR, "任务已取消")));
    }

    /** 处理单次状态查询。 */
    private Mono<JSONObject> processVideoStatus(AiTaskExecutionContext context, String providerTaskId, JSONObject response, int attempt) {
        String status = AiTaskParameterReader.firstNonEmpty(response.getString("status")).toLowerCase(Locale.ROOT);
        int providerProgress = parseProgress(response.get("progress"), Math.min(95, 20 + attempt));
        int progress = Math.max(20, Math.min(95, providerProgress));
        return context.updateRunningProgress(progress).then(Mono.defer(() -> {
            if (Set.of("completed", "succeeded", "success", "done").contains(status)) return Mono.just(response);
            if (PROCESSING_STATUSES.contains(status)) return Mono.empty();
            if (FAILURE_STATUSES.contains(status)) return resolveVideoFailure(context, providerTaskId, response).flatMap(Mono::error);
            return Mono.error(new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "OpenAI视频JSON接口返回未知任务状态: " + status));
        }));
    }

    /** Lumina's compatibility response omits fail_reason; read the same task's native detail when available. */
    Mono<AiProviderException> resolveVideoFailure(AiTaskExecutionContext context, String providerTaskId, JSONObject response) {
        AiProviderException fallback = AiErrorSupport.providerTaskFailure(response, "OpenAI视频JSON生成失败");
        String token = properties.getAi().getLumina().getLocalApiToken();
        String base = context.channel().baseUrl().replaceAll("/+$", "");
        String nativeId = providerTaskId.replaceFirst("^video_", "");
        if (!StringUtils.hasText(token) || !base.endsWith("/openai/v1") || !nativeId.matches("[a-zA-Z0-9_-]+")
                || !fallback.getMessage().toLowerCase(Locale.ROOT).contains("video generation did not complete")) {
            return Mono.just(fallback);
        }
        var nativeChannel = new AiTaskDtos.AiChannelConfig(context.channel().id(), context.channel().name(),
                base, token, context.channel().apiFormat(), context.channel().models());
        String nativeUrl = base.substring(0, base.length() - "/openai/v1".length()) + "/v1/videos/" + nativeId;
        return Mono.defer(() -> aiHttpClient.sendBearerJsonUrlRequest(nativeChannel, "GET", nativeUrl, null))
                .timeout(Duration.ofSeconds(5))
                .map(detail -> nativeVideoFailure(detail, fallback))
                .onErrorReturn(fallback);
    }

    static AiProviderException nativeVideoFailure(JSONObject detail, AiProviderException fallback) {
        JSONObject task = detail.getJSONObject("task");
        if (task == null) return fallback;
        JSONObject failed = task;
        JSONArray children = task.getJSONArray("children");
        if (children != null) {
            for (int i = 0; i < children.size(); i++) {
                JSONObject child = children.getJSONObject(i);
                if (child != null && StringUtils.hasText(child.getString("fail_reason"))) { failed = child; break; }
            }
        }
        String reason = failed.getString("fail_reason");
        if (!StringUtils.hasText(reason)) return fallback;
        JSONObject extra = failed.getJSONObject("extra");
        String code = extra == null ? null : extra.getString("error_code");
        if ("23003".equals(code) || reason.contains("[code=23003]")) {
            code = "23003";
            reason = "提示词未通过上游内容审核（23003），请调整描述后重试";
        }
        JSONObject error = new JSONObject();
        error.put("message", reason);
        if (StringUtils.hasText(code)) error.put("code", code);
        JSONObject enriched = new JSONObject();
        enriched.put("error", error);
        return AiErrorSupport.providerTaskFailure(enriched, reason);
    }

    /** 下载完成视频并写入全站默认对象存储。 */
    private Mono<JSONObject> storeVideoResult(AiTaskExecutionContext context, String providerTaskId, JSONObject response) {
        int durationMilliseconds = parseDurationSeconds(context.request().parameters(), context.model()) * 1000;
        // Lumina任务地址依赖创建任务的上游账号，完成后必须立即通过带鉴权的/content端点下载并转存。
        return aiHttpClient.downloadBinary(context.channel(), "/videos/" + providerTaskId + "/content")
                .flatMap(binary -> mediaSupport.storeGeneratedMedia(
                        context.task().getUserId(), AiTaskTypes.VIDEO, "generated-video.mp4",
                        new GeneratedBinary(binary.data(), AiTaskParameterReader.firstNonEmpty(binary.mimeType(), "video/mp4")),
                        null, null, durationMilliseconds))
                .map(media -> AiJsonUtils.jsonObject(Map.of("item", media, "providerTaskId", providerTaskId)));
    }

    /**
     * 构建Lumina/OpenAI兼容JSON视频请求体。
     */
    static Map<String, Object> buildVideoRequestPayload(String model, String prompt, Map<String, Object> parameters,
                                                         String videoGenerationMode, List<String> referenceUrls,
                                                         List<String> referenceRoles) {
        List<String> images = referenceUrls == null ? List.of() : referenceUrls;
        List<String> roles = referenceRoles == null ? List.of() : referenceRoles;
        String mode = VideoGenerationMode.defaultIfBlank(AiTaskParameterReader.firstNonEmpty(
                videoGenerationMode, AiTaskParameterReader.parameterText(parameters, "videoGenerationMode", "")));
        if (!VideoGenerationMode.isSupported(mode)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "视频生成模式不受支持");
        }

        Map<String, Object> payload = new LinkedHashMap<>();
        validatePrompt(model, prompt);
        payload.put("model", model);
        payload.put("prompt", prompt);
        payload.put("seconds", parseDurationSeconds(parameters, model));
        String resolution = normalizeResolution(AiTaskParameterReader.parameterText(parameters, "resolution", "480p"));
        validateResolution(model, resolution);
        payload.put("resolution", resolution);
        payload.put("with_audio", booleanParameter(parameters, "with_audio", booleanParameter(parameters, "withAudio", true)));

        String size = AiTaskParameterReader.parameterText(parameters, "size", "").trim();
        if (size.matches("^\\d+[xX]\\d+$")) {
            payload.put("size", size.toLowerCase(Locale.ROOT));
        } else if (size.matches("^\\d+(?:\\.\\d+)?:\\d+(?:\\.\\d+)?$") || "adaptive".equalsIgnoreCase(size)) {
            payload.put("aspect_ratio", size.toLowerCase(Locale.ROOT));
        } else {
            payload.put("aspect_ratio", "16:9");
        }

        switch (mode) {
            case VideoGenerationMode.TEXT_TO_VIDEO -> {
                if (!images.isEmpty()) throw new BusinessException(ErrorCode.PARAM_INVALID, "文生视频不能携带图片参考素材");
                payload.put("task_type", "t2v");
            }
            case VideoGenerationMode.IMAGE_TO_VIDEO -> {
                if (images.isEmpty()) throw new BusinessException(ErrorCode.PARAM_INVALID, "图生视频至少需要一张图片参考素材");
                payload.put("task_type", "i2v");
                // 2.x只传prompt_pic会静默丢图；media_urls可同时兼容Seedance 1.x和2.x。
                payload.put("media_urls", new ArrayList<>(images));
            }
            case VideoGenerationMode.FIRST_LAST_FRAME_TO_VIDEO -> {
                if (images.size() != 2) throw new BusinessException(ErrorCode.PARAM_INVALID, "首尾帧视频必须提供两张图片");
                List<String> orderedImages = orderFirstLastFrames(images, roles);
                payload.put("task_type", "flf");
                payload.put("first_prompt_pic", orderedImages.get(0));
                payload.put("last_prompt_pic", orderedImages.get(1));
                if (isSeedance25(model)) {
                    payload.remove("size");
                    payload.put("aspect_ratio", "adaptive");
                }
            }
            case VideoGenerationMode.REFERENCE_TO_VIDEO -> {
                if (images.isEmpty()) throw new BusinessException(ErrorCode.PARAM_INVALID, "主体参考视频至少需要一张图片参考素材");
                payload.put("task_type", "r2v");
                payload.put("reference_urls", new ArrayList<>(images));
            }
            default -> throw new BusinessException(ErrorCode.PARAM_INVALID, "视频生成模式不受支持");
        }
        return payload;
    }

    /** 按媒体角色确定首尾帧顺序，旧数据未携带角色时保留列表顺序。 */
    private static List<String> orderFirstLastFrames(List<String> images, List<String> roles) {
        int firstIndex = roles.indexOf("first_frame");
        int lastIndex = roles.indexOf("last_frame");
        if (firstIndex >= 0 && firstIndex < images.size() && lastIndex >= 0 && lastIndex < images.size()) {
            return List.of(images.get(firstIndex), images.get(lastIndex));
        }
        return images;
    }

    /** 从常见完成响应字段读取视频地址。 */
    static String readVideoResultUrl(JSONObject response) {
        if (response == null) return "";
        String direct = AiTaskParameterReader.firstNonEmpty(response.getString("url"), response.getString("output_url"),
                response.getString("video_url"), response.getString("content_url"));
        if (StringUtils.hasText(direct)) return direct;
        for (String key : List.of("output", "result", "video")) {
            JSONObject nested = response.getJSONObject(key);
            String nestedUrl = nested == null ? "" : AiTaskParameterReader.firstNonEmpty(
                    nested.getString("url"), nested.getString("output_url"), nested.getString("video_url"), nested.getString("content_url"));
            if (StringUtils.hasText(nestedUrl)) return nestedUrl;
        }
        JSONArray data = response.getJSONArray("data");
        if (data != null && !data.isEmpty() && data.get(0) instanceof JSONObject item) {
            return AiTaskParameterReader.firstNonEmpty(item.getString("url"), item.getString("video_url"), item.getString("content_url"));
        }
        return "";
    }

    /** 解析视频时长，兼容前端字符串值。 */
    private static int parseDurationSeconds(Map<String, Object> parameters, String model) {
        String value = AiTaskParameterReader.parameterText(parameters, "seconds",
                AiTaskParameterReader.parameterText(parameters, "duration", "5"));
        try {
            int seconds = Integer.parseInt(value);
            ModelLimits limits = modelLimits(model);
            if (seconds < limits.minimumSeconds() || seconds > limits.maximumSeconds()) {
                throw new BusinessException(ErrorCode.PARAM_INVALID,
                        model + " 视频时长必须在" + limits.minimumSeconds() + "到" + limits.maximumSeconds() + "秒之间");
            }
            return seconds;
        } catch (NumberFormatException exception) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "视频时长必须是整数秒");
        }
    }

    /** 规范化接口支持的清晰度名称。 */
    private static String normalizeResolution(String resolution) {
        String normalized = resolution == null ? "" : resolution.trim().toLowerCase(Locale.ROOT);
        if (normalized.equals("4k") || normalized.equals("2160p")) return "4k";
        if (normalized.equals("auto") || normalized.equals("low")) return "480p";
        if (normalized.equals("medium") || normalized.equals("high")) return "720p";
        if (normalized.contains("1080")) return "1080p";
        if (normalized.contains("480")) return "480p";
        if (normalized.contains("720")) return "720p";
        throw new BusinessException(ErrorCode.PARAM_INVALID, "视频清晰度仅支持480p、720p、1080p或4k");
    }

    /** 按Lumina实时模型ID校验各模型分辨率。 */
    private static void validateResolution(String model, String resolution) {
        ModelLimits limits = modelLimits(model);
        if (!limits.resolutions().contains(resolution)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    model + " 不支持" + resolution + "，可用清晰度为" + String.join("、", limits.resolutions()));
        }
    }

    /** 按模型限制提示词字符数，避免任务到上游后才失败。 */
    private static void validatePrompt(String model, String prompt) {
        ModelLimits limits = modelLimits(model);
        int length = prompt == null ? 0 : prompt.codePointCount(0, prompt.length());
        if (length > limits.maximumPromptCharacters()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    model + " 提示词不能超过" + limits.maximumPromptCharacters() + "个字符");
        }
    }

    /** 返回API-INTEGRATION.md中实测的模型约束；Mini保留产品侧8秒上限。 */
    private static ModelLimits modelLimits(String model) {
        String normalized = model == null ? "" : model.trim().toLowerCase(Locale.ROOT);
        if (normalized.equals("doubao-seedance-2.5") || normalized.equals("seedance 2.5")) {
            return new ModelLimits(4, 30, 15_000, List.of("480p", "720p", "1080p"));
        }
        if (normalized.equals("doubao-seedance-2.0-pro")) {
            return new ModelLimits(4, 15, 5_000, List.of("480p", "720p", "1080p", "4k"));
        }
        if (normalized.equals("doubao-seedance-2.0-pro-fast") || normalized.equals("seedance 2.0 fast")) {
            return new ModelLimits(4, 15, 5_000, List.of("480p", "720p"));
        }
        if (normalized.equals("doubao-seedance-2.0-mini") || normalized.equals("seedance 2.0 mini")) {
            return new ModelLimits(4, 8, 5_000, List.of("480p", "720p"));
        }
        if (normalized.equals("bytedance-seedance-1.5-pro")) {
            return new ModelLimits(4, 12, 4_000, List.of("480p", "720p", "1080p"));
        }
        if (normalized.equals("bytedance-seedance-1.0-pro") || normalized.equals("bytedance-seedance-1.0-pro-fast")) {
            return new ModelLimits(2, 12, 500, List.of("480p", "720p", "1080p"));
        }
        if (normalized.equals("seedance_i2v_pro_com")) {
            return new ModelLimits(3, 12, 4_000, List.of("480p", "720p", "1080p"));
        }
        return new ModelLimits(1, 60, 15_000, List.of("480p", "720p", "1080p", "4k"));
    }

    private static boolean isSeedance25(String model) {
        String normalized = model == null ? "" : model.trim().toLowerCase(Locale.ROOT);
        return normalized.equals("doubao-seedance-2.5") || normalized.equals("seedance 2.5");
    }

    /** Lumina模型实测约束。 */
    private record ModelLimits(int minimumSeconds, int maximumSeconds, int maximumPromptCharacters,
                               List<String> resolutions) {
    }

    /** 读取布尔参数。 */
    private static boolean booleanParameter(Map<String, Object> parameters, String key, boolean fallback) {
        Object value = parameters == null ? null : parameters.get(key);
        if (value instanceof Boolean booleanValue) return booleanValue;
        if (value instanceof String text && StringUtils.hasText(text)) return Boolean.parseBoolean(text.trim());
        return fallback;
    }

    /** 解析数字或百分数字符串进度。 */
    private static int parseProgress(Object value, int fallback) {
        if (value instanceof Number number) return number.intValue();
        if (value instanceof String text) {
            String normalized = text.trim().replace("%", "");
            try {
                return Integer.parseInt(normalized);
            } catch (NumberFormatException ignored) {
                return fallback;
            }
        }
        return fallback;
    }
}
