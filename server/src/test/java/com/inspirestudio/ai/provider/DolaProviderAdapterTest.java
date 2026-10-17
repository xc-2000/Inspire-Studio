package com.inspirestudio.ai.provider;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.ai.AiErrorDetails;
import com.inspirestudio.ai.AiErrorSupport;
import com.inspirestudio.ai.AiProviderException;
import com.inspirestudio.ai.AiTaskTypes;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.inspirestudio.ai.AiHttpClient;
import com.inspirestudio.ai.AiMediaSupport;
import com.inspirestudio.ai.AiTaskExecutionContext;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.dto.AiTaskDtos;
import com.inspirestudio.entity.AiGenerationTask;
import java.io.IOException;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;
import reactor.test.scheduler.VirtualTimeScheduler;

/**
 * Dola渠道适配器测试。
 *
 * @date     2026-09-21 20:00
 */
class DolaProviderAdapterTest {

    /**
     * Dola适配器应只声明视频任务能力。
     *
     * @return void 无返回值
     */
    @Test
    void shouldOnlySupportVideoTasks() {
        DolaProviderAdapter adapter = new DolaProviderAdapter(null, null, new InspireProperties());

        Assertions.assertEquals("dola", adapter.apiFormat());
        Assertions.assertTrue(adapter.supports(AiTaskTypes.VIDEO));
        Assertions.assertFalse(adapter.supports(AiTaskTypes.IMAGE));
        Assertions.assertFalse(adapter.supports(AiTaskTypes.TEXT));
    }

    /**
     * 数据库模型名称应转换为Dola上游模型标识。
     *
     * @return void 无返回值
     */
    @Test
    void shouldMapModelNameToUpstreamIdentifier() {
        Assertions.assertEquals("seedance-2.5", DolaProviderAdapter.planRequest(
                "Doubao-Seedance-2.5", Map.of("seconds", "30")).upstreamModel());
        Assertions.assertEquals("seedance-2.0", DolaProviderAdapter.planRequest(
                "Doubao-Seedance-2.0", Map.of("seconds", "10")).upstreamModel());
    }

    /**
     * 时长应限制在模型允许的离散取值内。
     *
     * @return void 无返回值
     */
    @Test
    void shouldValidateDiscreteDurations() {
        Assertions.assertEquals(30, DolaProviderAdapter.planRequest(
                "Doubao-Seedance-2.5", Map.of("seconds", 30)).durationSeconds());
        Assertions.assertEquals(10, DolaProviderAdapter.planRequest(
                "Doubao-Seedance-2.5", Map.of()).durationSeconds());

        BusinessException twentySeconds = Assertions.assertThrows(BusinessException.class,
                () -> DolaProviderAdapter.planRequest("Doubao-Seedance-2.5", Map.of("seconds", "20")));
        Assertions.assertEquals("Dola 视频时长只支持 10 秒、15 秒和 30 秒", twentySeconds.getMessage());

        BusinessException thirtySecondsOnOlderModel = Assertions.assertThrows(BusinessException.class,
                () -> DolaProviderAdapter.planRequest("Doubao-Seedance-2.0", Map.of("seconds", "30")));
        Assertions.assertEquals("Dola 生成 30 秒视频必须使用 seedance-2.5 模型",
                thirtySecondsOnOlderModel.getMessage());

        BusinessException fifteenSecondsOnOlderModel = Assertions.assertThrows(BusinessException.class,
                () -> DolaProviderAdapter.planRequest("Doubao-Seedance-2.0", Map.of("seconds", "11")));
        Assertions.assertEquals("Dola 视频时长只支持 10 秒和 15 秒", fifteenSecondsOnOlderModel.getMessage());

        BusinessException unknownModel = Assertions.assertThrows(BusinessException.class,
                () -> DolaProviderAdapter.planRequest("gpt-image-1", Map.of("seconds", "10")));
        Assertions.assertTrue(unknownModel.getMessage().contains("Dola 渠道模型不支持"));
    }

