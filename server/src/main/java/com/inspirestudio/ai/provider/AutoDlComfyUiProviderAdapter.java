package com.inspirestudio.ai.provider;

import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.ai.AiErrorSupport;
import com.inspirestudio.ai.AiHttpClient;
import com.inspirestudio.ai.AiJsonUtils;
import com.inspirestudio.ai.AiMediaSupport;
import com.inspirestudio.ai.AiProviderAdapter;
import com.inspirestudio.ai.AiRequestBodySupport;
import com.inspirestudio.ai.AiTaskExecutionContext;
import com.inspirestudio.ai.AiTaskParameterReader;
import com.inspirestudio.ai.AiTaskPollingSupport;
import com.inspirestudio.ai.AiTaskTypes;
import com.inspirestudio.ai.GeneratedBinary;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.dto.AiTaskDtos;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * AutoDL ComfyUI 工作流视频渠道适配器。
 *
 * @date 2026-09-22 12:00
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class AutoDlComfyUiProviderAdapter implements AiProviderAdapter {

    /** 渠道调用格式。 */
    public static final String API_FORMAT = "autodl-comfyui";

    /** 默认工作流 ID，仅用于初始化现有配置。 */
    public static final String WORKFLOW_ID = "minimax_h3_image_audio_to_video_v2_15s";

    /** 工作流 ID 只允许作为单个安全路径片段。 */
    private static final Pattern WORKFLOW_ID_PATTERN = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$");

    /** 提交工作流路径前缀。 */
    private static final String SUBMISSION_PATH_PREFIX = "/api/v1/comfyui/comfyui_workflow/";

    /** 查询任务路径前缀。 */
    private static final String RESULT_PATH_PREFIX = "/api/v1/comfyui/comfyui_workflow/result/";

    /** 最大参考图片数量。 */
    private static final int MAXIMUM_REFERENCE_IMAGE_COUNT = 9;

    /** 最大参考音频数量。 */
    private static final int MAXIMUM_REFERENCE_AUDIO_COUNT = 3;

    /** 与 AutoDL 在线调用表单一致，全部参考文件原始大小合计不能超过50MiB。 */
    static final long MAXIMUM_REFERENCE_BYTES = 50L * 1024 * 1024;

    private static final Set<String> H3_IMAGE_MIME_TYPES = Set.of("image/jpeg", "image/png", "image/webp");
    private static final Set<String> H3_AUDIO_MIME_TYPES = Set.of("audio/mpeg", "audio/wav", "audio/mp4", "audio/flac");

    /** 最大提示词长度。 */
    private static final int MAXIMUM_PROMPT_LENGTH = 10_000;

    /** 最大轮询次数，配合统一轮询间隔可覆盖长视频排队。 */
    private static final int MAXIMUM_POLLING_ATTEMPTS = 240;

    /** 处理中状态。 */
    private static final Set<String> PROCESSING_STATUSES = Set.of("queued", "pending", "running", "processing");

    /** 成功状态。 */
    private static final Set<String> SUCCESS_STATUSES = Set.of("success", "succeeded", "completed");

    /** 失败状态。 */
    private static final Set<String> FAILURE_STATUSES = Set.of("failed", "error", "cancelled", "canceled");

    /** AI HTTP 客户端。 */
    private final AiHttpClient aiHttpClient;

    /** AI 媒体支持。 */
    private final AiMediaSupport mediaSupport;

    /** 服务配置。 */
    private final InspireProperties properties;

    /** {@inheritDoc} */
    @Override
    public String apiFormat() {
        return API_FORMAT;
    }

    /** {@inheritDoc} */
    @Override
    public boolean supports(String taskType) {
        return AiTaskTypes.VIDEO.equals(taskType);
    }

    /** {@inheritDoc} */
    @Override
    public Mono<JSONObject> execute(AiTaskExecutionContext context) {
        if (!supports(context.task().getTaskType())) {
            return Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR, "AutoDL ComfyUI 调用格式仅支持视频任务"));
        }
        String workflowId = workflowId(context.model());
        List<AiTaskDtos.AiTaskMediaReference> images =
                AiTaskParameterReader.safeReferences(context.request().references());
        List<AiTaskDtos.AiTaskMediaReference> videos =
                AiTaskParameterReader.safeReferences(context.request().videoReferences());
        List<AiTaskDtos.AiTaskMediaReference> audio =
                AiTaskParameterReader.safeReferences(context.request().audioReferences());
        validateReferences(images, videos, audio);
        return Mono.defer(() -> {
            // 在读取参考素材前校验通用参数；每次订阅使用独立的合计大小预算。
            buildRequestPayload(context.request().prompt(), context.request().parameters(), List.of(), List.of());
            long[] referenceBytes = {0L};
            return resolveReferenceDataUrls(context, workflowId, images, false, referenceBytes)
                    .flatMap(imageData -> resolveReferenceDataUrls(context, workflowId, audio, true, referenceBytes)
                            .flatMap(audioData -> submit(context, workflowId, imageData, audioData)));
        });
    }

    /**
     * AutoDL 的通用媒体表单使用 readAsDataURL 直接提交文件。先由本站读取原图，
     * 避免上游访问 R2 公共域名超时；保留 storageKey 归属校验和音频裁剪。
     * 图片和音频依次解析以限制内存并共享50MiB总预算，任何准备失败都不会提交生成。
     */
    private Mono<List<String>> resolveReferenceDataUrls(
            AiTaskExecutionContext context, String workflowId,
            List<AiTaskDtos.AiTaskMediaReference> references, boolean audio, long[] referenceBytes) {
        return Flux.fromIterable(references)
                .concatMap(reference -> mediaSupport.resolveReferenceBinary(
                                context.task().getUserId(), reference, audio ? "audio/mpeg" : "image/png")
                        .map(binary -> {
                            referenceBytes[0] = checkedReferenceSize(referenceBytes[0],
                                    binary.data() == null ? 0 : binary.data().length);
                            return referenceDataUrl(binary, workflowId, audio);
                        }), 1)
                .collectList();
    }

    static long checkedReferenceSize(long existingBytes, long addedBytes) {
        if (addedBytes <= 0) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "AutoDL 参考素材不能为空，尚未提交生成请求");
        }
        if (addedBytes > MAXIMUM_REFERENCE_BYTES || existingBytes > MAXIMUM_REFERENCE_BYTES - addedBytes) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "AutoDL 所有参考图片和音频合计不能超过50MB，尚未提交生成请求");
        }
        return existingBytes + addedBytes;
    }

    /** H3按官方工作流accept_types校验；其他可配置工作流保留对应媒体类别的兼容性。 */
    static String referenceDataUrl(GeneratedBinary binary, String workflowId, boolean audio) {
        String mimeType = AiTaskParameterReader.firstNonEmpty(binary.mimeType())
                .split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        mimeType = switch (mimeType) {
            case "image/jpg" -> "image/jpeg";
            case "audio/x-wav", "audio/wave" -> "audio/wav";
            case "audio/mp3" -> "audio/mpeg";
            case "audio/x-flac" -> "audio/flac";
            case "audio/x-m4a" -> "audio/mp4";
            default -> mimeType;
        };
        boolean supported = mimeType.startsWith(audio ? "audio/" : "image/");
        if (WORKFLOW_ID.equals(workflowId)) {
            supported = (audio ? H3_AUDIO_MIME_TYPES : H3_IMAGE_MIME_TYPES).contains(mimeType);
        }
        if (!supported) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, audio
                    ? "AutoDL 参考音频格式不支持，H3工作流支持MP3、WAV、MP4或FLAC，尚未提交生成请求"
                    : "AutoDL 参考图片格式不支持，H3工作流支持JPG、PNG或WebP，尚未提交生成请求");
        }
        return "data:" + mimeType + ";base64," + Base64.getEncoder().encodeToString(binary.data());
    }

    /** 提交一次工作流任务并等待完成。 */
    private Mono<JSONObject> submit(
            AiTaskExecutionContext context, String workflowId, List<String> imageUrls, List<String> audioUrls) {
        Map<String, Object> payload = buildRequestPayload(
                context.request().prompt(), context.request().parameters(), imageUrls, audioUrls);
        Object mergedPayload = AiRequestBodySupport.mergeCustomBodyParameters(payload, context.customBodyParameters());
        String submissionPath = SUBMISSION_PATH_PREFIX + workflowId;
        log.info("创建AutoDL ComfyUI视频任务: taskId={}, workflow={}, imageCount={}, audioCount={}, referenceTransport=inline",
                context.task().getId(), workflowId, imageUrls.size(), audioUrls.size());
        // 提交调用没有重试，避免网络抖动时重复创建并重复扣取上游费用。
        return aiHttpClient.sendRawAuthorizationJsonRequest(context.channel(), "POST", submissionPath, mergedPayload)
                .map(response -> envelopePayload(response, "submission"))
                .flatMap(created -> {
                    String providerTaskId = AiTaskParameterReader.firstNonEmpty(created.getString("task_id"));
                    if (!StringUtils.hasText(providerTaskId)) {
                        return Mono.error(new BusinessException(
                                ErrorCode.THIRD_PARTY_CALL_ERROR, "AutoDL ComfyUI 接口没有返回任务ID"));
                    }
                    return context.updateRunningProgress(20)
                            .then(poll(context, providerTaskId))
                            .flatMap(finished -> storeVideo(context, providerTaskId, finished));
                });
    }

    /** 轮询 AutoDL 任务直到成功或失败。 */
    private Mono<JSONObject> poll(AiTaskExecutionContext context, String providerTaskId) {
        Duration interval = AiTaskPollingSupport.pollingInterval(properties);
        String queryPath = RESULT_PATH_PREFIX + providerTaskId;
        return Flux.range(0, MAXIMUM_POLLING_ATTEMPTS)
                .concatMap(attempt -> Mono.delay(interval)
                        .then(context.isCancelRequested())
                        .flatMap(cancelRequested -> Boolean.TRUE.equals(cancelRequested)
                                ? Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR, "任务已取消"))
                                : query(context, providerTaskId, queryPath, attempt)))
                .next()
                .switchIfEmpty(Mono.error(AiErrorSupport.providerPollingTimeout(
                        "AutoDL ComfyUI 视频生成超时，请稍后重试")));
    }

    /** 查询一次任务状态，处理中返回空信号。 */
    private Mono<JSONObject> query(
            AiTaskExecutionContext context, String providerTaskId, String queryPath, int attempt) {
        log.debug("AutoDL ComfyUI视频轮询第{}次: providerTaskId={}", attempt + 1, providerTaskId);
        return aiHttpClient.sendRawAuthorizationJsonRequest(context.channel(), "GET", queryPath, null)
                .map(response -> envelopePayload(response, "polling"))
                .flatMap(task -> {
                    String status = AiTaskParameterReader.firstNonEmpty(task.getString("status"))
                            .toLowerCase(Locale.ROOT);
                    int progress = Math.min(95, 20 + attempt);
                    return context.updateRunningProgress(progress).then(Mono.defer(() -> {
                        if (SUCCESS_STATUSES.contains(status)) return Mono.just(task);
                        if (PROCESSING_STATUSES.contains(status)) return Mono.empty();
                        if (FAILURE_STATUSES.contains(status)) {
                            return Mono.error(AiErrorSupport.providerTaskFailure(
                                    task, autoDlFailureMessage(task, status)));
                        }
                        return Mono.error(new BusinessException(
                                ErrorCode.THIRD_PARTY_CALL_ERROR, "AutoDL ComfyUI 返回了未知任务状态: " + status));
                    }));
                });
    }

    /** 下载临时结果地址并转存到默认对象存储。 */
    private Mono<JSONObject> storeVideo(
            AiTaskExecutionContext context, String providerTaskId, JSONObject task) {
        JSONArray results = task.getJSONArray("results");
        JSONObject firstResult = results == null || results.isEmpty() ? null : results.getJSONObject(0);
        String videoUrl = firstResult == null ? "" : AiTaskParameterReader.firstNonEmpty(firstResult.getString("url"));
        if (!StringUtils.hasText(videoUrl)) {
            return Mono.error(new BusinessException(
                    ErrorCode.THIRD_PARTY_CALL_ERROR, "AutoDL ComfyUI 任务成功但没有返回视频URL"));
        }
        int durationSeconds = durationParameter(context.request().parameters());
        log.info("AutoDL ComfyUI视频任务完成: taskId={}, providerTaskId={}, duration={}",
                context.task().getId(), providerTaskId, durationSeconds);
        return mediaSupport.registerGeneratedMediaUrl(
                        context.task().getUserId(), AiTaskTypes.VIDEO, videoUrl, "video/mp4",
                        null, null, durationSeconds * 1000)
                .map(media -> AiJsonUtils.jsonObject(Map.of(
                        "item", media,
                        "providerTaskId", providerTaskId
                )));
    }

    /**
     * 构建 AutoDL 工作流请求体。
     *
     * @param prompt String 视频提示词
     * @param parameters Map 通用视频参数
     * @param imageUrls List 图片 URL
     * @param audioUrls List 音频 URL
     * @return Map 请求体
     */
    static Map<String, Object> buildRequestPayload(
            String prompt, Map<String, Object> parameters, List<String> imageUrls, List<String> audioUrls) {
        String normalizedPrompt = StringUtils.hasText(prompt) ? prompt.trim() : "";
        if (normalizedPrompt.isEmpty() || normalizedPrompt.length() > MAXIMUM_PROMPT_LENGTH) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "AutoDL 视频提示词长度必须为1～10000个字符");
        }
        validateReferenceCounts(imageUrls, audioUrls);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("prompt", normalizedPrompt);
        payload.put("duration", durationParameter(parameters));
        payload.put("resolution", resolutionParameter(parameters));
        Long seed = seedParameter(parameters);
        if (seed != null) payload.put("seed", seed);
        for (int index = 0; index < imageUrls.size(); index++) {
            payload.put("ref_image_" + index, imageUrls.get(index));
        }
        for (int index = 0; index < audioUrls.size(); index++) {
            payload.put("ref_audio_" + index, audioUrls.get(index));
        }
        return payload;
    }

    /** 解析并校验生成时长。 */
    static int durationParameter(Map<String, Object> parameters) {
        String raw = AiTaskParameterReader.parameterText(parameters, "seconds", "5");
        try {
            int duration = Integer.parseInt(raw);
            if (duration < 1 || duration > 15) throw new NumberFormatException("out of range");
            return duration;
        } catch (NumberFormatException exception) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "AutoDL 视频时长必须为1～15秒的整数");
        }
    }

    /** 把通用分辨率和画面比例映射为 AutoDL 的四个枚举值。 */
    static String resolutionParameter(Map<String, Object> parameters) {
        String resolution = AiTaskParameterReader.stringParameter(parameters, "resolution", "768p")
                .toLowerCase(Locale.ROOT);
        if ("768".equals(resolution)) resolution = "768p";
        if ("480".equals(resolution)) resolution = "480p";
        if (!Set.of("480p", "768p").contains(resolution)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "AutoDL 视频分辨率仅支持480p或768p");
        }
        String size = AiTaskParameterReader.stringParameter(parameters, "size", "9:16")
                .toLowerCase(Locale.ROOT).replace(" ", "");
        return resolution + (isPortrait(size) ? "竖" : "横");
    }

    /** 判断比例或像素尺寸是否为竖屏。 */
    private static boolean isPortrait(String size) {
        String normalized = StringUtils.hasText(size) ? size : "9:16";
        String separator = normalized.contains(":") ? ":" : normalized.contains("x") ? "x" : "";
        if (separator.isEmpty()) return !Set.of("adaptive", "auto").contains(normalized);
        String[] parts = normalized.split(separator);
        if (parts.length != 2) return true;
        try {
            return Double.parseDouble(parts[0]) < Double.parseDouble(parts[1]);
        } catch (NumberFormatException exception) {
            return true;
        }
    }

    /** 解析可选随机种子。 */
    private static Long seedParameter(Map<String, Object> parameters) {
        Object raw = parameters == null ? null : parameters.get("seed");
        if (raw == null || !StringUtils.hasText(String.valueOf(raw))) return null;
        try {
            long seed = Long.parseLong(String.valueOf(raw).trim());
            if (seed < 1 || seed > 999_999_999_999_999L) throw new NumberFormatException("out of range");
            return seed;
        } catch (NumberFormatException exception) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "AutoDL 随机种子必须为1～999999999999999的整数");
        }
    }

    /** 校验工作流响应包装并返回 data。 */
    static JSONObject envelopePayload(JSONObject response, String stage) {
        String code = response == null ? "" : AiTaskParameterReader.firstNonEmpty(response.getString("code"));
        if (!"success".equalsIgnoreCase(code)) {
            throw AiErrorSupport.providerException(400,
                    response == null ? "{}" : response.toJSONString(), stage);
        }
        JSONObject data = response.getJSONObject("data");
        if (data == null) {
            throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "AutoDL ComfyUI 响应缺少data字段");
        }
        return data;
    }

    /**
     * 从所选视频模型读取工作流 ID。
     * <p>每个 AutoDL 渠道模型对应一个工作流，切换模型即可切换提交路径。</p>
     */
    static String workflowId(String model) {
        String normalized = model == null ? "" : model.trim();
        if (!WORKFLOW_ID_PATTERN.matcher(normalized).matches()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "AutoDL 工作流 ID 只能包含字母、数字、点、下划线和连字符");
        }
        return normalized;
    }

    /** 校验各类参考素材。 */
    private static void validateReferences(
            List<AiTaskDtos.AiTaskMediaReference> images,
            List<AiTaskDtos.AiTaskMediaReference> videos,
            List<AiTaskDtos.AiTaskMediaReference> audio) {
        if (!videos.isEmpty()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "AutoDL ComfyUI 工作流不支持参考视频，只支持图片和音频");
        }
        validateReferenceCounts(images, audio);
    }

    /** 校验参考图片和音频数量。 */
    private static void validateReferenceCounts(List<?> images, List<?> audio) {
        if (images.size() > MAXIMUM_REFERENCE_IMAGE_COUNT) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "AutoDL ComfyUI 工作流最多支持9张参考图片");
        }
        if (audio.size() > MAXIMUM_REFERENCE_AUDIO_COUNT) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "AutoDL ComfyUI 工作流最多支持3段参考音频");
        }
    }

    /** 读取供应商失败说明。 */
    private static String autoDlFailureMessage(JSONObject task, String status) {
        String message = AiTaskParameterReader.firstNonEmpty(
                task.getString("message"), task.getString("msg"), task.getString("error"));
        return StringUtils.hasText(message) ? message : "AutoDL ComfyUI 视频生成失败: " + status;
    }
}
