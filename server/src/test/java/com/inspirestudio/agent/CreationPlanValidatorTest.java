package com.inspirestudio.agent;

import com.inspirestudio.agent.dto.CreationPlan;
import com.inspirestudio.agent.dto.CreationSettings;
import com.inspirestudio.agent.dto.CreationTask;
import com.inspirestudio.agent.workflow.FirstLastFrameVideoWorkflow;
import com.inspirestudio.agent.workflow.VideoWorkflowRegistry;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.dto.GenerationStyleDtos;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

/**
 * 主Agent创作计划确定性校验测试。
 *
 * @date     2026-07-23 00:00
 */
class CreationPlanValidatorTest {

    /** 计划校验器 */
    private final CreationPlanValidator validator = new CreationPlanValidator(new AgentToolRegistry());

    @Test
    void normalizesObservedCanvasOperationAliasOnlyForRegisteredEditingTools() {
        var task = new CreationTask("t", "tool_call", null, "新增文本", "current",
                List.of(), "canvas_create_text_node", Map.of("text", "纸船沿湖面前行"));
        var result = validator.validate(plan(CreationEntrySource.CANVAS, List.of(task)), CreationEntrySource.CANVAS, null);
        Assertions.assertEquals("canvas", result.tasks().getFirst().taskType());
        Assertions.assertEquals("tool", result.tasks().getFirst().action());
        var withUnknownWorkflow = new CreationPlan("edit", "edit", CreationEntrySource.CANVAS,
                "新增文本", "", false, null, List.of(task), List.of(), "canvas_edit");
        Assertions.assertEquals("tool", validator.validate(withUnknownWorkflow, CreationEntrySource.CANVAS, null)
                .tasks().getFirst().action());
        var mislabeled = new CreationTask("edit", "canvas_create_text_node", "创建文本", "新增文本", "current",
                List.of(), "canvas_create_text_node", Map.of("text", "纸船沿湖面前行"));
        var navigation = new CreationPlan("edit", "edit", CreationEntrySource.CANVAS,
                "新增文本", "", true, null, List.of(mislabeled), List.of());
        var actualEdit = validator.validate(navigation, CreationEntrySource.CANVAS, null);
        Assertions.assertFalse(actualEdit.canvasGuidance());
        Assertions.assertEquals(1, actualEdit.tasks().size());
        Assertions.assertEquals("canvas", actualEdit.tasks().getFirst().taskType());
        Assertions.assertThrows(BusinessException.class, () -> validator.validate(
                plan(CreationEntrySource.IMAGE_PAGE, List.of(task)), CreationEntrySource.IMAGE_PAGE, imageSettings()));
    }

    @Test
    void normalizesObservedSnakeCaseGenerationAndEditTogether() {
        for (String action : List.of("generate_image", "edit_image")) {
            var task = new CreationTask("t", "image_generation", action, "bedroom_warm", "current", List.of(), "generate_image", Map.of());
            var result = validator.validate(plan(CreationEntrySource.IMAGE_PAGE, List.of(task)), CreationEntrySource.IMAGE_PAGE, imageSettings());
            Assertions.assertEquals("image", result.tasks().getFirst().taskType());
            Assertions.assertEquals(action.startsWith("edit") ? "edit" : "generate", result.tasks().getFirst().action());
            Assertions.assertThrows(BusinessException.class, () -> validator.validate(plan(CreationEntrySource.VIDEO_PAGE, List.of(task)), CreationEntrySource.VIDEO_PAGE, imageSettings()));
        }
    }

    @Test
    void shouldNormalizeObservedImageActionAliasWithoutAllowingCanvasTools() {
        var task = new CreationTask("t", "image", "generateImage", "pink", null, List.of(), "imageGeneration", Map.of());
        var result = validator.validate(plan(CreationEntrySource.IMAGE_PAGE, List.of(task)), CreationEntrySource.IMAGE_PAGE, imageSettings());
        Assertions.assertEquals("generate", result.tasks().getFirst().action());
        Assertions.assertNull(result.tasks().getFirst().toolName());
        var invalid = new CreationTask("t", "image", "generateImage", "pink", null, List.of(), "canvas_delete_node", Map.of());
        Assertions.assertThrows(BusinessException.class, () -> validator.validate(
                plan(CreationEntrySource.IMAGE_PAGE, List.of(invalid)), CreationEntrySource.IMAGE_PAGE, imageSettings()));
        Assertions.assertThrows(BusinessException.class, () -> validator.validate(
                plan(CreationEntrySource.VIDEO_PAGE, List.of(task)), CreationEntrySource.VIDEO_PAGE, imageSettings()));
    }

