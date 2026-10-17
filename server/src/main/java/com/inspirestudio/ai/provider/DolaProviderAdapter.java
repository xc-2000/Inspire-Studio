package com.inspirestudio.ai.provider;

import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.ai.AiErrorDetails;
import com.inspirestudio.ai.AiErrorSupport;
import com.inspirestudio.ai.AiHttpClient;
import com.inspirestudio.ai.AiJsonUtils;
import com.inspirestudio.ai.AiMediaSupport;
import com.inspirestudio.ai.AiProviderAdapter;
import com.inspirestudio.ai.AiProviderException;
import com.inspirestudio.ai.AiRequestBodySupport;
import com.inspirestudio.ai.AiTaskExecutionContext;
import com.inspirestudio.ai.AiTaskParameterReader;
import com.inspirestudio.ai.AiTaskPollingSupport;
import com.inspirestudio.ai.AiTaskTypes;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.dto.AiTaskDtos;
import java.io.IOException;
import java.time.Duration;
import java.util.Comparator;
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
 * Dola 视频生成渠道适配器。
 * <p>
 * Dola 的对外协议与 OpenAI/Seedance 都不同：提交任务返回 {@code 200} 而不是 {@code 202}，
 * 状态与视频地址平铺在响应根节点（没有 {@code content.video_url} 嵌套），
 * 时长只接受 10/15/30 三个离散值，并且没有远端取消接口。
 * 另外 Dola 的错误体是 {@code {"detail":"中文说明"}}，没有 {@code code}/{@code message} 字段，
 * 通用错误分类会丢失这段中文，因此本适配器在提交阶段对通用文案做了替换。
 *
 * @date     2026-09-21 20:00
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class DolaProviderAdapter implements AiProviderAdapter {

    /** Dola 视频任务提交路径 */
    private static final String VIDEO_GENERATION_PATH = "/videos/generations";

    /** Dola 视频任务查询路径前缀 */
    private static final String VIDEO_TASK_PATH_PREFIX = "/videos/";

    /** Dola 最大参考图片数量（与上游 media.py 的限制一致） */
    private static final int MAXIMUM_REFERENCE_IMAGE_COUNT = 30;

    /** 仍需继续轮询的任务状态 */
    private static final Set<String> IN_FLIGHT_STATUSES = Set.of("queued", "processing");

    /** 任务成功终态 */
    private static final String STATUS_COMPLETED = "completed";

    /** 任务失败终态 */
    private static final String STATUS_FAILED = "failed";

    /** seedance-2.0 支持的时长 */
    private static final List<Integer> SEEDANCE_20_DURATIONS = List.of(10, 15);

    /** seedance-2.5 支持的时长 */
    private static final List<Integer> SEEDANCE_25_DURATIONS = List.of(10, 15, 30);

    /** seedance-2.0 上游模型标识 */
    private static final String UPSTREAM_MODEL_20 = "seedance-2.0";

    /** seedance-2.5 上游模型标识 */
    private static final String UPSTREAM_MODEL_25 = "seedance-2.5";

    /** Dola 时长默认值（未传 seconds 时与上游默认一致） */
    private static final int DEFAULT_DURATION_SECONDS = 10;

    /** Dola 页面比例标签顺序，用于稳定构造错误提示 */
    private static final List<String> RATIO_LABELS = List.of("16:9", "9:16", "1:1", "4:3", "3:4");

    /** Dola 支持的视频比例及其比值 */
    private static final Map<String, Double> RATIO_VALUES = Map.of(
            "16:9", 16D / 9D,
            "9:16", 9D / 16D,
            "1:1", 1D,
            "4:3", 4D / 3D,
            "3:4", 3D / 4D
    );

    /** Dola 认可的像素尺寸到比例的映射 */
    private static final Map<String, String> SIZE_TO_RATIO = Map.ofEntries(
            Map.entry("1280x720", "16:9"),
            Map.entry("1920x1080", "16:9"),
            Map.entry("720x1280", "9:16"),
            Map.entry("1080x1920", "9:16"),
            Map.entry("1024x1024", "1:1"),
            Map.entry("1440x1080", "4:3"),
            Map.entry("1080x1440", "3:4")
    );

    /**
     * 下游轮询预算秒数（所有档位通用）。
     * <p>
     * 预算的权威在 dola pool 一侧，它按档位计时并会按上游公告的完成时间动态延长：
     * 10 秒档公告「5 分後に完成します」（实测 175~489 秒），15 秒档公告 10 分钟，
     * 30 秒档公告「40分後に完成します」（实测 38 分钟 = 2280 秒），pool 侧硬上限为
     * 5400 秒。
     * <p>
     * 下游必须严格大于 pool 的硬上限，否则会出现「pool 仍在出片、我们却先报超时」，
     * 把已经生成的成品丢掉（历史故障：30 秒档下游 1900 秒先放弃，而 pool 侧刚把预算
     * 延长到 3600 秒）。取 5700 秒后，任何失败都由 pool 自己的超时错误先对外暴露，
     * 而不是被下游的裸超时掩盖。
     * <p>
     * 不对各档位再细分：pool 对真实失败（额度不足、风控、内容策略、上游反问）都是
     * 立即返回终态的，因此预算给宽不会拖慢失败路径，只会在成功路径上避免早退。
     */
    private static final long POLLING_BUDGET_SECONDS = 5700L;

    /**
     * 单次轮询查询的最大网络重试次数。
     * <p>
     * 轮询查询是幂等的 GET，且只读取上游任务状态，因此连接级瞬态故障（GOAWAY、
     * 连接重置、读超时）直接重发新连接即可恢复。若不重试，一次瞬时网络抖动会被
     * 当作任务失败上报，而实际上游仍在正常出片（实测 dola pool 侧任务状态为
     * {@code processing}，下游却报了 {@code HTTP/1.1 header parser received no bytes}）。
     * 只重试网络层异常，业务错误码与状态判定绝不重试。
     */
    private static final int POLLING_QUERY_MAX_RETRIES = 2;

    /** 上游明确说明未扣积分时，最多换池内账号重新提交一次。 */
    private static final int NO_CHARGE_FAILURE_MAX_RETRIES = 1;

    /** Dola 不同语言界面返回的“失败但未扣积分”特征文本。 */
    private static final List<String> NO_CHARGE_FAILURE_MARKERS = List.of(
            "今回の生成でクレジットは使用されませんでした",
            "本次生成不消耗积分",
            "本次不消耗积分",
            "本次生成未消耗积分",
            "未扣除积分",
            "no credits were used",
            "credits were not used");

    /** AI HTTP 客户端 */
    private final AiHttpClient aiHttpClient;

    /** AI 媒体支持 */
    private final AiMediaSupport mediaSupport;

    /** 服务配置 */
    private final InspireProperties properties;

    /**
     * 获取渠道调用格式。
     *
     * @return String Dola 渠道调用格式
     */
    @Override
    public String apiFormat() {
        return "dola";
    }

    /**
     * 判断当前适配器是否支持任务类型。
     *
     * @param taskType String 任务类型
     * @return boolean 是否为视频任务
     */
    @Override
    public boolean supports(String taskType) {
        return AiTaskTypes.VIDEO.equals(taskType);
    }

    /**
     * 执行 Dola 视频生成任务。
     *
     * @param context AiTaskExecutionContext AI 任务执行上下文
     * @return Mono<JSONObject> 视频生成结果
     */
    @Override
    public Mono<JSONObject> execute(AiTaskExecutionContext context) {
        if (!supports(context.task().getTaskType())) {
            return Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR, "Dola 调用格式仅支持视频任务"));
        }
        List<AiTaskDtos.AiTaskMediaReference> imageReferences =
                AiTaskParameterReader.safeReferences(context.request().references());
        List<AiTaskDtos.AiTaskMediaReference> videoReferences =
                AiTaskParameterReader.safeReferences(context.request().videoReferences());
        List<AiTaskDtos.AiTaskMediaReference> audioReferences =
                AiTaskParameterReader.safeReferences(context.request().audioReferences());
        DolaRequestPlan plan;
        try {
            validateReferences(imageReferences.size(), videoReferences.size(), audioReferences.size());
            plan = planRequest(context.model(), context.request().parameters());
        } catch (BusinessException exception) {
            // 参数问题在发起任何上游请求前失败，避免浪费 Dola 的账号额度。
            return Mono.error(exception);
        }
        return resolveReferenceUrls(context, imageReferences)
                .flatMap(imageUrls -> createDolaVideoTask(context, plan, imageUrls));
    }

    /**
     * 解析参考媒体 URL 列表。
     *
     * @param context AiTaskExecutionContext AI 任务执行上下文
     * @param references List<AiTaskMediaReference> 参考媒体列表
     * @return Mono<List<String>> 可供 Dola 访问的媒体 URL 列表
     */
    private Mono<List<String>> resolveReferenceUrls(
            AiTaskExecutionContext context,
            List<AiTaskDtos.AiTaskMediaReference> references) {
        return Flux.fromIterable(references)
                .concatMap(reference -> mediaSupport.resolveReferenceUrl(context.task().getUserId(), reference))
                .collectList();
    }

    /**
     * 创建 Dola 视频任务并等待任务完成。
     *
     * @param context AiTaskExecutionContext AI 任务执行上下文
     * @param plan DolaRequestPlan 已校验的请求计划
     * @param imageUrls List<String> 参考图片 URL 列表
     * @return Mono<JSONObject> 视频生成结果
     */
    private Mono<JSONObject> createDolaVideoTask(
            AiTaskExecutionContext context, DolaRequestPlan plan, List<String> imageUrls) {
        Map<String, Object> payload = AiRequestBodySupport.mergeCustomBodyParameters(
                assemblePayload(plan, context.request().prompt(), imageUrls), context.customBodyParameters());
        return submitDolaVideoTask(context, plan, imageUrls, payload, 0);
    }

    /**
     * 提交并等待单个 Dola 上游任务；仅在上游明确说明未扣积分时换账号重提一次。
     */
    private Mono<JSONObject> submitDolaVideoTask(
            AiTaskExecutionContext context,
            DolaRequestPlan plan,
            List<String> imageUrls,
            Map<String, Object> payload,
            int retryAttempt) {
        log.info("创建Dola视频任务: taskId={}, model={}, duration={}, imageCount={}",
                context.task().getId(), plan.upstreamModel(), plan.durationSeconds(), imageUrls.size());
        return aiHttpClient.sendJsonRequest(context.channel(), "POST", VIDEO_GENERATION_PATH, payload)
                .onErrorMap(AiProviderException.class, DolaProviderAdapter::explainSubmissionFailure)
                .map(AiJsonUtils::responsePayload)
                .flatMap(created -> {
                    String providerTaskId = AiTaskParameterReader.firstNonEmpty(created.getString("id"));
                    if (!StringUtils.hasText(providerTaskId)) {
                        return Mono.error(new BusinessException(
                                ErrorCode.THIRD_PARTY_CALL_ERROR, "Dola 接口没有返回任务ID"));
                    }
                    return context.updateRunningProgress(20)
                            .then(pollDolaVideoTask(context, plan, providerTaskId))
                            .flatMap(finished -> storeDolaVideo(context, plan, providerTaskId, finished));
                })
                .onErrorResume(exception -> retryAttempt < NO_CHARGE_FAILURE_MAX_RETRIES
                                && isNoChargeGenerationFailure(exception),
                        exception -> {
                            log.warn("Dola上游未扣积分但生成失败，换池内账号重提: taskId={}, retry={}/{}",
                                    context.task().getId(), retryAttempt + 1, NO_CHARGE_FAILURE_MAX_RETRIES);
                            return submitDolaVideoTask(context, plan, imageUrls, payload, retryAttempt + 1);
                        });
    }

    /**
     * 轮询 Dola 视频任务。
     * <p>
     * Dola 没有取消接口，因此收到取消请求时只终止本地轮询，不再向上游发送任何调用。
     *
     * @param context AiTaskExecutionContext AI 任务执行上下文
     * @param plan DolaRequestPlan 已校验的请求计划
     * @param providerTaskId String Dola 任务 ID
     * @return Mono<JSONObject> Dola 成功状态响应
     */
    private Mono<JSONObject> pollDolaVideoTask(
            AiTaskExecutionContext context, DolaRequestPlan plan, String providerTaskId) {
        String taskPath = VIDEO_TASK_PATH_PREFIX + providerTaskId;
        Duration pollingInterval = AiTaskPollingSupport.pollingInterval(properties);
        int maximumAttempts = maximumPollingAttempts(plan, pollingInterval);
        return Flux.range(0, maximumAttempts)
                .concatMap(attempt -> Mono.delay(pollingInterval)
                        .then(context.isCancelRequested())
                        .flatMap(cancelRequested -> Boolean.TRUE.equals(cancelRequested)
                                ? Mono.<JSONObject>error(new BusinessException(ErrorCode.BUSINESS_ERROR, "任务已取消"))
                                : queryDolaVideoTask(context, providerTaskId, taskPath, attempt)))
                .next()
                .switchIfEmpty(Mono.error(AiErrorSupport.providerPollingTimeout(
                        "Dola 视频生成超时，请稍后重试")));
    }

    /**
     * 判断异常是否为可重试的瞬态网络故障。
     * <p>
     * 只认连接级 IO 异常（GOAWAY、连接重置、读超时、响应头未读完等）。业务异常
     * （{@link AiProviderException} 与 {@link BusinessException}）携带的是上游明确语义，
     * 重试既无意义又可能放大错误，必须直接抛出。
     * <p>
     * {@code Mono.fromCallable} 不会包装受检异常，因此这里直接判断原始类型即可。
     *
     * @param throwable Throwable 待判断的异常
     * @return boolean 是否为瞬态网络故障
     */
    private static boolean isTransientNetworkError(Throwable throwable) {
        Throwable current = throwable;
        while (current != null) {
            if (current instanceof IOException) return true;
            current = current.getCause();
        }
        return false;
    }

    /**
     * 判断上游终态失败是否明确承诺未消耗积分，可安全换账号重提。
     * 额度不足、内容政策、超时和未知网络结果都不会进入此分支。
     */
    private static boolean isNoChargeGenerationFailure(Throwable throwable) {
        if (!(throwable instanceof AiProviderException providerException)
                || providerException.getDetails() == null
                || !StringUtils.hasText(providerException.getDetails().message())) {
            return false;
        }
        String normalized = providerException.getDetails().message().toLowerCase(Locale.ROOT);
        return NO_CHARGE_FAILURE_MARKERS.stream()
                .anyMatch(marker -> normalized.contains(marker.toLowerCase(Locale.ROOT)));
    }

    /**
     * 计算轮询次数上限。
     * <p>
     * 取「配置等待时长」与 {@link #POLLING_BUDGET_SECONDS} 的较大值。该预算已经覆盖
     * 全部档位（含 pool 侧按上游公告延长后的上限），因此不再按 duration 分支。
     *
     * @param plan DolaRequestPlan 已校验的请求计划
     * @param pollingInterval Duration 轮询间隔
     * @return int 轮询次数上限
     */
    private int maximumPollingAttempts(DolaRequestPlan plan, Duration pollingInterval) {
        long configured = Math.max(1L, properties.getAi().getTask().getVideoWaitTimeoutSeconds());
        long budgetSeconds = Math.max(configured, POLLING_BUDGET_SECONDS);
        long intervalSeconds = Math.max(1L, pollingInterval.toSeconds());
        long attempts = (budgetSeconds + intervalSeconds - 1) / intervalSeconds;
        return (int) Math.min(Integer.MAX_VALUE, Math.max(1L, attempts));
    }

    /**
     * 查询一次 Dola 视频任务状态。
     *
     * @param context AiTaskExecutionContext AI 任务执行上下文
     * @param providerTaskId String Dola 任务 ID
     * @param taskPath String Dola 任务查询路径
     * @param attempt int 当前轮询序号
     * @return Mono<JSONObject> 成功时返回状态对象，处理中返回空信号
     */
    private Mono<JSONObject> queryDolaVideoTask(
            AiTaskExecutionContext context, String providerTaskId, String taskPath, int attempt) {
        log.debug("Dola视频轮询第{}次: providerTaskId={}", attempt + 1, providerTaskId);
        return aiHttpClient.sendJsonRequest(context.channel(), "GET", taskPath, null)
                // 幂等状态查询：瞬态网络故障重发新连接即可恢复，不放大为任务失败
                .retryWhen(Retry.max(POLLING_QUERY_MAX_RETRIES)
                        .filter(DolaProviderAdapter::isTransientNetworkError))
                .map(AiJsonUtils::responsePayload)
                .flatMap(response -> {
                    String status = AiTaskParameterReader.firstNonEmpty(response.getString("status"))
                            .toLowerCase(Locale.ROOT);
                    int progress = Math.min(95, 20 + attempt);
                    return context.updateRunningProgress(progress).then(Mono.defer(() -> {
                        if (STATUS_COMPLETED.equals(status)) {
                            return Mono.just(response);
                        }
                        if (IN_FLIGHT_STATUSES.contains(status)) {
                            return Mono.empty();
                        }
                        if (STATUS_FAILED.equals(status)) {
                            return Mono.error(AiErrorSupport.providerTaskFailure(
                                    response, "Dola 视频生成失败"));
                        }
                        return Mono.error(new BusinessException(
                                ErrorCode.THIRD_PARTY_CALL_ERROR, "Dola 返回了未知任务状态: " + status));
                    }));
                });
    }

    /**
     * 下载并保存 Dola 生成的视频。
     *
     * @param context AiTaskExecutionContext AI 任务执行上下文
     * @param plan DolaRequestPlan 已校验的请求计划
     * @param providerTaskId String Dola 任务 ID
     * @param finished JSONObject Dola 成功状态响应
     * @return Mono<JSONObject> 已持久化的视频结果
     */
    private Mono<JSONObject> storeDolaVideo(
            AiTaskExecutionContext context, DolaRequestPlan plan, String providerTaskId, JSONObject finished) {
        String videoUrl = AiTaskParameterReader.firstNonEmpty(finished.getString("video_url"));
        if (!StringUtils.hasText(videoUrl)) {
            return Mono.error(new BusinessException(
                    ErrorCode.THIRD_PARTY_CALL_ERROR, "Dola 任务成功但没有返回视频URL"));
        }
        log.info("Dola视频任务完成: taskId={}, providerTaskId={}, duration={}",
                context.task().getId(), providerTaskId, plan.durationSeconds());
        // Dola 的视频地址由它自己的静态目录提供，必须转存到项目媒体存储后再返回给前端。
        return aiHttpClient.downloadRemoteBinary(videoUrl, "video/mp4")
                .flatMap(binary -> mediaSupport.storeGeneratedMedia(
                        context.task().getUserId(), AiTaskTypes.VIDEO, "generated-dola-video.mp4",
                        binary, null, null, plan.durationSeconds() * 1000))
                .map(media -> AiJsonUtils.jsonObject(Map.of(
                        "item", media,
                        "providerTaskId", providerTaskId
                )));
    }

    /**
     * 校验参考素材数量与类型。
     * <p>
     * Dola 只接受图片参考（非空即为图生视频），既没有视频/音频参考输入，也没有首尾帧接口。
     *
     * @param imageCount int 参考图片数量
     * @param videoCount int 参考视频数量
     * @param audioCount int 参考音频数量
     * @return void 无返回值
     */
    private static void validateReferences(int imageCount, int videoCount, int audioCount) {
        if (imageCount > MAXIMUM_REFERENCE_IMAGE_COUNT) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "Dola 参考图片最多" + MAXIMUM_REFERENCE_IMAGE_COUNT + "张");
        }
        if (videoCount > 0) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Dola 暂不支持视频参考素材");
        }
        if (audioCount > 0) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Dola 暂不支持音频参考素材");
        }
    }

    /**
     * 构建并校验 Dola 请求计划。
     *
     * @param model String 数据库中的模型名称
     * @param parameters Map<String, Object> 通用视频参数
     * @return DolaRequestPlan 已校验的请求计划
     */
    static DolaRequestPlan planRequest(String model, Map<String, Object> parameters) {
        String upstreamModel = resolveUpstreamModel(model);
        return new DolaRequestPlan(
                upstreamModel,
                resolveDuration(parameters, upstreamModel),
                resolveRatio(parameters));
    }

    /**
     * 构建 Dola 视频任务请求体。
     *
     * @param model String 数据库中的模型名称
     * @param prompt String 视频提示词
     * @param parameters Map<String, Object> 通用视频参数
     * @param referenceImageUrls List<String> 参考图片 URL 列表
     * @return Map<String, Object> Dola 请求体
     */
    static Map<String, Object> buildRequestPayload(
            String model, String prompt, Map<String, Object> parameters, List<String> referenceImageUrls) {
        return assemblePayload(planRequest(model, parameters), prompt, referenceImageUrls);
    }

    /**
     * 组装 Dola 请求体。
     * <p>
     * {@code reference_images} 只在非空时出现：文生视频必须完全省略该字段，
     * 显式传 {@code null} 会被上游以 422 拒绝。
     *
     * @param plan DolaRequestPlan 已校验的请求计划
     * @param prompt String 视频提示词
     * @param referenceImageUrls List<String> 参考图片 URL 列表
     * @return Map<String, Object> Dola 请求体
     */
    static Map<String, Object> assemblePayload(
            DolaRequestPlan plan, String prompt, List<String> referenceImageUrls) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("model", plan.upstreamModel());
        payload.put("prompt", prompt);
        payload.put("duration", plan.durationSeconds());
        if (StringUtils.hasText(plan.ratio())) {
            payload.put("ratio", plan.ratio());
        }
        if (referenceImageUrls != null && !referenceImageUrls.isEmpty()) {
            payload.put("reference_images", List.copyOf(referenceImageUrls));
        }
        return payload;
    }

    /**
     * 将数据库模型名称解析为 Dola 上游模型标识。
     *
     * @param model String 数据库中的模型名称
     * @return String Dola 上游模型标识
     */
    private static String resolveUpstreamModel(String model) {
        String normalized = model == null ? "" : model.trim().toLowerCase(Locale.ROOT);
        if (normalized.contains("2.5") || normalized.contains("2-5") || normalized.contains("2_5")) {
            return UPSTREAM_MODEL_25;
        }
        if (normalized.contains("2.0") || normalized.contains("2-0") || normalized.contains("2_0")) {
            return UPSTREAM_MODEL_20;
        }
        throw new BusinessException(ErrorCode.PARAM_INVALID,
                "Dola 渠道模型不支持: " + model + "（当前支持 seedance-2.0 / seedance-2.5）");
    }

    /**
     * 解析并校验 Dola 视频时长。
     *
     * @param parameters Map<String, Object> 通用视频参数
     * @param upstreamModel String Dola 上游模型标识
     * @return int 视频时长秒数
     */
    private static int resolveDuration(Map<String, Object> parameters, String upstreamModel) {
        List<Integer> allowed = UPSTREAM_MODEL_25.equals(upstreamModel)
                ? SEEDANCE_25_DURATIONS : SEEDANCE_20_DURATIONS;
        String text = AiTaskParameterReader.parameterText(parameters, "seconds", "");
        if (!StringUtils.hasText(text)) {
            return DEFAULT_DURATION_SECONDS;
        }
        int duration;
        try {
            duration = Integer.parseInt(text.trim());
        } catch (NumberFormatException exception) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Dola 视频时长必须是整数秒");
        }
        if (allowed.contains(duration)) {
            return duration;
        }
        if (duration == 30) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "Dola 生成 30 秒视频必须使用 seedance-2.5 模型");
        }
        throw new BusinessException(ErrorCode.PARAM_INVALID, "Dola 视频时长只支持" + describeDurations(allowed));
    }

    /**
     * 拼接时长清单文案。
     *
     * @param durations List<Integer> 时长列表
     * @return String 形如" 10 秒、15 秒和 30 秒"的文案
     */
    private static String describeDurations(List<Integer> durations) {
        List<String> parts = durations.stream().map(value -> value + " 秒").toList();
        if (parts.size() == 1) {
            return " " + parts.get(0);
        }
        // 逗号分隔的量词之间必须补空格，否则会拼出"15 秒和30 秒"。
        return " " + String.join("、", parts.subList(0, parts.size() - 1))
                + "和 " + parts.get(parts.size() - 1);
    }

    /**
     * 解析并校验 Dola 视频比例。
     *
     * @param parameters Map<String, Object> 通用视频参数
     * @return String Dola 页面比例标签，需要跟随上游默认比例时返回 null
     */
    private static String resolveRatio(Map<String, Object> parameters) {
        String value = AiTaskParameterReader.parameterText(parameters, "size", "");
        if (!StringUtils.hasText(value)) {
            value = AiTaskParameterReader.parameterText(parameters, "ratio", "");
        }
        String normalized = value == null ? "" : value.trim().toLowerCase(Locale.ROOT).replace(" ", "");
        if (normalized.isEmpty() || "auto".equals(normalized) || "adaptive".equals(normalized)) {
            return null;
        }
        if (RATIO_VALUES.containsKey(normalized)) {
            return normalized;
        }
        if (SIZE_TO_RATIO.containsKey(normalized)) {
            return SIZE_TO_RATIO.get(normalized);
        }
        if (!normalized.matches("^\\d+x\\d+$")) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "Dola 视频比例不支持: " + value + "，请选择 " + String.join("、", RATIO_LABELS));
        }
        String[] dimensions = normalized.split("x");
        double width = Double.parseDouble(dimensions[0]);
        double height = Double.parseDouble(dimensions[1]);
        if (width <= 0 || height <= 0) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Dola 视频尺寸必须为正数");
        }
        double ratio = width / height;
        return RATIO_VALUES.entrySet().stream()
                .min(Comparator.comparingDouble(entry -> Math.abs(entry.getValue() - ratio)))
                .orElseThrow()
                .getKey();
    }

    /**
     * 替换提交阶段丢失了上游说明的通用错误文案。
     * <p>
     * Dola 的错误体是 {@code {"detail":"账号限流：..."}} 这类没有 {@code code}/{@code message}
     * 字段的响应，通用分类只能得到"AI供应商请求失败（HTTP N）"，限流、额度不足等关键信息
     * 会全部丢失；这里按通用文案+分类+状态码补回可操作的中文说明。
     * <p>
     * 注意上游用同一个 {@code 429} 同时表示"账号限流"和"积分不足"，而 {@code detail} 中的
     * 中文说明在通用分类阶段已被丢弃，适配器无法再区分这两者，因此 429 的提示必须同时覆盖
     * 两种可能，不能断言是其中一种。
     *
     * @param exception AiProviderException 原始供应商异常
     * @return AiProviderException 补全说明后的供应商异常
     */
    static AiProviderException explainSubmissionFailure(AiProviderException exception) {
        AiErrorDetails details = exception.getDetails();
        if (details == null || !StringUtils.hasText(details.message())
                || !details.message().startsWith("AI供应商请求失败（HTTP")) {
            return exception;
        }
        int httpStatus = details.httpStatus() == null ? 0 : details.httpStatus();
        String category = details.category() == null ? "" : details.category();
        String hint;
        if (httpStatus == 400 || httpStatus == 422) {
            hint = "Dola 视频接口拒绝了本次请求（HTTP " + httpStatus
                    + "），请检查提示词、参考图片（需公网可访问、JPEG/PNG/WEBP、不超过 15MB）与时长是否符合上游要求";
        } else if (httpStatus == 429) {
            hint = "Dola 上游账号受限（HTTP 429），可能是当日视频额度已用完或账号积分不足，请稍后重试或补充账号";
        } else if (httpStatus == 503) {
            hint = "Dola 账号池当前没有可用账号（HTTP 503），请稍后重试";
        } else {
            hint = switch (category) {
                case "rate_limited" -> "Dola 上游账号受限，请稍后重试";
                case "quota" -> "Dola 上游账号积分不足，请稍后重试或补充账号";
                case "authentication" -> "Dola 接口鉴权失败，请检查渠道 API Key 配置";
                case "permission" -> "Dola 接口无权访问该模型，请检查渠道配置";
                case "provider_unavailable" -> "Dola 服务暂时不可用，请稍后重试";
                default -> "Dola 视频接口调用失败（HTTP " + httpStatus + "）";
            };
        }
        return new AiProviderException(new AiErrorDetails(details.source(), details.category(), details.stage(),
                details.httpStatus(), details.code(), details.type(), details.parameter(), hint,
                details.requestAccepted(), details.safeToRetry()));
    }

    /**
     * Dola 视频请求计划。
     *
     * @param upstreamModel String Dola 上游模型标识
     * @param durationSeconds int 视频时长秒数
     * @param ratio String Dola 页面比例标签，可空
     */
    record DolaRequestPlan(String upstreamModel, int durationSeconds, String ratio) {
    }
}