    /**
     * 通用尺寸参数应转换为Dola页面比例标签。
     *
     * @return void 无返回值
     */
    @Test
    void shouldMapSizeToDolaRatioLabel() {
        Assertions.assertEquals("16:9", DolaProviderAdapter.planRequest(
                "Doubao-Seedance-2.0", Map.of("size", "1280x720")).ratio());
        Assertions.assertEquals("9:16", DolaProviderAdapter.planRequest(
                "Doubao-Seedance-2.0", Map.of("size", "720x1280")).ratio());
        Assertions.assertEquals("1:1", DolaProviderAdapter.planRequest(
                "Doubao-Seedance-2.0", Map.of("size", "1024x1024")).ratio());
        Assertions.assertEquals("4:3", DolaProviderAdapter.planRequest(
                "Doubao-Seedance-2.0", Map.of("size", "4:3")).ratio());
        // 非Dola映射表内的像素尺寸按比值就近归一到页面标签。
        Assertions.assertEquals("1:1", DolaProviderAdapter.planRequest(
                "Doubao-Seedance-2.0", Map.of("size", "720x720")).ratio());
        // 未指定比例时跟随上游默认比例，不能凭空编造比例。
        Assertions.assertNull(DolaProviderAdapter.planRequest(
                "Doubao-Seedance-2.0", Map.of("size", "adaptive")).ratio());
        Assertions.assertNull(DolaProviderAdapter.planRequest(
                "Doubao-Seedance-2.0", Map.of()).ratio());

        BusinessException unknownRatio = Assertions.assertThrows(BusinessException.class,
                () -> DolaProviderAdapter.planRequest("Doubao-Seedance-2.0", Map.of("size", "wide")));
        Assertions.assertTrue(unknownRatio.getMessage().contains("Dola 视频比例不支持"));
    }

    /**
     * 请求体应使用Dola字段名，并在文生视频时完全省略参考图片字段。
     *
     * @return void 无返回值
     */
    @Test
    void shouldBuildDolaTextToVideoPayload() {
        JSONObject payload = toJsonObject(DolaProviderAdapter.buildRequestPayload(
                "Doubao-Seedance-2.5",
                "一只橘猫在窗台上打盹",
                Map.of("size", "1280x720", "resolution", "720p", "seconds", "30", "watermark", "true"),
                List.of()
        ));

        Assertions.assertEquals("seedance-2.5", payload.getString("model"));
        Assertions.assertEquals("一只橘猫在窗台上打盹", payload.getString("prompt"));
        Assertions.assertEquals(30, payload.getIntValue("duration"));
        Assertions.assertEquals("16:9", payload.getString("ratio"));
        // Dola 没有清晰度参数，且 reference_images 传 null 会被上游以 422 拒绝。
        Assertions.assertFalse(payload.containsKey("resolution"));
        Assertions.assertFalse(payload.containsKey("watermark"));
        Assertions.assertFalse(payload.containsKey("reference_images"));
    }

    /**
     * 携带参考图片时应按Dola字段名提交图片URL数组。
     *
     * @return void 无返回值
     */
    @Test
    void shouldBuildDolaImageToVideoPayload() {
        JSONObject payload = toJsonObject(DolaProviderAdapter.buildRequestPayload(
                "Doubao-Seedance-2.0",
                "让画面动起来",
                Map.of("size", "9:16", "seconds", 15),
                List.of("https://example.com/reference.png")
        ));
        JSONArray referenceImages = payload.getJSONArray("reference_images");

        Assertions.assertEquals("seedance-2.0", payload.getString("model"));
        Assertions.assertEquals(15, payload.getIntValue("duration"));
        Assertions.assertEquals("9:16", payload.getString("ratio"));
        Assertions.assertEquals(1, referenceImages.size());
        Assertions.assertEquals("https://example.com/reference.png", referenceImages.getString(0));
    }

    /**
     * Dola失败终态的中文说明必须保留在结构化错误里。
     *
     * @return void 无返回值
     */
    @Test
    void shouldKeepDolaFailureDetailAsMessage() {
        JSONObject failed = JSON.parseObject("""
                {"id":"video_1","status":"failed","model":"seedance-2.0",
                 "prompt":"x","video_url":null,"error":"参考图片下载失败 HTTP 404"}
                """);

        AiProviderException exception = AiErrorSupport.providerTaskFailure(failed, "Dola 视频生成失败");
        AiErrorDetails details = exception.getDetails();

        Assertions.assertEquals("参考图片下载失败 HTTP 404", details.message());
        Assertions.assertEquals("polling", details.stage());
        Assertions.assertTrue(details.requestAccepted());
        Assertions.assertFalse(details.safeToRetry());
    }

