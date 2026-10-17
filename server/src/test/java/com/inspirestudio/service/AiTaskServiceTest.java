package com.inspirestudio.service;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.inspirestudio.agent.AgentTaskOrchestrator;
import com.inspirestudio.ai.AiProviderAdapter;
import com.inspirestudio.ai.AiProviderAdapterRegistry;
import com.inspirestudio.ai.AiErrorDetails;
import com.inspirestudio.ai.AiProviderException;
import com.inspirestudio.ai.AiTaskTypes;
import com.inspirestudio.ai.AiTaskSources;
import com.inspirestudio.ai.VideoGenerationMode;
import com.inspirestudio.ai.provider.CustomProviderAdapter;
import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.dto.AiTaskDtos;
import com.inspirestudio.dto.GenerationStyleDtos;
import com.inspirestudio.dto.PersistenceDtos;
import com.inspirestudio.dto.VideoBillingConfiguration;
import com.inspirestudio.entity.AiGenerationTask;
import com.inspirestudio.repository.AiTaskRepository;
import com.inspirestudio.security.CurrentUserProvider;
import com.inspirestudio.task.AiTaskEventPublisher;
import com.inspirestudio.task.AiTaskQueue;
import com.inspirestudio.task.ModelTaskExecutionDispatcher;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.transaction.reactive.TransactionalOperator;
import org.springframework.test.util.ReflectionTestUtils;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Sinks;
import reactor.test.StepVerifier;