    @Test
    void shouldDefaultMissingActionForObservedPlainImageSkillTask() {
        for (String action : java.util.Arrays.asList(null, "", " ")) {
            var task = new CreationTask("skill-image", "image", action, "小狗打架", null, List.of(), null, Map.of());
            var result = validator.validate(plan(CreationEntrySource.IMAGE_PAGE, List.of(task)),
                    CreationEntrySource.IMAGE_PAGE, imageSettings());
            Assertions.assertEquals("generate", result.tasks().getFirst().action());
            Assertions.assertEquals("小狗打架", result.tasks().getFirst().prompt());
            Assertions.assertEquals(imageSettings(), result.creationSettings());
            Assertions.assertNull(result.tasks().getFirst().toolName());
        }
    }

    @Test
    void shouldNotDefaultMissingActionForToolsOrCrossPageTasks() {
        for (var task : List.of(
                new CreationTask("t", "image", null, "小狗打架", "current", List.of(), "canvas_delete_node", Map.of()),
                new CreationTask("t", "image", null, "小狗打架", "current", List.of(), null, Map.of("nodeId", "node-1")),
                new CreationTask("t", "video", null, "小狗打架", "current", List.of(), null, Map.of()),
                new CreationTask("t", "canvas", null, "小狗打架", "current", List.of(), null, Map.of()),
                new CreationTask("t", "image", "delete", "小狗打架", "current", List.of(), null, Map.of()))) {
            Assertions.assertThrows(BusinessException.class, () -> validator.validate(
                    plan(CreationEntrySource.IMAGE_PAGE, List.of(task)), CreationEntrySource.IMAGE_PAGE, imageSettings()));
        }
    }

    @Test
    void shouldNormalizeImageEditAndGenerationAliasesWithoutChangingAction() {
        for (String alias : List.of("image_generation", "image_edit", "generate_image", "edit_image", "text_to_image", "image_to_image")) {
            var task = new CreationTask("t1", alias, "edit", "添加 ASTON", "current", List.of(), "generateImage", Map.of());
            var result = validator.validate(plan(CreationEntrySource.IMAGE_PAGE, List.of(task)), CreationEntrySource.IMAGE_PAGE, imageSettings());
            Assertions.assertEquals("image", result.tasks().getFirst().taskType());
            Assertions.assertEquals("edit", result.tasks().getFirst().action());
        }
    }

    @Test
    void shouldNormalizeObservedFollowUpImageGenerationCategory() {
        var task = new CreationTask("edit-perfume-label", "image_generation", "generate", "添加 ASTON 标签",
                "current", List.of(), "generate_image", Map.of());
        var result = validator.validate(plan(CreationEntrySource.IMAGE_PAGE, List.of(task)),
                CreationEntrySource.IMAGE_PAGE, imageSettings());
        var normalized = result.tasks().getFirst();
        Assertions.assertEquals("image", normalized.taskType());
        Assertions.assertEquals("current", normalized.sourcePromptId());
        Assertions.assertEquals(task.prompt(), normalized.prompt());
        Assertions.assertNull(normalized.toolName());
        Assertions.assertThrows(BusinessException.class, () -> validator.validate(
                plan(CreationEntrySource.VIDEO_PAGE, List.of(task)), CreationEntrySource.VIDEO_PAGE, imageSettings()));
        var tool = new CreationTask("t", "image_generation", "tool", "delete", "current", List.of(), "canvas_delete_node", Map.of());
        Assertions.assertThrows(BusinessException.class, () -> validator.validate(
                plan(CreationEntrySource.IMAGE_PAGE, List.of(tool)), CreationEntrySource.IMAGE_PAGE, imageSettings()));
    }

    @Test
    void shouldDiscardModelToolMetadataOnImagePageWithoutChangingRequestSettings() {
        var task = new CreationTask("image-task", "image", "generate", "original", "current", List.of(),
                "canvas_generate_image", Map.of("model", "wrong-model", "count", 9));
        var settings = imageSettings();
        var result = validator.validate(plan(CreationEntrySource.IMAGE_PAGE, List.of(task)), CreationEntrySource.IMAGE_PAGE, settings);
        var normalized = result.tasks().getFirst();
        Assertions.assertNull(normalized.toolName());
        Assertions.assertTrue(normalized.toolArguments().isEmpty());
        Assertions.assertEquals("original", normalized.prompt());
        Assertions.assertEquals("current", normalized.sourcePromptId());
        Assertions.assertEquals(settings, result.creationSettings());
    }