    /**
     * Dola提交阶段丢失上游中文说明时，应补回可操作的中文提示。
     *
     * @return void 无返回值
     */
    @Test
    void shouldExplainDolaSubmissionFailure() {
        // Dola 的错误体是 {"detail":"..."}，没有 code/message 字段，通用分类只能给出HTTP文案。
        AiProviderException rateLimited = DolaProviderAdapter.explainSubmissionFailure(
                AiErrorSupport.providerException(429, "{\"detail\":\"账号限流\"}", "submission"));
        // 上游用同一个 429 表示"账号限流"和"积分不足"，detail 中文在通用分类阶段已丢失，
        // 适配器无法区分，因此提示必须同时覆盖两种可能。
        Assertions.assertTrue(rateLimited.getDetails().message().contains("额度已用完"));
        Assertions.assertTrue(rateLimited.getDetails().message().contains("积分不足"));

        AiProviderException quota = DolaProviderAdapter.explainSubmissionFailure(
                AiErrorSupport.providerException(429, "{\"detail\":\"积分不足\"}", "submission"));
        Assertions.assertEquals(rateLimited.getDetails().message(), quota.getDetails().message());

        AiProviderException noAccount = DolaProviderAdapter.explainSubmissionFailure(
                AiErrorSupport.providerException(503, "{\"detail\":\"no account in pool\"}", "submission"));
        Assertions.assertTrue(noAccount.getDetails().message().contains("没有可用账号"));

        AiProviderException rejected = DolaProviderAdapter.explainSubmissionFailure(
                AiErrorSupport.providerException(422, "{\"detail\":\"当前固定支持 10 秒、15 秒和 30 秒视频\"}",
                        "submission"));
        Assertions.assertTrue(rejected.getDetails().message().startsWith("Dola 视频接口拒绝了本次请求（HTTP 422）"));

        // 已经带说明的异常必须原样保留，不能被通用文案覆盖。
        AiProviderException explained = new AiProviderException(new AiErrorDetails(
                "provider", "rate_limited", "submission", 429, null, null, null, "上游自定义说明", false, true));
        Assertions.assertSame(explained, DolaProviderAdapter.explainSubmissionFailure(explained));
    }

    /**
     * 轮询查询遇到瞬态网络故障时应在同一次轮询内重试，而不是把任务判为失败。
     * <p>
     * 实测故障形态：上游任务其实仍在 {@code processing}，下游却因连接被重置报出
     * {@code HTTP/1.1 header parser received no bytes}。幂等 GET 重发新连接即可恢复。
     *
     * @return void 无返回值
     */
    @Test
    void shouldRetryPollingQueryOnTransientNetworkError() {
        AiHttpClient aiHttpClient = mock(AiHttpClient.class);
        AiMediaSupport mediaSupport = mock(AiMediaSupport.class);
        DolaProviderAdapter adapter = new DolaProviderAdapter(aiHttpClient, mediaSupport, new InspireProperties());
        when(aiHttpClient.sendJsonRequest(any(AiTaskDtos.AiChannelConfig.class), eq("POST"), eq("/videos/generations"), any()))
                .thenReturn(Mono.just(JSON.parseObject("{\"id\":\"video_abc\",\"status\":\"queued\"}")));
        // 必须用 Mono.defer 包裹：retryWhen 重新订阅的是同一个 Mono 实例，不会重新调用
        // mock 方法。生产实现返回的 Mono.fromCallable 每次订阅都会重新执行阻塞的 HTTP 调用，
        // 所以重试是真实的；测试必须复现这一"每次订阅都重新求值"的语义，否则测不出重试。
        java.util.concurrent.atomic.AtomicInteger pollCalls = new java.util.concurrent.atomic.AtomicInteger();
        when(aiHttpClient.sendJsonRequest(any(AiTaskDtos.AiChannelConfig.class), eq("GET"), eq("/videos/video_abc"), isNull()))
                .thenReturn(Mono.defer(() -> {
                    // 前两次连接被重置，第三次成功返回 completed。
                    int call = pollCalls.incrementAndGet();
                    if (call == 1) {
                        return Mono.error(new IOException("HTTP/1.1 header parser received no bytes"));
                    }
                    if (call == 2) {
                        return Mono.error(new IOException("connection reset"));
                    }
                    return Mono.just(JSON.parseObject("{\"id\":\"video_abc\",\"status\":\"completed\",\"video_url\":\"https://dola.example/v.mp4\"}"));
                }));
        when(aiHttpClient.downloadRemoteBinary("https://dola.example/v.mp4", "video/mp4"))
                .thenReturn(Mono.just(new com.inspirestudio.ai.GeneratedBinary(new byte[]{1, 2}, "video/mp4")));
        when(mediaSupport.storeGeneratedMedia(eq(7L), eq(AiTaskTypes.VIDEO), eq("generated-dola-video.mp4"),
                any(com.inspirestudio.ai.GeneratedBinary.class), isNull(Integer.class), isNull(Integer.class), eq(10000)))
                .thenReturn(Mono.just(new com.inspirestudio.dto.PersistenceDtos.UploadedMediaResponse(
                        "video:1", "https://storage.example/v.mp4", 2L, "video/mp4", null, null, 10000, null)));

        VirtualTimeScheduler scheduler = VirtualTimeScheduler.create();
        StepVerifier.withVirtualTime(() -> adapter.execute(dolaContext("Doubao-Seedance-2.0", 10)), () -> scheduler, 1)
                .thenAwait(Duration.ofSeconds(5))
                .assertNext(result -> Assertions.assertEquals("video_abc", result.getString("providerTaskId")))
                .verifyComplete();

        // 一次轮询内部的 2 次重试 + 成功那次 = 恰好 3 次上游查询，绝不能再多。
        Assertions.assertEquals(3, pollCalls.get(),
                "应恰好重试 2 次后成功，实际：" + pollCalls.get());
    }

