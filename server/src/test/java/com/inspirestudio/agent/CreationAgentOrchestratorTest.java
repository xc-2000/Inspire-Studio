package com.inspirestudio.agent;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.fastjson2.JSON;
import com.inspirestudio.agent.dto.AgentMessage;
import com.inspirestudio.agent.dto.AgentChatRequest;
import com.inspirestudio.agent.dto.AgentSession;
import com.inspirestudio.agent.dto.CreationPlan;
import com.inspirestudio.agent.dto.CreationSettings;
import com.inspirestudio.agent.dto.CreationTask;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.entity.CreationAgentRequest;
import com.inspirestudio.repository.AgentPlanRepository;
import com.inspirestudio.repository.CreationAgentRequestRepository;
import com.inspirestudio.service.AiTaskService;
import com.inspirestudio.service.PersistenceService;
import com.inspirestudio.service.SkillService;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import reactor.core.publisher.Mono;

/**
 * 统一主Agent入口路由和提示词约束测试。
 *
 * @date     2026-07-23 00:00
 */
class CreationAgentOrchestratorTest {

    @Test
    void imageClarificationMustPreserveSelectedModelAndResolutionForFollowUp() {
        var orchestrator = orchestrator(mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        var persistence = mock(PersistenceService.class);
        org.springframework.test.util.ReflectionTestUtils.setField(orchestrator, "persistenceService", persistence);
        when(persistence.saveOrUpdateGenerationRound(anyLong(), anyString(), anyString(), anyString(), any()))
                .thenReturn(Mono.empty());
        var settings = new CreationSettings("selected-image-model", "16:9", "4K", "high", 1, null, null);
        var request = new AgentChatRequest("session", CreationEntrySource.IMAGE_PAGE, "修改背景", null, null, List.of(), null, settings, null);
        Mono<Void> save = org.springframework.test.util.ReflectionTestUtils.invokeMethod(orchestrator,
                "saveClarificationRound", 1L, session(List.of()), request, "想把背景换成什么？", List.of());
        save.block();
        var round = ArgumentCaptor.forClass(com.alibaba.fastjson2.JSONObject.class);
        verify(persistence).saveOrUpdateGenerationRound(anyLong(), anyString(), anyString(), anyString(), round.capture());
        var config = round.getValue().getJSONObject("config");
        Assertions.assertEquals("selected-image-model", config.getString("model"));
        Assertions.assertEquals("4K", config.getString("resolution"));
        Assertions.assertEquals("high", config.getString("quality"));
        Assertions.assertEquals("16:9", config.getString("size"));
    }

    @Test
    void vagueBackgroundEditMustAskForTargetWithoutCreatingGenerationTasks() {
        var orchestrator = orchestrator(mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        for (String instruction : List.of("修改背景", "换个背景", "请帮我把背景换一下", "更换背景", "Change the background")) {
            var request = new AgentChatRequest("session", CreationEntrySource.IMAGE_PAGE, instruction, null, null,
                    List.of(new AgentChatRequest.Attachment("https://example.com/original.png", "image/png", "原图", "image:original")),
                    null, new CreationSettings("image-model", "1:1", "4K", "high", 1, null, null), null);
            var clarification = orchestrator.buildImageEditClarificationPlan(request);
            Assertions.assertNotNull(clarification, instruction);
            Assertions.assertTrue(clarification.tasks().isEmpty());
            Assertions.assertTrue(clarification.clarificationQuestion().contains("直接描述"));
            Assertions.assertEquals(4, clarification.choices().size());
            Assertions.assertNull(orchestrator.buildExplicitImageEditPlan(request));
            var choiceRequest = new AgentChatRequest("session", CreationEntrySource.IMAGE_PAGE,
                    clarification.choices().getFirst().value(), null, null, request.attachments(), null, request.creationSettings(), null);
            Assertions.assertNull(orchestrator.buildImageEditClarificationPlan(choiceRequest));
            Assertions.assertEquals("edit", orchestrator.buildExplicitImageEditPlan(choiceRequest).tasks().getFirst().action());
        }
        var noImage = orchestrator.buildImageEditClarificationPlan(chatRequest("修改背景"));
        Assertions.assertTrue(noImage.tasks().isEmpty());
        Assertions.assertEquals("upload_image", noImage.choices().getFirst().action());
        for (String specific : List.of("背景换成白色", "将背景改为雪山", "去掉背景", "背景换一个更好看的，你自由发挥", "生成咖啡馆背景")) {
            Assertions.assertNull(orchestrator.buildImageEditClarificationPlan(chatRequest(specific)), specific);
        }
        Assertions.assertTrue(orchestrator.shouldRestoreImageEditReference("修改背景"));
        Assertions.assertTrue(orchestrator.shouldRestoreImageEditReference("Change the background"));
        Assertions.assertFalse(orchestrator.shouldRestoreImageEditReference("生成一张海报，添加一个男生"));
    }

    @Test
    void shouldLetSkillPlanReferenceEditsInsteadOfSkippingItsInstructions() {
        var orchestrator = orchestrator(mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        var request = new AgentChatRequest("session", CreationEntrySource.IMAGE_PAGE, "添加男生", null, null,
                List.of(new AgentChatRequest.Attachment("https://r2.example/reference.jpg", "image/jpeg", "参考图", "image:reference")),
                null, new CreationSettings("image-model", "21:9", "4K", "medium", 1, null, null), "42");
        var plan = orchestrator.buildExplicitImageEditPlan(request);
        Assertions.assertNull(plan);

        var noAttachment = new AgentChatRequest("session", CreationEntrySource.IMAGE_PAGE, "添加男生", null, null,
                List.of(), null, request.creationSettings(), "42");
        Assertions.assertNull(orchestrator.buildExplicitImageEditPlan(noAttachment));
        var unrelated = new AgentChatRequest("session", CreationEntrySource.IMAGE_PAGE, "这是参考资料", null, null,
                request.attachments(), null, request.creationSettings(), "42");
        Assertions.assertNull(orchestrator.buildExplicitImageEditPlan(unrelated));
    }

    @Test
    void shouldBindReferenceForEveryImageSkillToImageEditTask() {
        var orchestrator = orchestrator(mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        for (String skillId : List.of("1", "8", "500")) {
            var request = new AgentChatRequest("session-" + skillId, CreationEntrySource.IMAGE_PAGE,
                    "确认生成：严格保留参考主体", null, null,
                    List.of(new AgentChatRequest.Attachment("https://r2.example/reference.png", "image/png",
                            "参考图.png", "image:reference")), null,
                    new CreationSettings("image-model", "16:9", "4K", "medium", 1, null, null), skillId);

            CreationPlan result = orchestrator.bindReferenceImageToEditTask(
                    planWithSourcePromptId(request.message(), "current"), request);

            Assertions.assertEquals("edit", result.tasks().getFirst().action());
            Assertions.assertEquals(request.message(), result.tasks().getFirst().prompt());
            Assertions.assertEquals("current", result.tasks().getFirst().sourcePromptId());
        }
    }

    @Test
    void shouldBindUrlOnlyRecentReferenceToImageEditTask() {
        var orchestrator = orchestrator(mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        var request = new AgentChatRequest("session", CreationEntrySource.IMAGE_PAGE,
                "使用最近上传的参考图", null, null,
                List.of(new AgentChatRequest.Attachment("https://r2.example/recent.png", "image/png",
                        "最近上传的参考图", null)), null,
                new CreationSettings("image-model", "1:1", "2K", "medium", 1, null, null), "42");

        CreationPlan result = orchestrator.bindReferenceImageToEditTask(
                planWithSourcePromptId(request.message(), "current"), request);

        Assertions.assertEquals("edit", result.tasks().getFirst().action());
    }

    @Test
    void shouldInjectReferenceRulesIntoCurrentAndFutureMediaSkills() {
        var orchestrator = orchestrator(mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));

        String imagePrompt = orchestrator.withGlobalReferenceMediaRule("image", "图片技能自定义要求");
        String videoPrompt = orchestrator.withGlobalReferenceMediaRule("video", "视频技能自定义要求");

        Assertions.assertTrue(imagePrompt.startsWith("【全局参考素材规则】"));
        Assertions.assertTrue(imagePrompt.endsWith("图片技能自定义要求"));
        Assertions.assertTrue(videoPrompt.contains("最终任务"));
        Assertions.assertEquals(imagePrompt, orchestrator.withGlobalReferenceMediaRule("image", imagePrompt));
        Assertions.assertEquals("画布技能要求", orchestrator.withGlobalReferenceMediaRule("canvasSettingGraph", "画布技能要求"));
    }

    @Test
    void shouldKeepExplicitSingleImageOnItsRequestedPage() {
        var orchestrator = orchestrator(mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        String prompt = "生成一张 TikTok 直播截图，画面里是一位漂亮女性正在直播。";
        for (String entry : List.of(CreationEntrySource.IMAGE_PAGE, CreationEntrySource.CANVAS)) {
            var settings = new CreationSettings("model", "16:9", "2K", "medium", 1, null, null);
            var request = new AgentChatRequest("session", entry, prompt, null, null, List.of(), null, settings, null);
            var plan = orchestrator.buildExplicitSingleImagePlan(request);
            var validated = new CreationPlanValidator(new AgentToolRegistry()).validate(plan, entry, settings);
            Assertions.assertFalse(validated.canvasGuidance());
            Assertions.assertEquals(1, validated.tasks().size());
            Assertions.assertEquals("current", validated.tasks().getFirst().sourcePromptId());
            Assertions.assertEquals(prompt, validated.tasks().getFirst().prompt());
            if (CreationEntrySource.CANVAS.equals(entry)) Assertions.assertEquals("canvas_generate_image", validated.tasks().getFirst().toolName());
            Assertions.assertNull(orchestrator.buildExplicitSingleImagePlan(new AgentChatRequest(
                    "session", entry, prompt, null, null, List.of(), null, settings, "42")));
        }
        Assertions.assertNull(orchestrator.buildExplicitSingleImagePlan(new AgentChatRequest("s", CreationEntrySource.IMAGE_PAGE,
                "生成三张图片", null, null, List.of(), null, new CreationSettings("m", "1:1", "2K", "medium", 1, null, null), null)));
    }

    @Test
    void shouldUseVideoShortcutOnlyWhenNoSkillIsSelected() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        CreationSettings settings = new CreationSettings("video-model", "16:9", "720p", "medium",
                null, "5", false, null, null, null, "text-to-video", "video-model", null);
        AgentChatRequest textToVideo = new AgentChatRequest("session", CreationEntrySource.VIDEO_PAGE,
                "橘猫在霓虹街道奔跑", null, null, List.of(), null, settings, null);
        CreationPlan textPlan = orchestrator.buildDirectVideoPlan(textToVideo);
        Assertions.assertNotNull(textPlan);
        Assertions.assertEquals("current", textPlan.tasks().getFirst().sourcePromptId());
        Assertions.assertEquals("video", textPlan.tasks().getFirst().taskType());

        AgentChatRequest imageToVideo = new AgentChatRequest("session", CreationEntrySource.VIDEO_PAGE,
                "保持人物外观并挥手", null, null,
                List.of(new AgentChatRequest.Attachment("https://r2.example/reference.png", "image/png",
                        "参考图", "video:reference")), null, settings, null);
        Assertions.assertNotNull(orchestrator.buildDirectVideoPlan(imageToVideo));

        AgentChatRequest skillRequest = new AgentChatRequest("session", CreationEntrySource.VIDEO_PAGE,
                textToVideo.message(), null, null, List.of(), null, settings, "42");
        CreationPlan skillPlan = orchestrator.buildDirectVideoPlan(skillRequest);
        Assertions.assertNull(skillPlan, "Selected skills must reach the main agent instead of the direct video shortcut");
    }

    @Test
    void shouldRecoverExactCanvasPromptReference() {
        var orchestrator = orchestrator(mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        var resolved = orchestrator.resolveTaskPromptSources(canvasPlan("生成一只小猫"), canvasSession(List.of()), "生成一只小猫");
        Assertions.assertEquals("current", resolved.tasks().getFirst().sourcePromptId());
    }

    @Test
    void shouldResolveMissingPromptBeforePlanValidation() {
        var orchestrator = orchestrator(mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        var resolved = orchestrator.resolveTaskPromptSources(planWithSourcePromptId(null, null), session(List.of()), "生成悟空游戏场景");
        var validated = new CreationPlanValidator(new AgentToolRegistry()).validate(resolved, CreationEntrySource.IMAGE_PAGE, resolved.creationSettings());
        Assertions.assertEquals("生成悟空游戏场景", validated.tasks().getFirst().prompt());
    }

    @Test
    void shouldResolveBackgroundColorChoiceOnlyAfterRelevantQuestion() {
        var orchestrator = orchestrator(mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        var history = session(List.of(new AgentMessage("a", "assistant", "你想把背景换成哪种颜色？", null)));
        String instruction = orchestrator.resolveBackgroundColorReply(history, "pink");
        Assertions.assertEquals("在原图上，将背景颜色换成粉色，其他内容保持不变。", instruction);
        var request = new AgentChatRequest("session", CreationEntrySource.IMAGE_PAGE, instruction, null, null,
                List.of(new AgentChatRequest.Attachment("https://example.com/original.png", "image/png", "原图", "image:original")),
                null, new CreationSettings("image-model", "1:1", "2K", "medium", 1, null, null), null);
        Assertions.assertEquals("edit", orchestrator.buildExplicitImageEditPlan(request).tasks().getFirst().action());
        Assertions.assertEquals("pink", orchestrator.resolveBackgroundColorReply(session(List.of()), "pink"));
        Assertions.assertEquals("pink", orchestrator.resolveBackgroundColorReply(
                session(List.of(new AgentMessage("a", "assistant", "衣服需要哪种颜色？", null))), "pink"));
    }

    @Test
    void shouldExplainModelTimeoutWithoutExposingInternalErrors() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        Assertions.assertEquals("模型响应超时，本次未完成，请稍后重试",
                orchestrator.errorMessage(new java.util.concurrent.TimeoutException("internal details")));
        Assertions.assertEquals("Agent服务暂不可用，已停止生成",
                orchestrator.errorMessage(new IllegalStateException("database details")));
    }

    /**
     * 图片、视频和画布入口必须全部由统一主Agent支持。
     */
    @Test
    void shouldBuildDeterministicEditPlanForExplicitInstructionWithImage() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        var request = new AgentChatRequest("session", CreationEntrySource.IMAGE_PAGE, "在原有香水瓶上增加 ASTON 标签",
                null, null, List.of(new AgentChatRequest.Attachment("https://example.com/original.png", "image/png", "原图", "image:original")),
                null, new CreationSettings("image-model", "1:1", "1K", "low", 1, null, null), null);
        var result = orchestrator.buildExplicitImageEditPlan(request);
        Assertions.assertEquals("edit", result.tasks().getFirst().action());
        Assertions.assertEquals(request.message(), result.tasks().getFirst().prompt());
        Assertions.assertEquals(request.creationSettings(), result.creationSettings());
        var noReference = new AgentChatRequest("session", CreationEntrySource.IMAGE_PAGE, request.message(), null, null, List.of(), null, request.creationSettings(), null);
        Assertions.assertNull(orchestrator.buildExplicitImageEditPlan(noReference));
    }

    @Test
    void shouldRouteExplicitExistingImageModificationThroughEditTool() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        String instruction = "在原有透明玻璃香水瓶上增加 ASTON 品牌标签";
        var history = session(List.of(new AgentMessage("u1", "user", "生成一瓶香水", null)));
        var result = orchestrator.composeFollowUpPrompts(planWithSourcePromptId(instruction, "current"), history, instruction);
        Assertions.assertEquals("edit", result.tasks().getFirst().action());
        Assertions.assertEquals(instruction, result.tasks().getFirst().prompt());
        var fresh = orchestrator.composeFollowUpPrompts(planWithSourcePromptId("生成一张城市图片", "current"), history, "生成一张城市图片");
        Assertions.assertEquals("generate", fresh.tasks().getFirst().action());
    }

    @Test
    void shouldSupportAllCreationEntrySources() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));

        Assertions.assertTrue(orchestrator.supports(CreationEntrySource.IMAGE_PAGE));
        Assertions.assertTrue(orchestrator.supports(CreationEntrySource.VIDEO_PAGE));
        Assertions.assertTrue(orchestrator.supports(CreationEntrySource.CANVAS));
        Assertions.assertFalse(orchestrator.supports("unknown"));
    }

    /**
     * 历史中的用户原始创作提示词可以被主Agent任务继续使用。
     */
    @Test
    void shouldAcceptPromptFromHistoricalUserMessage() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        AgentSession session = session(List.of(
                new AgentMessage("user-1", "user", "生成一只小猫和小狗在玩耍", null),
                new AgentMessage("assistant-1", "assistant", "请补充尺寸", null)));

        CreationPlan result = orchestrator.withServerPlanId(plan("生成一只小猫和小狗在玩耍"), session, "使用胶片风格");

        Assertions.assertEquals("生成一只小猫和小狗在玩耍", result.tasks().getFirst().prompt());
        Assertions.assertNotEquals("model-plan", result.planId());
    }