    @Test
    void shouldNotConvertCanvasToolActionsIntoPageGeneration() {
        for (String type : List.of("image", "canvas")) {
            var task = new CreationTask("t1",type,"tool","delete node",List.of(),"canvas_delete_node",Map.of("nodeId","n1"));
            Assertions.assertThrows(BusinessException.class, () -> validator.validate(
                    plan(CreationEntrySource.IMAGE_PAGE,List.of(task)),CreationEntrySource.IMAGE_PAGE,imageSettings()));
        }
    }

    @Test
    void shouldIgnoreModelWorkflowMetadataForConfirmedImageGeneration() {
        for (String workflow : List.of("null", "image", "text-to-image", "first-last-frame", "product-image")) {
            var imageTask = new CreationTask("image-task", "image", "generate", "", "current", List.of(), null, Map.of());
            var candidate = new CreationPlan("plan", "生成商品图", CreationEntrySource.VIDEO_PAGE,
                    "确认生成", "", false, null, List.of(imageTask), List.of(), workflow);
            var result = validator.validate(candidate, CreationEntrySource.IMAGE_PAGE, imageSettings());
            Assertions.assertNull(result.workflowType());
            Assertions.assertEquals(CreationEntrySource.IMAGE_PAGE, result.entrySource());
            Assertions.assertEquals(List.of(imageTask), result.tasks());
            Assertions.assertEquals("current", result.tasks().getFirst().sourcePromptId());
        }
    }

    @Test
    void shouldPreserveImageClarificationWhenWorkflowMetadataIsWrong() {
        var candidate = new CreationPlan("plan", "商品图", CreationEntrySource.IMAGE_PAGE,
                "", "请选择商品风格", false, null, List.of(), List.of(), "first-last-frame");
        var result = validator.validate(candidate, CreationEntrySource.IMAGE_PAGE, imageSettings());
        Assertions.assertNull(result.workflowType());
        Assertions.assertEquals("请选择商品风格", result.clarificationQuestion());
        Assertions.assertTrue(result.tasks().isEmpty());
    }

    @Test
    void shouldStillRejectVideoTaskWithWorkflowMetadataOnImagePage() {
        var candidate = new CreationPlan("plan", "生成视频", CreationEntrySource.IMAGE_PAGE,
                "", "", false, null, List.of(task("video", "video", List.of())), List.of(), "first-last-frame");
        Assertions.assertThrows(BusinessException.class,
                () -> validator.validate(candidate, CreationEntrySource.IMAGE_PAGE, imageSettings()));
    }

    /**
     * 图片页必须拒绝视频子Agent任务。
     */
    @Test
    void shouldRejectVideoTaskOnImagePage() {
        CreationPlan plan = plan(CreationEntrySource.IMAGE_PAGE,
                List.of(task("video-task", "video", List.of())));

        Assertions.assertThrows(BusinessException.class,
                () -> validator.validate(plan, CreationEntrySource.IMAGE_PAGE, videoSettings()));
    }

    /**
     * 视频页必须拒绝图片子Agent任务。
     */
    @Test
    void shouldRejectImageTaskOnVideoPage() {
        CreationPlan plan = plan(CreationEntrySource.VIDEO_PAGE,
                List.of(task("image-task", "image", List.of())));

        Assertions.assertThrows(BusinessException.class,
                () -> validator.validate(plan, CreationEntrySource.VIDEO_PAGE, imageSettings()));
    }

    /**
     * 画布允许同时规划图片和视频子Agent任务。
     */
    @Test
    void shouldAllowImageAndVideoTasksOnCanvas() {
        CreationPlan plan = plan(CreationEntrySource.CANVAS, List.of(
                canvasGenerationTask("image-task", "image", "canvas_generate_image",
                        Map.of("prompt", "一只小猫", "size", "16:9")),
                canvasGenerationTask("video-task", "video", "canvas_generate_video",
                        Map.of("prompt", "一只小狗奔跑"))));
        CreationSettings settings = new CreationSettings("model", "16:9", "720p", "medium", 1,
                "5", false, null, null, null, "text-to-video", "video-model");

        CreationPlan result = validator.validate(plan, CreationEntrySource.CANVAS, settings);

        Assertions.assertEquals(2, result.tasks().size());
        Assertions.assertSame(settings, result.creationSettings());
    }