    /** 上游明确说明未扣积分时应换池内账号重提一次并保存第二次结果。 */
    @Test
    void shouldRetryOnceWhenUpstreamFailureDidNotConsumeCredits() {
        AiHttpClient aiHttpClient = mock(AiHttpClient.class);
        AiMediaSupport mediaSupport = mock(AiMediaSupport.class);
        DolaProviderAdapter adapter = new DolaProviderAdapter(aiHttpClient, mediaSupport, new InspireProperties());
        when(aiHttpClient.sendJsonRequest(any(AiTaskDtos.AiChannelConfig.class), eq("POST"),
                eq("/videos/generations"), any()))
                .thenReturn(
                        Mono.just(JSON.parseObject("{\"id\":\"video_failed\",\"status\":\"queued\"}")),
                        Mono.just(JSON.parseObject("{\"id\":\"video_retry\",\"status\":\"queued\"}")));
        when(aiHttpClient.sendJsonRequest(any(AiTaskDtos.AiChannelConfig.class), eq("GET"),
                eq("/videos/video_failed"), isNull()))
                .thenReturn(Mono.just(JSON.parseObject("{\"id\":\"video_failed\",\"status\":\"failed\","
                        + "\"error\":\"Dola 返回生成失败: 動画を生成できません。今回の生成でクレジットは使用されませんでした。\"}")));
        when(aiHttpClient.sendJsonRequest(any(AiTaskDtos.AiChannelConfig.class), eq("GET"),
                eq("/videos/video_retry"), isNull()))
                .thenReturn(Mono.just(JSON.parseObject("{\"id\":\"video_retry\",\"status\":\"completed\","
                        + "\"video_url\":\"https://dola.example/retry.mp4\"}")));
        when(aiHttpClient.downloadRemoteBinary("https://dola.example/retry.mp4", "video/mp4"))
                .thenReturn(Mono.just(new com.inspirestudio.ai.GeneratedBinary(new byte[]{1, 2}, "video/mp4")));
        when(mediaSupport.storeGeneratedMedia(eq(7L), eq(AiTaskTypes.VIDEO), eq("generated-dola-video.mp4"),
                any(com.inspirestudio.ai.GeneratedBinary.class), isNull(Integer.class), isNull(Integer.class), eq(10000)))
                .thenReturn(Mono.just(new com.inspirestudio.dto.PersistenceDtos.UploadedMediaResponse(
                        "video:retry", "https://storage.example/retry.mp4", 2L, "video/mp4", null, null,
                        10000, null)));

        VirtualTimeScheduler scheduler = VirtualTimeScheduler.create();
        StepVerifier.withVirtualTime(() -> adapter.execute(dolaContext("seedance-2.0", 10)), () -> scheduler, 1)
                .thenAwait(Duration.ofSeconds(10))
                .assertNext(result -> Assertions.assertEquals("video_retry", result.getString("providerTaskId")))
                .verifyComplete();

        verify(aiHttpClient, times(2)).sendJsonRequest(any(AiTaskDtos.AiChannelConfig.class), eq("POST"),
                eq("/videos/generations"), any());
    }

