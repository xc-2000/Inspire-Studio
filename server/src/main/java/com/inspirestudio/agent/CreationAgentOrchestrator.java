package com.inspirestudio.agent;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.agent.dto.*;
import com.inspirestudio.agent.workflow.VideoWorkflowContext;
import com.inspirestudio.agent.workflow.VideoWorkflowConversationTurn;
import com.inspirestudio.agent.workflow.VideoWorkflowDefinition;
import com.inspirestudio.agent.workflow.VideoWorkflowRegistry;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.ai.ImageEditIntent;
import com.inspirestudio.logging.MappedDiagnosticContext;
import com.inspirestudio.service.AiTaskService;
import com.inspirestudio.service.PersistenceService;
import com.inspirestudio.service.SkillService;
import com.inspirestudio.repository.AgentPlanRepository;
import com.inspirestudio.repository.VideoWorkflowContextRepository;
import com.inspirestudio.repository.CreationAgentRequestRepository;
import com.inspirestudio.entity.CreationAgentRequest;
import io.agentscope.core.ReActAgent;
import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.model.Model;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Map;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.util.StringUtils;
import reactor.core.Disposable;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Sinks;

/**
 * 图片、视频和画布入口的配置驱动主Agent编排器。
 *
 * @date     2026-07-23 00:00
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class CreationAgentOrchestrator {

    /** Agent会话服务 */
    private final AgentSessionService sessionService;
    /** Agent事件发射器 */
    private final AgentEventEmitter eventEmitter;
    /** Agent执行登记 */
    private final AgentExecutionRegistry executionRegistry;
    /** AgentScope模型工厂 */
    private final AgentScopeModelFactory modelFactory;
    /** 固定Agent工厂 */
    private final AgentScopeAgentFactory agentFactory;
    /** 计划校验器 */
    private final CreationPlanValidator planValidator;
    /** 计划执行器 */
    private final CreationPlanExecutor planExecutor;
    /** 计划仓储 */
    private final AgentPlanRepository planRepository;
    /** AI任务服务 */
    private final AiTaskService aiTaskService;
    /** 技能服务 */
    private final SkillService skillService;
    /** 持久化服务（对话生成记录） */
    private final PersistenceService persistenceService;
    /** Java固定注册的画布工具 */
    private final AgentToolRegistry toolRegistry;
    /** 画布快照裁剪器，避免完整快照原样发给大模型 */
    private final CanvasSnapshotCompactor canvasSnapshotCompactor;
    /** 主Agent请求持久化仓储 */
    private final CreationAgentRequestRepository requestRepository;
    /** 主Agent请求分区调度器 */
    private final CreationAgentRequestDispatcher requestDispatcher;
    /** 主Agent请求Redis队列 */
    private final CreationAgentRequestQueue requestQueue;
    /** 视频技能工作流注册表。 */
    private VideoWorkflowRegistry videoWorkflowRegistry;
    /** 视频技能工作流上下文仓储。 */
    private VideoWorkflowContextRepository videoWorkflowContextRepository;
    /** 本实例正在执行的请求上下文 */
    private final Map<String, ActiveRequestExecution> activeRequests = new ConcurrentHashMap<>();
    /** 已领取请求的可取消订阅，用于及时中断前端工具等待 */
    private final Map<String, Disposable> claimedRequestSubscriptions = new ConcurrentHashMap<>();
    /** 画布图片命令的原始用户提示词格式 */
    private static final Pattern CANVAS_IMAGE_COMMAND_PATTERN = Pattern.compile(
            "^(?:生成|创建|绘制|制作)\\s*(?:一张|一幅|一个)?\\s*(?:图片|图像)\\s*[：:]\\s*(.+)$",
            Pattern.DOTALL);
    /** 画布视频命令的原始用户提示词格式 */
    private static final Pattern CANVAS_VIDEO_COMMAND_PATTERN = Pattern.compile(
            "^(?:生成|创建|绘制|制作)\\s*(?:一个|一段)?\\s*视频\\s*[：:]\\s*(.+)$",
            Pattern.DOTALL);
    /** 从非结构化回复中识别中文引号包裹的候选项。 */
    private static final Pattern WORKFLOW_QUOTED_CHOICE_PATTERN = Pattern.compile(
            "[「『“\\\"]([^」』”\\\"]{1,30})[」』”\\\"]");
    /** 从非结构化回复中识别编号或短横线列表候选项。 */
    private static final Pattern WORKFLOW_LIST_CHOICE_PATTERN = Pattern.compile(
            "(?m)(?:^|[：:])\\s*(?:\\d+[、.．)]|[-*])\\s*([^\\n；;。！？]{1,30})");
    /** 从“选项：A、B、C”形式的回复中识别候选项。 */
    private static final Pattern WORKFLOW_INLINE_CHOICE_PATTERN = Pattern.compile(
            "(?:选项|方案|方式)\\s*[：:]\\s*([^\\n。！？]{1,100})");
    /** 首尾帧工作流常见运镜候选项，用于模型承诺提供选项但未输出列表时补全按钮。 */
    private static final List<String> FIRST_LAST_FRAME_CAMERA_CHOICES = List.of(
            "缓慢推进", "缓慢拉远", "平稳横移", "轻微环绕");
    /** 所有当前及未来图片、视频技能共用的参考素材约束。 */
    private static final String GLOBAL_REFERENCE_MEDIA_RULE = """
            【全局参考素材规则】
            1. attachmentCount 大于 0 表示用户已经上传参考素材。参考素材在整个技能多轮会话中持续有效，最终生成任务必须继续携带并使用。
            2. 不得把参考素材中的主体替换成无关人物、商品或示例内容；只修改用户明确要求的部分。
            3. 无法可靠识别素材内容时不得猜测，应让用户补充名称、卖点、场景或修改要求。
            4. 图片技能存在图片参考素材时，最终图片任务使用 action=edit；没有图片参考素材时才使用 action=generate。
            5. 视频技能必须把用户上传的图片、视频和音频继续传给最终任务，并按用户选择的工作流角色使用。
            """.strip();

    /**
     * 注入视频技能工作流注册表。
     *
     * @param registry VideoWorkflowRegistry 工作流注册表
     * @return void 无返回值
     */
    @Autowired
    void setVideoWorkflowRegistry(VideoWorkflowRegistry registry) {
        this.videoWorkflowRegistry = registry;
    }

    /**
     * 注入视频技能工作流上下文仓储。
     *
     * @param repository VideoWorkflowContextRepository 上下文仓储
     * @return void 无返回值
     */
    @Autowired
    void setVideoWorkflowContextRepository(VideoWorkflowContextRepository repository) {
        this.videoWorkflowContextRepository = repository;
    }

    /**
     * 判断请求是否应进入统一主Agent。
     *
     * @param entrySource String 入口来源
     * @return boolean 是否支持
     */
    public boolean supports(String entrySource) {
        return CreationEntrySource.supported(entrySource);
    }

    /**
     * 创建并排队一次主Agent对话，立即返回本次请求标识。
     *
     * @param userId Long 用户ID
     * @param request AgentChatRequest 对话请求
     * @return Mono<CreationAgentChatResponse> 会话、请求和状态
     */
    public Mono<CreationAgentChatResponse> startChat(Long userId, AgentChatRequest request) {
        validateRequest(request);
        return sessionService.getOrCreateSession(userId, request.sessionId(), request.entrySource())
                .flatMap(session -> {
                    if (!request.entrySource().equals(session.profile())) {
                        return Mono.error(new BusinessException(ErrorCode.PARAM_INVALID, "会话入口来源与当前页面不一致"));
                    }
                    AgentChatRequest snapshot = requestWithSessionId(request, session.id());
                    CreationAgentRequest queuedRequest = new CreationAgentRequest();
                    queuedRequest.setId(UUID.randomUUID().toString());
                    queuedRequest.setUserId(userId);
                    queuedRequest.setSessionId(session.id());
                    queuedRequest.setEntrySource(snapshot.entrySource());
                    queuedRequest.setRequestData(JSON.toJSONString(snapshot));
                    queuedRequest.setStatus("queued");
                    queuedRequest.setCreatedAt(OffsetDateTime.now());
                    return cancelSupersededQueuedRequests(userId, snapshot)
                            .then(ensureGenerationLogForRequest(userId, session.id(), snapshot))
                            .then(requestRepository.create(queuedRequest))
                            .then(Mono.fromRunnable(() -> eventEmitter.emit(userId,
                                    AgentEvent.queueStatus(session.id(), queuedRequest.getId(), "queued", "排队中"))))
                            .then(requestDispatcher.enqueue(queuedRequest))
                            .then(requestRepository.findStatusById(queuedRequest.getId())
                                    .defaultIfEmpty("queued")
                                    .map(status -> new CreationAgentChatResponse(session.id(), queuedRequest.getId(), status)));
                });
    }

    /**
     * 作废同一画布、同一设定图节点上仍在排队的旧请求。
     * <p>
     * 页面刷新后重复点击会为同一次设定图生成堆叠出多个排队请求，最终表现为长时间"排队中"。
     * 这里让新请求替换旧排队项：只处理 status=queued 的请求，已在执行的请求不做抢占。
     *
     * @param userId Long 用户ID
     * @param request AgentChatRequest 新提交的请求快照
     * @return Mono<Void> 作废完成信号
     */
    private Mono<Void> cancelSupersededQueuedRequests(Long userId, AgentChatRequest request) {
        String targetNodeId = request.settingGraphNodeId();
        if (!StringUtils.hasText(targetNodeId)) {
            return Mono.empty();
        }
        return requestRepository.listQueuedSettingGraphRequests(userId, request.entrySource(), targetNodeId)
                .concatMap(queued -> requestRepository.cancelQueuedIfQueued(userId, queued.getId(),
                                "同一设定图节点已提交新请求，旧请求不再执行")
                        .flatMap(canceled -> {
                            if (!Boolean.TRUE.equals(canceled)) {
                                return Mono.empty();
                            }
                            log.info("作废被新请求替换的排队设定图请求: userId={}, requestId={}, settingGraphNodeId={}",
                                    userId, queued.getId(), targetNodeId);
                            return requestQueue.removeQueuedRequest(userId, queued.getEntrySource(), queued.getId());
                        }))
                .then();
    }

    /**
     * 图片/视频入口发起对话时幂等创建对话生成记录，保证刷新后左侧会话列表可见。
     * <p>
     * 仅当会话尚无生成记录时初始化空记录；失败不阻断对话主流程。
     *
     * @param userId Long 用户ID
     * @param sessionId String Agent 会话ID
     * @param request AgentChatRequest 对话请求
     * @return Mono<Void> 完成信号
     */
    private Mono<Void> ensureGenerationLogForRequest(Long userId, String sessionId, AgentChatRequest request) {
        String logType = "videoPage".equals(request.entrySource()) ? "video" : "image";
        if (!"imagePage".equals(request.entrySource()) && !"videoPage".equals(request.entrySource())) {
            return Mono.empty();
        }
        String message = request.message() == null ? "" : request.message().trim();
        String title = StringUtils.hasText(message)
                ? (message.length() > 30 ? message.substring(0, 30) : message) : "新对话";
        return Mono.defer(() -> {
                    Mono<Void> save = persistenceService.ensureGenerationLog(userId, sessionId, logType, title);
                    return save == null ? Mono.empty() : save;
                })
                .onErrorResume(exception -> {
                    log.warn("创建对话生成记录失败: sessionId={}, 原因={}", sessionId, exception.getMessage());
                    return Mono.empty();
                });
    }

    /**
     * 将技能引导/澄清问答轮次写入生成记录，保证历史会话能看到完整对话过程。
     * <p>
     * 生成轮次由任务执行链路（AbstractTaskProfile）保存，这里只保存纯对话（无生成任务）轮次；
     * 仅在图片/视频入口生效，失败不阻断对话主流程。
     *
     * @param userId Long 用户ID
     * @param session AgentSession 会话
     * @param request AgentChatRequest 对话请求
     * @param reply String 助手澄清回复
     * @param choices List<AgentChoice> 该轮提供给用户的选项（历史记录只读展示，可为空）
     * @return Mono<Void> 完成信号
     */
    private Mono<Void> saveClarificationRound(Long userId, AgentSession session, AgentChatRequest request, String reply,
                                              List<AgentChoice> choices) {
        String logType = "videoPage".equals(request.entrySource()) ? "video" : "image";
        if (!"imagePage".equals(request.entrySource()) && !"videoPage".equals(request.entrySource())) {
            return Mono.empty();
        }
        String message = request.message() == null ? "" : request.message().trim();
        if (!StringUtils.hasText(message) && !StringUtils.hasText(reply)) {
            return Mono.empty();
        }
        return resolveSkillSnapshot(request)
                .flatMap(skill -> {
                    JSONObject round = new JSONObject();
                    round.put("id", UUID.randomUUID().toString());
                    round.put("prompt", message);
                    round.put("assistantText", reply == null ? "" : reply);
                    round.put("config", request.creationSettings() == null ? new JSONObject() : JSON.toJSON(request.creationSettings()));
                    // 图片/视频入口的轮次结构不同：图片用 results 数组，视频用 result 单数对象
                    if ("video".equals(logType)) {
                        round.put("result", new JSONObject());
                        Object workflowType = skill.get("workflowType");
                        if (workflowType instanceof String workflow && StringUtils.hasText(workflow)) {
                            round.put("workflowType", workflowType);
                            round.put("workflowStatus", "clarifying");
                        }
                    } else {
                        round.put("results", List.of());
                    }
                    round.put("references", attachmentReferences(request.attachments(), "image/"));
                    round.put("videoReferences", attachmentReferences(request.attachments(), "video/"));
                    if (!skill.isEmpty()) {
                        round.put("skill", skill);
                    }
                    if (choices != null && !choices.isEmpty()) {
                        round.put("choices", JSON.toJSON(choices));
                    }
                    round.put("createdAt", System.currentTimeMillis());
                    String title = StringUtils.hasText(message)
                            ? (message.length() > 30 ? message.substring(0, 30) : message) : "新对话";
                    Mono<Void> save = persistenceService.saveOrUpdateGenerationRound(userId, session.id(), logType, title, round);
                    return Mono.defer(() -> save == null ? Mono.empty() : save)
                            .onErrorResume(exception -> {
                                log.warn("保存澄清问答轮次失败: sessionId={}, 原因={}", session.id(), exception.getMessage());
                                return Mono.empty();
                            });
                });
    }

    /**
     * 将澄清轮次中的上传附件保存为可恢复的媒体引用。
     * 优先保存服务端存储键；从“最近上传”恢复的素材允许保存公开 HTTP(S) 地址，
     * 与实际任务执行器支持的引用类型保持一致。
     */
    private List<Map<String, Object>> attachmentReferences(List<AgentChatRequest.Attachment> attachments,
                                                           String mimeTypePrefix) {
        if (attachments == null || attachments.isEmpty()) {
            return List.of();
        }
        List<Map<String, Object>> references = new ArrayList<>();
        for (AgentChatRequest.Attachment attachment : attachments) {
            if (attachment == null || !hasUsableAttachmentLocation(attachment)
                    || !StringUtils.hasText(attachment.type())
                    || !attachment.type().startsWith(mimeTypePrefix)) {
                continue;
            }
            String storageKey = StringUtils.hasText(attachment.storageKey()) ? attachment.storageKey().trim() : "";
            String publicUrl = isPublicHttpUrl(attachment.url()) ? attachment.url().trim() : "";
            Map<String, Object> reference = new LinkedHashMap<>();
            reference.put("id", StringUtils.hasText(storageKey) ? storageKey : publicUrl);
            reference.put("name", attachment.name());
            reference.put("mimeType", attachment.type());
            if (StringUtils.hasText(storageKey)) {
                reference.put("storageKey", storageKey);
            }
            reference.put("image/".equals(mimeTypePrefix) ? "dataUrl" : "url", publicUrl);
            references.add(reference);
        }
        return references;
    }

    private boolean hasUsableAttachmentLocation(AgentChatRequest.Attachment attachment) {
        return attachment != null
                && (StringUtils.hasText(attachment.storageKey()) || isPublicHttpUrl(attachment.url()));
    }

    private boolean isPublicHttpUrl(String value) {
        return StringUtils.hasText(value) && value.trim().matches("(?i)^https?://.+");
    }

    /**
     * 为每个图片和视频技能动态补充通用参考素材规则。
     * 数据库迁移覆盖现有技能；此处保证管理员以后新增或重写的技能同样生效。
     */
    String withGlobalReferenceMediaRule(String targetType, String systemPrompt) {
        String prompt = systemPrompt == null ? "" : systemPrompt.trim();
        if (!("image".equals(targetType) || "video".equals(targetType))
                || prompt.contains("【全局参考素材规则】")) {
            return prompt;
        }
        return StringUtils.hasText(prompt)
                ? GLOBAL_REFERENCE_MEDIA_RULE + "\n\n" + prompt
                : GLOBAL_REFERENCE_MEDIA_RULE;
    }

    /**
     * 加载请求所选技能的快照（id/name/targetType），供对话轮次落库时展示。
     *
     * @param request AgentChatRequest 原始请求
     * @return Mono<Map<String, Object>> 技能快照或空Map
     */
    private Mono<Map<String, Object>> resolveSkillSnapshot(AgentChatRequest request) {
        if (request == null || !StringUtils.hasText(request.skillId())) {
            return Mono.just(readCanvasSettingGraphSnapshot(request));
        }
        Long skillId;
        try {
            skillId = Long.valueOf(request.skillId());
        } catch (NumberFormatException exception) {
            return Mono.just(readCanvasSettingGraphSnapshot(request));
        }
        return skillService.findEnabledSkill(skillId)
                .map(skill -> {
                    Map<String, Object> snapshot = new LinkedHashMap<>();
                    snapshot.put("id", skill.getId());
                    snapshot.put("name", skill.getName());
                    snapshot.put("targetType", skill.getTargetType());
                    snapshot.put("systemPrompt", withGlobalReferenceMediaRule(skill.getTargetType(), skill.getSystemPrompt()));
                    snapshot.put("aspectRatio", skill.getAspectRatio() == null ? "16:9" : skill.getAspectRatio());
                    if (CreationEntrySource.VIDEO_PAGE.equals(request.entrySource()) && videoWorkflowRegistry != null) {
                        videoWorkflowRegistry.resolveWorkflowType(skill.getSystemPrompt()).ifPresent(type -> snapshot.put("workflowType", type));
                    }
                    return snapshot;
                })
                .onErrorResume(exception -> {
                    log.warn("加载技能快照失败: skillId={}, 原因={}", request.skillId(), exception.getMessage());
                    return Mono.just(readCanvasSettingGraphSnapshot(request));
                });
    }

    /** 读取画布节点携带的设定图技能快照。 */
    private Map<String, Object> readCanvasSettingGraphSnapshot(AgentChatRequest request) {
        if (request == null || !CreationEntrySource.CANVAS.equals(request.entrySource()) || request.settingGraphSkillSnapshot() == null) {
            return Map.of();
        }
        Map<String, Object> snapshot = request.settingGraphSkillSnapshot();
        if (!"canvasSettingGraph".equals(String.valueOf(snapshot.get("targetType")))
                || !(snapshot.get("id") instanceof Number)
                || !StringUtils.hasText(String.valueOf(snapshot.get("name")))
                || !StringUtils.hasText(String.valueOf(snapshot.get("systemPrompt")))) {
            return Map.of();
        }
        String aspectRatio = String.valueOf(snapshot.getOrDefault("aspectRatio", "16:9")).trim();
        return Map.of("id", snapshot.get("id"), "name", snapshot.get("name"),
                "targetType", "canvasSettingGraph", "systemPrompt", snapshot.get("systemPrompt"),
                "aspectRatio", aspectRatio.isEmpty() || "null".equalsIgnoreCase(aspectRatio) ? "16:9" : aspectRatio);
    }

    /**
     * 判断会话是否存在本实例正在执行的主Agent请求。
     *
     * @param sessionId String 会话ID
     * @return boolean 是否活跃
     */
    public boolean isActive(String sessionId) {
        return activeRequests.values().stream().anyMatch(active -> active.sessionId().equals(sessionId));
    }

    /**
     * 按请求ID精确停止主Agent请求及其关联的生成任务。
     *
     * @param userId Long 用户ID
     * @param requestId String 主Agent请求ID
     * @return Mono<Void> 取消完成信号
     */
    public Mono<Void> cancelChat(Long userId, String requestId) {
        return requestRepository.findByIdForUser(userId, requestId)
                .switchIfEmpty(Mono.error(new BusinessException(ErrorCode.RESOURCE_NOT_FOUND, "主Agent请求不存在")))
                .flatMap(request -> cancelRequest(userId, request));
    }

    /**
     * 执行已由分区调度器领取的主Agent请求。
     *
     * @param requestId String 主Agent请求ID
     * @return Mono<Void> 请求执行完成信号
     */
    public Mono<Void> executeClaimedRequest(String requestId) {
        AtomicBoolean cleaned = new AtomicBoolean();
        Sinks.Empty<Void> stopSignal = Sinks.empty();
        Runnable cleanup = () -> {
            if (cleaned.compareAndSet(false, true)) {
                claimedRequestSubscriptions.remove(requestId);
                clearClaimedRequestExecution(requestId);
            }
        };
        Mono<Void> execution = requestRepository.findById(requestId)
                .flatMap(request -> requestRepository.markRunningIfQueued(requestId)
                        .filter(Boolean::booleanValue)
                        .flatMap(ignored -> executeRunningRequest(request)));
        // 通过完成信号终止外层订阅，确保调用方拿到的Disposable也同步进入已释放状态。
        return Mono.firstWithSignal(execution, stopSignal.asMono())
                .doOnSubscribe(subscription -> claimedRequestSubscriptions.put(requestId, new Disposable() {
                    private final AtomicBoolean disposed = new AtomicBoolean();

                    @Override
                    public void dispose() {
                        if (disposed.compareAndSet(false, true)) {
                            stopSignal.tryEmitEmpty();
                        }
                    }

                    @Override
                    public boolean isDisposed() {
                        return disposed.get();
                    }
                }))
                .doOnSuccess(ignored -> cleanup.run())
                .doOnError(exception -> cleanup.run())
                .doFinally(signal -> cleanup.run());
    }

    /**
     * 终止当前实例已领取的运行请求，不会影响其他请求。
     *
     * @param requestId String 主Agent请求ID
     * @return Mono<Void> 停止执行完成信号
     */
    public Mono<Void> stopClaimedExecution(String requestId) {
        ActiveRequestExecution active = activeRequests.get(requestId);
        if (active == null) {
            // 请求已被调度器领取但尚未建立执行上下文时，也必须终止订阅，触发调度器释放名额并补位。
            return Mono.<Void>fromRunnable(() -> {
                Disposable subscription = claimedRequestSubscriptions.get(requestId);
                if (subscription != null) {
                    subscription.dispose();
                }
            });
        }
        if (!active.cancellationHandled().compareAndSet(false, true)) {
            return Mono.empty();
        }
        AgentExecutionRegistry.AgentCancellation cancellation = executionRegistry.requestCancellation(active.userId(), active.sessionId());
        String planId = active.planId().get();
        return reactor.core.publisher.Flux.fromIterable(cancellation.tasks())
                .flatMap(task -> aiTaskService.cancelTaskForUser(active.userId(), task.taskId())
                        .onErrorResume(exception -> {
                            log.error("取消主Agent关联任务失败: requestId={}, taskId={}", requestId, task.taskId(), exception);
                            return Mono.empty();
                        }))
                .then(requestRepository.findById(requestId)
                        .flatMap(request -> completePlanForTerminalRequest(request, planId, "已停止生成")))
                .doFinally(signal -> executionRegistry.disposeWhenReady(active.sessionId()));
    }

    /**
     * 中断已失去活动租约的本实例请求，防止旧执行线程继续创建任务。
     *
     * @param requestId String 主Agent请求ID
     * @param message String 中断说明
     * @return Mono<Void> 中断收尾完成信号
     */
    public Mono<Void> interruptClaimedExecution(String requestId, String message) {
        return requestRepository.interruptRunningIfRunning(requestId, message)
                .flatMap(interrupted -> Boolean.TRUE.equals(interrupted)
                        ? requestQueue.markCancelRequested(requestId)
                                .then(requestRepository.findById(requestId))
                                .flatMap(request -> interruptPersistedRequest(request, message))
                        : Mono.empty());
    }

    /**
     * 执行主Agent规划、计划执行和结果汇总。
     *
     * @param userId Long 用户ID
     * @param session AgentSession 会话
     * @param request AgentChatRequest 对话请求
     * @param active ActiveRequestExecution 当前请求执行上下文
     * @return Mono<Void> 执行完成信号
     */
    private Mono<Void> executeConversation(Long userId, AgentSession session, AgentChatRequest request,
                                           ActiveRequestExecution active) {
        String userMessageId = UUID.randomUUID().toString();
        return isRequestCancellationRequested(active)
                .flatMap(canceled -> Boolean.TRUE.equals(canceled)
                        ? Mono.empty()
                        : sessionService.appendUserMessage(session.id(), userMessageId, request.message())
                                .then(isRequestCancellationRequested(active))
                                .flatMap(canceledAfterAppend -> Boolean.TRUE.equals(canceledAfterAppend)
                                        ? Mono.empty()
                                        : createAndExecutePlan(userId, session, request, active)));
    }

    /**
     * 调用主Agent创建计划并执行。
     *
     * @param userId Long 用户ID
     * @param session AgentSession 会话
     * @param request AgentChatRequest 原始请求
     * @param active ActiveRequestExecution 当前请求执行上下文
     * @return Mono<Void> 执行完成信号
     */
    private Mono<Void> createAndExecutePlan(Long userId, AgentSession session, AgentChatRequest request,
                                            ActiveRequestExecution active) {
        Mono<String> resolvedChoice = persistenceService != null && CreationEntrySource.IMAGE_PAGE.equals(request.entrySource())
                ? persistenceService.resolveImageEditChoice(userId, session.id(), request.message()) : Mono.empty();
        return (resolvedChoice == null ? Mono.<String>empty() : resolvedChoice).defaultIfEmpty(request.message())
                .flatMap(instruction -> createAndExecuteImageAwarePlan(userId, session,
                        new AgentChatRequest(request.sessionId(), request.entrySource(), instruction, request.canvasSnapshot(),
                                request.references(), request.attachments(), request.history(), request.creationSettings(),
                                request.skillId(), request.settingGraphNodeId(), request.settingGraphSkillSnapshot()), active));
    }

    private Mono<Void> createAndExecuteImageAwarePlan(Long userId, AgentSession session, AgentChatRequest request,
                                                     ActiveRequestExecution active) {
        String editInstruction = resolveBackgroundColorReply(session, request.message());
        if (CreationEntrySource.IMAGE_PAGE.equals(request.entrySource()) && !editInstruction.equals(request.message())) {
            return createAndExecutePlan(userId, session, new AgentChatRequest(request.sessionId(), request.entrySource(),
                    editInstruction, request.canvasSnapshot(), request.references(), request.attachments(), request.history(),
                    request.creationSettings(), request.skillId(), request.settingGraphNodeId(), request.settingGraphSkillSnapshot()), active);
        }
        if (persistenceService == null || !CreationEntrySource.IMAGE_PAGE.equals(request.entrySource())
                || !shouldRestoreImageEditReference(request.message())
                || (request.attachments() != null && !request.attachments().isEmpty())) {
            return createAndExecutePreparedPlan(userId, session, request, active);
        }
        // Resolve from this user's current conversation before planning, so both agents see the reference.
        return persistenceService.sessionImageEditReferences(userId, session.id())
                .filter(images -> !images.isEmpty())
                .map(images -> new AgentChatRequest(request.sessionId(), request.entrySource(), request.message(),
                        request.canvasSnapshot(), request.references(), images.stream().map(image -> new AgentChatRequest.Attachment(
                                image.getString("url"), "image/png", "当前会话原图", image.getString("storageKey"))).toList(),
                        request.history(), request.creationSettings(), request.skillId(), request.settingGraphNodeId(),
                        request.settingGraphSkillSnapshot()))
                .defaultIfEmpty(request)
                .flatMap(prepared -> createAndExecutePreparedPlan(userId, session, prepared, active));
    }

    CreationPlan buildExplicitImageEditPlan(AgentChatRequest request) {
        if (StringUtils.hasText(request.skillId()) || !CreationEntrySource.IMAGE_PAGE.equals(request.entrySource())
                || !(isExplicitImageEdit(request.message()) || isReferenceImageEditInstruction(request.message()))
                || ImageEditIntent.needsBackgroundTarget(request.message()) || request.attachments() == null
                || request.attachments().stream().noneMatch(a -> a.type() != null && a.type().startsWith("image/"))) return null;
        return new CreationPlan(null, "编辑图片", request.entrySource(), "根据本轮要求修改原图", "", false,
                request.creationSettings(), List.of(new CreationTask("image-edit", "image", "edit", request.message(),
                "current", List.of(), null, Map.of())), List.of());
    }

    CreationPlan buildImageEditClarificationPlan(AgentChatRequest request) {
        if (!CreationEntrySource.IMAGE_PAGE.equals(request.entrySource()) || StringUtils.hasText(request.skillId())
                || !ImageEditIntent.needsBackgroundTarget(request.message())) return null;
        boolean hasImage = request.attachments() != null && request.attachments().stream().anyMatch(attachment ->
                attachment != null && attachment.type() != null && attachment.type().startsWith("image/")
                        && hasUsableAttachmentLocation(attachment));
        String question = hasImage
                ? "想把背景换成什么？可以选择下面的效果，或直接描述目标场景、颜色。主体和未要求修改的内容保持不变。"
                : "请先上传要编辑的原图，并描述要换成什么背景。";
        List<AgentChoice> choices = hasImage ? List.of(
                new AgentChoice("纯白背景", "在原图上，将背景换成纯白色，保留主体和未要求修改的内容。", false, null),
                new AgentChoice("海边日落", "在原图上，将背景换成海边日落，保留主体和未要求修改的内容。", false, null),
                new AgentChoice("雪山风景", "在原图上，将背景换成白雪覆盖的群山，保留主体和未要求修改的内容。", false, null),
                new AgentChoice("城市夜景", "在原图上，将背景换成现代城市夜景，保留主体和未要求修改的内容。", false, null))
                : List.of(new AgentChoice("上传原图", "", false, "upload_image"));
        return new CreationPlan(null, "编辑图片", request.entrySource(), "确认背景修改要求", question, false,
                request.creationSettings(), List.of(), choices);
    }

    CreationPlan buildExplicitSingleImagePlan(AgentChatRequest request) {
        if (StringUtils.hasText(request.skillId())
                || !(CreationEntrySource.IMAGE_PAGE.equals(request.entrySource()) || CreationEntrySource.CANVAS.equals(request.entrySource()))
                || !StringUtils.hasText(request.message()) || !request.message().trim().matches("(?s)^(?:请)?生成\\s*(?:一|1)\\s*张.+")
                || request.creationSettings() == null || !Integer.valueOf(1).equals(request.creationSettings().count())
                || (request.attachments() != null && !request.attachments().isEmpty())
                || (request.references() != null && !request.references().isEmpty())) return null;
        boolean canvas = CreationEntrySource.CANVAS.equals(request.entrySource());
        if (canvas && !StringUtils.hasText(request.creationSettings().size())) return null;
        Map<String, Object> arguments = canvas
                ? Map.of("prompt", request.message(), "size", request.creationSettings().size(), "count", 1) : Map.of();
        return new CreationPlan(null, "生成图片", request.entrySource(), "生成一张图片", "", false,
                request.creationSettings(), List.of(new CreationTask("image-generate", "image", "generate", request.message(),
                "current", List.of(), canvas ? "canvas_generate_image" : null, arguments)), List.of());
    }

    /**
     * 普通视频页请求直接构造可信单任务计划。
     * <p>
     * 仅无技能请求使用快捷计划。选中技能时必须先由主Agent读取完整技能并处理澄清/确认，
     * 执行器再应用技能正文生成最终提示词。参考素材和生成参数始终由请求设置约束。
     */
    CreationPlan buildDirectVideoPlan(AgentChatRequest request) {
        if (StringUtils.hasText(request.skillId()) || !CreationEntrySource.VIDEO_PAGE.equals(request.entrySource())
                || !StringUtils.hasText(request.message())) {
            return null;
        }
        return new CreationPlan(null, "生成视频", request.entrySource(), "按当前视频设置生成", "", false,
                request.creationSettings(), List.of(new CreationTask("video-generate", "video", "generate",
                request.message(), "current", List.of(), null, Map.of())), List.of());
    }

    String resolveBackgroundColorReply(AgentSession session, String message) {
        if (!StringUtils.hasText(message)) return message;
        String color = Map.of("pink", "粉色", "green", "绿色", "blue", "蓝色", "white", "白色", "dark", "深色",
                "粉色", "粉色", "绿色", "绿色", "蓝色", "蓝色", "白色", "白色", "深色", "深色")
                .get(message.trim().toLowerCase(java.util.Locale.ROOT));
        if (color == null || session.messages() == null) return message;
        String lastAssistant = session.messages().stream().filter(item -> "assistant".equals(item.role()))
                .map(item -> item.text() == null ? "" : item.text()).reduce((left, right) -> right).orElse("");
        if (!lastAssistant.contains("背景") || !lastAssistant.contains("颜色")
                || !(lastAssistant.contains("？") || lastAssistant.contains("?"))) return message;
        return "在原图上，将背景颜色换成" + color + "，其他内容保持不变。";
    }

    private boolean isExplicitImageEdit(String message) {
        return StringUtils.hasText(message)
                && message.matches("(?s).*(在原有|在原图|在这张|在上图|基于原图|修改这张|修改原图).*")
                && message.matches("(?s).*(增加|添加|修改|替换|改成|改为|换成|去掉|移除).*");
    }

    boolean shouldRestoreImageEditReference(String message) {
        if (!StringUtils.hasText(message) || message.trim().matches("(?is)^(?:(?:请|帮我|给我)\\s*)?(?:生成|绘制|创建|新建|create|generate).*")) return false;
        return isExplicitImageEdit(message) || isReferenceImageEditInstruction(message)
                || ImageEditIntent.needsBackgroundTarget(message);
    }

    private boolean isReferenceImageEditInstruction(String message) {
        if (!StringUtils.hasText(message)) return false;
        String normalized = message.replaceAll("[\\s，。！？!?,、:：]+", "");
        return List.of("增加", "添加", "修改", "替换", "改成", "改为", "换成", "换个", "去掉", "移除",
                "删除", "加上", "补上", "保留", "调整", "变成", "添加男", "添加女")
                .stream().anyMatch(normalized::contains);
    }

    private Mono<Void> createAndExecutePreparedPlan(Long userId, AgentSession session, AgentChatRequest request,
                                            ActiveRequestExecution active) {
        CreationPlan backgroundClarification = buildImageEditClarificationPlan(request);
        if (backgroundClarification != null) {
            return isRequestCancellationRequested(active).flatMap(canceled -> Boolean.TRUE.equals(canceled) ? Mono.empty()
                    : saveClarificationRound(userId, session, request, backgroundClarification.clarificationQuestion(), backgroundClarification.choices())
                            .then(completeWithMessage(userId, session.id(), backgroundClarification.clarificationQuestion(),
                                    AgentAction.choice(backgroundClarification.choices()))));
        }
        return isRequestCancellationRequested(active)
                .flatMap(canceled -> Boolean.TRUE.equals(canceled) ? Mono.empty() : modelFactory.defaultTextModel(userId)
                .flatMap(model -> resolveVideoWorkflowPlan(userId, session, request, model)
                                .map(candidate -> validateCandidatePlan(candidate, request))
                                .switchIfEmpty(Mono.justOrEmpty(buildStyleFollowUpPlan(session, request))
                                .map(candidate -> validateCandidatePlan(candidate, request))
                                .switchIfEmpty(Mono.justOrEmpty(buildSettingGraphPlan(request))
                                        .map(candidate -> validateCandidatePlan(candidate, request)))
                                .switchIfEmpty(Mono.justOrEmpty(buildExplicitImageEditPlan(request))
                                        .map(candidate -> validateCandidatePlan(candidate, request)))
                                .switchIfEmpty(Mono.justOrEmpty(buildExplicitSingleImagePlan(request))
                                        .map(candidate -> validateCandidatePlan(candidate, request)))
                                .switchIfEmpty(Mono.justOrEmpty(buildDirectVideoPlan(request))
                                        .map(candidate -> validateCandidatePlan(candidate, request)))
                                .switchIfEmpty(Mono.justOrEmpty(buildCanvasOverviewPlan(request))
                                        .map(candidate -> validateCandidatePlan(candidate, request))
                                .switchIfEmpty(Mono.defer(() -> callMainAgent(userId, session, request, model)
                                        .map(candidate -> resolveTaskPromptSources(candidate, session, request.message(), request.entrySource()))
                                        .map(candidate -> validateCandidatePlan(candidate, request))))))
                        .flatMap(validated -> isRequestCancellationRequested(active).flatMap(canceledAfterPlanning -> {
                            if (Boolean.TRUE.equals(canceledAfterPlanning)) {
                                return Mono.empty();
                            }
                            if (StringUtils.hasText(validated.clarificationQuestion())) {
                                AgentAction action;
                                if (validated.choices() != null && !validated.choices().isEmpty()) {
                                    action = AgentAction.choice(validated.choices());
                                } else if (Boolean.TRUE.equals(validated.canvasGuidance())) {
                                    action = AgentAction.navigateToCanvas(request.message());
                                } else {
                                    action = null;
                                }
                                String clarification = validated.clarificationQuestion();
                                return saveClarificationRound(userId, session, request, clarification, validated.choices())
                                        .then(completeWithMessage(userId, session.id(), clarification, action));
                            }
                            CreationPlan plan = composeFollowUpPrompts(withServerPlanId(validated, session, request.message()),
                                    session, request.message());
                            active.planId().set(plan.planId());
                            return planRepository.create(userId, session.id(), plan)
                                    .then(requestRepository.updatePlanId(active.requestId(), plan.planId()))
                                    .then(isRequestCancellationRequested(active))
                                    .flatMap(canceledAfterPlanCreation -> Boolean.TRUE.equals(canceledAfterPlanCreation)
                                            ? requestRepository.findById(active.requestId())
                                                    .flatMap(current -> completePlanForTerminalRequest(current, plan.planId(), "已停止生成"))
                                            : Mono.fromRunnable(() -> eventEmitter.emit(userId,
                                                            AgentEvent.planCreated(session.id(), plan.planId(), plan.summary(), plan.tasks().size())))
                                                    .then(planExecutor.execute(userId, session.id(), plan, request, model)
                                                            .contextWrite(context -> MappedDiagnosticContext.put(
                                                                    context, MappedDiagnosticContext.PLAN_ID, plan.planId())))
                                                            .flatMap(summary -> {
                                                                active.setCompletion(summary.status(), summary.message());
                                                                return isWorkflowImageStagePlan(plan)
                                                                        ? completeImageStageWithConfirmation(userId, session, request, plan, summary)
                                                                        : completeWithMessage(userId, session.id(), summary.message());
                                                            }));
                        }))));
    }

    /** The overview shortcut reads only the submitted canvas snapshot and never schedules tools. */
    CreationPlan buildCanvasOverviewPlan(AgentChatRequest request) {
        if (request == null || !CreationEntrySource.CANVAS.equals(request.entrySource())
                || !CanvasOverviewFormatter.matches(request.message())) {
            return null;
        }
        String answer = CanvasOverviewFormatter.format(request.canvasSnapshot());
        return new CreationPlan(null, "整理当前画布", CreationEntrySource.CANVAS,
                "画布概况与下一步建议", answer, false, request.creationSettings(), List.of(), List.of());
    }

    /**
     * 使用当前请求设置校验计划，并在澄清恢复场景下保留上下文中的原始设置。
     *
     * @param candidate CreationPlan 待校验计划
     * @param request AgentChatRequest 当前请求
     * @return CreationPlan 校验后的计划
     */
    private CreationPlan validateCandidatePlan(CreationPlan candidate, AgentChatRequest request) {
        CreationSettings settings = candidate != null && CreationEntrySource.VIDEO_PAGE.equals(request.entrySource())
                && videoWorkflowRegistry != null && StringUtils.hasText(candidate.workflowType())
                && videoWorkflowRegistry.isRegistered(candidate.workflowType())
                ? candidate.creationSettings()
                : request != null && request.creationSettings() != null
                ? request.creationSettings() : candidate == null ? null : candidate.creationSettings();
        CreationPlan validated = planValidator.validate(candidate, request.entrySource(), settings);
        return bindReferenceImageToEditTask(validated, request);
    }

    /**
     * 任意图片技能携带参考图时必须执行图片编辑，确保模型实际接收并保留参考主体。
     * 主Agent偶尔会把带参考图的任务标记为 generate，这里按可执行请求附件确定性纠正。
     */
    CreationPlan bindReferenceImageToEditTask(CreationPlan plan, AgentChatRequest request) {
        if (plan == null || request == null || !CreationEntrySource.IMAGE_PAGE.equals(request.entrySource())
                || request.attachments() == null
                || request.attachments().stream().noneMatch(attachment -> attachment != null
                && hasUsableAttachmentLocation(attachment)
                && StringUtils.hasText(attachment.type()) && attachment.type().startsWith("image/"))
                || plan.tasks() == null || plan.tasks().isEmpty()) {
            return plan;
        }
        List<CreationTask> tasks = plan.tasks().stream().map(task -> {
            if (task == null || !"image".equals(task.taskType()) || !"generate".equals(task.action())) {
                return task;
            }
            return new CreationTask(task.taskId(), task.taskType(), "edit", task.prompt(), task.sourcePromptId(),
                    task.dependsOn(), task.toolName(), task.toolArguments(), task.taskRole());
        }).toList();
        return new CreationPlan(plan.planId(), plan.intent(), plan.entrySource(), plan.summary(),
                plan.clarificationQuestion(), plan.canvasGuidance(), plan.creationSettings(), tasks,
                plan.choices(), plan.workflowType());
    }

    /**
     * 识别或恢复视频技能工作流。
     * <p>
     * 已存在澄清上下文时优先恢复，通过工作流对话助手多轮理解意图并起草提示词，
     * 用户确认草案后才构建执行计划，避免中途回复被解释为普通视频请求。
     *
     * @param userId Long 用户ID
     * @param session AgentSession 当前会话
     * @param request AgentChatRequest 当前请求
     * @param model Model 默认文本模型
     * @return Mono<CreationPlan> 工作流计划；未选择工作流时为空
     */
    private Mono<CreationPlan> resolveVideoWorkflowPlan(Long userId, AgentSession session, AgentChatRequest request, Model model) {
        if (!CreationEntrySource.VIDEO_PAGE.equals(request.entrySource()) || videoWorkflowRegistry == null
                || videoWorkflowContextRepository == null) {
            return Mono.empty();
        }
        return videoWorkflowContextRepository.findImagePendingConfirmByUserAndSession(userId, session.id())
                .filter(context -> videoWorkflowRegistry.isRegistered(context.workflowType()))
                .flatMap(context -> handleWorkflowImageConfirmTurn(userId, session, request, model, context))
                .switchIfEmpty(Mono.defer(() -> videoWorkflowContextRepository.findPendingConfirmByUserAndSession(userId, session.id())
                        .filter(context -> videoWorkflowRegistry.isRegistered(context.workflowType()))
                        .flatMap(context -> handleWorkflowDraftTurn(userId, session, request, model, context))
                        .switchIfEmpty(Mono.defer(() -> videoWorkflowContextRepository.findClarifyingByUserAndSession(userId, session.id())
                                .filter(context -> videoWorkflowRegistry.isRegistered(context.workflowType()))
                                .flatMap(context -> handleWorkflowClarifyingTurn(userId, session, request, model, context))
                                .switchIfEmpty(Mono.defer(() -> startWorkflowConversation(userId, session, request, model)))))));
    }

    /**
     * 处理图片待确认阶段的用户回复。
     * <p>用户确认使用已生成图片时构建视频阶段计划；用户要求修改提示词时回到澄清阶段重新起草。
     *
     * @param userId Long 用户ID
     * @param session AgentSession 当前会话
     * @param request AgentChatRequest 当前请求
     * @param model Model 默认文本模型
     * @param context VideoWorkflowContext 图片待确认的工作流上下文
     * @return Mono<CreationPlan> 视频阶段计划或澄清计划
     */
    private Mono<CreationPlan> handleWorkflowImageConfirmTurn(Long userId, AgentSession session, AgentChatRequest request,
                                                              Model model, VideoWorkflowContext context) {
        VideoWorkflowDefinition definition = videoWorkflowRegistry.require(context.workflowType());
        String message = request.message() == null ? "" : request.message().trim();
        // 用户确认使用已生成图片生成视频
        if ("用这些图片生成视频".equals(message) || "确认生成".equals(message)) {
            return videoWorkflowContextRepository.confirmGeneratedImages(context)
                    .switchIfEmpty(Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR,
                            "视频工作流图片确认状态已变化，请重新发送")))
                    // 图片确认轮用户可能调整了视频比例/清晰度/时长，用最新设置构建视频阶段计划
                    .map(confirmed -> request.creationSettings() != null
                            ? definition.buildVideoStagePlan(confirmed.withCreationSettings(request.creationSettings()))
                            : definition.buildVideoStagePlan(confirmed));
        }
        // 用户要求修改提示词：回到澄清阶段，由对话助手重新起草
        return videoWorkflowContextRepository.reopenImages(context)
                .switchIfEmpty(Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR,
                        "视频工作流状态已变化，请重新发送")))
                .flatMap(reopened -> handleWorkflowClarifyingTurn(userId, session, request, model, reopened));
    }

    /**
     * 判断计划是否为工作流图片阶段计划（仅图片任务且工作流支持图片二次确认）。
     *
     * @param plan CreationPlan 创作计划
     * @return boolean 是否图片阶段计划
     */
    private boolean isWorkflowImageStagePlan(CreationPlan plan) {
        if (plan == null || !StringUtils.hasText(plan.workflowType()) || videoWorkflowRegistry == null
                || plan.tasks() == null || plan.tasks().isEmpty()) {
            return false;
        }
        VideoWorkflowDefinition definition;
        try {
            definition = videoWorkflowRegistry.require(plan.workflowType());
        } catch (BusinessException exception) {
            return false;
        }
        return definition.supportsImageConfirmation()
                && plan.tasks().stream().allMatch(task -> "image".equals(task.taskType()));
    }

    /**
     * 图片阶段计划执行完成后收尾：保存首帧/尾帧图片到工作流上下文并推送图片确认询问。
     * <p>
     * 仅当图片阶段全部成功时保存图片结果并推进上下文到图片待确认状态；
     * 阶段失败时直接推送失败消息，由用户决定下一步。
     *
     * @param userId Long 用户ID
     * @param session AgentSession 当前会话
     * @param request AgentChatRequest 原始请求
     * @param plan CreationPlan 图片阶段计划
     * @param summary CreationPlanExecutor.PlanExecutionSummary 计划汇总
     * @return Mono<Void> 完成信号
     */
    private Mono<Void> completeImageStageWithConfirmation(Long userId, AgentSession session, AgentChatRequest request,
                                                          CreationPlan plan,
                                                          CreationPlanExecutor.PlanExecutionSummary summary) {
        if (!"success".equals(summary.status())) {
            return completeWithMessage(userId, session.id(), summary.message());
        }
        return saveImageStageResults(userId, session.id(), plan, summary)
                .then(saveImageConfirmationRound(userId, session, request, plan))
                .then(completeWithMessage(userId, session.id(),
                        "首帧和尾帧图片已生成，请确认是否用这些图片生成视频，或修改提示词重新生成。",
                        AgentAction.choice(List.of(
                                new AgentChoice("用这些图片生成视频", "用这些图片生成视频", null, null),
                                new AgentChoice("修改提示词重新生成", "修改提示词重新生成", null, null)))));
    }

    /**
     * 从图片阶段执行结果提取首帧/尾帧图片并保存到工作流上下文（推进到图片待确认状态）。
     *
     * @param userId Long 用户ID
     * @param sessionId String 会话ID
     * @param plan CreationPlan 图片阶段计划
     * @param summary CreationPlanExecutor.PlanExecutionSummary 计划汇总
     * @return Mono<Void> 保存完成信号
     */
    private Mono<Void> saveImageStageResults(Long userId, String sessionId, CreationPlan plan,
                                             CreationPlanExecutor.PlanExecutionSummary summary) {
        if (videoWorkflowContextRepository == null) {
            return Mono.empty();
        }
        Map<String, Object> images = new LinkedHashMap<>();
        for (CreationPlanExecutor.TaskExecutionResult result : summary.tasks()) {
            if (result == null || !"success".equals(result.status()) || result.data() == null) {
                continue;
            }
            String role = plan.tasks().stream()
                    .filter(task -> task.taskId().equals(result.taskId()))
                    .map(CreationTask::taskRole).filter(StringUtils::hasText).findFirst().orElse(null);
            if (!StringUtils.hasText(role) || images.containsKey(role)) {
                continue;
            }
            List<JSONObject> media = CreationPlanExecutor.mediaItems(result.data());
            if (media.isEmpty()) {
                continue;
            }
            JSONObject first = media.get(0);
            JSONObject image = new JSONObject();
            image.put("url", first.getString("url"));
            String storageKey = first.getString("storageKey");
            if (!StringUtils.hasText(storageKey)) storageKey = first.getString("key");
            image.put("storageKey", storageKey);
            image.put("mimeType", first.getString("mimeType"));
            images.put(role, image);
        }
        if (images.isEmpty()) {
            return Mono.empty();
        }
        return videoWorkflowContextRepository.findLatestByUserAndSession(userId, sessionId)
                .flatMap(context -> videoWorkflowContextRepository.saveGeneratedImages(context, images))
                .then();
    }

    /**
     * 保存图片确认询问轮次到生成记录，保证刷新/切换会话后历史区可见。
     *
     * @param userId Long 用户ID
     * @param session AgentSession 当前会话
     * @param request AgentChatRequest 原始请求
     * @param plan CreationPlan 图片阶段计划
     * @return Mono<Void> 保存完成信号
     */
    private Mono<Void> saveImageConfirmationRound(Long userId, AgentSession session, AgentChatRequest request,
                                                  CreationPlan plan) {
        if (persistenceService == null) {
            return Mono.empty();
        }
        Mono<VideoWorkflowContext> contextMono = videoWorkflowContextRepository == null
                ? Mono.justOrEmpty((VideoWorkflowContext) null)
                : videoWorkflowContextRepository.findLatestByUserAndSession(userId, session.id());
        return contextMono.flatMap(context -> Mono.justOrEmpty(context.draftedPrompts())).defaultIfEmpty(Map.of()).flatMap(draftedPrompts -> {
            JSONObject round = new JSONObject();
            round.put("id", UUID.randomUUID().toString());
            round.put("prompt", request.message());
            round.put("assistantText", "首帧和尾帧图片已生成，请确认是否用这些图片生成视频，或修改提示词重新生成。");
            round.put("config", JSON.toJSON(plan.creationSettings()));
            round.put("workflowType", plan.workflowType());
            round.put("workflowStatus", "image_pending_confirm");
            if (!draftedPrompts.isEmpty()) round.put("draftedPrompts", JSON.toJSON(draftedPrompts));
            round.put("references", List.of());
            round.put("videoReferences", List.of());
            round.put("result", new JSONObject());
            round.put("choices", JSON.toJSON(List.of(
                    new AgentChoice("用这些图片生成视频", "用这些图片生成视频", null, null),
                    new AgentChoice("修改提示词重新生成", "修改提示词重新生成", null, null))));
            round.put("createdAt", System.currentTimeMillis());
            String title = StringUtils.hasText(request.message())
                    ? (request.message().length() > 30 ? request.message().substring(0, 30) : request.message()) : "新对话";
            Mono<Void> save = persistenceService.saveOrUpdateGenerationRound(userId, session.id(), "video", title, round);
            return save == null ? Mono.empty() : save;
        }).onErrorResume(exception -> {
            log.warn("保存图片确认轮次失败: sessionId={}, 原因={}", session.id(), exception.getMessage());
            return Mono.empty();
        });
    }

    /**
     * 处理提示词草案待确认阶段的用户回复。
     * <p>用户确认后从草案构建执行计划；用户要求修改时重新起草；其余回复维持待确认状态继续对话。
     *
     * @param userId Long 用户ID
     * @param session AgentSession 当前会话
     * @param request AgentChatRequest 当前请求
     * @param model Model 默认文本模型
     * @param context VideoWorkflowContext 待确认的工作流上下文
     * @return Mono<CreationPlan> 工作流计划或澄清计划
     */
    private Mono<CreationPlan> handleWorkflowDraftTurn(Long userId, AgentSession session, AgentChatRequest request,
                                                       Model model, VideoWorkflowContext context) {
        VideoWorkflowDefinition definition = videoWorkflowRegistry.require(context.workflowType());
        return callWorkflowConversationAgent(userId, session, request, model, definition, context, "pending_confirm")
                .flatMap(turn -> {
                    if (turn.isConfirm() && context.hasDraftedPrompts()) {
                        // 确认草案：推进到已规划状态；两阶段工作流执行图片阶段计划，一次性工作流执行完整计划。
                        // 用户确认草案时可能已在卡片调整图片模型/比例/清晰度/画质，先合并最新请求设置，
                        // 否则图片阶段会沿用上下文初始默认值（如 1:1/2K），用户选择不生效。
                        VideoWorkflowContext withSettings = request.creationSettings() != null
                                ? context.withCreationSettings(request.creationSettings())
                                : context;
                        return videoWorkflowContextRepository.confirmDrafts(withSettings)
                                .switchIfEmpty(Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR,
                                        "视频工作流确认状态已变化，请重新发送")))
                                .map(confirmed -> definition.supportsImageConfirmation()
                                        ? definition.buildImageStagePlan(confirmed)
                                        : definition.buildPlan(confirmed));
                    }
                    if (turn.isDraft() && definition.isDraftComplete(turn.prompts())) {
                        VideoWorkflowContext withSettings = request.creationSettings() != null
                                ? context.withAnswer(request.message()).withCreationSettings(request.creationSettings())
                                : context.withAnswer(request.message());
                        return videoWorkflowContextRepository.saveDrafts(withSettings, turn.prompts())
                                .switchIfEmpty(Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR,
                                        "视频工作流状态已变化，请重新发送")))
                                .map(updated -> workflowClarificationPlan(updated, definition,
                                        definition.draftDisplayMessage(turn.message(), updated.draftedPrompts()), turn.choices()));
                    }
                    return Mono.just(workflowClarificationPlan(context, definition, turn.message(), turn.choices()));
                });
    }

    /**
     * 处理意图澄清阶段的用户回复。
     *
     * @param userId Long 用户ID
     * @param session AgentSession 当前会话
     * @param request AgentChatRequest 当前请求
     * @param model Model 默认文本模型
     * @param context VideoWorkflowContext 澄清中的工作流上下文
     * @return Mono<CreationPlan> 澄清计划或待确认草案计划
     */
    private Mono<CreationPlan> handleWorkflowClarifyingTurn(Long userId, AgentSession session, AgentChatRequest request,
                                                            Model model, VideoWorkflowContext context) {
        VideoWorkflowDefinition definition = videoWorkflowRegistry.require(context.workflowType());
        return callWorkflowConversationAgent(userId, session, request, model, definition, context, "clarifying")
                .flatMap(turn -> turn.isDraft() && definition.isDraftComplete(turn.prompts())
                        ? videoWorkflowContextRepository.saveDrafts(request.creationSettings() != null
                                ? context.withAnswer(request.message()).withCreationSettings(request.creationSettings())
                                : context.withAnswer(request.message()), turn.prompts())
                                .switchIfEmpty(Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR,
                                        "视频工作流状态已变化，请重新发送")))
                                .map(updated -> workflowClarificationPlan(updated, definition,
                                        definition.draftDisplayMessage(turn.message(), updated.draftedPrompts()), turn.choices()))
                        : Mono.just(workflowClarificationPlan(context, definition, turn.message(), turn.choices())));
    }

    /**
     * 根据本轮选择的技能创建工作流上下文并开始多轮意图对话。
     *
     * @param userId Long 用户ID
     * @param session AgentSession 当前会话
     * @param request AgentChatRequest 当前请求
     * @param model Model 默认文本模型
     * @return Mono<CreationPlan> 首轮对话计划；非工作流技能时为空
     */
    private Mono<CreationPlan> startWorkflowConversation(Long userId, AgentSession session, AgentChatRequest request, Model model) {
        if (!StringUtils.hasText(request.skillId())) return Mono.empty();
        Long skillId;
        try {
            skillId = Long.valueOf(request.skillId());
        } catch (NumberFormatException exception) {
            return Mono.error(new BusinessException(ErrorCode.PARAM_INVALID, "技能ID不合法"));
        }
        return skillService.findEnabledSkill(skillId).flatMap(skill -> {
            if (!"video".equals(skill.getTargetType())) {
                return Mono.error(new BusinessException(ErrorCode.PARAM_INVALID, "当前技能不支持视频生成页面"));
            }
            return Mono.justOrEmpty(videoWorkflowRegistry.resolveWorkflowType(skill.getSystemPrompt())
                    .map(workflowType -> {
                        VideoWorkflowDefinition definition = videoWorkflowRegistry.require(workflowType);
                        Map<String, Object> skillSnapshot = new LinkedHashMap<>();
                        skillSnapshot.put("id", skill.getId());
                        skillSnapshot.put("name", skill.getName());
                        skillSnapshot.put("targetType", skill.getTargetType());
                        skillSnapshot.put("systemPrompt", withGlobalReferenceMediaRule(skill.getTargetType(), skill.getSystemPrompt()));
                        skillSnapshot.put("workflowType", workflowType);
                        VideoWorkflowContext context = new VideoWorkflowContext(UUID.randomUUID().toString(), workflowType,
                                skillSnapshot, request.message(), definition.clarificationQuestion(), List.of(), Map.of(),
                                Map.of(), request.creationSettings(), "clarifying", 1);
                        return context;
                    }))
                    .flatMap(context -> videoWorkflowContextRepository.create(userId, session.id(), context)
                            .then(callWorkflowConversationAgent(userId, session, request, model,
                                    videoWorkflowRegistry.require(context.workflowType()), context, "clarifying"))
                            .flatMap(turn -> {
                                VideoWorkflowDefinition definition = videoWorkflowRegistry.require(context.workflowType());
                                if (turn.isDraft() && definition.isDraftComplete(turn.prompts())) {
                                    return videoWorkflowContextRepository.saveDrafts(context, turn.prompts())
                                            .map(updated -> workflowClarificationPlan(updated, definition,
                                                    definition.draftDisplayMessage(turn.message(), updated.draftedPrompts()), turn.choices()));
                                }
                                return Mono.just(workflowClarificationPlan(context, definition, turn.message(), turn.choices()));
                            }));
        });
    }

    /**
     * 调用工作流对话助手，多轮理解意图并起草阶段提示词。
     *
     * @param userId Long 用户ID
     * @param session AgentSession 当前会话
     * @param request AgentChatRequest 当前请求
     * @param model Model 默认文本模型
     * @param definition VideoWorkflowDefinition 工作流定义
     * @param context VideoWorkflowContext 工作流上下文
     * @param phase String 当前对话阶段：clarifying意图澄清、pending_confirm草案待确认
     * @return Mono<VideoWorkflowConversationTurn> 对话助手结构化结果
     */
    private Mono<VideoWorkflowConversationTurn> callWorkflowConversationAgent(Long userId, AgentSession session,
                                                                              AgentChatRequest request, Model model,
                                                                              VideoWorkflowDefinition definition,
                                                                              VideoWorkflowContext context, String phase) {
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("workflowType", context.workflowType());
        input.put("phase", phase);
        input.put("originalRequest", context.originalRequest());
        input.put("collectedAnswers", context.answers() == null ? List.of() : context.answers());
        if (context.hasDraftedPrompts()) {
            input.put("draftedPrompts", context.draftedPrompts());
        }
        input.put("history", historyForAgent(request, session));
        input.put("message", request.message());
        ReActAgent agent = agentFactory.workflowConversationAgent(model, workflowConversationPrompt(definition, context));
        return agent.call(JSON.toJSONString(input), VideoWorkflowConversationTurn.class, RuntimeContext.builder()
                        .sessionId(session.id() + ":workflow")
                        .userId(String.valueOf(userId))
                        .put(AgentThinkingEventMiddleware.ThinkingEventContext.class,
                                new AgentThinkingEventMiddleware.ThinkingEventContext(userId, session.id()))
                        .build())
                .timeout(Duration.ofSeconds(60))
                .map(message -> parseWorkflowConversationTurn(message, definition.clarificationQuestion()))
                .doFinally(signal -> agent.close());
    }

    /**
     * 组装工作流对话助手系统提示词：服务端固定契约 + 技能正文自定义要求（剔除工作流标识行）。
     *
     * @param definition VideoWorkflowDefinition 工作流定义
     * @param context VideoWorkflowContext 工作流上下文
     * @return String 对话助手系统提示词
     */
    private String workflowConversationPrompt(VideoWorkflowDefinition definition, VideoWorkflowContext context) {
        Object skillPrompt = context.skillSnapshot() == null ? null : context.skillSnapshot().get("systemPrompt");
        String skillBody = skillPrompt instanceof String text && StringUtils.hasText(text)
                ? text.replaceAll("(?m)^\\s*workflow\\s*:.*$", "").trim() : "";
        String prompt = StringUtils.hasText(skillBody)
                ? definition.conversationSystemPrompt() + "\n\n技能自定义要求（不得改变上方JSON输出契约）：\n" + skillBody
                : definition.conversationSystemPrompt();
        return prompt + "\n\n运行时交互约束（优先级高于技能自定义文案）：本轮需要用户在两个或以上候选项中选择时，必须在结构化结果的 choices 数组中返回全部选项，以便前端渲染为可直接点击的按钮，禁止只在 message 中罗列多个候选项。";
    }

    /**
     * 解析对话助手的结构化结果，失败时降级为普通回复，避免单轮解析失败中断整个对话。
     *
     * @param message Msg 模型输出消息
     * @param fallbackReply String 全部解析失败时使用的默认回复
     * @return VideoWorkflowConversationTurn 对话轮次结果
     */
    private VideoWorkflowConversationTurn parseWorkflowConversationTurn(io.agentscope.core.message.Msg message,
                                                                        String fallbackReply) {
        if (message.hasStructuredData()) {
            try {
                VideoWorkflowConversationTurn turn = message.getStructuredData(VideoWorkflowConversationTurn.class);
                if (turn != null && StringUtils.hasText(turn.action())) {
                    String structuredText = (StringUtils.hasText(message.getTextContent())
                            ? message.getTextContent() : "") + "\n" + (turn.message() == null ? "" : turn.message());
                    return normalizeWorkflowChoices(turn, structuredText);
                }
            } catch (Exception exception) {
                log.warn("工作流对话助手结构化结果转换失败: {}", exception.getMessage());
            }
        }
        String text = message.getTextContent() == null ? "" : message.getTextContent().trim();
        VideoWorkflowConversationTurn fromText = parseWorkflowTurnFromText(text);
        if (fromText != null) {
            return normalizeWorkflowChoices(fromText, text);
        }
        // 文本本身就是无法解析的JSON片段时不能原样展示给用户
        String reply = StringUtils.hasText(text) && !text.startsWith("{") ? text
                : StringUtils.hasText(fallbackReply) ? fallbackReply : "请继续描述你的想法";
        return normalizeWorkflowChoices(
                new VideoWorkflowConversationTurn(VideoWorkflowConversationTurn.ACTION_REPLY, reply, null), reply);
    }

    /**
     * 从模型原始文本中提取JSON结构化结果，兼容Markdown代码围栏等包裹格式。
     *
     * @param text String 模型原始文本
     * @return VideoWorkflowConversationTurn 对话轮次结果，无法提取时为null
     */
    private VideoWorkflowConversationTurn parseWorkflowTurnFromText(String text) {
        if (!StringUtils.hasText(text)) {
            return null;
        }
        int start = text.indexOf('{');
        int end = text.lastIndexOf('}');
        if (start < 0 || end <= start) {
            return null;
        }
        try {
            VideoWorkflowConversationTurn turn = JSON.parseObject(text.substring(start, end + 1),
                    VideoWorkflowConversationTurn.class);
            return turn != null && StringUtils.hasText(turn.action()) ? turn : null;
        } catch (Exception exception) {
            return null;
        }
    }

    /**
     * 规范化工作流对话选项，并兼容模型未按JSON契约返回纯文本的情况。
     * <p>
     * 只有回复明确表达“选项/方案/运镜候选”且能识别出至少两个候选项时才生成按钮；
     * 首尾帧回复若明确承诺提供其他运镜选项但列表为空，则使用工作流内置的常见运镜项补齐。
     *
     * @param turn VideoWorkflowConversationTurn 模型结构化结果
     * @param text String 模型可见文本
     * @return VideoWorkflowConversationTurn 带规范化选项的结果
     */
    private VideoWorkflowConversationTurn normalizeWorkflowChoices(VideoWorkflowConversationTurn turn, String text) {
        if (turn == null) return null;
        List<AgentChoice> choices = turn.choices() == null ? List.of() : turn.choices().stream()
                .filter(choice -> choice != null && StringUtils.hasText(choice.label()) && StringUtils.hasText(choice.value()))
                .toList();
        if (choices.isEmpty() && VideoWorkflowConversationTurn.ACTION_REPLY.equalsIgnoreCase(turn.action())) {
            choices = extractWorkflowChoices(text);
        }
        if (choices.equals(turn.choices())) return turn;
        return new VideoWorkflowConversationTurn(turn.action(), turn.message(), turn.prompts(), choices);
    }

    /**
     * 从工作流助手纯文本中提取可点击候选项。
     *
     * @param text String 模型回复文本
     * @return List<AgentChoice> 至少两个候选项时返回按钮列表，否则返回空列表
     */
    static List<AgentChoice> extractWorkflowChoices(String text) {
        if (!StringUtils.hasText(text)) return List.of();
        boolean choiceIntent = text.contains("选项") || text.contains("候选") || text.contains("请选择")
                || text.contains("可选") || text.contains("方案");
        if (!choiceIntent) return List.of();
        LinkedHashSet<String> labels = new LinkedHashSet<>();
        Matcher quotedMatcher = WORKFLOW_QUOTED_CHOICE_PATTERN.matcher(text);
        while (quotedMatcher.find()) addWorkflowChoiceLabel(labels, quotedMatcher.group(1));
        Matcher listMatcher = WORKFLOW_LIST_CHOICE_PATTERN.matcher(text);
        while (listMatcher.find()) addWorkflowChoiceLabel(labels, listMatcher.group(1));
        Matcher inlineMatcher = WORKFLOW_INLINE_CHOICE_PATTERN.matcher(text);
        while (inlineMatcher.find()) {
            for (String candidate : inlineMatcher.group(1).split("[、，,或/]+")) {
                addWorkflowChoiceLabel(labels, candidate);
            }
        }
        boolean cameraAlternatives = text.contains("运镜")
                && (text.contains("其他") || text.contains("选项") || text.contains("可选"));
        if (cameraAlternatives && labels.size() == 1) {
            FIRST_LAST_FRAME_CAMERA_CHOICES.forEach(label -> addWorkflowChoiceLabel(labels, label));
        }
        if (labels.size() < 2) return List.of();
        return labels.stream().map(label -> new AgentChoice(label, label, false, null)).toList();
    }

    /** 将候选项清理后加入有序集合，避免把整段说明误渲染为按钮。 */
    private static void addWorkflowChoiceLabel(Set<String> labels, String rawLabel) {
        if (rawLabel == null) return;
        String label = rawLabel.trim().replaceFirst("^[：:、，,。；;\\s]+", "");
        if (label.length() > 30 || label.isBlank() || label.contains("可以看看") || label.contains("也可以")) return;
        labels.add(label);
    }

    /**
     * 构造工作流对话轮次的澄清计划，草案齐备时附带确认选项。
     *
     * @param context VideoWorkflowContext 工作流上下文
     * @param definition VideoWorkflowDefinition 工作流定义
     * @param replyMessage String 助手回复文本
     * @param turnChoices List<AgentChoice> 本轮需要用户选择的候选项
     * @return CreationPlan 澄清计划
     */
    private CreationPlan workflowClarificationPlan(VideoWorkflowContext context, VideoWorkflowDefinition definition,
                                                   String replyMessage, List<AgentChoice> turnChoices) {
        String message = StringUtils.hasText(replyMessage) ? replyMessage : definition.clarificationQuestion();
        List<AgentChoice> choices = context.hasDraftedPrompts() ? List.of(
                new AgentChoice("确认生成", "确认生成", null, null),
                new AgentChoice("调整提示词", "我想调整提示词", null, null))
                : turnChoices == null ? List.of() : turnChoices;
        return new CreationPlan("", "视频技能工作流", CreationEntrySource.VIDEO_PAGE,
                "正在补充工作流信息", message, false, context.creationSettings(), List.of(), choices, context.workflowType());
    }

    /**
     * 构造通用风格重生成计划。
     * <p>
     * 仅处理明确的“修改风格”类命令，并且要求画布中存在对应的图片或视频生成节点；
     * 其他带有具体创作意图的消息继续交给主Agent规划。
     *
     * @param session AgentSession 当前会话
     * @param request AgentChatRequest 当前对话请求
     * @return CreationPlan 可直接执行的风格重生成计划；无法确定目标时返回null
     */
    CreationPlan buildStyleFollowUpPlan(AgentSession session, AgentChatRequest request) {
        if (!isGenericStyleFollowUpRequest(request)) return null;
        Map<String, Object> snapshot = request.canvasSnapshot() == null ? Map.of() : request.canvasSnapshot();
        List<Map<String, Object>> nodes = snapshotNodes(snapshot.get("nodes"));
        Set<String> selectedNodeIds = new LinkedHashSet<>(stringList(snapshot.get("selectedNodeIds")));
        List<CreationTask> tasks = new ArrayList<>();
        for (String generationType : selectedGenerationTypes(request)) {
            String prompt = latestCanvasPrompt(session, generationType);
            if (!StringUtils.hasText(prompt)) continue;
            List<Map<String, Object>> targets = styleFollowUpTargets(nodes, selectedNodeIds, generationType);
            for (Map<String, Object> target : targets) {
                String nodeId = stringValue(target.get("id"));
                if (!StringUtils.hasText(nodeId) || tasks.size() >= 8) break;
                tasks.add(new CreationTask("style-follow-up-" + generationType + "-" + tasks.size(), "canvas", "tool",
                        prompt, List.of(), "canvas_run_generation", Map.of("nodeId", nodeId, "mode", generationType)));
            }
        }
        if (tasks.isEmpty()) return null;
        return new CreationPlan("", "按已选风格重新生成", CreationEntrySource.CANVAS,
                "按已选风格重新生成画布内容", "", false, request.creationSettings(), tasks, List.of());
    }

    /**
     * 为已选定设定图节点构造确定性的生成计划，避免重复等待主Agent规划。
     * <p>
     * 设定图按钮已经明确了技能、目标节点和生成类型，此处直接调用既有
     * {@code canvas_run_generation} 工具；图片节点的连线引用仍由前端生成器统一解析。
     *
     * @param request AgentChatRequest 画布设定图请求
     * @return CreationPlan 设定图生成计划；非设定图请求返回null
     */
    private CreationPlan buildSettingGraphPlan(AgentChatRequest request) {
        if (request == null || !CreationEntrySource.CANVAS.equals(request.entrySource())
                || !StringUtils.hasText(request.settingGraphNodeId())) {
            return null;
        }
        Map<String, Object> snapshot = readCanvasSettingGraphSnapshot(request);
        if (snapshot.isEmpty()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "设定图技能快照无效");
        }
        CreationSettings settings = request.creationSettings();
        if (settings == null || !StringUtils.hasText(settings.size())) {
            log.info("设定图请求缺少图片尺寸，等待用户补充: nodeId={}, skillId={}",
                    request.settingGraphNodeId(), snapshot.get("id"));
            return new CreationPlan("", "生成设定图", CreationEntrySource.CANVAS,
                    "正在准备设定图生成", "请先补充图片尺寸后再继续。", false, settings, List.of(), List.of());
        }
        String userPrompt = request.message() == null ? "" : request.message().trim();
        if (!StringUtils.hasText(userPrompt)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "设定图描述不能为空");
        }
        // 任务提示词必须保持用户原文，避免绕过统一的来源校验；技能要求通过快照随工具参数传递。
        String prompt = userPrompt;
        String skillName = String.valueOf(snapshot.get("name"));
        CreationTask task = new CreationTask(
                "setting-graph-" + UUID.randomUUID(),
                "canvas",
                "tool",
                prompt,
                "current",
                List.of(),
                "canvas_run_generation",
                Map.of("nodeId", request.settingGraphNodeId(), "mode", "image", "prompt", prompt));
        log.info("设定图请求直接执行画布生成: nodeId={}, skillId={}, skillName={}",
                request.settingGraphNodeId(), snapshot.get("id"), skillName);
        return new CreationPlan("", "生成设定图", CreationEntrySource.CANVAS,
                "生成设定图：" + skillName, "", false, settings, List.of(task), List.of());
    }

    /** 判断是否为不含额外创作要求的通用风格命令。 */
    private boolean isGenericStyleFollowUpRequest(AgentChatRequest request) {
        if (!isStyleFollowUpRequest(request)) return false;
        String normalized = request.message().replaceAll("[\\s，。！？!?,、:：]+", "");
        return Set.of("修改风格", "换风格", "应用风格", "使用风格", "使用当前风格", "使用这个风格",
                "按当前风格生成", "按当前风格重生成", "按已选风格生成", "按已选风格重生成",
                "重新生成风格").contains(normalized);
    }

    /** 读取当前风格选择对应的图片或视频类型，保持图片和视频组的选择顺序。 */
    private List<String> selectedGenerationTypes(AgentChatRequest request) {
        CreationSettings settings = request.creationSettings();
        if (settings == null) return List.of();
        Map<String, List<Long>> idsByType = settings.generationStyleIdsByType();
        if (idsByType != null) {
            return List.of("image", "video").stream()
                    .filter(type -> idsByType.get(type) != null && !idsByType.get(type).isEmpty())
                    .toList();
        }
        if (settings.generationStyleIds() == null || settings.generationStyleIds().isEmpty()) return List.of();
        if (CreationEntrySource.IMAGE_PAGE.equals(request.entrySource())) return List.of("image");
        if (CreationEntrySource.VIDEO_PAGE.equals(request.entrySource())) return List.of("video");
        return List.of();
    }

    /** 读取画布快照中的节点对象。 */
    private List<Map<String, Object>> snapshotNodes(Object value) {
        if (!(value instanceof List<?> values)) return List.of();
        return values.stream().map(this::objectMap).filter(node -> !node.isEmpty()).toList();
    }

    /** 选择当前选中节点，否则选择对应类型最近的一个生成节点。 */
    private List<Map<String, Object>> styleFollowUpTargets(List<Map<String, Object>> nodes,
                                                            Set<String> selectedNodeIds,
                                                            String generationType) {
        List<Map<String, Object>> selected = nodes.stream()
                .filter(node -> generationType.equals(stringValue(node.get("kind")))
                        && selectedNodeIds.contains(stringValue(node.get("id")))
                        && hasGenerationPrompt(node))
                .toList();
        if (!selected.isEmpty()) return selected;
        for (int index = nodes.size() - 1; index >= 0; index--) {
            Map<String, Object> node = nodes.get(index);
            if (generationType.equals(stringValue(node.get("kind"))) && hasGenerationPrompt(node)) {
                return List.of(node);
            }
        }
        return List.of();
    }

    /** 判断节点是否存在可重用的生成提示词。 */
    private boolean hasGenerationPrompt(Map<String, Object> node) {
        return objectMap(node.get("generation")).entrySet().stream()
                .anyMatch(entry -> "prompt".equals(entry.getKey()) && StringUtils.hasText(stringValue(entry.getValue())));
    }

    /** 获取历史中最近一条对应类型的原始图片或视频命令。 */
    private String latestCanvasPrompt(AgentSession session, String generationType) {
        Pattern commandPattern = "image".equals(generationType) ? CANVAS_IMAGE_COMMAND_PATTERN : CANVAS_VIDEO_COMMAND_PATTERN;
        for (int index = session.messages().size() - 1; index >= 0; index--) {
            var message = session.messages().get(index);
            if (!"user".equals(message.role()) || !StringUtils.hasText(message.text())) continue;
            if (commandPattern.matcher(message.text().trim()).matches()) return message.text();
        }
        return "";
    }

    /** 将快照中的任意对象转换为字符串键Map。 */
    private Map<String, Object> objectMap(Object value) {
        if (!(value instanceof Map<?, ?> source)) return Map.of();
        Map<String, Object> result = new LinkedHashMap<>();
        source.forEach((key, item) -> {
            if (key != null) result.put(String.valueOf(key), item);
        });
        return result;
    }

    /** 将快照中的字符串数组转换为去重后的有序列表。 */
    private List<String> stringList(Object value) {
        if (!(value instanceof List<?> values)) return List.of();
        return values.stream().map(this::stringValue).filter(StringUtils::hasText).distinct().toList();
    }

    /** 将任意快照值转换为字符串。 */
    private String stringValue(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    /**
     * 为聊天重试请求恢复最近创作计划中的历史风格，同时保留本次请求的页面设置。
     *
     * @param userId Long 用户ID
     * @param session AgentSession 当前Agent会话
     * @param request AgentChatRequest 当前对话请求
     * @return Mono<AgentChatRequest> 合并历史风格后的请求
     */
    private Mono<AgentChatRequest> resolveRetryRequest(Long userId, AgentSession session, AgentChatRequest request) {
        if (!isRetryMessage(request.message()) || hasGenerationStyles(request.creationSettings())) {
            return Mono.just(request);
        }
        return planRepository.findLatestCreationSettings(userId, session.id())
                .map(historicalSettings -> new AgentChatRequest(
                        request.sessionId(), request.entrySource(), request.message(), request.canvasSnapshot(),
                        request.references(), request.attachments(), request.history(),
                        mergeRetrySettings(request.creationSettings(), historicalSettings), request.skillId()))
                .defaultIfEmpty(request);
    }

    /**
     * 合并重试所需的历史风格字段，当前请求的其他页面设置保持不变。
     *
     * @param current CreationSettings 当前请求生成设置
     * @param historical CreationSettings 最近失败计划生成设置
     * @return CreationSettings 合并后的生成设置
     */
    CreationSettings mergeRetrySettings(CreationSettings current, CreationSettings historical) {
        if (current == null || historical == null || !hasGenerationStyles(historical)) {
            return current;
        }
        List<Long> styleIds = historical.generationStyleSnapshots() != null
                && !historical.generationStyleSnapshots().isEmpty() ? null : historical.generationStyleIds();
        java.util.Map<String, List<Long>> styleIdsByType = historical.generationStyleSnapshots() != null
                && !historical.generationStyleSnapshots().isEmpty() ? null : historical.generationStyleIdsByType();
        return new CreationSettings(current.model(), current.size(), current.resolution(), current.quality(),
                current.count(), current.seconds(), current.watermark(), styleIds, historical.generationStyleSnapshots(),
                styleIdsByType, current.videoGenerationMode(), current.videoModel(), current.imageModel(),
                current.imageSize(), current.imageResolution(), current.imageQuality(), current.generateAudio());
    }

    /**
     * 判断生成设置是否携带风格ID或风格快照。
     *
     * @param settings CreationSettings 生成设置
     * @return boolean 是否携带风格
     */
    private boolean hasGenerationStyles(CreationSettings settings) {
        return settings != null
                && ((settings.generationStyleIds() != null && !settings.generationStyleIds().isEmpty())
                || (settings.generationStyleSnapshots() != null && !settings.generationStyleSnapshots().isEmpty())
                || (settings.generationStyleIdsByType() != null && settings.generationStyleIdsByType().values().stream()
                .anyMatch(ids -> ids != null && !ids.isEmpty())));
    }

    /**
     * 调用AgentScope主Agent获取结构化计划。
     *
     * @param userId Long 用户ID
     * @param session AgentSession 当前会话
     * @param request AgentChatRequest 原始请求
     * @param model Model 默认文本模型
     * @return Mono<CreationPlan> 候选计划
     */
    private Mono<CreationPlan> callMainAgent(Long userId, AgentSession session, AgentChatRequest request, Model model) {
        return Mono.defer(() -> {
            ReActAgent agent;
            Map<String, Object> input = new java.util.LinkedHashMap<>();
            input.put("entrySource", request.entrySource());
            input.put("message", request.message());
            input.put("history", historyForAgent(request, session));
            input.put("promptCandidates", promptSources(session, request.message()));
            input.put("creationSettings", request.creationSettings());
            input.put("generationStyleSelection", generationStyleSelection(request));
            input.put("styleFollowUp", isStyleFollowUpRequest(request));
            input.put("retryRequested", isRetryMessage(request.message()));
            if (isRetryMessage(request.message())) {
                input.put("retryPrompt", latestRetryPrompt(session));
            }
            input.put("attachmentCount", request.attachments() == null ? 0 : request.attachments().size());
            if (CreationEntrySource.CANVAS.equals(request.entrySource())) {
                Map<String, Object> compactedSnapshot = canvasSnapshotCompactor.compact(request.canvasSnapshot());
                Object originalNodes = request.canvasSnapshot() == null ? null : request.canvasSnapshot().get("nodes");
                int originalNodeCount = originalNodes instanceof List<?> nodes ? nodes.size() : 0;
                log.info("主Agent画布快照裁剪完成: nodeCount={}, retainedFieldCount={}",
                        originalNodeCount, compactedSnapshot.size());
                input.put("canvasSnapshot", compactedSnapshot);
            } else {
                input.put("canvasSnapshot", Map.of());
            }
            if (CreationEntrySource.CANVAS.equals(request.entrySource()) && StringUtils.hasText(request.settingGraphNodeId())) {
                input.put("settingGraphNodeId", request.settingGraphNodeId());
            }
            if (CreationEntrySource.CANVAS.equals(request.entrySource()) && request.settingGraphSkillSnapshot() != null) {
                input.put("settingGraphSkillSnapshot", request.settingGraphSkillSnapshot());
            }
            input.put("canvasTools", CreationEntrySource.CANVAS.equals(request.entrySource())
                    ? toolRegistry.allTools().stream().filter(com.inspirestudio.agent.dto.AgentTool::frontend).toList()
                    : List.of());
            if (StringUtils.hasText(request.skillId())) {
                Long skillId;
                try {
                    skillId = Long.valueOf(request.skillId());
                } catch (NumberFormatException exception) {
                    return Mono.error(new BusinessException(ErrorCode.PARAM_INVALID, "技能ID不合法"));
                }
                return skillService.findEnabledSkill(skillId)
                        .filter(skill -> ("canvas".equals(request.entrySource()) && "canvasSettingGraph".equals(skill.getTargetType()))
                                || ("imagePage".equals(request.entrySource()) && "image".equals(skill.getTargetType()))
                                || ("videoPage".equals(request.entrySource()) && "video".equals(skill.getTargetType())))
                        .onErrorResume(exception -> Mono.empty())
                        .map(skill -> {
                            String skillPrompt = withGlobalReferenceMediaRule(skill.getTargetType(), skill.getSystemPrompt());
                            input.put("skillId", request.skillId());
                            input.put("skill", Map.of(
                                    "name", skill.getName(),
                                    "targetType", skill.getTargetType(),
                                    "instructions", skillPrompt));
                            return agentFactory.mainAgent(model, skillPrompt);
                        })
                        .switchIfEmpty(Mono.defer(() -> {
                            Map<String, Object> snapshot = readCanvasSettingGraphSnapshot(request);
                            if (!"canvas".equals(request.entrySource()) || snapshot.isEmpty()) {
                                return Mono.error(new BusinessException(ErrorCode.PARAM_INVALID, "技能类型与当前Agent入口不匹配"));
                            }
                            input.put("skillId", request.skillId());
                            input.put("skill", Map.of("name", snapshot.get("name"), "targetType", snapshot.get("targetType"), "instructions", snapshot.get("systemPrompt")));
                            return Mono.just(agentFactory.mainAgent(model, String.valueOf(snapshot.get("systemPrompt"))));
                        }))
                        .flatMap(skillAgent -> callMainAgentWith(skillAgent, userId, session, input));
            }
            agent = agentFactory.mainAgent(model);
            return callMainAgentWith(agent, userId, session, input);
        });
    }

    /**
     * 使用指定主Agent实例调用模型并解析计划。
     *
     * @param agent ReActAgent 主Agent实例
     * @param userId Long 用户ID
     * @param session AgentSession 当前会话
     * @param input Map<String, Object> 模型输入
     * @return Mono<CreationPlan> 候选计划
     */
    private Mono<CreationPlan> callMainAgentWith(ReActAgent agent, Long userId, AgentSession session, Map<String, Object> input) {
        return requestMainPlan(agent, userId, session, input)
                .flatMap(plan -> {
                    if (!needsCanvasPlanRepair(plan, String.valueOf(input.get("entrySource")))) return Mono.just(plan);
                    Map<String, Object> correction = new LinkedHashMap<>(input);
                    correction.put("taskSchemaCorrection", "canvas_generate_video 必须使用 taskType=video、action=generate；canvas_generate_image 必须使用 taskType=image、action=generate。action 是枚举字段，不能填写中文说明。每个任务使用唯一 taskId，sourcePromptId=current，未依赖其他任务时 dependsOn=[]。只生成用户要求的数量，默认一个视频。");
                    correction.put("planCorrection", "当前已经在画布。上次计划为空或任务编号为空/重复，尚未执行任何操作。请重新生成完整计划：每个 taskId 必须非空且唯一，dependsOn 只能引用本计划的有效任务编号。按用户请求和 creationSettings 的数量生成任务，禁止重复创建同一个视频。若要求生成或编辑，返回 canvasTools 中合法工具的完整 tasks、sourcePromptId 和 dependsOn，canvasGuidance=false；若缺参或用户只询问分析，在 clarificationQuestion 中给出真实问题或分析。禁止只返回 summary 代替执行。严格使用 creationSettings，不要自行增加任务或改变用户参数。");
                    return requestMainPlan(agent, userId, session, correction).map(repaired -> {
                        if ((repaired.tasks() == null || repaired.tasks().isEmpty())
                                && !StringUtils.hasText(repaired.clarificationQuestion())) {
                            throw new BusinessException(ErrorCode.PARAM_INVALID, "助手未返回可执行的画布任务，尚未创建内容。请重试。");
                        }
                        return repaired;
                    });
                })
                .doFinally(signal -> agent.close());
    }

    static boolean needsCanvasPlanRepair(CreationPlan plan, String entrySource) {
        if (plan == null || !CreationEntrySource.CANVAS.equals(entrySource)
                || StringUtils.hasText(plan.clarificationQuestion())) return false;
        if (plan.tasks() != null && !plan.tasks().isEmpty()) {
            Set<String> ids = new java.util.HashSet<>();
            return plan.tasks().stream().anyMatch(task -> task == null
                    || !StringUtils.hasText(task.taskId()) || !ids.add(task.taskId())
                    || (("canvas_generate_video".equals(task.toolName()) || "canvas_generate_image".equals(task.toolName()))
                        && StringUtils.hasText(task.action())
                        && !Set.of("generate", "generate_video", "generate_image").contains(task.action())));
        }
        return Boolean.TRUE.equals(plan.canvasGuidance())
                || Set.of("video_generation", "image_generation", "text-to-video", "image-to-video", "text-to-image")
                        .contains(plan.workflowType() == null ? "" : plan.workflowType());
    }

    private Mono<CreationPlan> requestMainPlan(ReActAgent agent, Long userId, AgentSession session, Map<String, Object> input) {
        return agent.call(JSON.toJSONString(input), CreationPlan.class, RuntimeContext.builder()
                        .sessionId(session.id() + ":main")
                        .userId(String.valueOf(userId))
                        .put(AgentThinkingEventMiddleware.ThinkingEventContext.class,
                                new AgentThinkingEventMiddleware.ThinkingEventContext(userId, session.id()))
                        .build())
                .timeout(Duration.ofSeconds(180))
                .map(message -> message.getStructuredData(CreationPlan.class))
                .doOnNext(plan -> {
                    log.info("主Agent计划路由: entry={}, workflow={}, canvasGuidance={}, clarification={}",
                            plan.entrySource(), plan.workflowType(), plan.canvasGuidance(),
                            StringUtils.hasText(plan.clarificationQuestion()));
                    if (plan.tasks() != null) plan.tasks().stream().filter(java.util.Objects::nonNull).forEach(task ->
                            log.info("主Agent计划结构: taskId={}, taskType={}, action={}, sourcePromptId={}, toolName={}",
                                    task.taskId(), task.taskType(), task.action(), task.sourcePromptId(), task.toolName()));
                });
    }

    /**
     * 构造主Agent可选择的服务端用户原文引用。
     * <p>
     * 当前消息始终使用固定引用，历史消息仅保留与主Agent上下文相同窗口内的用户消息，
     * 避免模型复制或改写长提示词后再参与执行。
     *
     * @param session AgentSession 当前会话
     * @param currentMessage String 当前用户消息
     * @return Map<String, String> 原文引用到用户消息的映射
     */
    private Map<String, String> promptSources(AgentSession session, String currentMessage) {
        Map<String, String> sources = new LinkedHashMap<>();
        sources.put("current", currentMessage);
        List<com.inspirestudio.agent.dto.AgentMessage> messages = session.messages();
        for (int index = Math.max(0, messages.size() - 20); index < messages.size(); index++) {
            com.inspirestudio.agent.dto.AgentMessage message = messages.get(index);
            if ("user".equals(message.role()) && StringUtils.hasText(message.text())) {
                sources.put("history-" + index, message.text());
            }
        }
        return sources;
    }

    /**
     * 将主Agent选择的用户原文引用解析为可信提示词。
     * <p>
     * 优先解析有效的用户消息引用；引用遗漏时从可信当前请求或澄清链回填。
     * 不接受不存在的显式引用，也不使用模型改写文本替代用户原文。
     *
     * @param plan CreationPlan 已完成页面能力校验的计划
     * @param session AgentSession 当前会话
     * @param currentMessage String 当前用户消息
     * @return CreationPlan 已回填用户原始提示词的计划
     * @throws BusinessException 引用不存在时抛出
     */
    CreationPlan resolveTaskPromptSources(CreationPlan plan, AgentSession session, String currentMessage) {
        return resolveTaskPromptSources(plan, session, currentMessage, plan == null ? null : plan.entrySource());
    }

    /**
     * 使用可信请求入口解析主Agent任务的用户原文引用。
     * 模型偶尔会同时漏填 sourcePromptId 并误填 entrySource，不能让错误的模型入口绕过生成页的安全回填。
     *
     * @param plan CreationPlan 主Agent候选计划
     * @param session AgentSession 当前会话
     * @param currentMessage String 当前用户消息
     * @param requestEntrySource String 服务端请求入口
     * @return CreationPlan 已回填用户原始提示词的计划
     */
    CreationPlan resolveTaskPromptSources(CreationPlan plan, AgentSession session, String currentMessage,
                                          String requestEntrySource) {
        if (plan == null || plan.tasks() == null || plan.tasks().isEmpty()) {
            return plan;
        }
        Map<String, String> sources = promptSources(session, currentMessage);
        List<CreationTask> tasks = plan.tasks().stream().map(task -> {
            String sourceId = task == null ? null : task.sourcePromptId();
            if (task != null && CreationEntrySource.CANVAS.equals(requestEntrySource)
                    && isCanvasGenerationTask(task) && StringUtils.hasText(sourceId)
                    && !sources.containsKey(sourceId) && task.dependsOn() != null
                    && task.dependsOn().contains(sourceId)) {
                String dependencyId = sourceId;
                // An upstream task supplies media through dependsOn, never user-authored text.
                // Recover provenance below only for an actual declared task dependency.
                if (plan.tasks().stream().anyMatch(upstream -> upstream != null
                        && dependencyId.equals(upstream.taskId()) && !dependencyId.equals(task.taskId()))) {
                    sourceId = null;
                }
            }
            // Generation pages bind missing references to server-owned user input. Exact historical
            // matches are preserved; otherwise the current instruction is composed with context later.
            if (task != null && !StringUtils.hasText(sourceId)
                    && (CreationEntrySource.IMAGE_PAGE.equals(requestEntrySource)
                    || CreationEntrySource.VIDEO_PAGE.equals(requestEntrySource))) {
                sourceId = sources.entrySet().stream()
                        .filter(entry -> StringUtils.hasText(entry.getValue()) && entry.getValue().equals(task.prompt()))
                        .map(Map.Entry::getKey).findFirst().orElse("current");
            }
            if (!StringUtils.hasText(sourceId)) {
                // On canvas, recover only an exact user-authored prompt, never a model rewrite.
                sourceId = task == null ? null : sources.entrySet().stream()
                        .filter(entry -> StringUtils.hasText(entry.getValue()) && entry.getValue().equals(task.prompt()))
                        .map(Map.Entry::getKey).findFirst().orElse(null);
            }
            if (!StringUtils.hasText(sourceId)
                    && CreationEntrySource.CANVAS.equals(requestEntrySource)
                    && isCanvasGenerationTask(task)) {
                // Prefer the original user message within an actual clarification chain.
                // A new scene description supersedes a vague initial request such as "生成视频";
                // short selections and parameter replies still use the original user prompt.
                String clarificationSourceId = clarificationPromptSourceId(session, currentMessage);
                if (StringUtils.hasText(clarificationSourceId)) {
                    String original = sources.get(clarificationSourceId);
                    sourceId = isStandaloneCanvasPrompt(session, currentMessage, original)
                            ? "current" : clarificationSourceId;
                } else {
                    // A direct canvas generation request is already trusted user input.
                    // Never substitute the model's rewritten task.prompt.
                    sourceId = "current";
                }
            }
            if (!StringUtils.hasText(sourceId) && task != null
                    && CreationEntrySource.CANVAS.equals(requestEntrySource)
                    && toolRegistry.isFrontend(task.toolName()) && !isCanvasGenerationTask(task)) {
                // Editing tools often omit generation provenance. Bind to actual user input;
                // registered-tool/schema validation still controls which operations can run.
                sourceId = "current";
            }
            if (!StringUtils.hasText(sourceId)) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "主Agent任务缺少用户原始提示词引用");
            }
            String prompt = sources.get(sourceId);
            if (!StringUtils.hasText(prompt)) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "主Agent任务引用的用户原始提示词不存在");
            }
            return new CreationTask(task.taskId(), task.taskType(), task.action(), prompt, sourceId, task.dependsOn(),
                    task.toolName(), task.toolArguments(), task.taskRole());
        }).toList();
        return new CreationPlan(plan.planId(), plan.intent(), plan.entrySource(), plan.summary(),
                plan.clarificationQuestion(), plan.canvasGuidance(), plan.creationSettings(), tasks,
                plan.choices(), plan.workflowType());
    }

    /** 判断任务是否为允许在画布直接生成媒体的注册工具。 */
    private boolean isCanvasGenerationTask(CreationTask task) {
        if (task == null || task.taskType() == null) return false;
        return "canvas_generate_image".equals(task.toolName())
                && Set.of("image", "imageGeneration", "image_generation").contains(task.taskType())
                || "canvas_generate_video".equals(task.toolName())
                && Set.of("video", "videoGeneration", "video_generation").contains(task.taskType());
    }

    /** A descriptive answer is its own prompt; confirmations and settings only extend the earlier prompt. */
    private boolean isStandaloneCanvasPrompt(AgentSession session, String currentMessage, String original) {
        if (!StringUtils.hasText(currentMessage) || isRetryMessage(currentMessage)) return false;
        String current = currentMessage.trim();
        if (current.matches("(?is)^(确认|确定|好的|可以|继续|是|否|yes|no|尺寸|比例|时长|分辨率|画幅)[\\s:：，,。！？!?.\\dA-Za-z-]*$")) {
            return false;
        }
        boolean genericOriginal = StringUtils.hasText(original) && original.trim()
                .matches("^(请|帮我|给我)?(生成|制作|做)(一张|一个|个)?(图片|图像|图|视频|短片)[。！!\\s]*$");
        String lastAssistant = session.messages().stream()
                .filter(message -> "assistant".equals(message.role()))
                .map(message -> message.text() == null ? "" : message.text())
                .reduce((left, right) -> right).orElse("");
        return genericOriginal || lastAssistant.contains("请描述")
                || lastAssistant.contains("画面内容") || lastAssistant.contains("场景内容");
    }

    /**
     * 从连续的助手澄清问答中定位最初的用户创作原文引用。
     * 当前消息可以已经追加到会话，也可以只存在于请求中。
     */
    private String clarificationPromptSourceId(AgentSession session, String currentMessage) {
        if (session == null || session.messages() == null || session.messages().isEmpty()) return null;
        List<com.inspirestudio.agent.dto.AgentMessage> messages = session.messages();
        int cursor = messages.size() - 1;
        if (cursor >= 0 && "user".equals(messages.get(cursor).role())
                && currentMessage != null && currentMessage.equals(messages.get(cursor).text())) {
            cursor--;
        }
        String sourceId = null;
        while (cursor >= 0) {
            while (cursor >= 0 && !"assistant".equals(messages.get(cursor).role())) cursor--;
            if (cursor < 0 || !isClarificationMessage(messages.get(cursor).text())) break;
            int userIndex = cursor - 1;
            while (userIndex >= 0 && !"user".equals(messages.get(userIndex).role())) userIndex--;
            if (userIndex < 0 || !StringUtils.hasText(messages.get(userIndex).text())) break;
            sourceId = "history-" + userIndex;
            cursor = userIndex - 1;
        }
        return sourceId;
    }

    /** 判断助手消息是否仍在请求用户确认或补充创作参数。 */
    private boolean isClarificationMessage(String text) {
        if (!StringUtils.hasText(text)) return false;
        String normalized = text.trim();
        return normalized.contains("？") || normalized.contains("?")
                || normalized.contains("请选择") || normalized.contains("请确认")
                || normalized.contains("还差") || normalized.contains("点选")
                || normalized.contains("选择一个") || normalized.contains("需要你")
                || normalized.contains("请补充") || normalized.contains("确认后")
                || normalized.endsWith("：") || normalized.endsWith(":");
    }

    /**
     * 判断当前画布请求是否是在已选风格基础上的风格重生成操作。
     * <p>
     * 风格ID由服务端校验和解析，主Agent只需要知道用户已经选择了风格以及请求属于风格操作，
     * 不应再次要求用户输入风格名称或自行拼接风格提示词。
     *
     * @param request AgentChatRequest 当前对话请求
     * @return boolean 是否为已选风格的画布重生成请求
     */
    boolean isStyleFollowUpRequest(AgentChatRequest request) {
        if (request == null || !CreationEntrySource.CANVAS.equals(request.entrySource())
                || !hasGenerationStyles(request.creationSettings()) || !StringUtils.hasText(request.message())) {
            return false;
        }
        String normalized = request.message().replaceAll("[\\s，。！？!?,、:：]+", "");
        if (!normalized.contains("风格")) return false;
        return List.of("修改", "改成", "改为", "换", "应用", "使用", "重生成", "重新生成")
                .stream().anyMatch(normalized::contains);
    }

    /**
     * 构造供主Agent理解的风格选择摘要，不包含风格提示词和未校验的名称。
     *
     * @param request AgentChatRequest 当前对话请求
     * @return Map<String, Object> 已选择风格的类型和数量
     */
    private Map<String, Object> generationStyleSelection(AgentChatRequest request) {
        Map<String, Object> selection = new LinkedHashMap<>();
        if (request == null || request.creationSettings() == null) return selection;
        CreationSettings settings = request.creationSettings();
        Map<String, List<Long>> idsByType = settings.generationStyleIdsByType();
        if (idsByType != null) {
            idsByType.forEach((type, ids) -> {
                if (ids != null && !ids.isEmpty()) selection.put(type, Map.of("selected", true, "count", ids.size()));
            });
            return selection;
        }
        if (settings.generationStyleIds() != null && !settings.generationStyleIds().isEmpty()) {
            String generationType = CreationEntrySource.IMAGE_PAGE.equals(request.entrySource()) ? "image"
                    : CreationEntrySource.VIDEO_PAGE.equals(request.entrySource()) ? "video" : "unknown";
            selection.put(generationType, Map.of("selected", true, "count", settings.generationStyleIds().size()));
        }
        return selection;
    }

    /**
     * 读取最近二十条自然语言会话历史，避免工具元数据进入主Agent上下文。
     *
     * @param session AgentSession 当前会话
     * @return List<Map<String, String>> 最近会话历史
     */
    private List<Map<String, String>> recentHistory(AgentSession session) {
        List<Map<String, String>> history = session.messages().stream()
                .filter(message -> "user".equals(message.role()) || "assistant".equals(message.role()))
                .map(message -> Map.of("role", message.role(), "text", message.text() == null ? "" : message.text()))
                .toList();
        return history.subList(Math.max(0, history.size() - 20), history.size());
    }

    /**
     * 选择主Agent使用的对话历史。
     * <p>
     * 画布前端会将风格分组格式化到请求历史中，优先使用该历史可以保留已选择的图片和视频风格；
     * 其他入口或旧客户端未提交历史时继续使用服务端会话记录。
     *
     * @param request AgentChatRequest 当前对话请求
     * @param session AgentSession 服务端会话
     * @return List<Map<String, String>> 最近对话历史
     */
    private List<Map<String, String>> historyForAgent(AgentChatRequest request, AgentSession session) {
        if (request != null && CreationEntrySource.CANVAS.equals(request.entrySource())
                && request.history() != null && !request.history().isEmpty()) {
            List<Map<String, String>> history = request.history().stream()
                    .filter(message -> message != null
                            && ("user".equals(message.role()) || "assistant".equals(message.role())))
                    .map(message -> Map.of("role", message.role(), "text", message.text() == null ? "" : message.text()))
                    .toList();
            return history.subList(Math.max(0, history.size() - 20), history.size());
        }
        return recentHistory(session);
    }

    /**
     * 保存助手终态消息并推送task-complete事件。
     *
     * @param userId Long 用户ID
     * @param sessionId String 会话ID
     * @param text String 用户可见消息
     * @return Mono<Void> 完成信号
     */
    private Mono<Void> completeWithMessage(Long userId, String sessionId, String text) {
        return completeWithMessage(userId, sessionId, text, null);
    }

    /**
     * 保存助手终态消息并推送task-complete事件，可选携带结构化交互动作。
     *
     * @param userId Long 用户ID
     * @param sessionId String 会话ID
     * @param text String 用户可见消息
     * @param action AgentAction 前端交互动作，可为空
     * @return Mono<Void> 完成信号
     */
    private Mono<Void> completeWithMessage(Long userId, String sessionId, String text, AgentAction action) {
        String messageId = UUID.randomUUID().toString();
        return sessionService.appendAssistantMessage(sessionId, messageId, text)
                .doOnSuccess(ignored -> eventEmitter.emit(userId, AgentEvent.taskComplete(sessionId, messageId, text, action)));
    }

    /**
     * 将本轮修改指令合并到引用历史原文的图片或视频任务提示词。
     * <p>
     * 图片页和视频页的后续消息常是“改为男性”“换成夜景”等修改或补充指令，主Agent按规则引用历史原文，
     * 该指令本身不会进入任务提示词；服务端在此把本轮指令合并到最终提示词，避免修改要求丢失。
     * 编辑任务直接使用本轮指令作为提示词（服务端自动挂载最近一张历史图片作参考图），长原文合并反而会稀释指令；
     * 生成任务的修改指令前置到提示词开头并强调优先级，避免被长原文末尾淹没而被生成模型忽略。
     * 纯重试指令不参与合并；画布图片和视频生成工具会合并多轮确认的最终用户选择，
     * 其他画布工具仍沿用工具自身语义。
     *
     * @param plan CreationPlan 已回填用户原文并校验的计划
     * @param session AgentSession 当前会话
     * @param currentMessage String 当前用户消息
     * @return CreationPlan 合并本轮指令后的计划
     */
    CreationPlan composeFollowUpPrompts(CreationPlan plan, AgentSession session, String currentMessage) {
        if (plan == null || plan.tasks() == null || plan.tasks().isEmpty()
                || !StringUtils.hasText(currentMessage) || isRetryMessage(currentMessage)) {
            return plan;
        }
        Set<String> historyPrompts = new LinkedHashSet<>();
        session.messages().forEach(message -> {
            if ("user".equals(message.role()) && StringUtils.hasText(message.text())
                    && !currentMessage.equals(message.text())) {
                historyPrompts.add(message.text());
            }
        });
        if (historyPrompts.isEmpty()) {
            return plan;
        }
        List<CreationTask> tasks = plan.tasks().stream().map(task -> {
            if (task == null || (StringUtils.hasText(task.toolName()) && !isCanvasGenerationTask(task))) {
                return task;
            }
            // 编辑任务以本轮指令为提示词，参考图由服务端自动注入，且当前指令本身是用户逐字原文。
            boolean explicitImageEdit = CreationEntrySource.IMAGE_PAGE.equals(plan.entrySource())
                    && "image".equals(task.taskType()) && "generate".equals(task.action())
                    && isExplicitImageEdit(currentMessage);
            if ("edit".equals(task.action()) || explicitImageEdit) {
                return new CreationTask(task.taskId(), task.taskType(), "edit",
                        currentMessage, task.sourcePromptId(), task.dependsOn(),
                        task.toolName(), task.toolArguments(), task.taskRole());
            }
            if (!historyPrompts.contains(task.prompt())) {
                return task;
            }
            // 修改指令放在提示词最前面并强调优先级，避免被长原文末尾淹没而被生成模型忽略。
            String mergedPrompt = "请优先应用以下修改要求，修改要求与原文冲突时以修改要求为准：\n"
                    + currentMessage + "\n\n原文：\n" + task.prompt();
            return new CreationTask(task.taskId(), task.taskType(), task.action(),
                    mergedPrompt, task.sourcePromptId(), task.dependsOn(),
                    task.toolName(), task.toolArguments(), task.taskRole());
        }).toList();
        return new CreationPlan(plan.planId(), plan.intent(), plan.entrySource(), plan.summary(),
                plan.clarificationQuestion(), plan.canvasGuidance(), plan.creationSettings(), tasks,
                plan.choices(), plan.workflowType());
    }

    /**
     * 使用服务端生成的计划编号替换模型输出编号。
     *
     * @param plan CreationPlan 已校验计划
     * @param session AgentSession 当前会话
     * @param currentMessage String 当前用户消息
     * @return CreationPlan 带可信计划编号的计划
     * @throws BusinessException 任务提示词不是用户逐字输入时抛出
     */
    CreationPlan withServerPlanId(CreationPlan plan, AgentSession session, String currentMessage) {
        if (StringUtils.hasText(plan.workflowType())) {
            return new CreationPlan(UUID.randomUUID().toString(), plan.intent(), plan.entrySource(), plan.summary(), "",
                    false, plan.creationSettings(), plan.tasks(), List.of(), plan.workflowType());
        }
        Set<String> userPrompts = new java.util.HashSet<>();
        userPrompts.add(currentMessage);
        session.messages().stream()
                .filter(message -> "user".equals(message.role()) && StringUtils.hasText(message.text()))
                .map(com.inspirestudio.agent.dto.AgentMessage::text)
                .forEach(userPrompts::add);
        java.util.List<com.inspirestudio.agent.dto.CreationTask> tasks = plan.tasks().stream()
                .map(task -> {
                    String taskPrompt = isRetryMessage(currentMessage) && isRetryMessage(task.prompt())
                            ? latestRetryPrompt(session) : task.prompt();
                    if (!userPrompts.contains(taskPrompt)) {
                        taskPrompt = resolveCanvasHistoricalPrompt(plan, task, taskPrompt, userPrompts);
                    }
                    if (!StringUtils.hasText(taskPrompt) || !userPrompts.contains(taskPrompt)) {
                        throw new BusinessException(ErrorCode.PARAM_INVALID, "主Agent任务提示词必须逐字来自用户消息");
                    }
                    return new com.inspirestudio.agent.dto.CreationTask(
                            task.taskId(), task.taskType(), task.action(), taskPrompt, task.sourcePromptId(), task.dependsOn(),
                            task.toolName(), task.toolArguments(), task.taskRole());
                })
                .toList();
        return new CreationPlan(UUID.randomUUID().toString(), plan.intent(), plan.entrySource(), plan.summary(), "",
                false, plan.creationSettings(), tasks, List.of(), plan.workflowType());
    }

    /**
     * 恢复画布多轮补参时被主Agent去掉命令前缀的原始提示词。
     * <p>
     * 只接受历史用户消息中明确的图片或视频命令，并且要求主Agent返回值等于命令分隔符后的完整正文，
     * 不接受任意子串、相似文本或模型自行改写的内容。
     *
     * @param plan CreationPlan 已校验计划
     * @param task CreationTask 当前任务
     * @param taskPrompt String 主Agent返回的任务提示词
     * @param userPrompts Set<String> 当前会话中的用户原始消息
     * @return String 恢复后的用户原始消息；无法恢复时返回主Agent原值
     */
    private String resolveCanvasHistoricalPrompt(CreationPlan plan,
                                                  com.inspirestudio.agent.dto.CreationTask task,
                                                  String taskPrompt,
                                                  Set<String> userPrompts) {
        if (!CreationEntrySource.CANVAS.equals(plan.entrySource()) || !StringUtils.hasText(taskPrompt)) {
            return taskPrompt;
        }
        Pattern commandPattern = switch (task.taskType()) {
            case "image" -> CANVAS_IMAGE_COMMAND_PATTERN;
            case "video" -> CANVAS_VIDEO_COMMAND_PATTERN;
            default -> null;
        };
        if (commandPattern == null) return taskPrompt;
        for (String userPrompt : userPrompts) {
            if (!StringUtils.hasText(userPrompt)) continue;
            Matcher matcher = commandPattern.matcher(userPrompt.trim());
            if (matcher.matches() && taskPrompt.equals(matcher.group(1).trim())) {
                return userPrompt;
            }
        }
        return taskPrompt;
    }

    /**
     * 判断用户消息是否为明确的重新生成指令。
     *
     * @param message String 用户消息
     * @return boolean 是否为重试指令
     */
    private boolean isRetryMessage(String message) {
        if (!StringUtils.hasText(message)) {
            return false;
        }
        String normalized = message.trim().replaceAll("[。！!？?，,、\\s]+$", "");
        return Set.of("重试", "再试一次", "重新生成", "再生成一次").contains(normalized);
    }

    /**
     * 获取重试时最近一条非重试用户创作消息。
     *
     * @param session AgentSession 当前会话
     * @return String 最近一次创作提示词；不存在时返回空字符串
     */
    private String latestRetryPrompt(AgentSession session) {
        for (int index = session.messages().size() - 1; index >= 0; index--) {
            com.inspirestudio.agent.dto.AgentMessage message = session.messages().get(index);
            if ("user".equals(message.role()) && StringUtils.hasText(message.text()) && !isRetryMessage(message.text())) {
                return message.text();
            }
        }
        return "";
    }

    /**
     * 校验对话请求基础字段。
     *
     * @param request AgentChatRequest 请求
     * @throws BusinessException 请求不合法时抛出
     */
    private void validateRequest(AgentChatRequest request) {
        if (request == null || !supports(request.entrySource())) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Agent入口来源不合法");
        }
        if (!StringUtils.hasText(request.message())) {
            throw new BusinessException(ErrorCode.PARAM_MISSING, "用户消息不能为空");
        }
        if (StringUtils.hasText(request.skillId())
                && !"imagePage".equals(request.entrySource()) && !"videoPage".equals(request.entrySource()) && !"canvas".equals(request.entrySource())) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "技能入口来源不合法");
        }
    }

    /**
     * 执行已条件切换为running的主Agent请求。
     *
     * @param queuedRequest CreationAgentRequest 已领取请求
     * @return Mono<Void> 请求执行完成信号
     */
    private Mono<Void> executeRunningRequest(CreationAgentRequest queuedRequest) {
        return requestRepository.findById(queuedRequest.getId())
                .filter(current -> "running".equals(current.getStatus()))
                .flatMap(current -> requestQueue.isCancelRequested(current.getId())
                        .flatMap(cancelRequested -> Boolean.TRUE.equals(cancelRequested)
                                ? finishClaimedRequest(current, "canceled", "已停止生成", null)
                                : executeRunningRequestSnapshot(current)));
    }

    /**
     * 校验已领取请求快照后加载最新会话并执行既有计划链路。
     *
     * @param queuedRequest CreationAgentRequest 当前运行请求
     * @return Mono<Void> 请求执行完成信号
     */
    private Mono<Void> executeRunningRequestSnapshot(CreationAgentRequest queuedRequest) {
        AgentChatRequest request;
        try {
            request = JSON.parseObject(queuedRequest.getRequestData(), AgentChatRequest.class);
        } catch (Exception exception) {
            return finishClaimedRequest(queuedRequest, "failed", "主Agent请求数据无效", exception);
        }
        if (request == null || !queuedRequest.getSessionId().equals(request.sessionId())
                || !queuedRequest.getEntrySource().equals(request.entrySource())) {
            return finishClaimedRequest(queuedRequest, "failed", "主Agent请求数据与持久化记录不一致", null);
        }
        return sessionService.getOrCreateSession(queuedRequest.getUserId(), queuedRequest.getSessionId(), queuedRequest.getEntrySource())
                .flatMap(session -> {
                    if (!queuedRequest.getEntrySource().equals(session.profile())) {
                        return finishClaimedRequest(queuedRequest, "failed", "会话入口来源与请求不一致", null);
                    }
                    ActiveRequestExecution active = new ActiveRequestExecution(queuedRequest.getId(), queuedRequest.getUserId(),
                            session.id(), new AtomicReference<>(), new AtomicReference<>("success"), new AtomicReference<>(""),
                            new AtomicBoolean());
                    executionRegistry.open(queuedRequest.getUserId(), session.id(), registration -> requestRepository
                            .appendTaskId(queuedRequest.getId(), registration.taskId())
                            .then(requestQueue.isCancelRequested(queuedRequest.getId()))
                            .doOnNext(cancelRequested -> {
                                if (Boolean.TRUE.equals(cancelRequested)) {
                                    executionRegistry.requestCancellation(queuedRequest.getUserId(), session.id());
                                }
                            })
                            .then());
                    Disposable subscription = claimedRequestSubscriptions.get(queuedRequest.getId());
                    if (subscription != null) {
                        executionRegistry.attachSubscription(session.id(), subscription);
                    }
                    activeRequests.put(queuedRequest.getId(), active);
                    eventEmitter.bindRequest(session.id(), queuedRequest.getId());
                    return isRequestCancellationRequested(active)
                            .flatMap(canceled -> Boolean.TRUE.equals(canceled)
                                    ? finishClaimedRequest(queuedRequest, "canceled", "已停止生成", null)
                                    : Mono.fromRunnable(() -> eventEmitter.emit(queuedRequest.getUserId(), AgentEvent.queueStatus(
                                                    session.id(), queuedRequest.getId(), "running", "生成中")))
                                            .then(resolveRetryRequest(queuedRequest.getUserId(), session, request))
                                            .flatMap(effectiveRequest -> executeConversation(queuedRequest.getUserId(), session,
                                                    effectiveRequest, active))
                                            .then(isRequestCancellationRequested(active))
                                            .then(finishClaimedRequest(queuedRequest, active.requestStatus(),
                                                    active.completionMessage().get(), null)))
                            .onErrorResume(exception -> finishClaimedRequest(queuedRequest, "failed", errorMessage(exception), exception));
                });
    }

    /**
     * 查询Redis取消标记，并同步到当前实例的会话执行登记。
     *
     * @param active ActiveRequestExecution 当前请求执行上下文
     * @return Mono<Boolean> 是否已请求取消
     */
    private Mono<Boolean> isRequestCancellationRequested(ActiveRequestExecution active) {
        return requestQueue.isCancelRequested(active.requestId())
                .doOnNext(canceled -> {
                    if (Boolean.TRUE.equals(canceled)) {
                        executionRegistry.requestCancellation(active.userId(), active.sessionId());
                    }
                });
    }

    /**
     * 按当前持久化状态精确取消排队或运行中的请求。
     *
     * @param userId Long 用户ID
     * @param request CreationAgentRequest 请求实体
     * @return Mono<Void> 取消完成信号
     */
    private Mono<Void> cancelRequest(Long userId, CreationAgentRequest request) {
        return switch (request.getStatus()) {
            case "queued" -> cancelQueuedRequest(userId, request);
            case "running" -> cancelRunningRequest(userId, request);
            // 请求已进入终态，无需再取消；幂等返回成功，避免前端因竞态停在「生成中」无法解锁。
            default -> Mono.empty();
        };
    }

    /**
     * 取消仍在Redis等待队列中的请求；若领取竞态已发生则转入运行取消。
     *
     * @param userId Long 用户ID
     * @param request CreationAgentRequest 请求实体
     * @return Mono<Void> 取消完成信号
     */
    private Mono<Void> cancelQueuedRequest(Long userId, CreationAgentRequest request) {
        return requestRepository.cancelQueuedIfQueued(userId, request.getId(), "已停止生成")
                .flatMap(canceled -> {
                    if (Boolean.TRUE.equals(canceled)) {
                        return requestQueue.removeQueuedRequest(userId, request.getEntrySource(), request.getId())
                                // Redis 已领取但数据库尚未切为 running 时，取消会先成功写入数据库。
                                // 此时释放该租约，后续请求无需等待领取线程回收。
                                .then(requestQueue.releaseActiveRequest(userId, request.getEntrySource(), request.getId()))
                                .then(Mono.fromRunnable(() -> eventEmitter.emit(userId, AgentEvent.canceled(request.getSessionId(),
                                        "已停止排队").withRequestId(request.getId()))))
                                .then(requestDispatcher.dispatchAvailable(userId, request.getEntrySource()));
                    }
                    return requestRepository.findByIdForUser(userId, request.getId())
                            .switchIfEmpty(Mono.error(new BusinessException(ErrorCode.RESOURCE_NOT_FOUND, "主Agent请求不存在")))
                            .flatMap(current -> "running".equals(current.getStatus())
                                    ? cancelRunningRequest(userId, current)
                                    : Mono.error(new BusinessException(ErrorCode.RESOURCE_NOT_FOUND, "主Agent请求已结束")));
                });
    }

    /**
     * 取消已运行请求，并向领取实例写入Redis取消标记。
     *
     * @param userId Long 用户ID
     * @param request CreationAgentRequest 请求实体
     * @return Mono<Void> 取消完成信号
     */
    private Mono<Void> cancelRunningRequest(Long userId, CreationAgentRequest request) {
        return requestRepository.cancelRunningIfRunning(userId, request.getId(), "已停止生成")
                .filter(Boolean::booleanValue)
                .switchIfEmpty(Mono.empty())
                .then(requestQueue.markCancelRequested(request.getId()))
                .then(stopClaimedExecution(request.getId()))
                .then(requestRepository.findByIdForUser(userId, request.getId()))
                .flatMap(this::cancelPersistedRequestTasks)
                .doOnSuccess(ignored -> eventEmitter.emit(userId, AgentEvent.canceled(request.getSessionId(),
                        "已停止生成").withRequestId(request.getId())));
    }

    /**
     * 取消已持久化到请求记录中的底层任务和关联计划。
     *
     * @param request CreationAgentRequest 请求实体
     * @return Mono<Void> 取消完成信号
     */
    private Mono<Void> cancelPersistedRequestTasks(CreationAgentRequest request) {
        Mono<Void> cancelPlan = StringUtils.hasText(request.getPlanId())
                ? planRepository.cancelPlan(request.getPlanId())
                : Mono.empty();
        return reactor.core.publisher.Flux.fromIterable(requestRepository.taskIds(request))
                .concatMap(taskId -> aiTaskService.cancelTaskForUser(request.getUserId(), taskId)
                        .onErrorResume(exception -> {
                            log.error("取消已持久化主Agent任务失败: requestId={}, taskId={}", request.getId(), taskId, exception);
                            return Mono.empty();
                        }))
                .then(cancelPlan);
    }

    /**
     * 取消中断请求已登记的任务，并将已创建计划标记为失败。
     *
     * @param request CreationAgentRequest 已中断请求
     * @param message String 中断说明
     * @return Mono<Void> 收尾完成信号
     */
    private Mono<Void> interruptPersistedRequest(CreationAgentRequest request, String message) {
        ActiveRequestExecution active = activeRequests.get(request.getId());
        AgentExecutionRegistry.AgentCancellation cancellation = active == null
                ? AgentExecutionRegistry.AgentCancellation.inactive()
                : executionRegistry.requestCancellation(active.userId(), active.sessionId());
        Set<String> taskIds = new LinkedHashSet<>(requestRepository.taskIds(request));
        cancellation.tasks().forEach(task -> taskIds.add(task.taskId()));
        String planId = StringUtils.hasText(request.getPlanId()) ? request.getPlanId()
                : active == null ? "" : active.planId().get();
        return reactor.core.publisher.Flux.fromIterable(taskIds)
                .concatMap(taskId -> aiTaskService.cancelTaskForUser(request.getUserId(), taskId)
                        .onErrorResume(exception -> {
                            log.error("中断主Agent请求时取消底层任务失败: requestId={}, taskId={}", request.getId(), taskId, exception);
                            return Mono.empty();
                        }))
                .then(completePlanForTerminalRequest(request, planId, message))
                .then(Mono.<Void>fromRunnable(() -> eventEmitter.emit(request.getUserId(),
                        AgentEvent.error(request.getSessionId(), message).withRequestId(request.getId()))))
                .doFinally(signal -> {
                    if (active != null) {
                        executionRegistry.disposeWhenReady(active.sessionId());
                    }
                });
    }

    /**
     * 完成已领取请求并清理本实例执行资源。
     *
     * @param request CreationAgentRequest 请求实体
     * @param status String success、failed或canceled
     * @param message String 终态说明
     * @param exception Throwable 原始异常，可为空
     * @return Mono<Void> 收尾完成信号
     */
    private Mono<Void> finishClaimedRequest(CreationAgentRequest request, String status, String message, Throwable exception) {
        ActiveRequestExecution active = activeRequests.get(request.getId());
        String planId = active == null ? request.getPlanId() : active.planId().get();
        boolean cancellationRequested = active != null && executionRegistry.isCancelRequested(active.sessionId());
        String requestedStatus = cancellationRequested ? "canceled" : status;
        String requestedMessage = cancellationRequested ? "已停止生成" : message;
        return requestRepository.finishRunning(request.getId(), requestedStatus, requestedMessage)
                .flatMap(updated -> {
                    if (!Boolean.TRUE.equals(updated)) {
                        return requestRepository.findById(request.getId())
                                .defaultIfEmpty(request)
                                .flatMap(current -> completePlanForTerminalRequest(current, planId, requestedMessage));
                    }
                    return completePlanForStatus(requestedStatus, planId, requestedMessage, request.getId())
                            .then(Mono.fromRunnable(() -> {
                        if (exception != null && !"canceled".equals(requestedStatus)) {
                            log.error("主Agent对话执行失败: requestId={}, sessionId={}, planId={}",
                                    request.getId(), request.getSessionId(), planId, exception);
                        }
                        if ("failed".equals(requestedStatus)) {
                            eventEmitter.emit(request.getUserId(), AgentEvent.error(request.getSessionId(), requestedMessage)
                                    .withRequestId(request.getId()));
                        } else if ("canceled".equals(requestedStatus)) {
                            eventEmitter.emit(request.getUserId(), AgentEvent.canceled(request.getSessionId(), requestedMessage)
                                    .withRequestId(request.getId()));
                        }
                    }));
                });
    }

    /**
     * 根据主Agent请求的持久化终态收敛关联计划，防止旧实例将中断请求错误覆盖为取消。
     *
     * @param request CreationAgentRequest 当前持久化请求
     * @param fallbackPlanId String 本实例已知但尚未回写的计划ID
     * @param fallbackMessage String 请求记录没有说明时使用的终态说明
     * @return Mono<Void> 计划状态收敛完成信号
     */
    Mono<Void> completePlanForTerminalRequest(CreationAgentRequest request, String fallbackPlanId, String fallbackMessage) {
        if (request == null) {
            return Mono.empty();
        }
        String planId = StringUtils.hasText(request.getPlanId()) ? request.getPlanId() : fallbackPlanId;
        String message = StringUtils.hasText(request.getErrorMessage()) ? request.getErrorMessage() : fallbackMessage;
        return completePlanForStatus(request.getStatus(), planId, message, request.getId());
    }

    /**
     * 按请求终态更新关联计划。
     *
     * @param requestStatus String 主Agent请求状态
     * @param planId String 关联计划ID
     * @param message String 终态说明
     * @param requestId String 主Agent请求ID
     * @return Mono<Void> 计划状态更新完成信号
     */
    private Mono<Void> completePlanForStatus(String requestStatus, String planId, String message, String requestId) {
        if (!StringUtils.hasText(planId)) {
            return Mono.empty();
        }
        Mono<Void> completion = switch (requestStatus) {
            case "canceled" -> planRepository.cancelPlan(planId);
            case "failed" -> planRepository.updatePlanStatus(planId, "failed", message);
            case "interrupted" -> planRepository.markInterruptedPlanFailed(planId, message);
            default -> Mono.empty();
        };
        return completion.onErrorResume(exception -> {
            log.error("收敛主Agent请求关联计划失败: requestId={}, planId={}, requestStatus={}",
                    requestId, planId, requestStatus, exception);
            return Mono.empty();
        });
    }

    /**
     * 清理被取消订阅遗留的本实例执行登记。
     *
     * @param requestId String 主Agent请求ID
     */
    private void clearClaimedRequestExecution(String requestId) {
        ActiveRequestExecution active = activeRequests.remove(requestId);
        if (active != null) {
            executionRegistry.complete(active.sessionId());
            eventEmitter.unbindRequest(active.sessionId(), requestId);
        }
    }

    /**
     * 将请求复制为明确携带服务端会话ID的完整快照。
     *
     * @param request AgentChatRequest 原始请求
     * @param sessionId String 服务端会话ID
     * @return AgentChatRequest 完整请求快照
     */
    private AgentChatRequest requestWithSessionId(AgentChatRequest request, String sessionId) {
        return new AgentChatRequest(sessionId, request.entrySource(), request.message(), request.canvasSnapshot(),
                request.references(), request.attachments(), request.history(), request.creationSettings(),
                request.skillId(), request.settingGraphNodeId(), request.settingGraphSkillSnapshot());
    }

    /**
     * 本实例正在执行的主Agent请求上下文。
     *
     * @param requestId String 主Agent请求ID
     * @param userId Long 用户ID
     * @param sessionId String Agent会话ID
     * @param planId AtomicReference<String> 当前创作计划ID
     * @param completionStatus AtomicReference<String> 请求最终状态
     * @param completionMessage AtomicReference<String> 请求最终说明
     */
    private record ActiveRequestExecution(String requestId, Long userId, String sessionId,
                                          AtomicReference<String> planId,
                                          AtomicReference<String> completionStatus,
                                          AtomicReference<String> completionMessage,
                                          AtomicBoolean cancellationHandled) {

        /**
         * 保存计划执行汇总对应的主Agent请求终态。
         *
         * @param planStatus String 计划执行状态
         * @param message String 计划执行说明
         */
        private void setCompletion(String planStatus, String message) {
            completionStatus.set("canceled".equals(planStatus) ? "canceled"
                    : "success".equals(planStatus) ? "success" : "failed");
            completionMessage.set("success".equals(planStatus) ? "" : (message == null ? "" : message));
        }

        /**
         * 获取可持久化的主Agent请求终态。
         *
         * @return String success、failed或canceled
         */
        private String requestStatus() {
            return completionStatus.get();
        }
    }

    /**
     * 提取适合SSE返回的异常消息。
     *
     * @param exception Throwable 异常
     * @return String 异常消息
     */
    String errorMessage(Throwable exception) {
        if (reactor.core.Exceptions.unwrap(exception) instanceof java.util.concurrent.TimeoutException) {
            return "模型响应超时，本次未完成，请稍后重试";
        }
        return exception instanceof BusinessException && StringUtils.hasText(exception.getMessage())
                ? exception.getMessage()
                : "Agent服务暂不可用，已停止生成";
    }
}