    /** 已注册画布生成工具在类型一致时应补齐模型遗漏的生成动作。 */
    @Test
    void shouldDefaultMissingActionForRegisteredCanvasGenerationTool() {
        CreationTask missingAction = new CreationTask("image-task", "image", null, "成都 360 全景图",
                "history-0", List.of(), "canvas_generate_image",
                Map.of("prompt", "成都 360 全景图", "size", "1:1"));
        CreationSettings settings = new CreationSettings("image-model", "1:1", "2K", "high", 1,
                null, null);

        CreationPlan result = validator.validate(plan(CreationEntrySource.CANVAS, List.of(missingAction)),
                CreationEntrySource.CANVAS, settings);

        Assertions.assertEquals("generate", result.tasks().getFirst().action());
        Assertions.assertEquals("canvas_generate_image", result.tasks().getFirst().toolName());

        CreationTask wrongType = new CreationTask("image-task", "video", null, "成都 360 全景图",
                "history-0", List.of(), "canvas_generate_image",
                Map.of("prompt", "成都 360 全景图", "size", "1:1"));
        CreationTask wrongAction = new CreationTask("image-task", "image", "edit", "成都 360 全景图",
                "history-0", List.of(), "canvas_generate_image",
                Map.of("prompt", "成都 360 全景图", "size", "1:1"));
        Assertions.assertThrows(BusinessException.class,
                () -> validator.validate(plan(CreationEntrySource.CANVAS, List.of(wrongType)),
                        CreationEntrySource.CANVAS, settings));
        Assertions.assertThrows(BusinessException.class,
                () -> validator.validate(plan(CreationEntrySource.CANVAS, List.of(wrongAction)),
                        CreationEntrySource.CANVAS, settings));
    }

    /**
     * 画布按类型风格ID与历史快照不能同时提交。
     */
    @Test
    void shouldRejectCanvasStyleIdsByTypeWithSnapshots() {
        CreationPlan plan = plan(CreationEntrySource.CANVAS, List.of(
                canvasGenerationTask("image-task", "image", "canvas_generate_image",
                        Map.of("prompt", "一只小猫", "size", "16:9"))));
        CreationSettings settings = new CreationSettings("image-model", "16:9", "2K", "high", 1, null, null,
                null,
                List.of(new GenerationStyleDtos.GenerationStyleSnapshot(7L, "电影感", "image", "电影感提示词")),
                Map.of("image", List.of(7L)));

        Assertions.assertThrows(BusinessException.class,
                () -> validator.validate(plan, CreationEntrySource.CANVAS, settings));
    }

    /**
     * 普通风格ID与画布按类型风格ID不能同时提交，避免其中一组被忽略。
     */
    @Test
    void shouldRejectStyleIdsAndStyleIdsByTypeTogether() {
        CreationPlan plan = plan(CreationEntrySource.CANVAS, List.of(
                canvasGenerationTask("image-task", "image", "canvas_generate_image",
                        Map.of("prompt", "一只小猫", "size", "16:9"))));
        CreationSettings settings = new CreationSettings("image-model", "16:9", "2K", "high", 1, null, null,
                List.of(7L), null, Map.of("image", List.of(8L)));

        Assertions.assertThrows(BusinessException.class,
                () -> validator.validate(plan, CreationEntrySource.CANVAS, settings));
    }

    /**
     * 即使按类型风格字段为空，也不能与普通风格ID并存后被静默忽略。
     */
    @Test
    void shouldRejectStyleIdsWithEmptyStyleIdsByTypeField() {
        CreationPlan plan = plan(CreationEntrySource.CANVAS, List.of(
                canvasGenerationTask("image-task", "image", "canvas_generate_image",
                        Map.of("prompt", "一只小猫", "size", "16:9"))));
        CreationSettings settings = new CreationSettings("image-model", "16:9", "2K", "high", 1, null, null,
                List.of(7L), null, Map.of());

        Assertions.assertThrows(BusinessException.class,
                () -> validator.validate(plan, CreationEntrySource.CANVAS, settings));
    }

    /**
     * 画布图片和视频风格总数超过一项时必须拒绝。
     */
    @Test
    void shouldRejectMultipleCanvasStylesAcrossTypes() {
        CreationPlan plan = plan(CreationEntrySource.CANVAS, List.of(
                canvasGenerationTask("image-task", "image", "canvas_generate_image",
                        Map.of("prompt", "一只小猫", "size", "16:9"))));
        CreationSettings settings = new CreationSettings("image-model", "16:9", "2K", "high", 1, null, null,
                null, null, Map.of("image", List.of(1L), "video", List.of(2L)));

        Assertions.assertThrows(BusinessException.class,
                () -> validator.validate(plan, CreationEntrySource.CANVAS, settings));
    }