    /** 内容政策失败没有未扣积分承诺，必须原样失败且不得自动重提。 */
    @Test
    void shouldNotRetryPolicyFailure() {
        AiHttpClient aiHttpClient = mock(AiHttpClient.class);
        DolaProviderAdapter adapter = new DolaProviderAdapter(aiHttpClient, mock(AiMediaSupport.class), new InspireProperties());
        when(aiHttpClient.sendJsonRequest(any(AiTaskDtos.AiChannelConfig.class), eq("POST"),
                eq("/videos/generations"), any()))
                .thenReturn(Mono.just(JSON.parseObject("{\"id\":\"video_policy\",\"status\":\"queued\"}")));
        when(aiHttpClient.sendJsonRequest(any(AiTaskDtos.AiChannelConfig.class), eq("GET"),
                eq("/videos/video_policy"), isNull()))
                .thenReturn(Mono.just(JSON.parseObject("{\"id\":\"video_policy\",\"status\":\"failed\","
                        + "\"error\":\"著作権を保護するため、生成された動画を表示できません。\"}")));

        VirtualTimeScheduler scheduler = VirtualTimeScheduler.create();
        StepVerifier.withVirtualTime(() -> adapter.execute(dolaContext("seedance-2.0", 10)), () -> scheduler, 1)
                .thenAwait(Duration.ofSeconds(5))
                .expectError(AiProviderException.class)
                .verify();

        verify(aiHttpClient, times(1)).sendJsonRequest(any(AiTaskDtos.AiChannelConfig.class), eq("POST"),
                eq("/videos/generations"), any());
    }

    /**
     * 业务错误不得被当作网络故障重试，避免放大上游明确拒绝。
     *
     * @return void 无返回值
     */
    @Test
    void shouldNotRetryPollingQueryOnBusinessError() {
        AiHttpClient aiHttpClient = mock(AiHttpClient.class);
        DolaProviderAdapter adapter = new DolaProviderAdapter(aiHttpClient, mock(AiMediaSupport.class), new InspireProperties());
        when(aiHttpClient.sendJsonRequest(any(AiTaskDtos.AiChannelConfig.class), eq("POST"), eq("/videos/generations"), any()))
                .thenReturn(Mono.just(JSON.parseObject("{\"id\":\"video_biz\",\"status\":\"queued\"}")));
        when(aiHttpClient.sendJsonRequest(any(AiTaskDtos.AiChannelConfig.class), eq("GET"), eq("/videos/video_biz"), isNull()))
                .thenReturn(Mono.error(new AiProviderException(new AiErrorDetails(
                        "provider", "rate_limited", "polling", 429, null, null, null, "账号限流", false, true))));

        VirtualTimeScheduler scheduler = VirtualTimeScheduler.create();
        StepVerifier.withVirtualTime(() -> adapter.execute(dolaContext("Doubao-Seedance-2.0", 10)), () -> scheduler, 1)
                .thenAwait(Duration.ofSeconds(5))
                .expectError(AiProviderException.class)
                .verify();

        verify(aiHttpClient, times(1)).sendJsonRequest(any(AiTaskDtos.AiChannelConfig.class), eq("GET"),
                eq("/videos/video_biz"), isNull());
    }

    /**
     * 构建 Dola 视频任务上下文。
     *
     * @param model String 数据库模型名
     * @param seconds int 期望时长
     * @return AiTaskExecutionContext 视频任务上下文
     */
    private AiTaskExecutionContext dolaContext(String model, int seconds) {
        AiGenerationTask task = new AiGenerationTask();
        task.setId("task-dola");
        task.setUserId(7L);
        task.setTaskType(AiTaskTypes.VIDEO);
        return new AiTaskExecutionContext(task,
                new AiTaskDtos.AiChannelConfig("channel-dola", "Dola 视频池",
                        "http://192.0.2.10:8000/v1", "test-key", "dola", List.of(model)),
                model, false, "",
                new AiTaskDtos.CreateAiTaskRequest(AiTaskTypes.VIDEO, "一只橘猫", model,
                        Map.of("size", "1280x720", "seconds", String.valueOf(seconds)), List.of(), List.of(), "videoPage"),
                () -> Mono.just(false), progress -> Mono.empty(), delta -> Mono.empty());
    }

    /**
     * 将请求映射转换为便于断言的Fastjson2对象。
     *
     * @param value Map<String, Object> 请求映射
     * @return JSONObject JSON对象
     */
    private JSONObject toJsonObject(Map<String, Object> value) {
        return JSON.parseObject(JSON.toJSONString(value));
    }
}
