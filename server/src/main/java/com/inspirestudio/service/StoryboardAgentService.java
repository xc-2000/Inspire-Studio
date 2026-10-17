package com.inspirestudio.service;

import com.alibaba.fastjson2.JSON;
import com.inspirestudio.agent.AgentScopeAgentFactory;
import com.inspirestudio.agent.AgentScopeModelFactory;
import com.inspirestudio.ai.AiTaskSources;
import com.inspirestudio.ai.AiTaskTypes;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.dto.AiTaskDtos;
import com.inspirestudio.dto.StoryboardDtos;
import com.inspirestudio.security.CurrentUserProvider;
import io.agentscope.core.ReActAgent;
import io.agentscope.core.util.JsonSchemaUtils;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import reactor.core.publisher.Mono;

/**
 * 分镜脚本Agent编排、结构化校验与独立积分计费服务。
 *
 * @date     2026-08-08 00:00
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class StoryboardAgentService {

    /** 标准景别集合。 */
    private static final Set<String> SHOT_SIZES = Set.of(
            "大特写", "特写", "近景", "头肩景", "中景", "中远景", "全景", "远景", "大远景", "大全景");

    /** 标准资产类别集合。 */
    private static final Set<String> ASSET_KINDS = Set.of("character", "scene", "prop");

    private static final Set<String> CONTINUITY_TRANSITIONS = Set.of("establish", "continue", "cut", "time-jump", "flashback", "return");
    private static final Pattern SPEECH_QUOTES = Pattern.compile("[“\"]([^”\"]+)[”\"]|「([^」]+)」|『([^』]+)』");
    private static final Pattern SPEECH_WORDS = Pattern.compile("[\\p{IsHan}]|[\\p{L}&&[^\\p{IsHan}]]+|[\\p{N}]+", Pattern.UNICODE_CHARACTER_CLASS);

    /** 最终提示词固定段落标题。 */
    private static final List<String> FINAL_PROMPT_SECTION_TITLES = List.of(
            "镜头规格：", "画面内容：", "场景：", "道具：", "光影氛围：", "运镜：", "声音：", "视觉风格：");

    /** 前七个固定段落之间的分隔符，允许空白字符但不影响最后的多行视觉风格。 */
    private static final Pattern PROMPT_SECTION_SEPARATOR = Pattern.compile("\\n[ \\t]*\\n");

    /** 资产图片提示词模板的类别段落标记，形如“# character”。 */
    private static final Pattern ASSET_PROMPT_SECTION = Pattern.compile("^#\\s*(\\S+)\\s*$");

    /** 资产图片提示词模板的占位符，形如“{{name}}”。 */
    private static final Pattern ASSET_PROMPT_PLACEHOLDER = Pattern.compile("\\{\\{\\s*(\\w+)\\s*\\}\\}");

    /** 当前用户提供器。 */
    private final CurrentUserProvider currentUserProvider;

    /** 文本模型解析工厂。 */
    private final AgentScopeModelFactory modelFactory;

    /** 分镜Agent工厂。 */
    private final AgentScopeAgentFactory agentFactory;

    /** 服务配置。 */
    private final InspireProperties properties;

    /** 积分服务。 */
    private final CreditService creditService;

    /** 系统提示词模板服务。 */
    private final SystemPromptTemplateService promptTemplateService;

    /** AI任务服务。 */
    private final AiTaskService aiTaskService;

    /**
     * 根据剧本文本和用户描述生成分镜与资产清单。
     *
     * @param request GenerateStoryboardRequest 生成请求
     * @return Mono<GenerateStoryboardResponse> 镜头、资产及实际扣费
     */
    public Mono<StoryboardDtos.GenerateStoryboardResponse> generateStoryboard(StoryboardDtos.GenerateStoryboardRequest request) {
        validateGenerateRequest(request);
        return currentUserProvider.currentUserId()
                .flatMap(userId -> modelFactory.resolveTextModel(request.model(),userId)
                        .flatMap(model -> generateWithModel(userId, model, request)));
    }

    /**
     * 根据用户确认后的镜头与资产合成全部中文最终提示词。
     *
     * @param request ComposePromptsRequest 合成请求
     * @return Mono<ComposePromptsResponse> 按稳定镜头标识返回的提示词与实际扣费
     */
    public Mono<StoryboardDtos.ComposePromptsResponse> composePrompts(StoryboardDtos.ComposePromptsRequest request) {
        validateComposeRequest(request);
        return currentUserProvider.currentUserId()
                .flatMap(userId -> modelFactory.resolveTextModel(request.model(),userId)
                        .flatMap(model -> composeWithModel(userId, model, request)));
    }

    /**
     * 为分镜资产创建图片生成任务，提示词由服务端按资产类别模板渲染。
     *
     * @param request CreateAssetImageTaskRequest 资产图片任务请求
     * @return Mono<AiGenerationTaskResponse> 已入队的AI任务
     */
    public Mono<AiTaskDtos.AiGenerationTaskResponse> createAssetImageTask(StoryboardDtos.CreateAssetImageTaskRequest request) {
        validateAssetImageRequest(request);
        Map<String, Object> parameters = new LinkedHashMap<>();
        parameters.put("count", 1);
        parameters.put("quality", request.settings().quality());
        parameters.put("resolution", request.settings().resolution());
        parameters.put("size", request.settings().size());
        parameters.put("storyboardNodeId", request.nodeId().trim());
        parameters.put("storyboardAssetId", request.asset().id().trim());
        AiTaskDtos.CreateAiTaskRequest taskRequest = new AiTaskDtos.CreateAiTaskRequest(
                AiTaskTypes.IMAGE, renderAssetImagePrompt(request), request.model().trim(), parameters, null, null, AiTaskSources.STORYBOARD);
        return aiTaskService.createTask(taskRequest);
    }

    /**
     * 使用已解析模型完成首次分镜生成。
     *
     * @param userId Long 当前用户ID
     * @param model TextModelSelection 已解析模型
     * @param request GenerateStoryboardRequest 生成请求
     * @return Mono<GenerateStoryboardResponse> 生成结果
     */
    private Mono<StoryboardDtos.GenerateStoryboardResponse> generateWithModel(
            Long userId, AgentScopeModelFactory.TextModelSelection model, StoryboardDtos.GenerateStoryboardRequest request) {
        return executeChargedOperation(userId, model.creditCost(), "分镜首次生成", operationId -> callGenerateAgent(userId, operationId, model, request)
                        .timeout(Duration.ofSeconds(storyboardOperationTimeoutSeconds()),
                                Mono.error(new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜规划与复核超时，原分镜保持不变，请重试")))
                        .map(result -> normalizeGeneratedStoryboard(result, request.existingAssets())))
                .map(result -> new StoryboardDtos.GenerateStoryboardResponse(result.shots(), result.assets(), TextTokenBillingService.chargedCredits(model.agentModel())));
    }

    /**
     * 使用已解析模型完成所有镜头提示词合成。
     *
     * @param userId Long 当前用户ID
     * @param model TextModelSelection 已解析模型
     * @param request ComposePromptsRequest 合成请求
     * @return Mono<ComposePromptsResponse> 合成结果
     */
    private Mono<StoryboardDtos.ComposePromptsResponse> composeWithModel(
            Long userId, AgentScopeModelFactory.TextModelSelection model, StoryboardDtos.ComposePromptsRequest request) {
        int credits = multiplyCredits(model.creditCost(), request.shots().size());
        return executeChargedOperation(userId, credits, "分镜提示词合成", operationId -> callComposeAgent(userId, operationId, model, request)
                        .map(result -> validatePromptComposition(request.shots(), request.visualStyle(), result)))
                .map(prompts -> new StoryboardDtos.ComposePromptsResponse(prompts, TextTokenBillingService.chargedCredits(model.agentModel())));
    }

    /**
     * 执行一次需要扣费的同步Agent操作；Agent超时、调用失败或结果校验失败时全额退款。
     *
     * @param userId Long 当前用户ID
     * @param credits int 本次应扣积分
     * @param operationName String 业务操作名称
     * @param operation Function<String, Mono<T>> 带稳定操作标识的实际调用
     * @return Mono<T> 业务结果
     * @param <T> 业务结果类型
     */
    private <T> Mono<T> executeChargedOperation(Long userId, int credits, String operationName,
                                                  Function<String, Mono<T>> operation) {
        String operationId = UUID.randomUUID().toString();
        AtomicBoolean charged = new AtomicBoolean(false);
        return creditService.chargeOperation(userId, operationId, credits, operationName)
                .then(Mono.defer(() -> {
                    charged.set(credits > 0);
                    log.info("开始执行分镜Agent操作: operationId={}, userId={}, operationName={}, credits={}", operationId, userId, operationName, credits);
                    return operation.apply(operationId);
                }))
                .doOnSuccess(ignored -> log.info("分镜Agent操作完成: operationId={}, userId={}, operationName={}", operationId, userId, operationName))
                .onErrorResume(exception -> {
                    if (!charged.get()) {
                        return Mono.error(exception);
                    }
                    log.error("分镜Agent操作失败，准备全额退款: operationId={}, userId={}, operationName={}", operationId, userId, operationName, exception);
                    return creditService.refundOperation(userId, operationId, operationName)
                            .doOnSuccess(ignored -> log.info("分镜Agent操作退款完成: operationId={}, userId={}, operationName={}", operationId, userId, operationName))
                            .then(Mono.error(exception));
                });
    }

    /**
     * 调用Agent生成首次分镜结构。
     *
     * @param userId Long 当前用户ID
     * @param operationId String 稳定操作标识
     * @param model TextModelSelection 已解析模型
     * @param request GenerateStoryboardRequest 生成请求
     * @return Mono<GeneratedStoryboardResult> Agent结构化结果
     */
    private Mono<StoryboardDtos.GeneratedStoryboardResult> callGenerateAgent(
            Long userId, String operationId, AgentScopeModelFactory.TextModelSelection model,
            StoryboardDtos.GenerateStoryboardRequest request) {
        Map<String, Object> input = buildGenerateAgentInput(request);
        return callAgent(userId, operationId, model, input, StoryboardDtos.GeneratedStoryboardResult.class)
                .flatMap(result -> correctGeneratedFields(userId, operationId, model, result))
                .flatMap(result -> reviewGeneratedStoryboard(userId, operationId, model, request, result))
                .flatMap(review -> repairGeneratedContinuity(userId, operationId, model, request, review));
    }

    private Map<String, Object> buildGenerateAgentInput(StoryboardDtos.GenerateStoryboardRequest request) {
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("action", "generateStoryboard");
        input.put("scriptContent", request.scriptContent().trim());
        input.put("instruction", request.instruction().trim());
        input.put("visualStyle", request.visualStyle().trim());
        input.put("existingAssets", request.existingAssets() == null ? List.of() : request.existingAssets());
        input.put("maxShotSeconds", request.maxShotSeconds() == null ? 10 : request.maxShotSeconds());
        input.put("allowedShotSeconds", allowedShotSeconds(request));
        addStoryContext(input, request.storyContext());
        input.put("storyRequirements", "scriptContent 是本次需要拍摄的完整目标章节，必须从开端覆盖到结尾。"
                + "先梳理人物目标、起因、冲突、关键转折、结果，再将每个必要情节落实到按叙事顺序排列的镜头；"
                + "不得仅生成前半段、重复开场、跳过关键因果或只输出预告片。遵守用户明确指定的片段范围。"
                + "storyContext.fullStory 及相邻章节只用于核对故事和人物连续性，不得把全剧或邻章再次塞入当前章节。"
                + "中间章节承接前章结果并保留后章入口，最终章忠实保留原故事结局，不为每一章另造全剧大结局。"
                + "同场相邻镜头保持人物身份、服装、伤势、道具归属、站位朝向、环境时间与光线一致，"
                + "在画面描述中写清起始状态、唯一主要动作及结束状态；下一镜承接动作结果，不重复演一遍。"
                + "场景、时间或人物状态变化必须有剧本依据，以建立镜头、动作或声音过渡交代，不强行接成同一地点。"
                + "对白完整且与镜头时长匹配，内容过多拆成连续镜头，不能靠删对白或省结局压缩。"
                + "返回前核对首尾情节、因果顺序、关键对白和资产身份，没有依据不得补写重大情节。"
                + "小说旁白、内心独白和背景介绍不能原文整段当画面，必须转译为当前镜头可拍摄的可见动作；"
                + "只在 dialogueVoiceover 写实际会听到的说话内容，标明说话人，不要在相邻镜头完整重复同句对白。"
                + "按中文每秒不超过4字、英文每秒不超过2词安排说话时间，预留动作和停顿；对白过多增加镜头，不删减关键故事。"
                + "每镜必须返回 continuity：sceneId 为稳定场景标识，time 为稳定的剧情时间，同场同时间须逐字一致；"
                + "transition 只能取 establish/continue/cut/time-jump/flashback/return，分别表示建立、同场动作接续、切镜、时间跳跃、回忆、回到当前。"
                + "开章首镜使用 establish/cut/flashback/return/time-jump 中适合的一项，禁止 continue；在文本中承接前章结果。"
                + "同场动作接续使用 continue，禁止同时改变 sceneId 或 time；回忆/回到现实必须显式标明。"
                + "openingState 写可拍摄首帧的人物位置朝向、服装、道具和动作阶段；closingState 写已完成动作及其结果；"
                + "storyBeat 写本镜推进哪条因果、冲突或转折，末镜写清本章实际结局或承接点，不得只重复人物情绪。"
                + "existingAssets 是现有角色/场景/道具设定，同一实体必须复用 id 作为 referenceKey 并原样保留名称和身份描述，"
                + "不要换名重建角色，不把邻章未出现的资产强行放入当前章节。每镜时长必须严格取 allowedShotSeconds 列表中的值，"
                + "这是视频模型真正支持的时长，不得自行在1到maxShotSeconds之间任选；例如仅[10]时所有镜头都用10秒，[5,10,15]不能用7秒。"
                + "对白超出所选视频模型时长时拆镜并前后接续，不能延长到模型上限之外。镜头最多100个，禁止为了数量限制只拍前半章。");
        return input;
    }

    private void addStoryContext(Map<String, Object> input, StoryboardDtos.StoryContext context) {
        if (context != null) input.put("storyContext", context);
    }

    private List<Integer> allowedShotSeconds(StoryboardDtos.GenerateStoryboardRequest request) {
        if (request.allowedShotSeconds() != null && !request.allowedShotSeconds().isEmpty()) {
            return request.allowedShotSeconds().stream().distinct().sorted().toList();
        }
        return java.util.stream.IntStream.rangeClosed(1, request.maxShotSeconds() == null ? 10 : request.maxShotSeconds())
                .boxed().toList();
    }

    /** 一次有界修订：保留完整原文和全部镜头，不以截断台词或删除后半章绕过生产校验。 */
    private Mono<StoryboardDtos.GeneratedStoryboardResult> repairGeneratedContinuity(
            Long userId, String operationId, AgentScopeModelFactory.TextModelSelection model,
            StoryboardDtos.GenerateStoryboardRequest request, StoryboardReview review) {
        var result = review.result();
        int maxSeconds = request.maxShotSeconds() == null ? 10 : request.maxShotSeconds();
        List<Integer> allowedSeconds = allowedShotSeconds(request);
        List<String> issues = new ArrayList<>(generatedContinuityIssues(result, maxSeconds, allowedSeconds));
        issues.addAll(review.narrativeIssues());
        if (issues.isEmpty()) return Mono.just(result);
        Map<String, Object> input = buildGenerateAgentInput(request);
        input.put("action", "repairStoryboardContinuity");
        input.put("previousResult", result);
        input.put("validationIssues", issues);
        input.put("repairInstruction", "依据完整原始章节修订 previousResult，返回全部 shots 和 assets，而非补丁。"
                + "逐项修正 validationIssues，允许将对白过长的镜头拆分并顺序重新编号，但保留全部必要因果和章节结尾；"
                + "将重复演出的同一句长对白只安排在真正发生的一镜，不靠删掉故事结果或随意拉长一个镜头规避检查。"
                + "保持原有资产 referenceKey 和规范身份。每镜 continuity 所有字段必须明确，转场和首尾动作必须可拍摄。"
                + "这是唯一一次自动修订，修订后仍不合格将拒绝本次结果，不能返回未解决的问题。");
        log.info("修订分镜连续性: operationId={}, issues={}", operationId, issues.size());
        return callAgent(userId, operationId + ":continuity-repair", model, input, StoryboardDtos.GeneratedStoryboardResult.class)
                .flatMap(repaired -> correctGeneratedFields(userId, operationId + ":repaired", model, repaired))
                .flatMap(repaired -> reviewGeneratedStoryboard(userId, operationId + ":repaired", model, request, repaired))
                .map(repaired -> {
                    if (!repaired.narrativeIssues().isEmpty()) throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR,
                            "剧情完整性复检未通过，原分镜保持不变：" + String.join("；", repaired.narrativeIssues().stream().limit(5).toList()));
                    return requireGeneratedContinuity(repaired.result(), maxSeconds, allowedSeconds);
                });
    }

    private StoryboardDtos.GeneratedStoryboardResult requireGeneratedContinuity(StoryboardDtos.GeneratedStoryboardResult result) {
        return requireGeneratedContinuity(result, 10);
    }

    private StoryboardDtos.GeneratedStoryboardResult requireGeneratedContinuity(StoryboardDtos.GeneratedStoryboardResult result, int maxSeconds) {
        return requireGeneratedContinuity(result, maxSeconds, List.of());
    }

    private StoryboardDtos.GeneratedStoryboardResult requireGeneratedContinuity(StoryboardDtos.GeneratedStoryboardResult result,
                                                                                int maxSeconds, List<Integer> allowedSeconds) {
        List<String> issues = generatedContinuityIssues(result, maxSeconds, allowedSeconds);
        if (!issues.isEmpty()) {
            throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR,
                    "分镜连续性检查未通过，原分镜保持不变：" + String.join("；", issues.stream().limit(5).toList()));
        }
        return result;
    }

    /** 校验能被确定的生产问题，语义上的完整因果由完整原文和每镜 storyBeat 驱动规划。 */
    private List<String> generatedContinuityIssues(StoryboardDtos.GeneratedStoryboardResult result) {
        return generatedContinuityIssues(result, 10);
    }

    private List<String> generatedContinuityIssues(StoryboardDtos.GeneratedStoryboardResult result, int maxSeconds) {
        return generatedContinuityIssues(result, maxSeconds, List.of());
    }

    private List<String> generatedContinuityIssues(StoryboardDtos.GeneratedStoryboardResult result, int maxSeconds, List<Integer> allowedSeconds) {
        List<String> issues = new ArrayList<>();
        if (result == null || result.shots() == null || result.shots().isEmpty()) return List.of("没有返回完整章节镜头");
        if (result.shots().size() > StoryboardDtos.MAX_SHOT_COUNT) return List.of("镜头超过100个，请按完整章节重新规划，不得截断结局");
        Map<String, Integer> spokenBefore = new LinkedHashMap<>();
        for (int index = 0; index < result.shots().size(); index++) {
            final int position = index + 1;
            var shot = result.shots().get(index);
            String label = "第" + (index + 1) + "镜";
            if (shot == null) { issues.add(label + "为空"); continue; }
            if (shot.durationSeconds() == null || shot.durationSeconds() < 1 || shot.durationSeconds() > maxSeconds) {
                issues.add(label + "时长必须在1到" + maxSeconds + "秒内，长对白须拆成多个衔接镜头");
            } else if (!allowedSeconds.isEmpty() && !allowedSeconds.contains(shot.durationSeconds())) {
                issues.add(label + "的" + shot.durationSeconds() + "秒不受视频模型支持，仅支持" + allowedSeconds + "秒，须按可用时长重新安排动作和对白");
            }
            var state = shot.continuity();
            if (state == null) {
                issues.add(label + "缺少结构化场景、转场与首尾状态");
            } else {
                if (!requiredBounded(state.sceneId(), 160) || !requiredBounded(state.time(), 300)
                        || !requiredBounded(state.openingState(), 2000) || !requiredBounded(state.closingState(), 2000)
                        || !requiredBounded(state.storyBeat(), 1000)) issues.add(label + "连续性字段缺失或超长");
                if (!CONTINUITY_TRANSITIONS.contains(normalizeOptionalText(state.transition()))) issues.add(label + "转场类型不合法");
                if (index == 0 && "continue".equals(state.transition())) issues.add(label + "没有本章前镜，须先建立场景并用文本承接前章");
                if (index > 0 && "continue".equals(state.transition())) {
                    var previous = result.shots().get(index - 1);
                    var previousState = previous == null ? null : previous.continuity();
                    if (previousState != null && (!normalizeOptionalText(previousState.sceneId()).equals(normalizeOptionalText(state.sceneId()))
                            || !normalizeOptionalText(previousState.time()).equals(normalizeOptionalText(state.time())))) {
                        issues.add(label + "标为同场接续但场景或时间改变，请明确转场");
                    }
                }
            }
            List<String> spokenSegments = spokenSegments(shot.dialogueVoiceover());
            int units = spokenSegments.stream().mapToInt(this::spokenUnits).sum();
            if (shot.durationSeconds() != null && shot.durationSeconds() > 0 && units > shot.durationSeconds() * 4L) {
                issues.add(label + "台词约" + units + "字量，" + shot.durationSeconds() + "秒内无法自然说完，请拆分镜头");
            }
            for (String speech : spokenSegments) {
                String normalized = speech.replaceAll("[^\\p{L}\\p{N}]", "").toLowerCase(java.util.Locale.ROOT);
                if (spokenUnits(speech) < 16) continue;
                Integer duplicate = spokenBefore.entrySet().stream()
                        .filter(entry -> !entry.getValue().equals(position)
                                && (entry.getKey().contains(normalized) || normalized.contains(entry.getKey())))
                        .map(Map.Entry::getValue).findFirst().orElse(null);
                if (duplicate != null) issues.add(label + "与第" + duplicate + "镜重复完整长台词");
                spokenBefore.putIfAbsent(normalized, index + 1);
            }
        }
        return List.copyOf(issues);
    }

    private boolean requiredBounded(String value, int limit) {
        return StringUtils.hasText(value) && value.length() <= limit;
    }

    private List<String> spokenSegments(String value) {
        if (!StringUtils.hasText(value) || Set.of("无", "无对白", "无旁白", "无对白或旁白", "无对白/旁白", "none").contains(value.trim().toLowerCase(java.util.Locale.ROOT))) return List.of();
        List<String> parts = new ArrayList<>();
        Matcher quotes = SPEECH_QUOTES.matcher(value);
        while (quotes.find()) {
            for (int group = 1; group <= quotes.groupCount(); group++) if (quotes.group(group) != null) parts.add(quotes.group(group));
        }
        if (!parts.isEmpty()) return parts;
        for (String line : value.split("[\\n；;]+")) {
            String speech = line.replaceAll("[（(][^）)]*[）)]|\\[[^\\]]*\\]|【[^】]*】", "")
                    .replaceFirst("^[^：:]{1,24}[：:]", "").trim();
            if (!speech.isEmpty()) parts.add(speech);
        }
        return parts;
    }

    private int spokenUnits(String value) {
        Matcher words = SPEECH_WORDS.matcher(value);
        int units = 0;
        while (words.find()) units += Character.UnicodeScript.of(words.group().codePointAt(0)) == Character.UnicodeScript.HAN ? 1 : 2;
        return units;
    }

    /** 逐镜头复核可见资产，防止“引用合法”却遗漏关键道具、内景或外景。 */
    private Mono<StoryboardReview> reviewGeneratedStoryboard(
            Long userId, String operationId, AgentScopeModelFactory.TextModelSelection model,
            StoryboardDtos.GenerateStoryboardRequest request, StoryboardDtos.GeneratedStoryboardResult result) {
        // 先拒绝无效结构，不将错误数据交给完整性审查。
        normalizeGeneratedStoryboard(result);
        List<Map<String, Object>> shots = new ArrayList<>();
        for (int i = 0; i < result.shots().size(); i++) shots.add(Map.of("index", i, "shot", result.shots().get(i)));
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("action", "reviewStoryboardProduction");
        input.put("shots", shots);
        input.put("assets", result.assets() == null ? List.of() : result.assets());
        input.put("visualStyle", request.visualStyle());
        input.put("scriptContent", request.scriptContent());
        input.put("requestedScope", request.instruction());
        input.put("existingAssets", request.existingAssets() == null ? List.of() : request.existingAssets());
        addStoryContext(input, request.storyContext());
        input.put("instruction", "你是复核员。先将 scriptContent 中的起因、目标、冲突、转折、结果逐项映射到镜头，"
                        + "必须阅读全文末段，确认原文章节的最后事件、结果或悬念实际已拍到，不能把起止镜头都有内容当成故事完整。"
                        + "requestedScope 若明确只要片段则按该范围；邻章仅供背景，不要求本章拍完整部小说，也不得凭空增加结局。"
                        + "检查时间顺序、动作先后、场景跳转、可见人物的身份外观、道具归属、重复对白/动作、"
                        + "内心或背景长段落是否被误当作一镜画面，以及关键因果有没有被省去。"
                        + "narrativeComplete 只有上述均成立才为 true，narrativeIssues 必须为数组。"
                        + "每条问题写明原文事件或短引用、具体镜号或缺失位置、应保留的因果/结尾；不要泛泛要求更精彩。"
                        + "不要仅因镜头很多而通过，也不要臆造原文没有的矛盾。旧角色设定冲突需指出并恢复 existingAssets。"
                        + "然后逐镜头检查 visualDescription 中实际可见的人物、场景和关键道具。"
                        + "返回 additions（仅遗漏资产）与 shots（每个 index 的完整资产引用数组）。"
                        + "不要限于主要人物和大型物件：动作使用或特写的刀具、手机、安全带等关键道具必须独立提取，"
                        + "驾驶室、车厢内部、道路等不同拍摄环境必须建立场景资产，不能用车辆道具替代内景。"
                        + "仅旁白提及但未出现在画面的人物物品不提取，不为普通身体部位、光线、情绪建资产。"
                        + "已有同一资产必须复用原 referenceKey，不按镜头重复创建，不因名称修饰不同新增同一实体。"
                        + "新增资产使用唯一 referenceKey，kind 为 character/scene/prop；name 和 description 为中文且非空。"
                        + "每个镜头必须返回 index 和 assetReferenceKeys，关联画面中实际可见的资产，移除错误关联，禁止漏镜头。"
                        + "没有遗漏时 additions=[]。不得修改镜头内容。只复核和补资产，不在本次审查中偷偷重写剧情。");
        return callAgent(userId, operationId + ":coverage", model, input, StoryboardDtos.AssetCoverageResult.class)
                .map(coverage -> new StoryboardReview(applyAssetCoverage(result, coverage), narrativeReviewIssues(coverage)));
    }

    private List<String> narrativeReviewIssues(StoryboardDtos.AssetCoverageResult review) {
        if (review == null || review.narrativeComplete() == null || review.narrativeIssues() == null
                || review.narrativeIssues().size() > 100
                || review.narrativeIssues().stream().anyMatch(issue -> !requiredBounded(issue, 2000))) {
            throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "剧情完整性检查结果不完整，请重试");
        }
        if (!review.narrativeComplete() && review.narrativeIssues().isEmpty()) {
            return List.of("原文剧情覆盖检查未通过，请逐项核对原文因果与最后事件，完整拍到章节结尾");
        }
        return List.copyOf(review.narrativeIssues());
    }

    private record StoryboardReview(StoryboardDtos.GeneratedStoryboardResult result, List<String> narrativeIssues) {}

    private StoryboardDtos.GeneratedStoryboardResult applyAssetCoverage(
            StoryboardDtos.GeneratedStoryboardResult original, StoryboardDtos.AssetCoverageResult coverage) {
        if (coverage == null || coverage.additions() == null || coverage.shots() == null
                || coverage.shots().size() != original.shots().size() || coverage.additions().size() > 300) {
            throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "资产完整性检查结果不完整，请重试");
        }
        List<StoryboardDtos.GeneratedStoryboardAsset> assets = new ArrayList<>(original.assets() == null ? List.of() : original.assets());
        Map<String, String> keysByName = new LinkedHashMap<>();
        Map<String, String> aliases = new LinkedHashMap<>();
        Set<String> keys = new LinkedHashSet<>();
        for (var asset : assets) {
            keys.add(asset.referenceKey());
            keysByName.put(normalizeGeneratedAssetKind(asset.kind()) + ":" + asset.name().trim(), asset.referenceKey());
        }
        Set<String> addedKeys = new LinkedHashSet<>();
        for (var asset : coverage.additions()) {
            if (asset == null || asset.kind() == null) throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "新增资产类别不合法");
            String key = normalizeRequiredText(asset.referenceKey(), "新增资产引用键");
            String name = normalizeRequiredText(asset.name(), "新增资产名称");
            if (keys.contains(key) || aliases.containsKey(key)) throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "新增资产引用键重复");
            String existing = keysByName.get(asset.kind().name() + ":" + name);
            if (existing != null) { aliases.put(key, existing); continue; }
            assets.add(new StoryboardDtos.GeneratedStoryboardAsset(asset.kind().name(), key, name,
                    normalizeRequiredText(asset.description(), "新增资产描述")));
            keys.add(key);
            addedKeys.add(key);
            keysByName.put(asset.kind().name() + ":" + name, key);
        }
        Map<Integer, List<String>> references = new LinkedHashMap<>();
        Set<String> used = new LinkedHashSet<>();
        for (var shot : coverage.shots()) {
            if (shot == null || shot.index() == null || shot.index() < 0 || shot.index() >= original.shots().size()
                    || references.containsKey(shot.index()) || shot.assetReferenceKeys() == null) {
                throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "资产完整性检查的镜头标识不合法");
            }
            Set<String> refs = new LinkedHashSet<>();
            for (String value : shot.assetReferenceKeys()) {
                String key = normalizeRequiredText(value, "镜头资产引用");
                key = aliases.getOrDefault(key, key);
                if (!keys.contains(key)) throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "资产完整性检查引用了不存在的资产");
                refs.add(key);
            }
            used.addAll(refs);
            references.put(shot.index(), List.copyOf(refs));
        }
        if (!used.containsAll(addedKeys)) throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "新增资产未关联任何镜头");
        List<StoryboardDtos.GeneratedStoryboardShot> shots = new ArrayList<>();
        for (int i = 0; i < original.shots().size(); i++) {
            var shot = original.shots().get(i);
            shots.add(new StoryboardDtos.GeneratedStoryboardShot(shot.shotNumber(), shot.durationSeconds(), shot.visualDescription(),
                    shot.shotSize(), shot.lightingAtmosphere(), shot.dialogueVoiceover(), shot.soundEffect(), shot.cameraMovement(), references.get(i), shot.continuity()));
        }
        var result = new StoryboardDtos.GeneratedStoryboardResult(List.copyOf(shots), List.copyOf(assets));
        normalizeGeneratedStoryboard(result);
        return result;
    }

    /** 仅对不合规的分类字段进行一次小范围纠正，不重新生成剧本或覆盖其他镜头内容。 */
    private Mono<StoryboardDtos.GeneratedStoryboardResult> correctGeneratedFields(
            Long userId, String operationId, AgentScopeModelFactory.TextModelSelection model,
            StoryboardDtos.GeneratedStoryboardResult result) {
        if (result == null || result.shots() == null || result.shots().isEmpty()
                || result.shots().size() > StoryboardDtos.MAX_SHOT_COUNT
                || (result.assets() != null && result.assets().size() > 300)) return Mono.justOrEmpty(result);
        List<Map<String, Object>> assets = new ArrayList<>();
        List<Map<String, Object>> shots = new ArrayList<>();
        Set<String> availableAssetKeys = new LinkedHashSet<>();
        if (result.assets() != null) {
            result.assets().stream().filter(java.util.Objects::nonNull).forEach(asset -> availableAssetKeys.add(normalizeOptionalText(asset.referenceKey())));
        }
        for (int i = 0; result.assets() != null && i < result.assets().size(); i++) {
            var asset = result.assets().get(i);
            if (asset != null && (!StringUtils.hasText(asset.kind()) || normalizeGeneratedAssetKind(asset.kind()) == null)) {
                assets.add(Map.of("index", i, "asset", asset));
            }
        }
        for (int i = 0; i < result.shots().size(); i++) {
            var shot = result.shots().get(i);
            if (shot != null && (!StringUtils.hasText(shot.shotSize()) || normalizeGeneratedShotSize(shot.shotSize()) == null
                    || shot.assetReferenceKeys() == null
                    || shot.assetReferenceKeys().stream().anyMatch(key -> !availableAssetKeys.contains(normalizeOptionalText(key))))) {
                shots.add(Map.of("index", i, "shot", shot));
            }
        }
        if (assets.isEmpty() && shots.isEmpty()) return Mono.just(result);
        log.info("纠正分镜分类字段: operationId={}, assets={}, shots={}", operationId, assets.size(), shots.size());
        Map<String, Object> input = Map.of("action", "correctStoryboardFields", "assets", assets, "shots", shots,
                "availableAssets", result.assets() == null ? List.of() : result.assets(),
                "instruction", "仅按上下文纠正所列资产类别和镜头景别，每个 index 必须原样返回且仅出现一次。"
                        + "assets 返回 index、kind（character/scene/prop）；shots 返回 index、shotSize（十种标准景别之一）、assetReferenceKeys。"
                        + "assetReferenceKeys 必须是数组，只能使用 availableAssets 中的 referenceKey，依据镜头描述关联资产；没有关联资产返回 []，禁止省略。"
                        + "人物和动物属于 character，地点环境属于 scene，车辆设备物品属于 prop。"
                        + "按画面描述判断拍摄范围，角度和机位不能作为景别。不要输出未列出的 index，空列表返回 []。");
        return callAgent(userId, operationId + ":fields", model, input, StoryboardDtos.StoryboardFieldCorrections.class)
                .map(corrections -> applyGeneratedFieldCorrections(result, corrections,
                        assets.stream().map(item -> (Integer) item.get("index")).collect(java.util.stream.Collectors.toSet()),
                        shots.stream().map(item -> (Integer) item.get("index")).collect(java.util.stream.Collectors.toSet())));
    }

    private StoryboardDtos.GeneratedStoryboardResult applyGeneratedFieldCorrections(
            StoryboardDtos.GeneratedStoryboardResult result, StoryboardDtos.StoryboardFieldCorrections corrections,
            Set<Integer> assetIndices, Set<Integer> shotIndices) {
        if (corrections == null || corrections.assets() == null || corrections.shots() == null
                || corrections.assets().size() != assetIndices.size() || corrections.shots().size() != shotIndices.size()) {
            throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜分类纠正结果不完整，请重新生成");
        }
        List<StoryboardDtos.GeneratedStoryboardAsset> assets = new ArrayList<>(result.assets() == null ? List.of() : result.assets());
        List<StoryboardDtos.GeneratedStoryboardShot> shots = new ArrayList<>(result.shots());
        Set<Integer> remainingAssets = new LinkedHashSet<>(assetIndices);
        Set<Integer> remainingShots = new LinkedHashSet<>(shotIndices);
        Set<String> availableKeys = assets.stream().filter(java.util.Objects::nonNull)
                .map(asset -> normalizeOptionalText(asset.referenceKey())).collect(java.util.stream.Collectors.toSet());
        for (var correction : corrections.assets()) {
            if (correction == null || correction.kind() == null || !remainingAssets.remove(correction.index())) {
                throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜资产类别纠正结果不合法，请重新生成");
            }
            var original = assets.get(correction.index());
            assets.set(correction.index(), new StoryboardDtos.GeneratedStoryboardAsset(
                    correction.kind().name(), original.referenceKey(), original.name(), original.description()));
        }
        for (var correction : corrections.shots()) {
            if (correction == null || correction.shotSize() == null || correction.assetReferenceKeys() == null || !remainingShots.remove(correction.index())) {
                throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜景别纠正结果不合法，请重新生成");
            }
            var original = shots.get(correction.index());
            String originalNormalizedSize = StringUtils.hasText(original.shotSize()) ? normalizeGeneratedShotSize(original.shotSize()) : null;
            String movement = originalNormalizedSize == null && StringUtils.hasText(original.shotSize())
                    ? preserveGeneratedShotSizeDescription(original.shotSize(), original.cameraMovement()) : original.cameraMovement();
            List<String> references = original.assetReferenceKeys() != null
                    && original.assetReferenceKeys().stream().allMatch(key -> availableKeys.contains(normalizeOptionalText(key)))
                    ? original.assetReferenceKeys() : correction.assetReferenceKeys();
            shots.set(correction.index(), new StoryboardDtos.GeneratedStoryboardShot(original.shotNumber(), original.durationSeconds(),
                    original.visualDescription(), originalNormalizedSize == null ? correction.shotSize().name() : original.shotSize(), original.lightingAtmosphere(),
                    original.dialogueVoiceover(), original.soundEffect(), movement, references, original.continuity()));
        }
        return new StoryboardDtos.GeneratedStoryboardResult(List.copyOf(shots), List.copyOf(assets));
    }

    /**
     * 调用Agent合成全部镜头提示词。
     *
     * @param userId Long 当前用户ID
     * @param operationId String 稳定操作标识
     * @param model TextModelSelection 已解析模型
     * @param request ComposePromptsRequest 合成请求
     * @return Mono<PromptCompositionResult> Agent结构化结果
     */
    private Mono<StoryboardDtos.PromptCompositionResult> callComposeAgent(
            Long userId, String operationId, AgentScopeModelFactory.TextModelSelection model,
            StoryboardDtos.ComposePromptsRequest request) {
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("action", "composePromptContent");
        input.put("scriptContent", request.scriptContent().trim());
        input.put("instruction", request.instruction().trim());
        input.put("visualStyle", request.visualStyle().trim());
        addStoryContext(input, request.storyContext());
        input.put("shots", buildComposeAgentShots(request));
        input.put("outputInstruction", "返回 prompts 数组，每项包含 shotId、visualDescription、openingState、closingState、transitionFromPrevious。"
                + "shotId 逐字复制镜头 id，每个镜头恰好一项。visualDescription 为一段简体中文画面提示词，"
                + "融合原画面内容、关联人物外貌及动作、构图和指定视觉风格，不得臆造未关联的资产。"
                + "sequenceIndex 是镜头在完整章节中的播放位置，不按镜号重排。previousShot 和 nextShot 仅供衔接参考，禁止复述邻镜整段剧情。"
                + "openingState 写本镜第一帧的位置、朝向、动作阶段和道具状态；closingState 写本镜结束时已完成的动作与停留状态；"
                + "同场镜头的 openingState 必须承接上一镜 closingState，不重演已完成动作。"
                + "transitionFromPrevious 说明本镜与上镜是同场接续、视角切换还是有剧情依据的时间/地点转场；"
                + "首镜衔接 previousChapter（若有），否则建立当前故事起点。换场时不得把上一场地点、光线或未出场人物强行带入。"
                + "保留人物身份、服装、伤势、持物手和运动方向；只有剧本明确变化才可改变；邻镜中未关联的资产不得出现在当前画面。"
                + "所有状态字段须为简短中文，不使用段落标题或空行；只拍当前镜头的动作和对白，不加入后续剧情，不把每镜都做成开场或收尾。"
                + "如果镜头提供 continuity，它是已确认的场景、时间、转场和首尾状态，必须原样遵循，不能重新改写动作结果或隐去回忆/时间跳跃。"
                + "不要输出 finalPrompt、段落标题或八段格式，固定段落由服务端组装。");
        return callAgent(userId, operationId, model, input, StoryboardDtos.PromptContentResult.class)
                .map(result -> renderComposedPrompts(request, result));
    }

    private StoryboardDtos.PromptCompositionResult renderComposedPrompts(
            StoryboardDtos.ComposePromptsRequest request, StoryboardDtos.PromptContentResult result) {
        if (result == null || result.prompts() == null || result.prompts().size() != request.shots().size()) {
            throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent返回的提示词数量与镜头数量不一致");
        }
        Set<String> expectedIds = request.shots().stream().map(StoryboardDtos.StoryboardShot::id).collect(java.util.stream.Collectors.toSet());
        Map<String, StoryboardDtos.StoryboardShot> shotsById = request.shots().stream()
                .collect(java.util.stream.Collectors.toMap(StoryboardDtos.StoryboardShot::id, Function.identity()));
        Map<String, String> descriptions = new LinkedHashMap<>();
        for (var content : result.prompts()) {
            if (content == null || !expectedIds.contains(content.shotId()) || descriptions.containsKey(content.shotId())) {
                throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent返回了缺失、重复或额外的镜头标识");
            }
            String description = normalizeRequiredText(content.visualDescription(), "分镜Agent返回的画面内容");
            if (!isChinesePrompt(description)) {
                throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent返回的最终提示词必须以中文为主");
            }
            List<String> visualParts = new ArrayList<>();
            visualParts.add(promptParagraph(description));
            var confirmed = shotsById.get(content.shotId()).continuity();
            appendContinuityPart(visualParts, "首帧状态", confirmed != null ? confirmed.openingState() : content.openingState());
            appendContinuityPart(visualParts, "结束状态", confirmed != null ? confirmed.closingState() : content.closingState());
            if (confirmed != null) {
                appendContinuityPart(visualParts, "场景时间", confirmed.sceneId() + " / " + confirmed.time());
                appendContinuityPart(visualParts, "镜头衔接", continuityTransitionLabel(confirmed.transition()));
                appendContinuityPart(visualParts, "剧情推进", confirmed.storyBeat());
            } else appendContinuityPart(visualParts, "镜头衔接", content.transitionFromPrevious());
            descriptions.put(content.shotId(), String.join("；", visualParts));
        }
        List<StoryboardDtos.StoryboardAsset> assets = request.assets() == null ? List.of() : request.assets();
        List<StoryboardDtos.StoryboardPrompt> prompts = request.shots().stream().map(shot -> {
            String scene = describePromptAssets(shot, assets, "scene");
            String props = describePromptAssets(shot, assets, "prop");
            String characters = describePromptAssets(shot, assets, "character");
            String visualDescription = descriptions.get(shot.id());
            if (!"无".equals(characters)) visualDescription += "；角色身份与外观保持一致：" + characters;
            List<String> sounds = new ArrayList<>();
            if (StringUtils.hasText(shot.dialogueVoiceover())) sounds.add("对白或旁白：" + promptParagraph(shot.dialogueVoiceover()));
            if (StringUtils.hasText(shot.soundEffect())) sounds.add("音效：" + promptParagraph(shot.soundEffect()));
            String prompt = String.join("\n\n",
                    "镜头规格：" + shot.shotSize().trim() + "，" + shot.durationSeconds() + " 秒。",
                    "画面内容：" + visualDescription,
                    "场景：" + scene,
                    "道具：" + props,
                    "光影氛围：" + promptParagraph(shot.lightingAtmosphere()),
                    "运镜：" + promptParagraph(shot.cameraMovement()),
                    "声音：" + (sounds.isEmpty() ? "无" : String.join("；", sounds)),
                    "视觉风格：" + normalizeLineBreaks(request.visualStyle().trim()));
            return new StoryboardDtos.StoryboardPrompt(shot.id(), prompt);
        }).toList();
        return new StoryboardDtos.PromptCompositionResult(prompts);
    }

    private void appendContinuityPart(List<String> parts, String label, String content) {
        if (!StringUtils.hasText(content)) return;
        if (content.length() > 2000) {
            throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent返回的镜头衔接说明过长");
        }
        parts.add(label + "：" + promptParagraph(content));
    }

    private String continuityTransitionLabel(String transition) {
        return switch (normalizeOptionalText(transition)) {
            case "establish" -> "建立当前场景与故事起点";
            case "continue" -> "同场承接上一镜已完成的动作，不重演";
            case "cut" -> "切换镜头，按当前场景重新构图";
            case "time-jump" -> "时间跳转，用建立镜头交代新的时间与地点";
            case "flashback" -> "进入回忆，明确与现实时间的区别";
            case "return" -> "结束回忆，回到当前故事时间";
            default -> normalizeOptionalText(transition);
        };
    }

    private String describePromptAssets(StoryboardDtos.StoryboardShot shot, List<StoryboardDtos.StoryboardAsset> assets, String kind) {
        String text = assets.stream().filter(asset -> kind.equals(asset.kind()) && shot.assetIds().contains(asset.id()))
                .map(asset -> promptParagraph(asset.name()) + (StringUtils.hasText(asset.description()) ? "（" + promptParagraph(asset.description()) + "）" : ""))
                .collect(java.util.stream.Collectors.joining("；"));
        return text.isEmpty() ? "无" : text;
    }

    private String promptParagraph(String text) {
        return StringUtils.hasText(text) ? normalizeLineBreaks(text).trim().replaceAll("\\s*\\n\\s*", " ") : "无";
    }

    /**
     * 构建按镜头裁剪资产后的Agent输入，避免无关资产影响最终提示词。
     *
     * @param request ComposePromptsRequest 已校验的提示词合成请求
     * @return List<Map<String, Object>> 每个镜头及其关联资产
     */
    private List<Map<String, Object>> buildComposeAgentShots(StoryboardDtos.ComposePromptsRequest request) {
        Map<String, StoryboardDtos.StoryboardAsset> assetsById = new LinkedHashMap<>();
        for (StoryboardDtos.StoryboardAsset asset : request.assets() == null ? List.<StoryboardDtos.StoryboardAsset>of() : request.assets()) {
            assetsById.put(asset.id(), asset);
        }
        List<StoryboardDtos.StoryboardShot> sequence = request.sequenceShots() == null
                ? request.shots() : request.sequenceShots();
        Map<String, Integer> sequencePositions = new LinkedHashMap<>();
        Map<String, StoryboardDtos.StoryboardShot> requestedShots = new LinkedHashMap<>();
        for (int index = 0; index < sequence.size(); index++) sequencePositions.put(sequence.get(index).id(), index);
        for (var shot : request.shots()) requestedShots.put(shot.id(), shot);
        List<Map<String, Object>> shots = new ArrayList<>();
        for (var shot : request.shots()) {
            int index = sequencePositions.get(shot.id());
            Map<String, Object> input = new LinkedHashMap<>();
            input.put("id", shot.id());
            input.put("shotNumber", shot.shotNumber());
            input.put("durationSeconds", shot.durationSeconds());
            input.put("visualDescription", shot.visualDescription());
            input.put("shotSize", shot.shotSize());
            input.put("lightingAtmosphere", shot.lightingAtmosphere());
            input.put("dialogueVoiceover", shot.dialogueVoiceover());
            input.put("soundEffect", shot.soundEffect());
            input.put("cameraMovement", shot.cameraMovement());
            input.put("continuity", shot.continuity());
            input.put("associatedAssets", shot.assetIds().stream().map(assetsById::get).toList());
            input.put("sequenceIndex", index + 1);
            input.put("sequenceCount", sequence.size());
            if (index > 0) {
                var previous = sequence.get(index - 1);
                input.put("previousShot", describeAdjacentShot(requestedShots.getOrDefault(previous.id(), previous)));
            }
            if (index + 1 < sequence.size()) {
                var next = sequence.get(index + 1);
                input.put("nextShot", describeAdjacentShot(requestedShots.getOrDefault(next.id(), next)));
            }
            shots.add(input);
        }
        return List.copyOf(shots);
    }

    /** 不嵌套最终提示词或资产说明，避免把邻镜提示词/无关资产注入当前画面。 */
    private Map<String, Object> describeAdjacentShot(StoryboardDtos.StoryboardShot shot) {
        Map<String, Object> context = new LinkedHashMap<>();
        context.put("id", shot.id());
        context.put("visualDescription", shot.visualDescription());
        context.put("dialogueVoiceover", shot.dialogueVoiceover());
        context.put("cameraMovement", shot.cameraMovement());
        context.put("lightingAtmosphere", shot.lightingAtmosphere());
        context.put("assetIds", shot.assetIds());
        context.put("continuity", shot.continuity());
        return context;
    }

    /**
     * 使用固定分镜Agent执行结构化调用。
     *
     * @param userId Long 当前用户ID
     * @param operationId String 稳定操作标识
     * @param model TextModelSelection 已解析模型
     * @param input Map<String, Object> Agent输入
     * @param resultType Class<T> 期望结构化结果类型
     * @return Mono<T> 结构化结果
     * @param <T> 结构化结果类型
     */
    <T> Mono<T> callAgent(Long userId, String operationId, AgentScopeModelFactory.TextModelSelection model,
                                  Map<String, Object> input, Class<T> resultType) {
        return Mono.defer(() -> {
                    ReActAgent agent = agentFactory.storyboardAgent(model.agentModel());
                    Map<String, Object> responseInput = new LinkedHashMap<>(input);
                    responseInput.put("responseSchema", JsonSchemaUtils.generateSchemaFromClass(resultType));
                    responseInput.put("responseContract", "请直接返回一个符合 responseSchema 的完整 JSON 对象，不调用工具、不输出代码围栏或说明文字。"
                            + "画面、首尾状态与剧情作用简洁明确，避免在多个字段重复粘贴大段原文；保留全部必要事件、对白与章末结果。");
                    java.util.function.Supplier<Mono<io.agentscope.core.message.Msg>> request = () ->
                            StoryboardModelResponse.call(model.agentModel(), agent.getSysPrompt(), JSON.toJSONString(responseInput))
                            .timeout(Duration.ofSeconds(storyboardCallTimeoutSeconds()),
                                    Mono.error(new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR,
                                            "分镜模型响应超过" + storyboardCallTimeoutSeconds()
                                                    + "秒，本次已停止，原分镜保持不变。可稍后重试或切换文本模型")));
                    return request.get()
                            .onErrorResume(StoryboardModelResponse.EmptyResponseException.class, error -> {
                                log.warn("分镜模型返回空响应，仅重新请求当前步骤一次: operationId={}, action={}", operationId, input.get("action"));
                                return request.get();
                            })
                            .map(message -> {
                                try {
                                    T result = StoryboardStructuredOutput.parse(message, resultType);
                                    log.info("分镜模型结果解析完成: operationId={}, action={}, resultType={}, structured={}, textLength={}",
                                            operationId, input.get("action"), resultType.getSimpleName(), message.hasStructuredData(),
                                            message.getTextContent() == null ? 0 : message.getTextContent().length());
                                    return result;
                                } catch (BusinessException exception) {
                                    log.warn("分镜模型结果解析失败: operationId={}, action={}, resultType={}, structured={}, textLength={}",
                                            operationId, input.get("action"), resultType.getSimpleName(), message.hasStructuredData(),
                                            message.getTextContent() == null ? 0 : message.getTextContent().length());
                                    throw exception;
                                }
                            })
                            .switchIfEmpty(Mono.error(new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent未返回结构化结果")))
                            .doFinally(signal -> agent.close());
                })
                .onErrorMap(exception -> exception instanceof BusinessException
                        ? exception
                        : new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent调用失败: " + errorMessage(exception)));
    }

    private long storyboardCallTimeoutSeconds() {
        int configured = properties.getAi().getStoryboardAgent().getTimeoutSeconds();
        return Math.min(300L, configured > 0 ? configured : 180L);
    }

    private long storyboardOperationTimeoutSeconds() {
        return Math.min(600L, Math.max(120L, storyboardCallTimeoutSeconds() * 4L));
    }

    /**
     * 校验并规范化首次生成的分镜结果，补齐稳定标识和待生成提示词。
     *
     * @param result GeneratedStoryboardResult Agent结构化结果
     * @return NormalizedStoryboard 已规范化镜头与资产
     */
    private NormalizedStoryboard normalizeGeneratedStoryboard(StoryboardDtos.GeneratedStoryboardResult result) {
        return normalizeGeneratedStoryboard(result, null);
    }

    private NormalizedStoryboard normalizeGeneratedStoryboard(StoryboardDtos.GeneratedStoryboardResult result,
                                                               List<StoryboardDtos.StoryboardAsset> existingAssets) {
        if (result == null || result.shots() == null || result.shots().isEmpty()) {
            throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent未生成有效镜头");
        }
        if (result.shots().size() > StoryboardDtos.MAX_SHOT_COUNT) {
            throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent返回的镜头数量超出限制");
        }
        if (result.assets() != null && result.assets().size() > 300) {
            throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent返回的资产数量超出限制");
        }
        List<StoryboardDtos.StoryboardAsset> assets = new ArrayList<>();
        Map<String, String> assetIdByReferenceKey = new LinkedHashMap<>();
        Map<String, StoryboardDtos.StoryboardAsset> canonicalById = new LinkedHashMap<>();
        Map<String, StoryboardDtos.StoryboardAsset> canonicalByName = new LinkedHashMap<>();
        Set<String> ambiguousNames = new LinkedHashSet<>();
        for (var canonical : existingAssets == null ? List.<StoryboardDtos.StoryboardAsset>of() : existingAssets) {
            canonicalById.put(canonical.id(), canonical);
            String name = canonical.kind() + ":" + canonical.name().trim();
            if (canonicalByName.putIfAbsent(name, canonical) != null) ambiguousNames.add(name);
        }
        ambiguousNames.forEach(canonicalByName::remove);
        Set<String> includedAssets = new LinkedHashSet<>();
        for (StoryboardDtos.GeneratedStoryboardAsset asset : result.assets() == null ? List.<StoryboardDtos.GeneratedStoryboardAsset>of() : result.assets()) {
            String kind = asset == null ? null : normalizeGeneratedAssetKind(asset.kind());
            if (kind == null) {
                throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent返回了不支持的资产类别");
            }
            String referenceKey = normalizeRequiredText(asset.referenceKey(), "分镜Agent返回的资产引用键");
            if (assetIdByReferenceKey.containsKey(referenceKey)) {
                throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent返回了重复的资产引用键");
            }
            String name = normalizeRequiredText(asset.name(), "分镜Agent返回的资产名称");
            var canonical = canonicalById.getOrDefault(referenceKey, canonicalByName.get(kind + ":" + name));
            if (canonical != null && !canonical.kind().equals(kind)) {
                throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent修改了已有资产类别，请重试");
            }
            String assetId = canonical == null ? UUID.randomUUID().toString() : canonical.id();
            assetIdByReferenceKey.put(referenceKey, assetId);
            if (includedAssets.add(assetId)) assets.add(canonical == null ? new StoryboardDtos.StoryboardAsset(
                    assetId, kind, name, normalizeOptionalText(asset.description())) : canonical);
        }
        Set<Integer> shotNumbers = new LinkedHashSet<>();
        List<StoryboardDtos.StoryboardShot> shots = new ArrayList<>();
        for (StoryboardDtos.GeneratedStoryboardShot shot : result.shots()) {
            if (shot == null) {
                throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent返回了空镜头");
            }
            String shotSize = normalizeGeneratedShotSize(shot.shotSize());
            if (shotSize == null) {
                String invalidSize = String.valueOf(shot.shotSize()).replaceAll("[\\p{Cntrl}]", " ");
                invalidSize = invalidSize.substring(0, Math.min(invalidSize.length(), 80));
                log.warn("分镜景别校验失败: shotNumber={}, shotSize={}", shot.shotNumber(), invalidSize);
                throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR,
                        "第" + shot.shotNumber() + "镜头景别无法识别（" + invalidSize + "），请重新生成");
            }
            validateShotFields(shot.shotNumber(), shot.durationSeconds(), shot.visualDescription(), shotSize, shotNumbers, "分镜Agent返回的镜头");
            if (shot.assetReferenceKeys() == null) {
                throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent返回的镜头资产引用不能为空");
            }
            Set<String> referencedAssetKeys = new LinkedHashSet<>();
            List<String> assetIds = new ArrayList<>();
            for (String referenceKeyValue : shot.assetReferenceKeys()) {
                String referenceKey = normalizeRequiredText(referenceKeyValue, "分镜Agent返回的镜头资产引用");
                if (!referencedAssetKeys.add(referenceKey)) {
                    throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent返回了重复的镜头资产引用");
                }
                String assetId = assetIdByReferenceKey.get(referenceKey);
                if (assetId == null) {
                    throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent返回了不存在的镜头资产引用");
                }
                if (!assetIds.contains(assetId)) assetIds.add(assetId);
            }
            shots.add(new StoryboardDtos.StoryboardShot(
                    UUID.randomUUID().toString(), shot.shotNumber(), shot.durationSeconds(), shot.visualDescription().trim(), shotSize,
                    normalizeOptionalText(shot.lightingAtmosphere()), normalizeOptionalText(shot.dialogueVoiceover()),
                    normalizeOptionalText(shot.soundEffect()), preserveGeneratedShotSizeDescription(shot.shotSize(), shot.cameraMovement()), "", List.copyOf(assetIds), shot.continuity()));
        }
        return new NormalizedStoryboard(List.copyOf(shots), List.copyOf(assets));
    }

    /**
     * 校验合成结果与输入镜头标识一一对应，并拒绝非中文为主的最终提示词。
     *
     * @param shots List<StoryboardShot> 输入镜头
     * @param visualStyle String 用户指定的整体视觉风格
     * @param result PromptCompositionResult Agent结构化结果
     * @return List<StoryboardPrompt> 按输入镜头顺序排列的提示词映射
     */
    private List<StoryboardDtos.StoryboardPrompt> validatePromptComposition(
            List<StoryboardDtos.StoryboardShot> shots, String visualStyle, StoryboardDtos.PromptCompositionResult result) {
        if (result == null || result.prompts() == null || result.prompts().size() != shots.size()) {
            throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent返回的提示词数量与镜头数量不一致");
        }
        String normalizedVisualStyle = normalizeLineBreaks(normalizeRequiredText(visualStyle, "视觉风格"));
        Set<String> expectedShotIds = shots.stream().map(StoryboardDtos.StoryboardShot::id).collect(java.util.stream.Collectors.toCollection(LinkedHashSet::new));
        Map<String, String> promptByShotId = new LinkedHashMap<>();
        for (StoryboardDtos.StoryboardPrompt prompt : result.prompts()) {
            String shotId = prompt == null ? "" : normalizeRequiredText(prompt.shotId(), "分镜Agent返回的镜头标识");
            String finalPrompt = prompt == null ? "" : normalizeRequiredText(prompt.finalPrompt(), "分镜Agent返回的最终提示词");
            if (!expectedShotIds.contains(shotId) || promptByShotId.putIfAbsent(shotId, finalPrompt) != null) {
                throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent返回了缺失、重复或额外的镜头标识");
            }
            if (!isChinesePrompt(finalPrompt)) {
                throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent返回的最终提示词必须以中文为主");
            }
            StoryboardDtos.StoryboardShot shot = shots.stream().filter(item -> item.id().equals(shotId)).findFirst().orElseThrow();
            if (!isFixedPromptFormat(finalPrompt, shot, normalizedVisualStyle)) {
                throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent返回的最终提示词未按固定格式生成");
            }
        }
        if (!promptByShotId.keySet().equals(expectedShotIds)) {
            throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜Agent返回的镜头标识不完整");
        }
        return shots.stream().map(shot -> new StoryboardDtos.StoryboardPrompt(shot.id(), promptByShotId.get(shot.id()))).toList();
    }

    /**
     * 校验最终提示词的固定段落结构和用户指定的视觉风格。
     *
     * @param finalPrompt String Agent返回的最终提示词
     * @param shot StoryboardShot 当前镜头
     * @param visualStyle String 用户指定的整体视觉风格
     * @return boolean 是否符合固定格式
     */
    private boolean isFixedPromptFormat(String finalPrompt, StoryboardDtos.StoryboardShot shot, String visualStyle) {
        String normalizedPrompt = finalPrompt.replace("\r\n", "\n").replace('\r', '\n').trim();
        String expectedSpecification = "镜头规格：" + shot.shotSize().trim() + "，" + shot.durationSeconds() + " 秒。";
        int sectionStart = 0;
        Matcher separatorMatcher = PROMPT_SECTION_SEPARATOR.matcher(normalizedPrompt);
        for (int index = 0; index < FINAL_PROMPT_SECTION_TITLES.size() - 1; index++) {
            separatorMatcher.region(sectionStart, normalizedPrompt.length());
            if (!separatorMatcher.find()) {
                return false;
            }
            String rawSection = normalizedPrompt.substring(sectionStart, separatorMatcher.start());
            if (!rawSection.equals(rawSection.trim())) {
                return false;
            }
            String section = rawSection.trim();
            if (index == 0 && !expectedSpecification.equals(section)) {
                return false;
            }
            String title = FINAL_PROMPT_SECTION_TITLES.get(index);
            if (index > 0 && (!section.startsWith(title) || !StringUtils.hasText(section.substring(title.length()).trim()))) {
                return false;
            }
            sectionStart = separatorMatcher.end();
        }
        String visualStyleSection = normalizedPrompt.substring(sectionStart).trim();
        return visualStyleSection.equals("视觉风格：" + visualStyle);
    }

    /**
     * 校验首次生成请求。
     *
     * @param request GenerateStoryboardRequest 生成请求
     * @return void 无返回值
     */
    private void validateGenerateRequest(StoryboardDtos.GenerateStoryboardRequest request) {
        if (request == null) {
            throw new BusinessException(ErrorCode.PARAM_MISSING, "分镜生成请求不能为空");
        }
        normalizeRequiredText(request.scriptContent(), "剧本文本");
        normalizeRequiredText(request.instruction(), "分镜描述");
        normalizeRequiredText(request.visualStyle(), "视觉风格");
        normalizeRequiredText(request.model(), "文本模型");
        validateStoryContext(request.storyContext());
        if (request.maxShotSeconds() != null && (request.maxShotSeconds() < 1 || request.maxShotSeconds() > 30)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "单镜头最大时长必须为1到30秒");
        }
        if (request.allowedShotSeconds() != null && (request.allowedShotSeconds().size() > 30
                || request.allowedShotSeconds().stream().anyMatch(seconds -> seconds == null || seconds < 1
                || seconds > (request.maxShotSeconds() == null ? 10 : request.maxShotSeconds())))) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "可用镜头时长最多30项，且每项必须为1到单镜头上限之间的整数");
        }
        if (request.existingAssets() != null) {
            if (request.existingAssets().size() > 300) throw new BusinessException(ErrorCode.PARAM_INVALID, "已有资产数量不能超过300");
            Set<String> ids = new LinkedHashSet<>();
            for (var asset : request.existingAssets()) {
                if (asset == null || !StringUtils.hasText(asset.kind()) || !ASSET_KINDS.contains(asset.kind())) throw new BusinessException(ErrorCode.PARAM_INVALID, "已有资产类别不合法");
                if (!ids.add(normalizeRequiredText(asset.id(), "已有资产标识"))) throw new BusinessException(ErrorCode.PARAM_INVALID, "已有资产标识不能重复");
                normalizeRequiredText(asset.name(), "已有资产名称");
            }
        }
    }

    /**
     * 校验提示词合成请求及当前用户已编辑的镜头、资产。
     *
     * @param request ComposePromptsRequest 合成请求
     * @return void 无返回值
     */
    private void validateComposeRequest(StoryboardDtos.ComposePromptsRequest request) {
        if (request == null) {
            throw new BusinessException(ErrorCode.PARAM_MISSING, "提示词合成请求不能为空");
        }
        normalizeRequiredText(request.scriptContent(), "剧本文本");
        normalizeRequiredText(request.instruction(), "分镜描述");
        normalizeRequiredText(request.visualStyle(), "视觉风格");
        normalizeRequiredText(request.model(), "文本模型");
        validateStoryContext(request.storyContext());
        if (request.shots() == null || request.shots().isEmpty()) {
            throw new BusinessException(ErrorCode.PARAM_MISSING, "至少需要一个镜头");
        }
        if (request.shots().size() > StoryboardDtos.MAX_SHOT_COUNT) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "镜头数量不能超过100");
        }
        Set<String> assetIds = new LinkedHashSet<>();
        for (StoryboardDtos.StoryboardAsset asset : request.assets() == null ? List.<StoryboardDtos.StoryboardAsset>of() : request.assets()) {
            if (asset == null || !ASSET_KINDS.contains(normalizeRequiredText(asset.kind(), "资产类别"))) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "资产类别仅支持character、scene、prop");
            }
            String assetId = normalizeRequiredText(asset.id(), "资产标识");
            if (!assetIds.add(assetId)) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "资产标识不能重复");
            }
            normalizeRequiredText(asset.name(), "资产名称");
        }
        Set<Integer> shotNumbers = new LinkedHashSet<>();
        Set<String> shotIds = new LinkedHashSet<>();
        for (StoryboardDtos.StoryboardShot shot : request.shots()) {
            if (shot == null) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "镜头不能为空");
            }
            String shotId = normalizeRequiredText(shot.id(), "镜头标识");
            if (!shotIds.add(shotId)) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "镜头标识不能重复");
            }
            validateShotFields(shot.shotNumber(), shot.durationSeconds(), shot.visualDescription(), shot.shotSize(), shotNumbers, "镜头");
            if (shot.assetIds() == null) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "镜头关联资产不能为空");
            }
            Set<String> associatedAssetIds = new LinkedHashSet<>();
            for (String assetIdValue : shot.assetIds()) {
                String assetId = normalizeRequiredText(assetIdValue, "镜头关联资产标识");
                if (!associatedAssetIds.add(assetId)) {
                    throw new BusinessException(ErrorCode.PARAM_INVALID, "镜头关联资产标识不能重复");
                }
                if (!assetIds.contains(assetId)) {
                    throw new BusinessException(ErrorCode.PARAM_INVALID, "镜头关联了不存在的资产");
                }
            }
        }
        validateSequenceShots(request.sequenceShots(), shotIds);
    }

    private void validateSequenceShots(List<StoryboardDtos.StoryboardShot> sequence, Set<String> targetIds) {
        if (sequence == null) return;
        if (sequence.isEmpty() || sequence.size() > StoryboardDtos.MAX_SHOT_COUNT) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "完整章节镜头数量必须在1到100之间");
        }
        Set<String> ids = new LinkedHashSet<>();
        Set<Integer> numbers = new LinkedHashSet<>();
        for (var shot : sequence) {
            if (shot == null || !ids.add(normalizeRequiredText(shot.id(), "章节镜头标识"))) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "完整章节镜头标识不能为空或重复");
            }
            validateShotFields(shot.shotNumber(), shot.durationSeconds(), shot.visualDescription(), shot.shotSize(), numbers, "章节镜头");
        }
        if (!ids.containsAll(targetIds)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "待合成镜头不在完整章节镜头中");
        }
    }

    private void validateStoryContext(StoryboardDtos.StoryContext context) {
        if (context == null) return;
        if ((context.chapterIndex() != null && context.chapterIndex() < 1)
                || (context.chapterCount() != null && context.chapterCount() < 1)
                || (context.chapterIndex() != null && context.chapterCount() != null
                    && context.chapterIndex() > context.chapterCount())) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "章节序号必须在有效章节范围内");
        }
        validateContextLength(context.storyTitle(), 300);
        validateContextLength(context.chapterTitle(), 300);
        validateContextLength(context.fullStory(), 120000);
        validateContextLength(context.previousChapter(), 12000);
        validateContextLength(context.nextChapter(), 12000);
    }

    private void validateContextLength(String value, int maxLength) {
        if (value != null && value.length() > maxLength) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "故事上下文过长，请缩短后重试");
        }
    }

    /**
     * 校验资产图片任务请求。
     *
     * @param request CreateAssetImageTaskRequest 资产图片任务请求
     * @return void 无返回值
     */
    private void validateAssetImageRequest(StoryboardDtos.CreateAssetImageTaskRequest request) {
        if (request == null) {
            throw new BusinessException(ErrorCode.PARAM_MISSING, "资产图片任务请求不能为空");
        }
        normalizeRequiredText(request.nodeId(), "分镜节点标识");
        normalizeRequiredText(request.visualStyle(), "视觉风格");
        normalizeRequiredText(request.model(), "图片模型");
        if (request.asset() == null || request.settings() == null) {
            throw new BusinessException(ErrorCode.PARAM_MISSING, "资产与图片生成参数不能为空");
        }
        if (!ASSET_KINDS.contains(normalizeRequiredText(request.asset().kind(), "资产类别"))) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "资产类别仅支持character、scene、prop");
        }
        normalizeRequiredText(request.asset().id(), "资产标识");
        normalizeRequiredText(request.asset().name(), "资产名称");
    }

    /**
     * 按资产类别渲染资产图片提示词。
     * <p>模板中整行占位符都取不到值时省略该行，避免留下“描述：”这类空标签行。</p>
     *
     * @param request CreateAssetImageTaskRequest 资产图片任务请求
     * @return String 渲染后的提示词
     */
    private String renderAssetImagePrompt(StoryboardDtos.CreateAssetImageTaskRequest request) {
        StoryboardDtos.StoryboardAsset asset = request.asset();
        Map<String, String> values = Map.of(
                "name", asset.name().trim(),
                "description", asset.description() == null ? "" : asset.description().trim(),
                "visualStyle", request.visualStyle().trim());
        List<String> rendered = new ArrayList<>();
        for (String line : readAssetImagePromptSection(asset.kind().trim()).split("\n", -1)) {
            Matcher matcher = ASSET_PROMPT_PLACEHOLDER.matcher(line);
            StringBuilder text = new StringBuilder();
            boolean hasPlaceholder = false;
            boolean hasValue = false;
            while (matcher.find()) {
                hasPlaceholder = true;
                String value = values.get(matcher.group(1));
                if (value == null) {
                    log.warn("分镜资产图片提示词模板存在未知占位符: placeholder={}", matcher.group(1));
                    value = "";
                } else if (!value.isEmpty()) {
                    hasValue = true;
                }
                matcher.appendReplacement(text, Matcher.quoteReplacement(value));
            }
            matcher.appendTail(text);
            if (hasPlaceholder && !hasValue) {
                continue;
            }
            rendered.add(text.toString());
        }
        if (rendered.isEmpty()) {
            throw new BusinessException(ErrorCode.BUSINESS_ERROR, "分镜资产图片提示词模板段落内容为空: " + asset.kind());
        }
        return String.join("\n", rendered).trim();
    }

    /**
     * 从模板中截取指定资产类别的提示词段落。
     *
     * @param kind String 资产类别
     * @return String 该类别对应的提示词段落
     */
    private String readAssetImagePromptSection(String kind) {
        String currentKind = "";
        List<String> lines = new ArrayList<>();
        for (String line : promptTemplateService.get(PromptTemplateType.IMAGE_STORYBOARD_ASSET).split("\n", -1)) {
            Matcher matcher = ASSET_PROMPT_SECTION.matcher(line);
            if (matcher.matches()) {
                if (kind.equals(currentKind)) {
                    return String.join("\n", lines).trim();
                }
                currentKind = matcher.group(1);
                lines.clear();
                continue;
            }
            if (!currentKind.isEmpty()) {
                lines.add(line);
            }
        }
        if (kind.equals(currentKind)) {
            return String.join("\n", lines).trim();
        }
        throw new BusinessException(ErrorCode.BUSINESS_ERROR, "分镜资产图片提示词模板缺少类别段落: " + kind);
    }

    /**
     * 校验镜头关键字段与标准景别。
     *
     * @param shotNumber Integer 镜号
     * @param durationSeconds Integer 时长秒数
     * @param visualDescription String 画面描述
     * @param shotSize String 景别
     * @param shotNumbers Set<Integer> 已出现镜号
     * @param subject String 字段所属对象名称
     * @return void 无返回值
     */
    private void validateShotFields(Integer shotNumber, Integer durationSeconds, String visualDescription, String shotSize,
                                    Set<Integer> shotNumbers, String subject) {
        if (shotNumber == null || shotNumber < 1 || !shotNumbers.add(shotNumber)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, subject + "镜号必须为不重复的正整数");
        }
        if (durationSeconds == null || durationSeconds < 1 || durationSeconds > 600) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, subject + "时长必须为1至600秒的正整数");
        }
        normalizeRequiredText(visualDescription, subject + "画面描述");
        if (!SHOT_SIZES.contains(normalizeRequiredText(shotSize, subject + "景别"))) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, subject + "景别不合法");
        }
    }

    /**
     * 计算按镜头数量计费的总积分。
     *
     * @param unitCredits int 单镜头积分
     * @param shotCount int 镜头数量
     * @return int 总积分
     */
    private int multiplyCredits(int unitCredits, int shotCount) {
        try {
            return Math.multiplyExact(unitCredits, shotCount);
        } catch (ArithmeticException exception) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "分镜提示词合成积分计算超出范围");
        }
    }

    /**
     * 读取必填文本。
     *
     * @param value String 原始文本
     * @param fieldName String 字段名称
     * @return String 去除首尾空白后的文本
     */
    private String normalizeRequiredText(String value, String fieldName) {
        String normalized = value == null ? "" : value.trim();
        if (!StringUtils.hasText(normalized)) {
            throw new BusinessException(ErrorCode.PARAM_MISSING, fieldName + "不能为空");
        }
        return normalized;
    }

    /**
     * 将模型偶尔返回的大小写、复数或中文资产类别收敛为画布标准值。
     *
     * @param value String Agent返回的资产类别
     * @return String character、scene、prop；不支持时返回null
     */
    private String normalizeGeneratedAssetKind(String value) {
        String normalized = normalizeRequiredText(value, "分镜Agent返回的资产类别").toLowerCase(java.util.Locale.ROOT);
        return switch (normalized) {
            case "character", "characters", "person", "people", "角色", "人物" -> "character";
            case "scene", "scenes", "location", "locations", "background", "场景", "环境" -> "scene";
            case "prop", "props", "object", "objects", "item", "items", "道具", "物品" -> "prop";
            default -> null;
        };
    }

    /**
     * 将模型常见的中英文景别别名收敛为画布支持的十种标准景别。
     * 机位、角度等非景别值仍返回 {@code null}，由调用方拒绝回写。
     *
     * @param value String Agent返回的景别
     * @return String 标准景别；无法识别时返回null
     */
    private String normalizeGeneratedShotSize(String value) {
        String normalized = normalizeRequiredText(value, "分镜Agent返回的镜头景别");
        String exact = normalizeShotSizeAlias(normalized);
        if (exact != null) return exact;
        // 一个连续镜头可以从远景推进至中景。以起始景别用于列表展示，完整变化另存运镜。
        String[] transition = normalized.replaceFirst("^从", "").split("\\s*(?:切换到|切换至|转为|转到|转至|推至|拉至|转|到|至|→|->)\\s*", -1);
        if (transition.length > 1) {
            List<String> sizes = new ArrayList<>();
            for (String part : transition) {
                String size = normalizeShotSizeAlias(part.trim());
                if (size == null) return null;
                sizes.add(size);
            }
            return sizes.getFirst();
        }
        // 允许“特写（CU）”“中景 / MS”等同义补充，不接受多种互相冲突的景别。
        String[] parts = normalized.split("[()（）\\[\\]【】/／,，:：;；]+\\s*");
        Set<String> recognized = new LinkedHashSet<>();
        for (String part : parts) {
            String size = normalizeShotSizeAlias(part.trim());
            if (size != null) recognized.add(size);
        }
        // 主字段必须是景别，避免把“俯拍（近景参考）”误判为合法景别。
        return parts.length > 0 && normalizeShotSizeAlias(parts[0].trim()) != null && recognized.size() == 1
                ? recognized.iterator().next() : null;
    }

    private String preserveGeneratedShotSizeDescription(String original, String cameraMovement) {
        String movement = normalizeOptionalText(cameraMovement);
        // 同义词不重复写入运镜；复合景别的角度或景别变化信息不能在规范化时丢失。
        if (normalizeShotSizeAlias(original.trim()) != null) return movement;
        return "景别说明：" + original.trim() + (movement.isEmpty() ? "" : "；" + movement);
    }

    private String normalizeShotSizeAlias(String normalized) {
        if (SHOT_SIZES.contains(normalized)) {
            return normalized;
        }
        String alias = normalized.toLowerCase(java.util.Locale.ROOT)
                .replace(" ", "")
                .replace("-", "")
                .replace("_", "");
        return switch (alias) {
            case "极近特写", "极致特写", "极特写", "超特写", "extremecloseup", "ecu", "xcu" -> "大特写";
            case "closeup", "cu" -> "特写";
            case "中近景", "半身近景", "胸像景", "胸像", "mediumcloseup", "mcu" -> "头肩景";
            case "半身景", "半身", "mediumshot", "ms" -> "中景";
            case "mediumlongshot", "mls" -> "中远景";
            case "全身景", "全身", "fullshot", "fullbodyshot", "fs" -> "全景";
            case "广角远景", "longshot", "wideshot", "ls", "ws" -> "远景";
            case "extremelongshot", "extremewideshot", "els", "ews" -> "大远景";
            case "establishingshot", "mastershot" -> "大全景";
            default -> null;
        };
    }

    /**
     * 统一文本换行符。
     *
     * @param value String 原始文本
     * @return String 使用换行符的文本
     */
    private String normalizeLineBreaks(String value) {
        return value.replace("\r\n", "\n").replace('\r', '\n');
    }

    /**
     * 读取可选文本。
     *
     * @param value String 原始文本
     * @return String 去除首尾空白后的文本，缺失时为空字符串
     */
    private String normalizeOptionalText(String value) {
        return value == null ? "" : value.trim();
    }

    /**
     * 判断提示词是否以中文为主。
     *
     * @param value String 提示词
     * @return boolean 汉字数量至少为其他文字字母数量两倍时为true
     */
    private boolean isChinesePrompt(String value) {
        long chineseCharacterCount = 0;
        long otherLetterCount = 0;
        for (int codePoint : value.codePoints().toArray()) {
            Character.UnicodeScript script = Character.UnicodeScript.of(codePoint);
            if (script == Character.UnicodeScript.HAN) {
                chineseCharacterCount++;
            } else if (Character.isLetter(codePoint)) {
                otherLetterCount++;
            }
        }
        return chineseCharacterCount > 0 && chineseCharacterCount >= otherLetterCount * 2;
    }

    /**
     * 读取对用户安全的调用失败摘要。
     *
     * @param exception Throwable 异常
     * @return String 错误摘要
     */
    private String errorMessage(Throwable exception) {
        String message = exception.getMessage();
        return StringUtils.hasText(message) ? message.trim() : "服务暂不可用";
    }

    /**
     * 已规范化的首次生成分镜。
     *
     * @param shots List<StoryboardShot> 镜头列表
     * @param assets List<StoryboardAsset> 资产列表
     */
    private record NormalizedStoryboard(List<StoryboardDtos.StoryboardShot> shots,
                                        List<StoryboardDtos.StoryboardAsset> assets) {
    }
}