    /**
     * 图片和视频页面的普通风格ID也只能提交一个。
     */
    @Test
    void shouldRejectMultipleDirectStyleIds() {
        CreationPlan plan = plan(CreationEntrySource.IMAGE_PAGE,
                List.of(task("image-task", "image", List.of())));
        CreationSettings settings = new CreationSettings("image-model", "1:1", "2K", "high", 1, null, null,
                List.of(1L, 2L), null);

        BusinessException exception = Assertions.assertThrows(BusinessException.class,
                () -> validator.validate(plan, CreationEntrySource.IMAGE_PAGE, settings));

        Assertions.assertTrue(exception.getMessage().contains("最多选择1个风格"));
    }

    /**
     * 画布普通操作只能使用Java注册的前端工具。
     */
    @Test
    void shouldAllowRegisteredCanvasTool() {
        CreationTask task = new CreationTask("canvas-task", "canvas", "tool", "创建文本节点", List.of(),
                "canvas_create_text_node", Map.of("text", "分镜标题"));

        CreationPlan result = validator.validate(plan(CreationEntrySource.CANVAS, List.of(task)),
                CreationEntrySource.CANVAS, null);

        Assertions.assertEquals("canvas_create_text_node", result.tasks().getFirst().toolName());
    }

    /**
     * 画布视频工具必须携带独立的视频模型，不能把对话模型当作视频模型。
     */
    @Test
    void shouldRequireVideoModelForCanvasVideoTask() {
        CreationTask task = new CreationTask("video-task", "video", "generate", "生成视频", List.of(),
                "canvas_generate_video", Map.of("prompt", "生成视频"));
        CreationSettings missingVideoModel = new CreationSettings("agent-model", "16:9", "720p", "medium", 1,
                "3", false, null, null, Map.of(), "text-to-video", null);

        CreationPlan missingResult = validator.validate(plan(CreationEntrySource.CANVAS, List.of(task)),
                CreationEntrySource.CANVAS, missingVideoModel);

        Assertions.assertTrue(missingResult.tasks().isEmpty());
        Assertions.assertTrue(missingResult.clarificationQuestion().contains("视频生成模型"));

        CreationSettings settings = new CreationSettings("agent-model", "16:9", "720p", "medium", 1,
                "3", false, null, null, Map.of(), "text-to-video", "video-model");
        CreationPlan result = validator.validate(plan(CreationEntrySource.CANVAS, List.of(task)),
                CreationEntrySource.CANVAS, settings);

        Assertions.assertEquals("canvas_generate_video", result.tasks().getFirst().toolName());
    }

    @Test
    void shouldNormalizeCanvasVideoGenerationAliasOnlyForMatchingTool() {
        CreationSettings settings = new CreationSettings("agent-model", "16:9", "720p", "medium", 1,
                "5", false, null, null, Map.of(), "text-to-video", "video-model");
        CreationTask matching = new CreationTask("video-task", "video_generation", "generate", "橘猫在窗台上打盹",
                "current", List.of(), "canvas_generate_video", Map.of("prompt", "橘猫在窗台上打盹"));

        CreationPlan result = validator.validate(plan(CreationEntrySource.CANVAS, List.of(matching)),
                CreationEntrySource.CANVAS, settings);
        Assertions.assertEquals("video", result.tasks().getFirst().taskType());

        CreationTask mismatch = new CreationTask("video-task", "video_generation", "generate", "橘猫在窗台上打盹",
                "current", List.of(), "canvas_generate_image", Map.of("prompt", "橘猫在窗台上打盹"));
        Assertions.assertThrows(BusinessException.class,
                () -> validator.validate(plan(CreationEntrySource.CANVAS, List.of(mismatch)),
                        CreationEntrySource.CANVAS, settings));
    }

    /**
     * Prompt声明的未注册工具不能突破Java权限边界。
     */
    @Test
    void shouldRejectUnregisteredCanvasTool() {
        CreationTask task = new CreationTask("canvas-task", "canvas", "tool", "执行未知工具", List.of(),
                "canvas_delete_all_projects", Map.of());

        Assertions.assertThrows(BusinessException.class,
                () -> validator.validate(plan(CreationEntrySource.CANVAS, List.of(task)),
                        CreationEntrySource.CANVAS, null));
    }