/**
 * AI任务服务测试。
 *
 * @date     2026-07-10 00:00
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class AiTaskServiceTest {

    /** AI任务仓储 */
    @Mock
    private AiTaskRepository repository;

    /** 当前用户提供器 */
    @Mock
    private CurrentUserProvider currentUserProvider;

    /** 服务配置 */
    @Mock
    private InspireProperties properties;

    /** 业务持久化服务 */
    @Mock
    private PersistenceService persistenceService;

    /** 任务事件发布器 */
    @Mock
    private AiTaskEventPublisher eventPublisher;

    /** AI任务队列 */
    @Mock
    private AiTaskQueue taskQueue;

    /** 模型任务执行调度器 */
    @Mock
    private ModelTaskExecutionDispatcher modelTaskExecutionDispatcher;

    /** Agent任务编排器 */
    @Mock
    private AgentTaskOrchestrator orchestrator;

    /** 渠道适配器注册表 */
    @Mock
    private AiProviderAdapterRegistry adapterRegistry;

    /** 自定义模型供应商适配器 */
    @Mock
    private CustomProviderAdapter customProviderAdapter;

    /** 图片供应商适配器 */
    private AiProviderAdapter providerAdapter;

    /** 积分服务 */
    @Mock
    private CreditService creditService;

    /** 响应式事务操作器 */
    @Mock
    private TransactionalOperator transactionalOperator;

    /** 待测试服务 */
    private AiTaskService service;

    /** 响应式操作实际执行顺序 */
    private List<String> executionOrder;

    /**
     * 初始化测试依赖和响应式执行记录。
     */
    @BeforeEach
    void setUp() {
        executionOrder = new ArrayList<>();
        service = new AiTaskService(repository, currentUserProvider, properties, persistenceService,
                eventPublisher, taskQueue, modelTaskExecutionDispatcher, orchestrator, adapterRegistry, customProviderAdapter, creditService, transactionalOperator);

        AiTaskDtos.AiChannelConfig channel = new AiTaskDtos.AiChannelConfig(
                "channel-1", "图片渠道", "https://example.com", "key", "openai", List.of("model-1"));
        when(currentUserProvider.currentUserId()).thenReturn(Mono.just(7L));
        when(persistenceService.getPlatformAiChannels()).thenReturn(Mono.just(List.of(channel)));
        when(persistenceService.getAvailablePlatformAiChannels()).thenAnswer(call -> persistenceService.getPlatformAiChannels());
        when(persistenceService.getPlatformModelConfigs()).thenReturn(Mono.just(List.of(
                new PersistenceDtos.ModelConfig("model-config-1", "channel-1", "model-1", AiTaskTypes.IMAGE, List.of(), true, 0, 0, true, "high"),
                new PersistenceDtos.ModelConfig("model-config-2", "channel-1", "model-1", AiTaskTypes.VIDEO,
                        List.of(VideoGenerationMode.TEXT_TO_VIDEO, VideoGenerationMode.IMAGE_TO_VIDEO, VideoGenerationMode.REFERENCE_TO_VIDEO), true, 0, 0, true, "high", "generation", 1,
                        new com.alibaba.fastjson2.JSONObject(), new VideoBillingConfiguration("generation", 3,
                        Map.of(VideoGenerationMode.TEXT_TO_VIDEO, Map.of("720p", 6),
                                VideoGenerationMode.IMAGE_TO_VIDEO, Map.of("720p", 8),
                                VideoGenerationMode.REFERENCE_TO_VIDEO, Map.of("720p", 10))), null, null, false, null),
                new PersistenceDtos.ModelConfig("model-config-3", "channel-1", "model-1", AiTaskTypes.TEXT, List.of(), true, 0, 0, true, "high")
        )));
        providerAdapter = mock(AiProviderAdapter.class);
        when(adapterRegistry.resolve(any(AiTaskDtos.AiChannelConfig.class), eq(AiTaskTypes.IMAGE)))
                .thenReturn(providerAdapter);
        when(adapterRegistry.resolve(any(AiTaskDtos.AiChannelConfig.class), eq(AiTaskTypes.VIDEO)))
                .thenReturn(providerAdapter);
        when(adapterRegistry.resolve(any(AiTaskDtos.AiChannelConfig.class), eq(AiTaskTypes.TEXT)))
                .thenReturn(providerAdapter);
        when(repository.createTask(any(AiGenerationTask.class))).thenReturn(Mono.defer(() -> {
            executionOrder.add("create");
            return Mono.empty();
        }));
        when(creditService.chargeTask(anyLong(), anyString(), org.mockito.ArgumentMatchers.anyInt(), anyString(), org.mockito.ArgumentMatchers.nullable(String.class))).thenReturn(Mono.empty());
        org.mockito.Mockito.lenient().when(creditService.refundTask(anyLong(), anyString(), anyString())).thenReturn(Mono.empty());
        when(transactionalOperator.transactional(org.mockito.ArgumentMatchers.<Mono<Object>>any())).thenAnswer(invocation -> invocation.getArgument(0));
        org.mockito.Mockito.lenient().when(repository.updateTaskIfNotTerminal(anyString(), any(), org.mockito.ArgumentMatchers.nullable(String.class))).thenReturn(Mono.just(true));
        when(repository.getTask(eq(7L), anyString())).thenAnswer(invocation -> Mono.defer(() -> {
            executionOrder.add("read");
            return Mono.just(task(invocation.getArgument(1)));
        }));
        org.mockito.Mockito.lenient().when(eventPublisher.publish(anyLong(), any(AiTaskDtos.AiTaskEvent.class))).thenReturn(Mono.defer(() -> {
            executionOrder.add("publish");
            return Mono.empty();
        }));
        org.mockito.Mockito.lenient().when(taskQueue.enqueue(anyString())).thenReturn(Mono.defer(() -> {
            executionOrder.add("enqueue");
            return Mono.empty();
        }));
        org.mockito.Mockito.lenient().when(modelTaskExecutionDispatcher.enqueue(anyString(), anyString())).thenReturn(Mono.defer(() -> {
            executionOrder.add("modelEnqueue");
            return Mono.empty();
        }));
    }

    @Test
    void disabledModelIsHiddenAndRejectedBeforeCharging() {
        when(persistenceService.getAvailablePlatformAiChannels()).thenReturn(Mono.just(List.of()));
        Assertions.assertTrue(service.listModels().block().models().isEmpty());
        BusinessException error = Assertions.assertThrows(BusinessException.class, () -> service.createTask(request()).block());
        Assertions.assertTrue(error.getMessage().contains("已禁用或不可用"));
        verifyNoInteractions(creditService);
        verify(repository, never()).createTask(any());
    }

    @Test
    void activeExplicitSelectionWorksWhenSavedDefaultIsDisabled() {
        when(persistenceService.getAvailablePlatformAiChannels()).thenReturn(Mono.just(List.of(new AiTaskDtos.AiChannelConfig(
                "channel-1", "网关", "https://example.com", "key", "openai", List.of("active")))));
        when(persistenceService.getPlatformModelConfigs()).thenReturn(Mono.just(List.of(
                new PersistenceDtos.ModelConfig("off", "channel-1", "model-1", AiTaskTypes.IMAGE, List.of(), true, 0, 0, true, "high"),
                new PersistenceDtos.ModelConfig("on", "channel-1", "active", AiTaskTypes.IMAGE, List.of(), false, 0, 0, true, "high"))));
        Assertions.assertEquals(List.of("channel-1::active"), service.listModels().block().imageModels());
        var request = new AiTaskDtos.CreateAiTaskRequest(AiTaskTypes.IMAGE, "生成图片", "channel-1::active", Map.of(), List.of(), List.of(), AiTaskSources.CANVAS);
        Assertions.assertNotNull(service.createTask(request).block());
        verify(modelTaskExecutionDispatcher).enqueue(eq("on"), anyString());
    }

    /**
     * 图片任务入库并读取响应后，应先完成入队前处理，再发布事件和写入模型队列。
     */
    @Test
    void shouldRunBeforeEnqueueAfterTaskResponseAndBeforePublishAndEnqueue() {
        AiTaskDtos.AiGenerationTaskResponse response = service.createTask(request(), taskResponse -> Mono.fromRunnable(() -> {
            executionOrder.add("beforeEnqueue");
            Assertions.assertNotNull(taskResponse.id());
            Assertions.assertFalse(taskResponse.id().isBlank());
        })).block();

        Assertions.assertNotNull(response);
        Assertions.assertEquals(List.of("create", "read", "beforeEnqueue", "publish", "modelEnqueue"), executionOrder);
        verify(modelTaskExecutionDispatcher).enqueue(eq("model-config-1"), anyString());
    }

    /** 无效蒙版渠道必须在风格解析和可能扣费的提示词优化之前拒绝。 */
    @Test
    void shouldRejectStyledMaskBeforePromptOptimizationOrCharging() {
        GenerationStyleService styles = mock(GenerationStyleService.class);
        PromptOptimizationService optimization = mock(PromptOptimizationService.class);
        ReflectionTestUtils.setField(service, "generationStyleService", styles);
        ReflectionTestUtils.setField(service, "promptOptimizationService", optimization);
        when(styles.resolveStyles(eq(AiTaskTypes.IMAGE), anyList(), anyList())).thenReturn(Mono.just(List.of(
                new GenerationStyleDtos.GenerationStyleSnapshot(9L, "电影光线", AiTaskTypes.IMAGE, "cinematic light"))));
        when(optimization.optimizeAndWait(anyLong(), anyString(), anyString(), anyList(), any())).thenReturn(Mono.just("优化后的精修要求"));
        when(persistenceService.getPlatformAiChannels()).thenReturn(Mono.just(List.of(new AiTaskDtos.AiChannelConfig(
                "channel-1", "不支持蒙版的图片渠道", "https://example.com", "key", "gemini", List.of("model-1")))));
        AiTaskDtos.CreateAiTaskRequest request = new AiTaskDtos.CreateAiTaskRequest(
                AiTaskTypes.IMAGE, "仅重绘选区", "channel-1::model-1",
                Map.of("editMask", Map.of("storageKey", "image:mask", "mimeType", "image/png")),
                List.of(new AiTaskDtos.AiTaskMediaReference("source", "source.png", "image/png", "image:source", null)),
                List.of(), AiTaskSources.CANVAS, List.of(9L), List.of());

        BusinessException error = Assertions.assertThrows(BusinessException.class, () -> service.createTask(request).block());

        Assertions.assertTrue(error.getMessage().contains("不支持局部蒙版"));
        verifyNoInteractions(styles, optimization);
        verify(repository, never()).createTask(any(AiGenerationTask.class));
        verify(creditService, never()).chargeTask(anyLong(), anyString(), org.mockito.ArgumentMatchers.anyInt(), anyString(), org.mockito.ArgumentMatchers.nullable(String.class));
        verify(modelTaskExecutionDispatcher, never()).enqueue(anyString(), anyString());
        Assertions.assertTrue(executionOrder.isEmpty());
    }

    /** 视频任务应按对应模型配置进入模型队列。 */
    @Test
    void shouldEnqueueVideoTaskToModelQueue() {
        AiTaskDtos.CreateAiTaskRequest request = new AiTaskDtos.CreateAiTaskRequest(
                AiTaskTypes.VIDEO, "生成视频", "channel-1::model-1", java.util.Map.of("seconds", 5, "resolution", "720p"), List.of(), List.of(), AiTaskSources.VIDEO_PAGE);

        AiTaskDtos.AiGenerationTaskResponse response = service.createTask(request).block();

        Assertions.assertNotNull(response);
        Assertions.assertTrue(executionOrder.contains("modelEnqueue"));
        verify(modelTaskExecutionDispatcher).enqueue(eq("model-config-2"), anyString());
    }

    /** Seedance 2.0 Mini 超过 8 秒时应在扣费和入队前拒绝。 */
    @Test
    void shouldRejectSeedanceMiniDurationOverEightSeconds() {
        String miniModel = "Doubao-Seedance-2.0-mini";
        when(persistenceService.getPlatformAiChannels()).thenReturn(Mono.just(List.of(new AiTaskDtos.AiChannelConfig(
                "channel-1", "Lumina 视频", "https://example.com", "key", "openai-video-json", List.of(miniModel)))));
        when(persistenceService.getPlatformModelConfigs()).thenReturn(Mono.just(List.of(new PersistenceDtos.ModelConfig(
                "mini-config", "channel-1", miniModel, AiTaskTypes.VIDEO,
                List.of(VideoGenerationMode.TEXT_TO_VIDEO), true, 0, 0, false, "high", "second", 1,
                new com.alibaba.fastjson2.JSONObject(), new VideoBillingConfiguration("second", 4,
                Map.of(VideoGenerationMode.TEXT_TO_VIDEO, Map.of("720p", 10))), null, null, false, null))));
        AiTaskDtos.CreateAiTaskRequest request = new AiTaskDtos.CreateAiTaskRequest(
                AiTaskTypes.VIDEO, "生成视频", "channel-1::" + miniModel,
                Map.of("seconds", 9, "resolution", "720p"), List.of(), List.of(), AiTaskSources.VIDEO_PAGE);

        BusinessException error = Assertions.assertThrows(BusinessException.class, () -> service.createTask(request).block());

        Assertions.assertTrue(error.getMessage().contains("最长只能生成8秒"));
        verify(repository, never()).createTask(any(AiGenerationTask.class));
        verify(creditService, never()).chargeTask(anyLong(), anyString(), org.mockito.ArgumentMatchers.anyInt(), anyString(), org.mockito.ArgumentMatchers.nullable(String.class));
        verify(modelTaskExecutionDispatcher, never()).enqueue(anyString(), anyString());
    }

    /** Seedance 2.5 应允许文档声明的 30 秒上限。 */
    @Test
    void shouldAllowSeedance25DurationUpToThirtySeconds() {
        String model = "Doubao-Seedance-2.5";
        when(persistenceService.getPlatformAiChannels()).thenReturn(Mono.just(List.of(new AiTaskDtos.AiChannelConfig(
                "channel-1", "Lumina 视频", "https://example.com", "key", "openai-video-json", List.of(model)))));
        when(persistenceService.getPlatformModelConfigs()).thenReturn(Mono.just(List.of(new PersistenceDtos.ModelConfig(
                "seedance-25-config", "channel-1", model, AiTaskTypes.VIDEO,
                List.of(VideoGenerationMode.TEXT_TO_VIDEO), true, 0, 0, false, "high", "second", 1,
                new com.alibaba.fastjson2.JSONObject(), new VideoBillingConfiguration("second", 4,
                Map.of(VideoGenerationMode.TEXT_TO_VIDEO, Map.of("1080p", 15))), null, null, false, null))));
        AiTaskDtos.CreateAiTaskRequest request = new AiTaskDtos.CreateAiTaskRequest(
                AiTaskTypes.VIDEO, "生成三十秒视频", "channel-1::" + model,
                Map.of("seconds", 30, "resolution", "1080p"), List.of(), List.of(), AiTaskSources.VIDEO_PAGE);

        AiTaskDtos.AiGenerationTaskResponse response = service.createTask(request).block();

        Assertions.assertNotNull(response);
        verify(repository).createTask(any(AiGenerationTask.class));
        verify(modelTaskExecutionDispatcher).enqueue(eq("seedance-25-config"), anyString());
    }

    @ParameterizedTest
    @ValueSource(ints = {15, 30})
    void shouldRejectUnconfiguredDurationBeforeCharge(int fixedSeconds) {
        configureFixedGatewayDuration(fixedSeconds);
        var request = new AiTaskDtos.CreateAiTaskRequest(AiTaskTypes.VIDEO, "视频", "channel-1::gateway-alias",
                Map.of("seconds", 10, "resolution", "720p"), List.of(), List.of(), AiTaskSources.VIDEO_PAGE);
        BusinessException error = Assertions.assertThrows(BusinessException.class, () -> service.createTask(request).block());
        Assertions.assertTrue(error.getMessage().contains("仅支持" + fixedSeconds + "秒"));
        verify(repository, never()).createTask(any(AiGenerationTask.class));
        verify(creditService, never()).chargeTask(anyLong(), anyString(), org.mockito.ArgumentMatchers.anyInt(), anyString(), org.mockito.ArgumentMatchers.nullable(String.class));
        verify(modelTaskExecutionDispatcher, never()).enqueue(anyString(), anyString());
    }

    @ParameterizedTest
    @ValueSource(ints = {15, 30})
    void shouldUseConfiguredGatewayDurationAndPrice(int fixedSeconds) {
        configureFixedGatewayDuration(fixedSeconds);
        var request = new AiTaskDtos.CreateAiTaskRequest(AiTaskTypes.VIDEO, "视频", "channel-1::gateway-alias",
                Map.of("seconds", fixedSeconds, "resolution", "720p"), List.of(), List.of(), AiTaskSources.VIDEO_PAGE);
        Assertions.assertNotNull(service.createTask(request).block());
        verify(creditService).chargeTask(anyLong(), anyString(), eq(10 * fixedSeconds), anyString(), org.mockito.ArgumentMatchers.nullable(String.class));
        verify(modelTaskExecutionDispatcher).enqueue(eq("fixed-config"), anyString());
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "720p"})
    void shouldApplyDefaultResolutionBeforePricingAndSnapshot(String explicitResolution) {
        configureFixedGatewayDuration(15);
        when(persistenceService.getPlatformModelConfigs()).thenReturn(Mono.just(List.of(new PersistenceDtos.ModelConfig(
                "fixed-config", "channel-1", "gateway-alias", AiTaskTypes.VIDEO,
                List.of(VideoGenerationMode.TEXT_TO_VIDEO), true, 0, 0, false, "high", "second", 1,
                new com.alibaba.fastjson2.JSONObject(), new VideoBillingConfiguration("second", 3,
                Map.of(VideoGenerationMode.TEXT_TO_VIDEO, Map.of("480p", 5, "720p", 10)), List.of(15), "480p"), null, null, false, null))));
        Map<String, Object> parameters = new java.util.HashMap<>(Map.of("seconds", 15));
        if (!explicitResolution.isBlank()) parameters.put("resolution", explicitResolution);
        var request = new AiTaskDtos.CreateAiTaskRequest(AiTaskTypes.VIDEO, "视频", "channel-1::gateway-alias",
                parameters, List.of(), List.of(), AiTaskSources.VIDEO_PAGE);
        Assertions.assertNotNull(service.createTask(request).block());
        verify(creditService).chargeTask(anyLong(), anyString(), eq(explicitResolution.isBlank() ? 75 : 150), anyString(), org.mockito.ArgumentMatchers.nullable(String.class));
        var captured = org.mockito.ArgumentCaptor.forClass(AiGenerationTask.class);
        verify(repository).createTask(captured.capture());
        var saved = com.alibaba.fastjson2.JSON.parseObject(captured.getValue().getRequestData());
        Assertions.assertEquals(explicitResolution.isBlank() ? "480p" : "720p", saved.getJSONObject("parameters").getString("resolution"));
        Assertions.assertEquals(explicitResolution.isBlank() ? null : "720p", parameters.get("resolution"));
    }

    private void configureFixedGatewayDuration(int seconds) {
        when(persistenceService.getPlatformAiChannels()).thenReturn(Mono.just(List.of(new AiTaskDtos.AiChannelConfig(
                "channel-1", "网关", "http://newapi:3000/v1", "key", "newapi", List.of("gateway-alias")))));
        when(persistenceService.getPlatformModelConfigs()).thenReturn(Mono.just(List.of(new PersistenceDtos.ModelConfig(
                "fixed-config", "channel-1", "gateway-alias", AiTaskTypes.VIDEO,
                List.of(VideoGenerationMode.TEXT_TO_VIDEO), true, 0, 0, false, "high", "second", 1,
                new com.alibaba.fastjson2.JSONObject(), new VideoBillingConfiguration("second", 3,
                Map.of(VideoGenerationMode.TEXT_TO_VIDEO, Map.of("720p", 10)), List.of(seconds)), null, null, false, null))));
    }

    /**
     * 文本任务应继续使用全局AI任务队列。
     */
    @Test
    void shouldEnqueueTextTaskToGlobalQueue() {
        AiTaskDtos.CreateAiTaskRequest request = new AiTaskDtos.CreateAiTaskRequest(
                AiTaskTypes.TEXT, "生成文本", "channel-1::model-1", java.util.Map.of(), List.of(), List.of(), null);

        AiTaskDtos.AiGenerationTaskResponse response = service.createTask(request).block();

        Assertions.assertNotNull(response);
        Assertions.assertTrue(executionOrder.contains("enqueue"));
        Assertions.assertFalse(executionOrder.contains("modelEnqueue"));
    }

    @Test
    void shouldRejectReverseTaskWithoutVisionBeforeCreatingOrCharging() {
        when(persistenceService.getMediaInfoForUser(7L, "owned-image")).thenReturn(Mono.just(
                new PersistenceDtos.UploadedMediaResponse("owned-image", "https://media.example.test/input.png", 12L, "image/png", 100, 100, null, null)));
        var request = new AiTaskDtos.CreateAiTaskRequest(AiTaskTypes.TEXT, "反推规则", "channel-1::model-1", Map.of(),
                List.of(new AiTaskDtos.AiTaskMediaReference("i", "input.png", "image/png", "owned-image", null)), List.of(), "image-prompt-reverse");

        BusinessException error = Assertions.assertThrows(BusinessException.class, () -> service.createTask(request).block());

        Assertions.assertTrue(error.getMessage().contains("vision"));
        verify(repository, never()).createTask(any());
        verify(creditService, never()).chargeTask(anyLong(), anyString(), org.mockito.ArgumentMatchers.anyInt(), anyString(), org.mockito.ArgumentMatchers.nullable(String.class));
        verify(taskQueue, never()).enqueue(anyString());
    }

    @Test
    void shouldUseExistingTaskAndGlobalQueueForReverseImage() {
        when(persistenceService.getMediaInfoForUser(7L, "owned-image")).thenReturn(Mono.just(
                new PersistenceDtos.UploadedMediaResponse("owned-image", "https://media.example.test/input.png", 12L, "image/png", 100, 100, null, null)));
        when(persistenceService.getPlatformModelConfigs()).thenReturn(Mono.just(List.of(
                new PersistenceDtos.ModelConfig("model-config-3", "channel-1", "model-1", AiTaskTypes.TEXT, List.of("vision"), true, 0, 0, false, "high"))));
        var request = new AiTaskDtos.CreateAiTaskRequest(AiTaskTypes.TEXT, "反推规则", "channel-1::model-1", Map.of(),
                List.of(new AiTaskDtos.AiTaskMediaReference("i", "input.png", "image/png", "owned-image", null)), List.of(), "image-prompt-reverse");

        Assertions.assertNotNull(service.createTask(request).block());

        verify(repository).createTask(any());
        verify(creditService).chargeTask(eq(7L), anyString(), eq(0), eq("text"), eq("image-prompt-reverse"));
        verify(taskQueue).enqueue(anyString());
        verify(modelTaskExecutionDispatcher, never()).enqueue(anyString(), anyString());
    }

    /** 供应商晚到响应不得在取消后结算、覆盖取消终态或再次退款；Redis标记丢失时仍检查持久终态。 */
    @ParameterizedTest
    @ValueSource(booleans = {true, false})
    void shouldDiscardLateReverseResponseAfterCancellationWithoutSettling(boolean keepCancelFlag) {
        var taskRequest = new AiTaskDtos.CreateAiTaskRequest(AiTaskTypes.TEXT, "反推规则", "channel-1::model-1", Map.of(),
                List.of(new AiTaskDtos.AiTaskMediaReference("i", "input.png", "image/png", "owned-image", null)), List.of(), "image-prompt-reverse");
        AiGenerationTask queuedTask = task("task-1");
        queuedTask.setTaskType(AiTaskTypes.TEXT);
        queuedTask.setModelConfigId("model-config-3");
        queuedTask.setRequestData(com.alibaba.fastjson2.JSON.toJSONString(taskRequest));
        when(repository.getTaskById("task-1")).thenReturn(Mono.just(queuedTask));
        when(repository.getTask(7L, "task-1")).thenReturn(Mono.just(queuedTask));
        when(repository.markTaskRunningIfExecutable("task-1")).thenReturn(Mono.just(true));
        when(repository.updateTaskIfNotTerminal(eq("task-1"), any(), org.mockito.ArgumentMatchers.nullable(String.class)))
                .thenAnswer(call -> Mono.fromSupplier(() -> {
                    if (List.of("success", "failed", "canceled").contains(queuedTask.getStatus())) return false;
                    Map<String, Object> values = call.getArgument(1);
                    queuedTask.setStatus((String) values.get("status"));
                    return true;
                }));
        java.util.concurrent.atomic.AtomicBoolean cancelled = new java.util.concurrent.atomic.AtomicBoolean(false);
        when(eventPublisher.isCancelRequested("task-1")).thenReturn(Mono.fromSupplier(cancelled::get));
        when(eventPublisher.markCancelRequested("task-1")).thenReturn(Mono.fromRunnable(() -> cancelled.set(true)));
        when(persistenceService.getMediaInfoForUser(7L, "owned-image")).thenReturn(Mono.just(
                new PersistenceDtos.UploadedMediaResponse("owned-image", "https://media.example.test/input.png", 12L, "image/png", 100, 100, null, null)));
        when(persistenceService.getPlatformModelConfigs()).thenReturn(Mono.just(List.of(
                new PersistenceDtos.ModelConfig("model-config-3", "channel-1", "model-1", AiTaskTypes.TEXT, List.of("vision"), true, 0, 0, false, "high"))));
        TextTokenBillingService billing = org.mockito.Mockito.spy(new TextTokenBillingService(mock(org.springframework.r2dbc.core.DatabaseClient.class),
                creditService, currentUserProvider, transactionalOperator));
        var price = new TextTokenBillingService.Price("model-config-3", "", java.math.BigDecimal.ZERO, java.math.BigDecimal.ZERO,
                java.math.BigDecimal.ONE, "CNY", java.math.BigDecimal.ONE, 0);
        org.mockito.Mockito.doReturn(Mono.just(price)).when(billing).price("model-config-3");
        org.mockito.Mockito.doReturn(Mono.just(1)).when(billing).settle(anyLong(), anyString(), any(), anyLong(), anyLong());
        ReflectionTestUtils.setField(service, "tokenBilling", billing);
        Sinks.One<com.alibaba.fastjson2.JSONObject> providerResponse = Sinks.one();
        when(providerAdapter.execute(any())).thenReturn(providerResponse.asMono());

        StepVerifier.create(service.executeQueuedTask("task-1"))
                .then(() -> {
                    Assertions.assertEquals("canceled", service.cancelTaskForUser(7L, "task-1").block().status());
                    if (!keepCancelFlag) cancelled.set(false);
                    com.alibaba.fastjson2.JSONObject result = new com.alibaba.fastjson2.JSONObject();
                    result.put("content", "{\"promptZh\":\"中文提示词\",\"promptEn\":\"English prompt\",\"negativePrompt\":\"blur, noise\"}");
                    result.put("tokenUsage", Map.of("inputTokens", 100, "outputTokens", 50));
                    providerResponse.tryEmitValue(result);
                })
                .verifyComplete();

        Assertions.assertEquals("canceled", queuedTask.getStatus());
        verify(billing, never()).settle(anyLong(), anyString(), any(), anyLong(), anyLong());
        verify(creditService).refundTask(7L, "task-1", AiTaskTypes.TEXT);
        verify(repository).updateTaskIfNotTerminal(eq("task-1"), any(), org.mockito.ArgumentMatchers.nullable(String.class));
    }

    /**
     * 入队前处理失败时，应保留已创建任务行但不得发布事件或写入队列。
     */
    @Test
    void shouldNotPublishOrEnqueueWhenBeforeEnqueueFails() {
        IllegalStateException exception = Assertions.assertThrows(IllegalStateException.class,
                () -> service.createTask(request(), taskResponse -> Mono.defer(() -> {
                    executionOrder.add("beforeEnqueue");
                    return Mono.error(new IllegalStateException("pending保存失败"));
                })).block());

        Assertions.assertEquals("pending保存失败", exception.getMessage());
        Assertions.assertEquals(List.of("create", "read", "beforeEnqueue"), executionOrder);
    }

    /**
     * 供应商结构化失败进入任务终态时必须退回该任务积分。
     */
    @Test
    void shouldRefundCreditsWhenProviderTaskFails() {
        when(repository.getTaskById("task-1")).thenReturn(Mono.just(task("task-1")));
        when(repository.markTaskRunningIfExecutable("task-1")).thenReturn(Mono.just(true));
        when(eventPublisher.isCancelRequested("task-1")).thenReturn(Mono.just(false));
        when(providerAdapter.execute(any())).thenReturn(Mono.error(new AiProviderException(
                new AiErrorDetails("provider", "prompt_policy_violation", "submission", 400,
                        "content_policy_violation", "invalid_request_error", "prompt", "提示词不符合内容策略",
                        false, true))));

        StepVerifier.withVirtualTime(() -> service.executeQueuedTask("task-1"))
                .thenAwait(java.time.Duration.ofSeconds(51)).verifyComplete();

        verify(providerAdapter, org.mockito.Mockito.times(4)).execute(any());
        verify(creditService).refundTask(7L, "task-1", AiTaskTypes.IMAGE);
        verify(creditService, never()).chargeTask(anyLong(), anyString(), org.mockito.ArgumentMatchers.anyInt(), anyString(), org.mockito.ArgumentMatchers.nullable(String.class));
    }

    @Test
    void shouldKeepTaskRunningAndChargeOnlyOnceWhileRetrying() {
        AiGenerationTask queuedTask = task("task-1");
        when(repository.getTaskById("task-1")).thenReturn(Mono.just(queuedTask));
        when(repository.markTaskRunningIfExecutable("task-1")).thenReturn(Mono.just(true));
        when(eventPublisher.isCancelRequested("task-1")).thenReturn(Mono.just(false));
        var calls = new java.util.concurrent.atomic.AtomicInteger();
        var statuses = new java.util.ArrayList<String>();
        when(repository.updateTaskIfNotTerminal(eq("task-1"), any(), org.mockito.ArgumentMatchers.nullable(String.class)))
                .thenAnswer(invocation -> {
                    java.util.Map<String, Object> fields = invocation.getArgument(1);
                    statuses.add((String) fields.get("status"));
                    return Mono.just(true);
                });
        when(providerAdapter.execute(any())).thenAnswer(invocation -> calls.incrementAndGet() < 3
                ? Mono.error(new IllegalStateException("temporary failure"))
                : Mono.just(new com.alibaba.fastjson2.JSONObject(java.util.Map.of("items", List.of("image")))));

        StepVerifier.withVirtualTime(() -> service.executeQueuedTask("task-1"))
                .thenAwait(java.time.Duration.ofSeconds(21)).verifyComplete();

        Assertions.assertEquals(3, calls.get());
        Assertions.assertFalse(statuses.contains("failed"));
        Assertions.assertEquals("success", statuses.getLast());
        verify(creditService, never()).refundTask(anyLong(), anyString(), anyString());
        verify(creditService, never()).chargeTask(anyLong(), anyString(), org.mockito.ArgumentMatchers.anyInt(), anyString(), org.mockito.ArgumentMatchers.nullable(String.class));
        verify(repository, never()).createTask(any());
    }

    /** 已持久化模型配置缺失时，图片任务不得按同名模型改投。 */
    @Test
    void shouldFailAndRefundWhenQueuedModelConfigIsMissing() {
        AiGenerationTask queuedTask = task("task-1");
        queuedTask.setModelConfigId("deleted-model-config");
        when(repository.getTaskById("task-1")).thenReturn(Mono.just(queuedTask));
        when(repository.markTaskRunningIfExecutable("task-1")).thenReturn(Mono.just(true));
        when(eventPublisher.isCancelRequested("task-1")).thenReturn(Mono.just(false));

        service.executeQueuedTask("task-1").block();

        verify(creditService).refundTask(7L, "task-1", AiTaskTypes.IMAGE);
        verify(providerAdapter, never()).execute(any());
    }

    /**
     * 分镜来源不能创建文本任务。
     */
    @Test
    void shouldRejectStoryboardSourceForTextTask() {
        AiTaskDtos.CreateAiTaskRequest request = new AiTaskDtos.CreateAiTaskRequest(
                AiTaskTypes.TEXT, "文本任务", "channel-1::model-1", java.util.Map.of(), List.of(), List.of(), AiTaskSources.STORYBOARD);

        Assertions.assertThrows(BusinessException.class, () -> service.createTask(request).block());
    }

    /**
     * 分镜来源应允许创建视频任务。
     */
    @Test
    void shouldAllowStoryboardSourceForVideoTask() {
        AiTaskDtos.CreateAiTaskRequest request = new AiTaskDtos.CreateAiTaskRequest(
                AiTaskTypes.VIDEO, "生成分镜视频", "channel-1::model-1", java.util.Map.of("seconds", 5, "resolution", "720p"), List.of(), List.of(), AiTaskSources.STORYBOARD);

        AiTaskDtos.AiGenerationTaskResponse response = service.createTask(request).block();

        Assertions.assertNotNull(response);
    }

    /**
     * 非图片媒体不能通过图片参考列表进入视频任务，失败时不得创建任务或扣积分。
     */
    @Test
    void shouldRejectNonImageMimeTypeBeforeCreatingVideoTask() {
        AiTaskDtos.CreateAiTaskRequest request = new AiTaskDtos.CreateAiTaskRequest(
                AiTaskTypes.VIDEO, "生成视频", "channel-1::model-1", Map.of("seconds", 5, "resolution", "720p"),
                List.of(new AiTaskDtos.AiTaskMediaReference("reference-1", "说明文件", "application/pdf", "files/reference-1", "https://example.com/reference-1")),
                List.of(), AiTaskSources.VIDEO_PAGE, null, null, VideoGenerationMode.IMAGE_TO_VIDEO);

        BusinessException exception = Assertions.assertThrows(BusinessException.class, () -> service.createTask(request).block());

        Assertions.assertTrue(exception.getMessage().contains("图片参考列表只能包含图片素材"));
        verify(repository, never()).createTask(any(AiGenerationTask.class));
        verify(creditService, never()).chargeTask(anyLong(), anyString(), org.mockito.ArgumentMatchers.anyInt(), anyString(), org.mockito.ArgumentMatchers.nullable(String.class));
        verify(modelTaskExecutionDispatcher, never()).enqueue(anyString(), anyString());
    }

    /** storageKey 查询不到媒体时，视频任务不得创建、扣费或入队。 */
    @Test
    void shouldRejectMissingVideoReferenceStorageKeyBeforeSideEffects() {
        when(persistenceService.getMediaInfoForUser(7L, "image:missing")).thenReturn(Mono.empty());
        AiTaskDtos.CreateAiTaskRequest request = videoRequest(VideoGenerationMode.IMAGE_TO_VIDEO,
                List.of(new AiTaskDtos.AiTaskMediaReference("missing", "图片", "image/png", " image:missing ", "https://example.com/missing.png")), List.of());

        BusinessException exception = Assertions.assertThrows(BusinessException.class, () -> service.createTask(request).block());

        Assertions.assertTrue(exception.getMessage().contains("不存在或不属于当前用户"));
        verify(repository, never()).createTask(any(AiGenerationTask.class));
        verify(creditService, never()).chargeTask(anyLong(), anyString(), org.mockito.ArgumentMatchers.anyInt(), anyString(), org.mockito.ArgumentMatchers.nullable(String.class));
        verify(modelTaskExecutionDispatcher, never()).enqueue(anyString(), anyString());
    }

    /** 媒体查询抛出资源不存在时，仍需统一返回素材归属错误且不产生副作用。 */
    @Test
    void shouldRejectVideoReferenceOwnedByAnotherUserBeforeSideEffects() {
        when(persistenceService.getMediaInfoForUser(7L, "image:other"))
                .thenReturn(Mono.error(new BusinessException(com.inspirestudio.common.ErrorCode.RESOURCE_NOT_FOUND, "媒体不存在")));
        AiTaskDtos.CreateAiTaskRequest request = videoRequest(VideoGenerationMode.IMAGE_TO_VIDEO,
                List.of(new AiTaskDtos.AiTaskMediaReference("other", "图片", "image/png", "image:other", "https://example.com/other.png")), List.of());

        BusinessException exception = Assertions.assertThrows(BusinessException.class, () -> service.createTask(request).block());

        Assertions.assertTrue(exception.getMessage().contains("不存在或不属于当前用户"));
        verify(repository, never()).createTask(any(AiGenerationTask.class));
        verify(creditService, never()).chargeTask(anyLong(), anyString(), org.mockito.ArgumentMatchers.anyInt(), anyString(), org.mockito.ArgumentMatchers.nullable(String.class));
        verify(modelTaskExecutionDispatcher, never()).enqueue(anyString(), anyString());
    }

    /** 数据库媒体类型与请求声明不一致时，视频任务必须失败。 */
    @Test
    void shouldRejectVideoReferenceWhenStoredMimeTypeDoesNotMatchDeclaration() {
        when(persistenceService.getMediaInfoForUser(7L, "image:stored"))
                .thenReturn(Mono.just(uploadedMedia("image:stored", "https://example.com/stored.png", "video/mp4")));
        AiTaskDtos.CreateAiTaskRequest request = videoRequest(VideoGenerationMode.IMAGE_TO_VIDEO,
                List.of(new AiTaskDtos.AiTaskMediaReference("stored", "图片", "image/png", "image:stored", "https://example.com/stored.png")), List.of());

        BusinessException exception = Assertions.assertThrows(BusinessException.class, () -> service.createTask(request).block());

        Assertions.assertTrue(exception.getMessage().contains("素材类型与声明不一致"));
        verify(repository, never()).createTask(any(AiGenerationTask.class));
        verify(creditService, never()).chargeTask(anyLong(), anyString(), org.mockito.ArgumentMatchers.anyInt(), anyString(), org.mockito.ArgumentMatchers.nullable(String.class));
        verify(modelTaskExecutionDispatcher, never()).enqueue(anyString(), anyString());
    }

    /** 参考素材没有地址或地址协议非法时，视频任务必须失败。 */
    @Test
    void shouldRejectVideoReferenceWithoutAccessibleHttpUrl() {
        when(persistenceService.getMediaInfoForUser(7L, "image:no-url"))
                .thenReturn(Mono.just(uploadedMedia("image:no-url", "javascript:alert(1)", "image/png")));
        AiTaskDtos.CreateAiTaskRequest request = videoRequest(VideoGenerationMode.IMAGE_TO_VIDEO,
                List.of(new AiTaskDtos.AiTaskMediaReference("no-url", "图片", "image/png", "image:no-url", "https://example.com/no-url.png")), List.of());

        BusinessException exception = Assertions.assertThrows(BusinessException.class, () -> service.createTask(request).block());

        Assertions.assertTrue(exception.getMessage().contains("没有可访问的http或https地址"));
        verify(repository, never()).createTask(any(AiGenerationTask.class));
        verify(creditService, never()).chargeTask(anyLong(), anyString(), org.mockito.ArgumentMatchers.anyInt(), anyString(), org.mockito.ArgumentMatchers.nullable(String.class));
        verify(modelTaskExecutionDispatcher, never()).enqueue(anyString(), anyString());
    }

    /** 构造带图片或视频参考的视频请求。 */
    private AiTaskDtos.CreateAiTaskRequest videoRequest(String mode,
                                                        List<AiTaskDtos.AiTaskMediaReference> references,
                                                        List<AiTaskDtos.AiTaskMediaReference> videoReferences) {
        return new AiTaskDtos.CreateAiTaskRequest(AiTaskTypes.VIDEO, "生成视频", "channel-1::model-1",
                Map.of("seconds", 5, "resolution", "720p"), references, videoReferences,
                AiTaskSources.VIDEO_PAGE, null, null, mode);
    }

    /** 构造素材查询响应。 */
    private PersistenceDtos.UploadedMediaResponse uploadedMedia(String storageKey, String url, String mimeType) {
        return new PersistenceDtos.UploadedMediaResponse(storageKey, url, 12L, mimeType, null, null, null, null);
    }

    /**
     * 构建图片生成任务请求。
     *
     * @return CreateAiTaskRequest 图片任务请求
     */
    private AiTaskDtos.CreateAiTaskRequest request() {
        return new AiTaskDtos.CreateAiTaskRequest(AiTaskTypes.IMAGE, "生成图片", "channel-1::model-1",
                java.util.Map.of("size", "1:1"), List.of(), List.of(), AiTaskSources.IMAGE_PAGE);
    }

    /**
     * 构建仓储查询返回的任务实体。
     *
     * @param taskId String 任务ID
     * @return AiGenerationTask 任务实体
     */
    private AiGenerationTask task(String taskId) {
        AiGenerationTask task = new AiGenerationTask();
        task.setId(taskId);
        task.setUserId(7L);
        task.setTaskType(AiTaskTypes.IMAGE);
        task.setModel("model-1");
        task.setProvider("图片渠道");
        task.setModelConfigId("model-config-1");
        task.setStatus("pending");
        task.setProgress(0);
        task.setRequestData("{}");
        task.setResultData("{}");
        return task;
    }
    @Test
    void shouldDisableNativeSoundForReferenceAudioEvenWithExplicitTrue() {
        var original = audioRequest();
        var request = new AiTaskDtos.CreateAiTaskRequest(original.taskType(), original.prompt(), original.model(),
                Map.of("seconds", 5, "resolution", "720p", "generate_audio", true, "with_audio", true),
                original.references(), original.videoReferences(), original.generationSource(), null, null,
                original.videoGenerationMode(), original.audioReferences());
        AiTaskDtos.CreateAiTaskRequest normalized = ReflectionTestUtils.invokeMethod(service, "normalizeVideoGenerationMode", request);
        Assertions.assertEquals(false, normalized.parameters().get("generate_audio"));
        Assertions.assertEquals(false, normalized.parameters().get("with_audio"));
        Assertions.assertEquals(request.audioReferences(), normalized.audioReferences());
        Assertions.assertEquals(true, request.parameters().get("generate_audio"));
    }

    @Test
    void shouldKeepExplicitMutedChoiceAndDefaultLegacyRequestsToSound() {
        for (Map<String, Object> parameters : List.of(Map.<String, Object>of(), Map.<String, Object>of("generate_audio", false), Map.<String, Object>of("with_audio", "false"))) {
            var request = new AiTaskDtos.CreateAiTaskRequest(AiTaskTypes.VIDEO, "test", "channel-1::model-1", parameters,
                    List.of(), List.of(), AiTaskSources.VIDEO_PAGE, null, null, VideoGenerationMode.TEXT_TO_VIDEO, List.of());
            AiTaskDtos.CreateAiTaskRequest normalized = ReflectionTestUtils.invokeMethod(service, "normalizeVideoGenerationMode", request);
            Assertions.assertEquals(parameters.isEmpty(), normalized.parameters().get("generate_audio"));
        }
    }

    /** 未开启能力时应在创建任务和扣费前拒绝音频。 */
    @Test
    void shouldRejectAudioWithoutCapabilityBeforeCharging() {
        BusinessException error = Assertions.assertThrows(BusinessException.class, () -> service.createTask(audioRequest()).block());
        Assertions.assertTrue(error.getMessage().contains("未开启音频输入"));
        verify(repository, never()).createTask(any(AiGenerationTask.class));
        verify(creditService, never()).chargeTask(anyLong(), anyString(), org.mockito.ArgumentMatchers.anyInt(), anyString(), org.mockito.ArgumentMatchers.nullable(String.class));
    }

    /** 音频输入是否可用由模型配置能力决定，不依据适配器预置标记拒绝。 */
    @Test
    void shouldUseConfiguredCapabilityInsteadOfAdapterWhitelist() {
        configureAudioModel("openai");
        when(persistenceService.getMediaInfoForUser(7L, "audio:reference")).thenReturn(Mono.just(
                new PersistenceDtos.UploadedMediaResponse("audio:reference", "https://example.com/audio.mp3", 100L, "audio/mpeg", null, null, 5000, null)));
        Assertions.assertDoesNotThrow(() -> service.createTask(audioRequest()).block());
        verify(repository).createTask(any(AiGenerationTask.class));
        verify(creditService).chargeTask(anyLong(), anyString(), org.mockito.ArgumentMatchers.anyInt(), anyString(), org.mockito.ArgumentMatchers.nullable(String.class));
    }

    /** 非当前用户的音频不能提交给渠道，也不会扣费。 */
    @Test
    void shouldRejectUnownedAudioBeforeCharging() {
        configureAudioModel("minimax");
        when(persistenceService.getMediaInfoForUser(7L, "audio:reference")).thenReturn(Mono.empty());
        BusinessException error = Assertions.assertThrows(BusinessException.class, () -> service.createTask(audioRequest()).block());
        Assertions.assertTrue(error.getMessage().contains("不属于当前用户"));
        verify(repository, never()).createTask(any(AiGenerationTask.class));
        verify(creditService, never()).chargeTask(anyLong(), anyString(), org.mockito.ArgumentMatchers.anyInt(), anyString(), org.mockito.ArgumentMatchers.nullable(String.class));
    }

    /** Evolink 必须在音频以外提供视觉参考。 */
    @Test
    void shouldRejectEvolinkAudioWithoutVisualReference() {
        configureAudioModel("evolink");
        BusinessException error = Assertions.assertThrows(BusinessException.class, () -> service.createTask(audioRequest()).block());
        Assertions.assertTrue(error.getMessage().contains("同时提供图片或视频"));
        verify(repository, never()).createTask(any(AiGenerationTask.class));
    }

    /** 音频请求即便声明合法，服务端也必须检查保存的实际媒体类型。 */
    @Test
    void shouldRejectStoredAudioTypeMismatch() {
        configureAudioModel("minimax");
        when(persistenceService.getMediaInfoForUser(7L, "audio:reference")).thenReturn(Mono.just(
                new PersistenceDtos.UploadedMediaResponse("audio:reference", "https://example.com/file.mp4", 100L, "video/mp4", null, null, 4000, null)));
        Assertions.assertThrows(BusinessException.class, () -> service.createTask(audioRequest()).block());
        verify(repository, never()).createTask(any(AiGenerationTask.class));
    }

    /**
     * 为测试启用支持音频输入的全能参考模型。
     * @param format String 渠道格式
     */
    private void configureAudioModel(String format) {
        when(persistenceService.getPlatformAiChannels()).thenReturn(Mono.just(List.of(new AiTaskDtos.AiChannelConfig(
                "channel-1", "音频测试渠道", "https://example.com", "key", format, List.of("model-1")))));
        when(persistenceService.getPlatformModelConfigs()).thenReturn(Mono.just(List.of(new PersistenceDtos.ModelConfig(
                "model-config-2", "channel-1", "model-1", AiTaskTypes.VIDEO, List.of("reference-to-video", "audio-input"), true, 0, 0, true, "high", "generation", 1,
                new com.alibaba.fastjson2.JSONObject(), new VideoBillingConfiguration("generation", 3, Map.of("reference-to-video", Map.of("720p", 10))), null, null, false, null))));
    }

    /**
     * 创建仅含音频的全能参考请求。
     * @return CreateAiTaskRequest 请求数据
     */
    private AiTaskDtos.CreateAiTaskRequest audioRequest() {
        return new AiTaskDtos.CreateAiTaskRequest(AiTaskTypes.VIDEO, "参考音频1", "channel-1::model-1",
                Map.of("seconds", 5, "resolution", "720p"), List.of(), List.of(), AiTaskSources.VIDEO_PAGE, null, null, "reference-to-video",
                List.of(new AiTaskDtos.AiTaskMediaReference("audio-1", "配乐", "audio/mpeg", "audio:reference", "https://example.com/audio.mp3")));
    }

}
