package com.inspirestudio.ai.provider;

import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.ai.AiErrorSupport;
import com.inspirestudio.ai.AiHttpClient;
import com.inspirestudio.ai.AiJsonUtils;
import com.inspirestudio.ai.AiMediaSupport;
import com.inspirestudio.ai.AiProviderAdapter;
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
import java.io.IOException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.util.retry.Retry;

/**
 * Muse 的 OpenAI Videos API 适配器。
 *
 * <p>Muse 接口的时长和构图参数会转换为提示词建议。项目对 Muse 固定请求 10 秒目标，
 * 不发送不受支持的 10 秒枚举值。</p>
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class MuseVideoProviderAdapter implements AiProviderAdapter {

    /** Muse 生成链路只提供 10 秒目标；实际成片时长由上游决定。 */
    private static final int TARGET_DURATION_SECONDS = 10;

    /** 单次轮询中连接级故障的最大重试次数。 */
    private static final int POLL_QUERY_MAX_RETRIES = 2;

    /** Muse 单次任务最长等待时间。 */
    private static final Duration MAXIMUM_POLLING_DURATION = Duration.ofMinutes(30);

    /** 异步处理中状态。 */
    private static final Set<String> PROCESSING_STATUSES = Set.of(
            "queued", "in_progress", "processing", "pending", "running");

    /** 失败或取消状态。 */
    private static final Set<String> FAILURE_STATUSES = Set.of(
            "failed", "canceled", "cancelled", "expired");

    private final AiHttpClient aiHttpClient;
    private final AiMediaSupport mediaSupport;
    private final InspireProperties properties;

    @Override
    public String apiFormat() {
        return "muse";
    }

    @Override
    public boolean supports(String taskType) {
        return AiTaskTypes.VIDEO.equals(taskType);
    }

    @Override
    public Mono<JSONObject> execute(AiTaskExecutionContext context) {
        if (!AiTaskTypes.VIDEO.equals(context.task().getTaskType())) {
            return Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR, "Muse 渠道只支持视频任务"));
        }
        List<AiTaskDtos.AiTaskMediaReference> imageReferences = AiTaskParameterReader.safeReferences(
                context.request().references());
        List<AiTaskDtos.AiTaskMediaReference> videoReferences = AiTaskParameterReader.safeReferences(
                context.request().videoReferences());
        List<AiTaskDtos.AiTaskMediaReference> audioReferences = AiTaskParameterReader.safeReferences(
                context.request().audioReferences());
        if (!videoReferences.isEmpty() || !audioReferences.isEmpty()) {
            return Mono.error(new BusinessException(ErrorCode.PARAM_INVALID,
                    "Muse 视频接口目前只支持图片参考素材"));
        }
        String mode = VideoGenerationMode.defaultIfBlank(AiTaskParameterReader.firstNonEmpty(
                context.request().videoGenerationMode(),
                AiTaskParameterReader.parameterText(context.request().parameters(), "videoGenerationMode", "")));
        String configuredSeconds = AiTaskParameterReader.parameterText(context.request().parameters(), "seconds", "10");
        if (!"10".equals(configuredSeconds.trim())) {
            return Mono.error(new BusinessException(ErrorCode.PARAM_INVALID,
                    "Muse 渠道时长只允许设置为 10 秒"));
        }
        if (VideoGenerationMode.TEXT_TO_VIDEO.equals(mode) && !imageReferences.isEmpty()) {
            return Mono.error(new BusinessException(ErrorCode.PARAM_INVALID,
                    "Muse 文生视频不能携带图片参考素材，请切换为图生视频"));
        }

        return Flux.fromIterable(imageReferences)
                .concatMap(reference -> mediaSupport.resolveReferenceUrl(context.task().getUserId(), reference))
                .collectList()
                .flatMap(referenceUrls -> submitVideoTask(context, mode, imageReferences, referenceUrls));
    }

    /** 创建任务、轮询结果并保存视频。 */
    private Mono<JSONObject> submitVideoTask(AiTaskExecutionContext context, String mode,
                                              List<AiTaskDtos.AiTaskMediaReference> imageReferences,
                                              List<String> referenceUrls) {
        Map<String, Object> payload = buildVideoRequestPayload(
                context.model(), context.request().prompt(), context.request().parameters(),
                mode, imageReferences, referenceUrls);
        log.info("创建Muse视频任务: taskId={}, model={}, targetDuration={}, imageCount={}",
                context.task().getId(), context.model(), TARGET_DURATION_SECONDS, referenceUrls.size());
        return aiHttpClient.sendJsonRequest(context.channel(), "POST", "/videos", payload)
                .map(AiJsonUtils::responsePayload)
                .flatMap(created -> {
                    String providerTaskId = AiTaskParameterReader.firstNonEmpty(created.getString("id"));
                    if (!StringUtils.hasText(providerTaskId)) {
                        return Mono.error(new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR,
                                "Muse 视频接口没有返回任务ID"));
                    }
                    return context.updateRunningProgress(10)
                            .then(pollVideoTask(context, providerTaskId))
                            .flatMap(finished -> storeVideoResult(context, providerTaskId, finished));
                });
    }

    /** 轮询 Muse 任务；临时网络错误只重试幂等 GET。 */
    private Mono<JSONObject> pollVideoTask(AiTaskExecutionContext context, String providerTaskId) {
        Duration configuredInterval = AiTaskPollingSupport.pollingInterval(properties);
        Duration interval = configuredInterval.compareTo(Duration.ofSeconds(5)) < 0
                ? Duration.ofSeconds(5) : configuredInterval;
        long intervalSeconds = Math.max(1L, interval.toSeconds());
        int maximumAttempts = (int) Math.max(1L, Math.min(360L,
                (MAXIMUM_POLLING_DURATION.toSeconds() + intervalSeconds - 1) / intervalSeconds));
        String taskPath = "/videos/" + providerTaskId;
        return Flux.range(0, maximumAttempts)
                .concatMap(attempt -> Mono.delay(interval)
                        .then(context.isCancelRequested())
                        .flatMap(cancelRequested -> Boolean.TRUE.equals(cancelRequested)
                                ? cancelRemoteTask(context, taskPath)
                                : queryVideoTask(context, providerTaskId, taskPath, attempt)))
                .next()
                .switchIfEmpty(Mono.error(AiErrorSupport.providerPollingTimeout(
                        "Muse 视频生成超时，请稍后查询任务状态")));
    }

    private Mono<JSONObject> queryVideoTask(AiTaskExecutionContext context, String providerTaskId,
                                             String taskPath, int attempt) {
        return aiHttpClient.sendJsonRequest(context.channel(), "GET", taskPath, null)
                .retryWhen(Retry.max(POLL_QUERY_MAX_RETRIES)
                        .filter(MuseVideoProviderAdapter::isTransientNetworkError))
                .map(AiJsonUtils::responsePayload)
                .flatMap(response -> processVideoStatus(context, providerTaskId, response, attempt));
    }

    /** 解析任务状态并更新进度。 */
    private Mono<JSONObject> processVideoStatus(AiTaskExecutionContext context, String providerTaskId,
                                                 JSONObject response, int attempt) {
        String status = AiTaskParameterReader.firstNonEmpty(response.getString("status"))
                .toLowerCase(Locale.ROOT);
        int fallbackProgress = Math.min(95, 15 + attempt);
        int progress = Math.max(10, Math.min(99, parseProgress(response.get("progress"), fallbackProgress)));
        return context.updateRunningProgress(progress).then(Mono.defer(() -> {
            if ("completed".equals(status) || "succeeded".equals(status) || "success".equals(status)) {
                return Mono.just(response);
            }
            if (PROCESSING_STATUSES.contains(status)) return Mono.empty();
            if (FAILURE_STATUSES.contains(status)) {
                return Mono.error(AiErrorSupport.providerTaskFailure(response, "Muse 视频生成失败"));
            }
            return Mono.error(new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR,
                    "Muse 视频接口返回未知任务状态: " + status + "（任务 " + providerTaskId + "）"));
        }));
    }

    /** 本地取消时请求 Muse 删除远端任务。 */
    private Mono<JSONObject> cancelRemoteTask(AiTaskExecutionContext context, String taskPath) {
        return aiHttpClient.sendJsonRequest(context.channel(), "DELETE", taskPath, null)
                .onErrorResume(error -> Mono.just(new JSONObject()))
                .then(Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR, "任务已取消")));
    }

    /** 通过授权 content 接口下载成片并保存到项目对象存储。 */
    private Mono<JSONObject> storeVideoResult(AiTaskExecutionContext context, String providerTaskId,
                                               JSONObject response) {
        int durationSeconds = parseActualDuration(response.get("seconds"));
        return aiHttpClient.downloadBinary(context.channel(), "/videos/" + providerTaskId + "/content")
                .flatMap(binary -> mediaSupport.storeGeneratedMedia(
                        context.task().getUserId(), AiTaskTypes.VIDEO, "generated-muse-video.mp4",
                        new GeneratedBinary(binary.data(), AiTaskParameterReader.firstNonEmpty(
                                binary.mimeType(), "video/mp4")), null, null, durationSeconds * 1000))
                .map(media -> AiJsonUtils.jsonObject(Map.of("item", media, "providerTaskId", providerTaskId)));
    }

    /** 组装 Muse OpenAI Videos 请求。Muse 的 10 秒目标通过提示词表达，seconds 只接受 4/8/12。 */
    static Map<String, Object> buildVideoRequestPayload(String model, String prompt, Map<String, Object> parameters,
                                                         String mode,
                                                         List<AiTaskDtos.AiTaskMediaReference> references,
                                                         List<String> referenceUrls) {
        if (references.size() != referenceUrls.size()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Muse 参考图片解析失败，请重新上传图片");
        }
        String configuredSeconds = AiTaskParameterReader.parameterText(parameters, "seconds", "10");
        if (!"10".equals(configuredSeconds.trim())) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Muse 渠道时长只允许设置为 10 秒");
        }
        String requestedMode = VideoGenerationMode.defaultIfBlank(mode);
        if (!VideoGenerationMode.isSupported(requestedMode)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Muse 视频生成模式不受支持");
        }
        MuseImages orderedImages = orderReferenceImages(requestedMode, references, referenceUrls);
        if (referenceUrls.size() > 30) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Muse 单次最多支持30张参考图片");
        }

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("model", StringUtils.hasText(model) ? model.trim() : "sora-2");
        payload.put("prompt", buildMusePrompt(prompt, requestedMode, parameters));
        MuseComposition composition = resolveComposition(
                AiTaskParameterReader.parameterText(parameters, "size", ""));
        if (StringUtils.hasText(composition.size())) payload.put("size", composition.size());

        if (!orderedImages.urls().isEmpty()) {
            List<Map<String, String>> imageValues = new ArrayList<>();
            for (String url : orderedImages.urls()) imageValues.add(Map.of("image_url", url));
            payload.put("input_reference", imageValues);
        }
        return payload;
    }

    /** 首尾帧模式根据角色排序；普通多图按原有顺序保留。 */
    private static MuseImages orderReferenceImages(String mode,
                                                   List<AiTaskDtos.AiTaskMediaReference> references,
                                                   List<String> urls) {
        if (!VideoGenerationMode.FIRST_LAST_FRAME_TO_VIDEO.equals(mode)) {
            return new MuseImages(references, urls);
        }
        if (references.size() != 2 || urls.size() != 2) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Muse 首尾帧视频需要恰好两张图片");
        }
        int first = -1;
        int last = -1;
        for (int index = 0; index < references.size(); index++) {
            String role = references.get(index).role();
            if ("first_frame".equals(role)) first = index;
            if ("last_frame".equals(role)) last = index;
        }
        if (first < 0 && last < 0) return new MuseImages(references, urls);
        if (first < 0 || last < 0) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Muse 首尾帧视频需要分别指定首帧和尾帧");
        }
        return new MuseImages(
                List.of(references.get(first), references.get(last)),
                List.of(urls.get(first), urls.get(last)));
    }

    /** 将 Muse 不能接受的时长或比例字段转换为明确的提示词。 */
    private static String buildMusePrompt(String prompt, String mode, Map<String, Object> parameters) {
        if (!StringUtils.hasText(prompt)) {
            throw new BusinessException(ErrorCode.PARAM_MISSING, "视频提示词不能为空");
        }
        StringBuilder prefix = new StringBuilder("目标视频时长10秒，请严格控制为10秒。");
        MuseComposition composition = resolveComposition(
                AiTaskParameterReader.parameterText(parameters, "size", ""));
        if (StringUtils.hasText(composition.promptHint())) prefix.append(composition.promptHint());
        if (VideoGenerationMode.FIRST_LAST_FRAME_TO_VIDEO.equals(mode)) {
            prefix.append("第一张参考图作为视频首帧，第二张参考图作为视频尾帧。");
        }
        return prefix.append(prompt.trim()).toString();
    }

    /** Muse 仅公开横竖屏尺寸；其他比例以提示词说明。 */
    private static MuseComposition resolveComposition(String rawSize) {
        String value = rawSize == null ? "" : rawSize.trim().toLowerCase(Locale.ROOT).replace(" ", "");
        if (value.isEmpty() || "auto".equals(value) || "adaptive".equals(value)
                || "16:9".equals(value) || "1280x720".equals(value)) {
            return new MuseComposition("", "");
        }
        if ("9:16".equals(value) || "720x1280".equals(value)) {
            return new MuseComposition("720x1280", "竖屏构图，9:16竖直比例。");
        }
        if ("1024x1792".equals(value)) return new MuseComposition(value, "竖屏构图，9:16竖直比例。");
        if ("1792x1024".equals(value)) return new MuseComposition(value, "采用横屏构图。");
        if ("1:1".equals(value) || "1024x1024".equals(value)) {
            return new MuseComposition("", "方形构图，1:1画面比例。");
        }
        if ("4:3".equals(value)) return new MuseComposition("", "采用4:3画面比例。");
        if ("3:4".equals(value)) return new MuseComposition("", "采用3:4竖幅画面比例。");
        if ("21:9".equals(value)) return new MuseComposition("", "采用21:9宽银幕构图。");

        String[] dimensions = value.split("x", -1);
        if (dimensions.length == 2) {
            try {
                int width = Integer.parseInt(dimensions[0]);
                int height = Integer.parseInt(dimensions[1]);
                if (width > 0 && height > 0 && width < height) {
                    return new MuseComposition("720x1280", "竖屏构图，9:16竖直比例。");
                }
                if (width > 0 && height > 0) return new MuseComposition("", "采用" + width + ":" + height + "画面比例。");
            } catch (NumberFormatException ignored) {
                // 历史配置值不是像素比例时按默认构图处理。
            }
        }
        return new MuseComposition("", "");
    }

    private static int parseActualDuration(Object value) {
        if (value instanceof Number number) {
            int seconds = number.intValue();
            return seconds > 0 && seconds <= 3600 ? seconds : TARGET_DURATION_SECONDS;
        }
        if (value instanceof String text) {
            try {
                int seconds = Integer.parseInt(text.trim());
                return seconds > 0 && seconds <= 3600 ? seconds : TARGET_DURATION_SECONDS;
            } catch (NumberFormatException ignored) {
                return TARGET_DURATION_SECONDS;
            }
        }
        return TARGET_DURATION_SECONDS;
    }

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

    private static boolean isTransientNetworkError(Throwable error) {
        Throwable current = error;
        while (current != null) {
            if (current instanceof IOException) return true;
            current = current.getCause();
        }
        return false;
    }

    private record MuseComposition(String size, String promptHint) {
    }

    private record MuseImages(List<AiTaskDtos.AiTaskMediaReference> references, List<String> urls) {
    }
}