    /**
     * 批量画布工具不得夹带生成操作，生成必须使用专用工具。
     */
    @Test
    void shouldRejectGenerationInsideCanvasApplyOperations() {
        CreationTask task = new CreationTask("canvas-task", "canvas", "tool", "批量操作并生成", List.of(),
                "canvas_apply_ops", Map.of("ops", List.of(Map.of(
                        "type", "run_generation", "nodeId", "image-1"))));

        Assertions.assertThrows(BusinessException.class,
                () -> validator.validate(plan(CreationEntrySource.CANVAS, List.of(task)),
                        CreationEntrySource.CANVAS, null));
    }

    /**
     * 画布工具缺少Schema必填参数时必须转为补参问题。
     */
    @Test
    void shouldAskForMissingCanvasToolArguments() {
        CreationTask task = new CreationTask("image-task", "image", "generate", "生成一只小猫", List.of(),
                "canvas_generate_image", Map.of("prompt", "生成一只小猫"));

        CreationPlan result = validator.validate(plan(CreationEntrySource.CANVAS, List.of(task)),
                CreationEntrySource.CANVAS, new CreationSettings("image-model", null, null, null, null, null, null));

        Assertions.assertTrue(result.tasks().isEmpty());
        Assertions.assertTrue(result.clarificationQuestion().contains("size"));
    }

    /**
     * 画布自动运行图片生成流程时必须确定性要求图片尺寸。
     */
    @Test
    void shouldAskForImageSizeBeforeAutoRunningCanvasFlow() {
        CreationTask task = new CreationTask("image-task", "image", "generate", "生成一只小猫", List.of(),
                "canvas_create_generation_flow", Map.of("mode", "image", "prompt", "生成一只小猫", "autoRun", true));

        CreationPlan result = validator.validate(plan(CreationEntrySource.CANVAS, List.of(task)),
                CreationEntrySource.CANVAS, new CreationSettings("image-model", null, null, null, null, null, null));

        Assertions.assertTrue(result.tasks().isEmpty());
        Assertions.assertTrue(result.clarificationQuestion().contains("size"));
    }

    /**
     * 循环依赖必须在任何子任务执行前被拒绝。
     */
    @Test
    void shouldRejectCyclicDependencies() {
        CreationPlan plan = plan(CreationEntrySource.CANVAS, List.of(
                new CreationTask("task-a", "canvas", "tool", "创建节点A", List.of("task-b"),
                        "canvas_create_text_node", Map.of("text", "A")),
                new CreationTask("task-b", "canvas", "tool", "创建节点B", List.of("task-a"),
                        "canvas_create_text_node", Map.of("text", "B"))));

        Assertions.assertThrows(BusinessException.class,
                () -> validator.validate(plan, CreationEntrySource.CANVAS, null));
    }

    /**
     * 缺少页面必填参数时返回询问并清空任务。
     */
    @Test
    void shouldAskForMissingSettingsWithoutCreatingTasks() {
        CreationPlan plan = plan(CreationEntrySource.IMAGE_PAGE,
                List.of(task("image-task", "image", List.of())));

        CreationPlan result = validator.validate(plan, CreationEntrySource.IMAGE_PAGE,
                new CreationSettings("model", "", "", "", null, null, null));

        Assertions.assertTrue(result.tasks().isEmpty());
        Assertions.assertFalse(result.clarificationQuestion().isBlank());
    }

    /**
     * 普通视频请求误填生成模式到工作流字段时，应按普通视频计划校验，不得要求注册技能工作流。
     */
    @Test
    void shouldTreatVideoGenerationModeAsOrdinaryVideoPlan() {
        CreationPlan plan = new CreationPlan("model-plan", "生成视频", CreationEntrySource.VIDEO_PAGE,
                "执行生成", "", false, null,
                List.of(task("video-task", "video", List.of())), List.of(), "text-to-video");

        CreationPlan result = validator.validate(plan, CreationEntrySource.VIDEO_PAGE, videoSettings());

        Assertions.assertNull(result.workflowType());
        Assertions.assertEquals(1, result.tasks().size());
    }

    @Test
    void shouldNormalizeVideoToolAliasWhenActionIsMissing() {
        CreationTask task = new CreationTask("video-task", "video", null, "霓虹街道上的橘猫",
                null, List.of(), "generateVideo", Map.of("prompt", "忽略工具参数，使用页面硬约束"));

        CreationPlan result = validator.validate(
                plan(CreationEntrySource.VIDEO_PAGE, List.of(task)),
                CreationEntrySource.VIDEO_PAGE, videoSettings());

        Assertions.assertEquals("generate", result.tasks().getFirst().action());
        Assertions.assertNull(result.tasks().getFirst().toolName());
        Assertions.assertTrue(result.tasks().getFirst().toolArguments().isEmpty());
    }