    /**
     * 主Agent不得将用户原文改写后作为任务提示词。
     */
    @Test
    void shouldRejectRewrittenPromptFromMainAgent() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        AgentSession session = session(List.of(new AgentMessage("user-1", "user", "生成一只小猫", null)));

        Assertions.assertThrows(BusinessException.class,
                () -> orchestrator.withServerPlanId(plan("一只橘色短毛猫在阳光下奔跑"), session, "生成一只小猫"));
    }

    /**
     * 主Agent选择当前消息引用时，服务端必须回填完整原文而非采用模型改写内容。
     */
    @Test
    void shouldResolveCurrentPromptFromSourcePromptId() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        String originalPrompt = "Cloudfalre在今年七月份发布了Monetizaiton Gateway";

        CreationPlan result = orchestrator.resolveTaskPromptSources(planWithSourcePromptId("Cloudflare Monetization Gateway", "current"),
                session(List.of()), originalPrompt);

        Assertions.assertEquals(originalPrompt, result.tasks().getFirst().prompt());
    }

    /**
     * 主Agent选择历史消息引用时，服务端必须保留该消息的完整原文。
     */
    @Test
    void shouldResolveHistoricalPromptFromSourcePromptId() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        AgentSession session = session(List.of(new AgentMessage("user-1", "user", "生成一只小猫", null)));

        CreationPlan result = orchestrator.resolveTaskPromptSources(planWithSourcePromptId("一只短毛猫", "history-0"),
                session, "尺寸 9:16");

        Assertions.assertEquals("生成一只小猫", result.tasks().getFirst().prompt());
    }

    /**
     * 主Agent引用不存在的用户原文时必须拒绝计划，不能采用模型改写文本。
     */
    @Test
    void shouldRejectUnknownSourcePromptId() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));

        Assertions.assertThrows(BusinessException.class,
                () -> orchestrator.resolveTaskPromptSources(planWithSourcePromptId("模型改写内容", "history-99"),
                        session(List.of()), "生成一只小猫"));
    }

    /**
     * 主Agent未提供用户原文引用时必须拒绝计划，避免旧字段回退绕过来源约束。
     */
    @Test
    void shouldRecoverMissingReferenceOnlyFromExactPagePrompt() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        String original = "一瓶透明玻璃香水置于浅灰色石台上";
        var current = orchestrator.resolveTaskPromptSources(plan(original), session(List.of()), original);
        Assertions.assertEquals("current", current.tasks().getFirst().sourcePromptId());
        Assertions.assertEquals(original, current.tasks().getFirst().prompt());
        var historical = orchestrator.resolveTaskPromptSources(plan(original),
                session(List.of(new AgentMessage("u1", "user", original, null))), "尺寸 9:16");
        Assertions.assertEquals("history-0", historical.tasks().getFirst().sourcePromptId());
        var canvas = orchestrator.resolveTaskPromptSources(canvasPlan(original), canvasSession(List.of()), original);
        Assertions.assertEquals("current", canvas.tasks().getFirst().sourcePromptId());
        Assertions.assertEquals(original, canvas.tasks().getFirst().prompt());
    }

    @Test
    void shouldUseCurrentUserInstructionWhenPageModelRewritesAndOmitsReference() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        String instruction = "在原有透明玻璃香水瓶上增加 ASTON 品牌标签";
        var result = orchestrator.resolveTaskPromptSources(plan("模型自行扩写的香水广告"),
                session(List.of(new AgentMessage("u1", "user", "生成一瓶香水", null))), instruction);
        Assertions.assertEquals("current", result.tasks().getFirst().sourcePromptId());
        Assertions.assertEquals(instruction, result.tasks().getFirst().prompt());
    }

    @Test
    void shouldUseTrustedVideoEntryWhenModelAlsoMisreportsEntrySource() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        String instruction = "dance=宅舞萌系";
        CreationPlan modelPlan = new CreationPlan("model-plan", "生成视频", CreationEntrySource.CANVAS,
                "执行生成", "", false, null,
                List.of(new CreationTask("video-task", "video", "generate", "模型扩写的舞蹈镜头",
                        null, List.of(), null, Map.of())), List.of());

        CreationPlan result = orchestrator.resolveTaskPromptSources(
                modelPlan, session(List.of()), instruction, CreationEntrySource.VIDEO_PAGE);

        Assertions.assertEquals("current", result.tasks().getFirst().sourcePromptId());
        Assertions.assertEquals(instruction, result.tasks().getFirst().prompt());
    }

    @Test
    void shouldBindDirectCanvasGenerationToUserPromptWithoutAcceptingModelRewrite() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));

        for (CreationPlan candidate : List.of(canvasPlan("模型改写内容"), canvasVideoPlan("模型改写内容"))) {
            var resolved = orchestrator.resolveTaskPromptSources(candidate, canvasSession(List.of()), "红色纸船漂浮在湖面，时长10秒");
            Assertions.assertEquals("current", resolved.tasks().getFirst().sourcePromptId());
            Assertions.assertEquals("红色纸船漂浮在湖面，时长10秒", resolved.tasks().getFirst().prompt());
        }
    }

    @Test
    void shouldRepairDescriptiveActionBeforeCanvasExecution() {
        var task = new CreationTask("t1", "video", "在画布创建视频生成配置节点并立即生成", "纸船", "current",
                List.of(), "canvas_generate_video", Map.of());
        var plan = new CreationPlan("p", "视频", "canvas", "", "", false, null, List.of(task), List.of());
        Assertions.assertTrue(CreationAgentOrchestrator.needsCanvasPlanRepair(plan, "canvas"));
    }

    @Test
    void shouldRepairMissingOrDuplicateCanvasTaskIdsBeforeExecution() {
        for (String id : java.util.Arrays.asList(null, "", "t1")) {
            var first = new CreationTask("t1", "video", "generate", "纸船", "current",
                    List.of(), "canvas_generate_video", Map.of());
            var second = new CreationTask(id, "video", "generate", "纸船", "current",
                    List.of(), "canvas_generate_video", Map.of());
            var plan = new CreationPlan("p", "视频", "canvas", "", "", false,
                    null, List.of(first, second), List.of());
            Assertions.assertTrue(CreationAgentOrchestrator.needsCanvasPlanRepair(plan, "canvas"));
            Assertions.assertFalse(CreationAgentOrchestrator.needsCanvasPlanRepair(plan, "videoPage"));
        }
        Assertions.assertFalse(CreationAgentOrchestrator.needsCanvasPlanRepair(canvasVideoPlan("纸船"), "canvas"));
    }

    @Test
    void shouldRepairEmptyCanvasGenerationPlanWithoutChangingReadOnlyAnswers() {
        var empty = new CreationPlan("p", "生成视频", "canvas", "按用户设置生成10秒视频", "", true,
                null, List.of(), List.of(), "video_generation");
        Assertions.assertTrue(CreationAgentOrchestrator.needsCanvasPlanRepair(empty, "canvas"));
        Assertions.assertFalse(CreationAgentOrchestrator.needsCanvasPlanRepair(empty, "videoPage"));
        var question = new CreationPlan("p", "生成视频", "canvas", "", "请指定视频内容", true,
                null, List.of(), List.of());
        Assertions.assertFalse(CreationAgentOrchestrator.needsCanvasPlanRepair(question, "canvas"));
        var analysis = new CreationPlan("p", "分析画布", "canvas", "当前画布为空", "", false,
                null, List.of(), List.of());
        Assertions.assertFalse(CreationAgentOrchestrator.needsCanvasPlanRepair(analysis, "canvas"));
    }

    @Test
    void shouldRecoverDeclaredMediaDependencyWithoutTreatingTaskIdAsUserText() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        var image = new CreationTask("t1", "image", "generate_image", "model image", null,
                List.of(), "canvas_generate_image", Map.of("prompt", "model image", "size", "1:1"));
        var video = new CreationTask("t2", "video", "generate_video", "model video", "t1",
                List.of("t1"), "canvas_generate_video", Map.of("prompt", "model video", "size", "1:1"));
        var candidate = new CreationPlan("p", "video", null, "生成", "", true,
                null, List.of(image, video), List.of(), "image-to-video");
        var resolved = orchestrator.resolveTaskPromptSources(candidate, canvasSession(List.of()),
                "红色纸船漂浮在清晨湖面，10秒", CreationEntrySource.CANVAS);
        for (var task : resolved.tasks()) {
            Assertions.assertEquals("current", task.sourcePromptId());
            Assertions.assertEquals("红色纸船漂浮在清晨湖面，10秒", task.prompt());
        }
        Assertions.assertEquals(List.of("t1"), resolved.tasks().get(1).dependsOn());
        var settings = new CreationSettings("agent-model", "1:1", "720p", "medium", 1,
                "10", false, null, null, null, "text-to-video", "video-model");
        var validated = new CreationPlanValidator(new AgentToolRegistry())
                .validate(resolved, CreationEntrySource.CANVAS, settings);
        Assertions.assertEquals(2, validated.tasks().size());
        Assertions.assertFalse(validated.canvasGuidance());
        Assertions.assertNull(validated.workflowType());
        validated.tasks().forEach(task -> Assertions.assertEquals("generate", task.action()));
    }

    @Test
    void shouldBindCanvasEditingToolToActualUserRequestWhenReferenceIsOmitted() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        String request = "新增一个文本节点，正文为纸船沿湖面前行";
        CreationPlan candidate = new CreationPlan("edit-plan", "edit", CreationEntrySource.CANVAS,
                "新增文本", "", false, null,
                List.of(new CreationTask("edit-task", "tool_call", null, "模型摘要", null,
                        List.of(), "canvas_create_text_node", Map.of())), List.of());
        CreationTask result = orchestrator.resolveTaskPromptSources(candidate, canvasSession(List.of()), request)
                .tasks().getFirst();
        Assertions.assertEquals("current", result.sourcePromptId());
        Assertions.assertEquals(request, result.prompt());
        Assertions.assertEquals("canvas_create_text_node", result.toolName());
    }

    /** 画布多轮确认结束后应安全回溯最初用户原文并合并最终选择。 */
    @Test
    void shouldRecoverCanvasPromptAcrossClarificationRounds() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        String original = "成都 的 360 等距柱状全景图";
        String selection = "老巷夜色";
        AgentSession session = canvasSession(List.of(
                new AgentMessage("u1", "user", original, null),
                new AgentMessage("a1", "assistant", "是否改用 2:1？请选择场景，确认后直接出图。", null),
                new AgentMessage("u2", "user", "确认", null),
                new AgentMessage("a2", "assistant", "尺寸已锁定，还差取景地，请点选一个：", null),
                new AgentMessage("u3", "user", selection, null)));

        CreationPlan resolved = orchestrator.resolveTaskPromptSources(
                canvasPlan("模型整理后的成都老巷全景图"), session, selection, CreationEntrySource.CANVAS);

        Assertions.assertEquals("history-0", resolved.tasks().getFirst().sourcePromptId());
        Assertions.assertEquals(original, resolved.tasks().getFirst().prompt());
        CreationPlan trusted = orchestrator.withServerPlanId(resolved, session, selection);
        CreationPlan composed = orchestrator.composeFollowUpPrompts(trusted, session, selection);
        Assertions.assertTrue(composed.tasks().getFirst().prompt().contains(original));
        Assertions.assertTrue(composed.tasks().getFirst().prompt().contains(selection));
        Assertions.assertEquals("canvas_generate_image", composed.tasks().getFirst().toolName());
    }

    @Test
    void shouldUseLatestSceneDescriptionAfterCanvasVideoClarification() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        String scene = "一只橘猫在窗台上打盹，阳光洒落，写实风格";
        AgentSession session = canvasSession(List.of(
                new AgentMessage("u1", "user", "asd", null),
                new AgentMessage("a1", "assistant", "请描述你想创作什么？", null),
                new AgentMessage("u2", "user", "生成视频", null),
                new AgentMessage("a2", "assistant", "请描述视频画面内容？", null),
                new AgentMessage("u3", "user", scene, null)));
        CreationPlan modelPlan = new CreationPlan("model-plan", "生成视频", CreationEntrySource.CANVAS,
                "生成一个视频", "", false, null,
                List.of(new CreationTask("task-1", "video_generation", "generate", "模型扩写的橘猫视频",
                        null, List.of(), "canvas_generate_video", Map.of("prompt", "模型扩写的橘猫视频", "size", "16:9"))),
                List.of());

        CreationPlan resolved = orchestrator.resolveTaskPromptSources(
                modelPlan, session, scene, CreationEntrySource.CANVAS);

        Assertions.assertEquals("current", resolved.tasks().getFirst().sourcePromptId());
        Assertions.assertEquals(scene, resolved.tasks().getFirst().prompt());
    }

    @Test
    void shouldKeepOriginalCanvasSceneWhenReplyOnlyChangesVideoSettings() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        String original = "橘猫在窗台上打盹，午后的阳光照进房间";
        String settingsReply = "把视频时长改成8秒，保持原来的画面";
        AgentSession session = canvasSession(List.of(
                new AgentMessage("u1", "user", original, null),
                new AgentMessage("a1", "assistant", "请确认视频时长？", null),
                new AgentMessage("u2", "user", settingsReply, null)));

        CreationPlan resolved = orchestrator.resolveTaskPromptSources(
                canvasVideoPlan("模型扩写的提示词"), session, settingsReply, CreationEntrySource.CANVAS);

        Assertions.assertEquals("history-0", resolved.tasks().getFirst().sourcePromptId());
        Assertions.assertEquals(original, resolved.tasks().getFirst().prompt());
    }

    /**
     * 多轮补充页面参数时，当前补参消息不得覆盖最初的创作提示词。
     */
    @Test
    void shouldKeepOriginalPromptWhenCurrentMessageOnlyAddsParameters() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        AgentSession session = session(List.of(new AgentMessage("user-1", "user", "生成一只小猫", null)));

        CreationPlan result = orchestrator.withServerPlanId(plan("生成一只小猫"), session, "尺寸 9:16，清晰度 2K");

        Assertions.assertEquals("生成一只小猫", result.tasks().getFirst().prompt());
    }

    /**
     * 画布多轮补充尺寸时，主Agent省略生成命令前缀也必须恢复完整用户消息。
     */
    @Test
    void shouldRestoreCanvasPromptWhenGenerationCommandPrefixIsDropped() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        AgentSession session = canvasSession(List.of(new AgentMessage("user-1", "user", "生成图片：小马在奔跑", null)));

        CreationPlan result = orchestrator.withServerPlanId(canvasPlan("小马在奔跑"), session, "9:16");

        Assertions.assertEquals("生成图片：小马在奔跑", result.tasks().getFirst().prompt());
    }

    /**
     * 画布视频多轮补充尺寸时，同样必须恢复完整用户消息。
     */
    @Test
    void shouldRestoreCanvasVideoPromptWhenGenerationCommandPrefixIsDropped() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        AgentSession session = canvasSession(List.of(new AgentMessage("user-1", "user", "生成视频：小马在奔跑", null)));

        CreationPlan result = orchestrator.withServerPlanId(canvasVideoPlan("小马在奔跑"), session, "9:16");

        Assertions.assertEquals("生成视频：小马在奔跑", result.tasks().getFirst().prompt());
    }

    /**
     * 画布已经选择风格且输入修改风格时，应标记为风格重生成请求。
     */
    @Test
    void shouldRecognizeCanvasStyleFollowUpRequest() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        AgentChatRequest request = new AgentChatRequest(null, CreationEntrySource.CANVAS, "修改风格", Map.of(),
                List.of(), List.of(), List.of(), new CreationSettings("image-model", "16:9", "2K", "high", 1,
                null, null, null, null, Map.of("image", List.of(7L))), null);

        Assertions.assertTrue(orchestrator.isStyleFollowUpRequest(request));
    }

    /**
     * 通用风格命令应直接重生成当前选中的图片节点，并沿用历史原始提示词。
     */
    @Test
    void shouldBuildCanvasStyleFollowUpGenerationPlan() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        AgentSession session = canvasSession(List.of(new AgentMessage("user-1", "user", "生成图片：小马在奔跑", null)));
        AgentChatRequest request = new AgentChatRequest(null, CreationEntrySource.CANVAS, "修改风格",
                Map.of("selectedNodeIds", List.of("image-1"), "nodes", List.of(Map.of(
                        "id", "image-1", "kind", "image", "generation", Map.of("prompt", "生成图片：小马在奔跑")))),
                List.of(), List.of(), List.of(), new CreationSettings("image-model", "16:9", "2K", "high", 1,
                null, null, null, null, Map.of("image", List.of(7L))), null);

        CreationPlan plan = orchestrator.buildStyleFollowUpPlan(session, request);

        Assertions.assertNotNull(plan);
        Assertions.assertEquals("canvas_run_generation", plan.tasks().getFirst().toolName());
        Assertions.assertEquals("生成图片：小马在奔跑", plan.tasks().getFirst().prompt());
        Assertions.assertEquals("image-1", plan.tasks().getFirst().toolArguments().get("nodeId"));
        Assertions.assertEquals("image", plan.tasks().getFirst().toolArguments().get("mode"));
    }

    /**
     * 没有风格选择或普通创作消息不能被误判为风格重生成请求。
     */
    @Test
    void shouldNotRecognizeCanvasNormalGenerationAsStyleFollowUp() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        AgentChatRequest request = new AgentChatRequest(null, CreationEntrySource.CANVAS, "生成图片：小马在奔跑", Map.of(),
                List.of(), List.of(), List.of(), new CreationSettings("image-model", "16:9", "2K", "high", 1,
                null, null), null);

        Assertions.assertFalse(orchestrator.isStyleFollowUpRequest(request));
    }

    /**
     * 画布提示词只允许恢复完整命令正文，近似改写仍必须被拒绝。
     */
    @Test
    void shouldRejectCanvasPromptThatIsNotTheCompleteCommandBody() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        AgentSession session = canvasSession(List.of(new AgentMessage("user-1", "user", "生成图片：小马在奔跑", null)));

        Assertions.assertThrows(BusinessException.class,
                () -> orchestrator.withServerPlanId(canvasPlan("小马奔跑"), session, "9:16"));
    }

    /**
     * 用户发送重试时，主Agent误将重试指令作为提示词也必须恢复为最近一次创作目标。
     */
    @Test
    void shouldRestoreLatestPromptWhenRetryMessageIsSelectedAsTaskPrompt() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        AgentSession session = session(List.of(
                new AgentMessage("user-1", "user", "生成一只小猫和小狗在沙滩上玩耍", null),
                new AgentMessage("assistant-1", "assistant", "生成失败", null)));

        CreationPlan result = orchestrator.withServerPlanId(plan("重试"), session, "重试");

        Assertions.assertEquals("生成一只小猫和小狗在沙滩上玩耍", result.tasks().getFirst().prompt());
    }

    /**
     * 用户切换模型后发送重试时，恢复历史风格但保留本次模型和页面设置。
     */
    @Test
    void shouldRestoreHistoricalStylesWithoutOverwritingCurrentSettings() {
        CreationAgentOrchestrator orchestrator = orchestrator(
                mock(AgentSessionService.class), mock(AgentScopeModelFactory.class), mock(AgentPlanRepository.class));
        CreationSettings current = new CreationSettings("new-image-model", "9:16", "2K", "medium", 1, null, null);
        CreationSettings historical = new CreationSettings("old-image-model", "1:1", "1K", "high", 1, null, null,
                List.of(7L), null);

        CreationSettings result = orchestrator.mergeRetrySettings(current, historical);

        Assertions.assertEquals("new-image-model", result.model());
        Assertions.assertEquals("9:16", result.size());
        Assertions.assertEquals(List.of(7L), result.generationStyleIds());
    }

    /**
     * 同一用户同一入口连续提交时，每次都必须创建独立请求并进入队列，不能复用或忽略旧请求。
     */
    @Test
    void shouldPersistAndQueueEverySameEntryRequest() {
        AgentSessionService sessionService = mock(AgentSessionService.class);
        CreationAgentRequestRepository requestRepository = mock(CreationAgentRequestRepository.class);
        CreationAgentRequestDispatcher requestDispatcher = mock(CreationAgentRequestDispatcher.class);
        AgentEventEmitter eventEmitter = mock(AgentEventEmitter.class);
        AgentSession agentSession = session(List.of());
        when(sessionService.getOrCreateSession(1L, null, CreationEntrySource.IMAGE_PAGE)).thenReturn(Mono.just(agentSession));
        when(requestRepository.create(any(CreationAgentRequest.class))).thenReturn(Mono.empty());
        when(requestDispatcher.enqueue(any(CreationAgentRequest.class))).thenReturn(Mono.empty());
        when(requestRepository.findStatusById(anyString())).thenReturn(Mono.just("queued"));
        CreationAgentOrchestrator orchestrator = queuedOrchestrator(sessionService, eventEmitter,
                mock(AgentPlanRepository.class), mock(AiTaskService.class), requestRepository, requestDispatcher,
                mock(CreationAgentRequestQueue.class));

        var first = orchestrator.startChat(1L, chatRequest("第一条图片请求")).block();
        var second = orchestrator.startChat(1L, chatRequest("第二条图片请求")).block();

        Assertions.assertNotNull(first);
        Assertions.assertNotNull(second);
        Assertions.assertEquals("session", first.sessionId());
        Assertions.assertEquals("session", second.sessionId());
        Assertions.assertEquals("queued", first.status());
        Assertions.assertEquals("queued", second.status());
        Assertions.assertNotEquals(first.requestId(), second.requestId());

        ArgumentCaptor<CreationAgentRequest> requestCaptor = ArgumentCaptor.forClass(CreationAgentRequest.class);
        verify(requestRepository, times(2)).create(requestCaptor.capture());
        verify(requestDispatcher, times(2)).enqueue(any(CreationAgentRequest.class));
        List<CreationAgentRequest> requests = requestCaptor.getAllValues();
        Assertions.assertEquals(first.requestId(), requests.getFirst().getId());
        Assertions.assertEquals(second.requestId(), requests.get(1).getId());
        Assertions.assertEquals("第一条图片请求", JSON.parseObject(requests.getFirst().getRequestData(), AgentChatRequest.class).message());
        Assertions.assertEquals("第二条图片请求", JSON.parseObject(requests.get(1).getRequestData(), AgentChatRequest.class).message());
        Assertions.assertEquals("session", JSON.parseObject(requests.getFirst().getRequestData(), AgentChatRequest.class).sessionId());
    }

    /**
     * 取消排队请求只能移除目标请求，不能影响同分区正在运行或其他入口的请求。
     */
    @Test
    void shouldCancelOnlyTargetQueuedRequest() {
        CreationAgentRequestRepository requestRepository = mock(CreationAgentRequestRepository.class);
        CreationAgentRequestDispatcher requestDispatcher = mock(CreationAgentRequestDispatcher.class);
        CreationAgentRequestQueue requestQueue = mock(CreationAgentRequestQueue.class);
        AgentPlanRepository planRepository = mock(AgentPlanRepository.class);
        AiTaskService aiTaskService = mock(AiTaskService.class);
        CreationAgentRequest queued = queuedRequest("request-b", "queued", "");
        when(requestRepository.findByIdForUser(1L, "request-b")).thenReturn(Mono.just(queued));
        when(requestRepository.cancelQueuedIfQueued(1L, "request-b", "已停止生成")).thenReturn(Mono.just(true));
        when(requestQueue.removeQueuedRequest(1L, CreationEntrySource.IMAGE_PAGE, "request-b")).thenReturn(Mono.empty());
        when(requestQueue.releaseActiveRequest(1L, CreationEntrySource.IMAGE_PAGE, "request-b")).thenReturn(Mono.empty());
        when(requestDispatcher.dispatchAvailable(1L, CreationEntrySource.IMAGE_PAGE)).thenReturn(Mono.empty());
        CreationAgentOrchestrator orchestrator = queuedOrchestrator(mock(AgentSessionService.class), mock(AgentEventEmitter.class),
                planRepository, aiTaskService, requestRepository, requestDispatcher, requestQueue);

        orchestrator.cancelChat(1L, "request-b").block();

        verify(requestRepository).cancelQueuedIfQueued(1L, "request-b", "已停止生成");
        verify(requestQueue).removeQueuedRequest(1L, CreationEntrySource.IMAGE_PAGE, "request-b");
        verify(requestQueue).releaseActiveRequest(1L, CreationEntrySource.IMAGE_PAGE, "request-b");
        verify(requestDispatcher).dispatchAvailable(1L, CreationEntrySource.IMAGE_PAGE);
        verify(requestRepository, never()).cancelRunningIfRunning(anyLong(), anyString(), anyString());
        verify(requestQueue, never()).markCancelRequested(anyString());
        verify(planRepository, never()).cancelPlan(anyString());
        verify(aiTaskService, never()).cancelTaskForUser(anyLong(), anyString());
    }

    /**
     * 取消运行请求必须写入跨实例取消标记，并取消已创建计划和底层任务。
     */
    @Test
    void shouldMarkAndCancelRunningRequestResources() {
        CreationAgentRequestRepository requestRepository = mock(CreationAgentRequestRepository.class);
        CreationAgentRequestDispatcher requestDispatcher = mock(CreationAgentRequestDispatcher.class);
        CreationAgentRequestQueue requestQueue = mock(CreationAgentRequestQueue.class);
        AgentPlanRepository planRepository = mock(AgentPlanRepository.class);
        AiTaskService aiTaskService = mock(AiTaskService.class);
        CreationAgentRequest running = queuedRequest("request-running", "running", "plan-1");
        running.setTaskIds("[\"task-1\"]");
        when(requestRepository.findByIdForUser(1L, "request-running")).thenReturn(Mono.just(running));
        when(requestRepository.cancelRunningIfRunning(1L, "request-running", "已停止生成")).thenReturn(Mono.just(true));
        when(requestQueue.markCancelRequested("request-running")).thenReturn(Mono.empty());
        when(requestRepository.taskIds(running)).thenReturn(List.of("task-1"));
        when(planRepository.cancelPlan("plan-1")).thenReturn(Mono.empty());
        when(aiTaskService.cancelTaskForUser(1L, "task-1")).thenReturn(Mono.empty());
        CreationAgentOrchestrator orchestrator = queuedOrchestrator(mock(AgentSessionService.class), mock(AgentEventEmitter.class),
                planRepository, aiTaskService, requestRepository, requestDispatcher, requestQueue);

        orchestrator.cancelChat(1L, "request-running").block();

        verify(requestRepository).cancelRunningIfRunning(1L, "request-running", "已停止生成");
        verify(requestQueue).markCancelRequested("request-running");
        verify(planRepository).cancelPlan("plan-1");
        verify(aiTaskService).cancelTaskForUser(1L, "task-1");
        verify(requestQueue, never()).removeQueuedRequest(anyLong(), anyString(), anyString());
        verify(requestDispatcher, never()).dispatchAvailable(anyLong(), anyString());
    }

    /**
     * 请求已领取但尚未建立执行上下文时，停止操作必须取消领取订阅，避免分区名额一直被占用。
     */
    @Test
    void shouldStopClaimedSubscriptionBeforeExecutionContextIsReady() {
        CreationAgentRequestRepository requestRepository = mock(CreationAgentRequestRepository.class);
        when(requestRepository.findById("request-running")).thenReturn(Mono.never());
        CreationAgentOrchestrator orchestrator = queuedOrchestrator(mock(AgentSessionService.class), mock(AgentEventEmitter.class),
                mock(AgentPlanRepository.class), mock(AiTaskService.class), requestRepository,
                mock(CreationAgentRequestDispatcher.class), mock(CreationAgentRequestQueue.class));

        reactor.core.Disposable subscription = orchestrator.executeClaimedRequest("request-running").subscribe();
        orchestrator.stopClaimedExecution("request-running").block();

        Assertions.assertTrue(subscription.isDisposed());
    }

    /**
     * 旧实例收到中断取消标记后，必须保持关联计划失败，不能覆盖为已取消。
     */
    @Test
    void shouldKeepInterruptedRequestPlanFailedWhenOldInstanceStops() {
        AgentPlanRepository planRepository = mock(AgentPlanRepository.class);
        CreationAgentRequest interrupted = queuedRequest("request-interrupted", "interrupted", "plan-1");
        interrupted.setErrorMessage("服务重启导致请求已中断");
        when(planRepository.markInterruptedPlanFailed("plan-1", "服务重启导致请求已中断"))
                .thenReturn(Mono.empty());
        CreationAgentOrchestrator orchestrator = queuedOrchestrator(mock(AgentSessionService.class), mock(AgentEventEmitter.class),
                planRepository, mock(AiTaskService.class), mock(CreationAgentRequestRepository.class),
                mock(CreationAgentRequestDispatcher.class), mock(CreationAgentRequestQueue.class));

        orchestrator.completePlanForTerminalRequest(interrupted, "plan-1", "已停止生成").block();

        verify(planRepository).markInterruptedPlanFailed("plan-1", "服务重启导致请求已中断");
        verify(planRepository, never()).cancelPlan("plan-1");
    }

    /**
     * 构造主Agent编排器。
     *
     * @param sessionService AgentSessionService 会话服务
     * @param modelFactory AgentScopeModelFactory 模型工厂
     * @param planRepository AgentPlanRepository 计划仓储
     * @return CreationAgentOrchestrator 主Agent编排器
     */
    private CreationAgentOrchestrator orchestrator(AgentSessionService sessionService,
                                                    AgentScopeModelFactory modelFactory,
                                                    AgentPlanRepository planRepository) {
        return new CreationAgentOrchestrator(
                sessionService,
                mock(AgentEventEmitter.class),
                mock(AgentExecutionRegistry.class),
                modelFactory,
                mock(AgentScopeAgentFactory.class),
                mock(CreationPlanValidator.class),
                mock(CreationPlanExecutor.class),
                planRepository,
                mock(AiTaskService.class),
                mock(SkillService.class),
                mock(PersistenceService.class),
                new AgentToolRegistry(),
                new CanvasSnapshotCompactor(),
                mock(CreationAgentRequestRepository.class),
                mock(CreationAgentRequestDispatcher.class),
                mock(CreationAgentRequestQueue.class));
    }

    /**
     * 构造用于主Agent请求队列测试的编排器。
     *
     * @param sessionService Agent会话服务
     * @param eventEmitter Agent事件发射器
     * @param planRepository 创作计划仓储
     * @param aiTaskService 底层AI任务服务
     * @param requestRepository 主Agent请求仓储
     * @param requestDispatcher 主Agent请求调度器
     * @param requestQueue 主Agent请求Redis队列
     * @return CreationAgentOrchestrator 主Agent编排器
     */
    private CreationAgentOrchestrator queuedOrchestrator(AgentSessionService sessionService,
                                                          AgentEventEmitter eventEmitter,
                                                          AgentPlanRepository planRepository,
                                                          AiTaskService aiTaskService,
                                                          CreationAgentRequestRepository requestRepository,
                                                          CreationAgentRequestDispatcher requestDispatcher,
                                                          CreationAgentRequestQueue requestQueue) {
        return new CreationAgentOrchestrator(
                sessionService,
                eventEmitter,
                mock(AgentExecutionRegistry.class),
                mock(AgentScopeModelFactory.class),
                mock(AgentScopeAgentFactory.class),
                mock(CreationPlanValidator.class),
                mock(CreationPlanExecutor.class),
                planRepository,
                aiTaskService,
                mock(SkillService.class),
                mock(PersistenceService.class),
                new AgentToolRegistry(),
                new CanvasSnapshotCompactor(),
                requestRepository,
                requestDispatcher,
                requestQueue);
    }

    /**
     * 构造图片入口主Agent聊天请求。
     *
     * @param message String 用户消息
     * @return AgentChatRequest 聊天请求
     */
    private AgentChatRequest chatRequest(String message) {
        return new AgentChatRequest(null, CreationEntrySource.IMAGE_PAGE, message, Map.of(), List.of(), List.of(), List.of(), null, null);
    }

    /**
     * 构造主Agent请求记录。
     *
     * @param requestId String 请求ID
     * @param status String 请求状态
     * @param planId String 创作计划ID
     * @return CreationAgentRequest 请求记录
     */
    private CreationAgentRequest queuedRequest(String requestId, String status, String planId) {
        CreationAgentRequest request = new CreationAgentRequest();
        request.setId(requestId);
        request.setUserId(1L);
        request.setSessionId("session");
        request.setEntrySource(CreationEntrySource.IMAGE_PAGE);
        request.setStatus(status);
        request.setPlanId(planId);
        request.setTaskIds("[]");
        return request;
    }

    /**
     * 构造包含指定历史消息的图片创作会话。
     *
     * @param messages List<AgentMessage> 会话消息
     * @return AgentSession 图片创作会话
     */
    private AgentSession session(List<AgentMessage> messages) {
        return new AgentSession("session", 1L, "新对话", CreationEntrySource.IMAGE_PAGE,
                messages, OffsetDateTime.now(), OffsetDateTime.now());
    }

    /**
     * 构造画布创作会话。
     *
     * @param messages List<AgentMessage> 会话消息
     * @return AgentSession 画布会话
     */
    private AgentSession canvasSession(List<AgentMessage> messages) {
        return new AgentSession("session", 1L, "新对话", CreationEntrySource.CANVAS,
                messages, OffsetDateTime.now(), OffsetDateTime.now());
    }

    /**
     * 构造主Agent候选计划。
     *
     * @param prompt String 主Agent选择的任务提示词
     * @return CreationPlan 候选计划
     */
    private CreationPlan plan(String prompt) {
        return new CreationPlan("model-plan", "生成图片", CreationEntrySource.IMAGE_PAGE, "生成一张图片", "", false,
                new CreationSettings("image-model", "1:1", "2K", "high", 1, null, null),
                List.of(new CreationTask("task-1", "image", "generate", prompt, List.of(), null, Map.of())),
                List.of());
    }

    /**
     * 构造携带用户原文引用的主Agent候选计划。
     *
     * @param prompt String 模型返回的临时提示词
     * @param sourcePromptId String 服务端用户原文引用
     * @return CreationPlan 候选计划
     */
    private CreationPlan planWithSourcePromptId(String prompt, String sourcePromptId) {
        return new CreationPlan("model-plan", "生成图片", CreationEntrySource.IMAGE_PAGE, "生成一张图片", "", false,
                new CreationSettings("image-model", "1:1", "2K", "high", 1, null, null),
                List.of(new CreationTask("task-1", "image", "generate", prompt, sourcePromptId, List.of(), null, Map.of())),
                List.of());
    }

    /**
     * 构造画布图片候选计划。
     *
     * @param prompt String 主Agent选择的任务提示词
     * @return CreationPlan 画布图片计划
     */
    private CreationPlan canvasPlan(String prompt) {
        return new CreationPlan("model-plan", "生成图片", CreationEntrySource.CANVAS, "生成一张图片", "", false,
                new CreationSettings("image-model", "1:1", "2K", "high", 1, null, null),
                List.of(new CreationTask("task-1", "image", "generate", prompt, List.of(), "canvas_generate_image",
                        Map.of("prompt", prompt, "size", "9:16"))),
                List.of());
    }

    /**
     * 构造画布视频候选计划。
     *
     * @param prompt String 主Agent选择的任务提示词
     * @return CreationPlan 画布视频计划
     */
    private CreationPlan canvasVideoPlan(String prompt) {
        return new CreationPlan("model-plan", "生成视频", CreationEntrySource.CANVAS, "生成一个视频", "", false,
                new CreationSettings("video-model", "16:9", "1080P", "high", 1, "5", false),
                List.of(new CreationTask("task-1", "video", "generate", prompt, List.of(), "canvas_generate_video",
                        Map.of("prompt", prompt, "size", "16:9"))),
                List.of());
    }
}