    /**
     * 普通视频技能误填未注册工作流元数据时，应继续执行普通视频计划。
     */
    @Test
    void shouldTreatUnregisteredVideoWorkflowMetadataAsOrdinaryVideoPlan() {
        CreationPlan plan = new CreationPlan("model-plan", "生成视频", CreationEntrySource.VIDEO_PAGE,
                "执行生成", "", false, null,
                List.of(task("video-task", "video", List.of())), List.of(), "video");

        CreationPlan result = validator.validate(plan, CreationEntrySource.VIDEO_PAGE, videoSettings());

        Assertions.assertNull(result.workflowType());
        Assertions.assertEquals(1, result.tasks().size());
    }

    /**
     * 服务端已注册的专用视频工作流标记必须保留并进入对应工作流校验。
     */
    @Test
    void shouldPreserveRegisteredVideoWorkflowMetadata() {
        CreationPlanValidator workflowValidator = new CreationPlanValidator(new AgentToolRegistry());
        workflowValidator.setVideoWorkflowRegistry(
                new VideoWorkflowRegistry(List.of(new FirstLastFrameVideoWorkflow())));
        CreationPlan plan = new CreationPlan("workflow-plan", "首尾帧视频", CreationEntrySource.VIDEO_PAGE,
                "等待确认", "请确认首尾帧方案", false, null, List.of(), List.of(), "first-last-frame");

        CreationPlan result = workflowValidator.validate(plan, CreationEntrySource.VIDEO_PAGE, videoSettings());

        Assertions.assertEquals("first-last-frame", result.workflowType());
        Assertions.assertEquals("请确认首尾帧方案", result.clarificationQuestion());
    }

    /**
     * 主Agent通过用户原文引用提交任务时，服务端回填前允许提示词为空。
     */
    @Test
    void shouldAllowSourcePromptIdBeforeServerResolvesPrompt() {
        CreationTask task = new CreationTask("image-task", "image", "generate", "", "current", List.of(), null, Map.of());

        CreationPlan result = validator.validate(plan(CreationEntrySource.IMAGE_PAGE, List.of(task)),
                CreationEntrySource.IMAGE_PAGE, imageSettings());

        Assertions.assertEquals("current", result.tasks().getFirst().sourcePromptId());
    }

    /**
     * 图片页多任务必须转换为画布引导，不能进入执行器。
     */
    @Test
    void shouldGuideImageBatchToCanvas() {
        CreationPlan plan = plan(CreationEntrySource.IMAGE_PAGE, List.of(
                task("image-task-a", "image", List.of()),
                task("image-task-b", "image", List.of())));

        CreationPlan result = validator.validate(plan, CreationEntrySource.IMAGE_PAGE, imageSettings());

        Assertions.assertTrue(result.tasks().isEmpty());
        Assertions.assertTrue(result.canvasGuidance());
        Assertions.assertEquals("图片生成页面每次只能生成 1 张图片。需要批量生成多个画面时，请前往画布操作。", result.clarificationQuestion());
    }

    @Test
    void shouldReturnCanvasAnalysisWhenModelMistakenlyRequestsCanvasGuidance() {
        CreationPlan candidate = new CreationPlan("analysis", "分析画布", CreationEntrySource.CANVAS,
                "画布含剧本与分镜节点", "剧本节点连接分镜节点；建议先补齐失败的分镜图片。", true,
                null, List.of(task("unexpected-generation", "image", List.of())), List.of());

        CreationPlan result = validator.validate(candidate, CreationEntrySource.CANVAS, null);

        Assertions.assertFalse(result.canvasGuidance());
        Assertions.assertTrue(result.tasks().isEmpty());
        Assertions.assertEquals("剧本节点连接分镜节点；建议先补齐失败的分镜图片。", result.clarificationQuestion());
    }

    @Test
    void shouldUseCanvasSummaryAsReadOnlyReplyWhenQuestionIsEmpty() {
        CreationPlan candidate = new CreationPlan("analysis", "分析画布", CreationEntrySource.CANVAS,
                "先检查分镜与剧本的连接。", "", false, null, List.of(), List.of());

        CreationPlan result = validator.validate(candidate, CreationEntrySource.CANVAS, null);

        Assertions.assertTrue(result.tasks().isEmpty());
        Assertions.assertEquals("先检查分镜与剧本的连接。", result.clarificationQuestion());
    }

    @Test
    void shouldNotRepeatCanvasNavigationInsideCanvas() {
        CreationPlan candidate = new CreationPlan("analysis", "分析画布", CreationEntrySource.CANVAS,
                "", "请前往画布", true, null, List.of(), List.of());

        CreationPlan result = validator.validate(candidate, CreationEntrySource.CANVAS, null);

        Assertions.assertFalse(result.canvasGuidance());
        Assertions.assertTrue(result.tasks().isEmpty());
        Assertions.assertFalse(result.clarificationQuestion().contains("前往画布"));
    }

    /**
     * 视频页多任务必须转换为画布引导，不能进入执行器。
     */
    @Test
    void shouldGuideVideoBatchToCanvas() {
        CreationPlan plan = plan(CreationEntrySource.VIDEO_PAGE, List.of(
                task("video-task-a", "video", List.of()),
                task("video-task-b", "video", List.of())));

        CreationPlan result = validator.validate(plan, CreationEntrySource.VIDEO_PAGE, videoSettings());

        Assertions.assertTrue(result.tasks().isEmpty());
        Assertions.assertTrue(result.canvasGuidance());
        Assertions.assertEquals("视频生成页面每次只能生成 1 个视频。需要批量生成多个视频时，请前往画布操作。", result.clarificationQuestion());
    }

    /**
     * 图片数量大于一时必须转换为画布引导。
     */
    @Test
    void shouldGuideImageCountToCanvas() {
        CreationPlan plan = plan(CreationEntrySource.IMAGE_PAGE,
                List.of(task("image-task", "image", List.of())));
        CreationSettings settings = new CreationSettings("image-model", "1:1", "2K", "high", 2, null, null);

        CreationPlan result = validator.validate(plan, CreationEntrySource.IMAGE_PAGE, settings);

        Assertions.assertTrue(result.tasks().isEmpty());
        Assertions.assertTrue(result.canvasGuidance());
        Assertions.assertTrue(result.clarificationQuestion().contains("1 张图片"));
    }

    /**
     * 图片数量超过一且模型没有返回任务时仍必须直接引导到画布。
     */
    @Test
    void shouldGuideImageCountToCanvasBeforeTaskValidation() {
        CreationPlan plan = plan(CreationEntrySource.IMAGE_PAGE, List.of());
        CreationSettings settings = new CreationSettings("image-model", "1:1", "2K", "high", 2, null, null);

        CreationPlan result = validator.validate(plan, CreationEntrySource.IMAGE_PAGE, settings);

        Assertions.assertTrue(result.tasks().isEmpty());
        Assertions.assertTrue(result.canvasGuidance());
    }

    /**
     * 构造测试计划。
     *
     * @param entrySource String 入口来源
     * @param tasks List<CreationTask> 任务
     * @return CreationPlan 计划
     */
    private CreationPlan plan(String entrySource, List<CreationTask> tasks) {
        return new CreationPlan("model-plan", "生成内容", entrySource, "执行生成", "", false, null, tasks, List.of());
    }

    /**
     * 构造测试任务。
     *
     * @param taskId String 任务ID
     * @param taskType String 任务类型
     * @param dependencies List<String> 依赖
     * @return CreationTask 任务
     */
    private CreationTask task(String taskId, String taskType, List<String> dependencies) {
        return new CreationTask(taskId, taskType, "generate", "一只小猫", dependencies, null, Map.of());
    }

    /**
     * 构造画布图片或视频生成任务。
     *
     * @param taskId String 任务ID
     * @param taskType String image或video
     * @param toolName String 画布生成工具名
     * @param arguments Map<String, Object> 工具参数
     * @return CreationTask 画布生成任务
     */
    private CreationTask canvasGenerationTask(String taskId, String taskType, String toolName,
                                               Map<String, Object> arguments) {
        return new CreationTask(taskId, taskType, "generate", String.valueOf(arguments.get("prompt")),
                List.of(), toolName, arguments);
    }

    /**
     * 构造完整图片设置。
     *
     * @return CreationSettings 图片设置
     */
    private CreationSettings imageSettings() {
        return new CreationSettings("image-model", "1:1", "2K", "high", 1, null, null);
    }

    /**
     * 构造完整视频设置。
     *
     * @return CreationSettings 视频设置
     */
    private CreationSettings videoSettings() {
        return new CreationSettings("video-model", "16:9", "720p", "medium", null, "5", false);
    }
}
