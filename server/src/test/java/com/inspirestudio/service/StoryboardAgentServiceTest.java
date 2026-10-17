package com.inspirestudio.service;

import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.fastjson2.JSON;
import com.inspirestudio.agent.AgentScopeAgentFactory;
import com.inspirestudio.agent.AgentScopeModelFactory;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.dto.StoryboardDtos;
import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.security.CurrentUserProvider;
import io.agentscope.core.ReActAgent;
import io.agentscope.core.message.TextBlock;
import io.agentscope.core.model.ChatResponse;
import io.agentscope.core.model.Model;
import java.time.Duration;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.List;
import java.util.Map;
import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.function.Function;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Flux;
import reactor.test.StepVerifier;

/**
 * 分镜脚本Agent结构化结果与计费失败处理测试。
 *
 * @date     2026-08-08 00:00
 */
class StoryboardAgentServiceTest {

    /** 测试使用的整体视觉风格。 */
    private static final String VISUAL_STYLE = "国风手绘厚涂，电影级质感";

    /** 积分服务。 */
    private CreditService creditService;

    /** 待测试分镜服务。 */
    private StoryboardAgentService storyboardAgentService;

    /**
     * 初始化测试依赖。
     */
    @BeforeEach
    void setUp() {
        creditService = mock(CreditService.class);
        storyboardAgentService = new StoryboardAgentService(
                mock(CurrentUserProvider.class), mock(AgentScopeModelFactory.class), mock(AgentScopeAgentFactory.class),
                new InspireProperties(), creditService, mock(SystemPromptTemplateService.class), mock(AiTaskService.class));
    }

    @Test
    void shouldCompleteMissingPropsAndScenesAndDeduplicateAssets() {
        var original = new StoryboardDtos.GeneratedStoryboardResult(List.of(
                new StoryboardDtos.GeneratedStoryboardShot(1, 5, "驾驶室中人物拿着手机", "中景", "冷光", "对白", "音效", "推进", List.of("person"))),
                List.of(new StoryboardDtos.GeneratedStoryboardAsset("character", "person", "主角", "司机")));
        var coverage = new StoryboardDtos.AssetCoverageResult(List.of(
                new StoryboardDtos.CoverageAsset(StoryboardDtos.GeneratedAssetKind.character, "person-copy", "主角", "司机"),
                new StoryboardDtos.CoverageAsset(StoryboardDtos.GeneratedAssetKind.prop, "phone", "手机", "老式手机"),
                new StoryboardDtos.CoverageAsset(StoryboardDtos.GeneratedAssetKind.scene, "cabin", "驾驶室", "狭窄驾驶室")),
                List.of(new StoryboardDtos.CoverageShot(0, List.of("person-copy", "person", "phone", "cabin"))));
        var result = (StoryboardDtos.GeneratedStoryboardResult) invoke("applyAssetCoverage",
                new Class<?>[]{StoryboardDtos.GeneratedStoryboardResult.class, StoryboardDtos.AssetCoverageResult.class}, original, coverage);
        Assertions.assertEquals(3, result.assets().size());
        Assertions.assertEquals(List.of("person", "phone", "cabin"), result.shots().getFirst().assetReferenceKeys());
        Assertions.assertEquals(original.shots().getFirst().visualDescription(), result.shots().getFirst().visualDescription());
        Assertions.assertEquals(original.shots().getFirst().dialogueVoiceover(), result.shots().getFirst().dialogueVoiceover());
        Assertions.assertEquals(1, original.assets().size());
        Assertions.assertNotNull(invokeGeneratedStoryboardValidation(result));
        for (var invalid : List.of(
                new StoryboardDtos.AssetCoverageResult(List.of(), List.of()),
                new StoryboardDtos.AssetCoverageResult(List.of(), List.of(new StoryboardDtos.CoverageShot(99, List.of("person")))),
                new StoryboardDtos.AssetCoverageResult(List.of(), List.of(new StoryboardDtos.CoverageShot(0, List.of("missing")))),
                new StoryboardDtos.AssetCoverageResult(coverage.additions(), List.of(new StoryboardDtos.CoverageShot(0, List.of("person")))))) {
            Assertions.assertThrows(BusinessException.class, () -> invoke("applyAssetCoverage",
                    new Class<?>[]{StoryboardDtos.GeneratedStoryboardResult.class, StoryboardDtos.AssetCoverageResult.class}, original, invalid));
        }
    }

    @Test
    void shouldRenderFixedPromptFromConfirmedShotFieldsAndMultilineStyle() {
        String style = "写实电影\n\n保留风格段落，3D细节";
        var first = new StoryboardDtos.StoryboardShot("one", 1, 8, "车内人物", "中景", "暖光\n\n侧逆光",
                "他说：快走。", "发动机声", "推进\n\n缓慢", "", List.of("room", "key"));
        var request = new StoryboardDtos.ComposePromptsRequest("剧本", "分镜", style, "model", List.of(first, shot("two", 2)), List.of(
                new StoryboardDtos.StoryboardAsset("room", "scene", "车内", "昏暗\n\n狭窄"),
                new StoryboardDtos.StoryboardAsset("key", "prop", "钥匙", "金属钥匙"),
                new StoryboardDtos.StoryboardAsset("unused", "scene", "不相关场景", "不要加入")));
        var content = new StoryboardDtos.PromptContentResult(List.of(
                new StoryboardDtos.ComposedShotContent("two", "雨夜街道，角色缓慢前行。"),
                new StoryboardDtos.ComposedShotContent("one", "车内人物握紧钥匙。\n\n镜头突出人物紧张的表情。")));
        var rendered = (StoryboardDtos.PromptCompositionResult) invoke("renderComposedPrompts",
                new Class<?>[]{StoryboardDtos.ComposePromptsRequest.class, StoryboardDtos.PromptContentResult.class}, request, content);
        var validated = invokePromptValidation(request.shots(), style, rendered);
        Assertions.assertEquals(List.of("one", "two"), validated.stream().map(StoryboardDtos.StoryboardPrompt::shotId).toList());
        String prompt = validated.getFirst().finalPrompt();
        Assertions.assertTrue(prompt.startsWith("镜头规格：中景，8 秒。\n\n画面内容：车内人物握紧钥匙。 镜头突出人物紧张的表情。"));
        Assertions.assertTrue(prompt.contains("场景：车内（昏暗 狭窄）"));
        Assertions.assertTrue(prompt.contains("道具：钥匙（金属钥匙）"));
        Assertions.assertTrue(prompt.contains("光影氛围：暖光 侧逆光"));
        Assertions.assertTrue(prompt.contains("声音：对白或旁白：他说：快走。；音效：发动机声"));
        Assertions.assertTrue(prompt.endsWith("视觉风格：" + style));
        Assertions.assertFalse(prompt.contains("不相关场景"));
        Assertions.assertTrue(validated.get(1).finalPrompt().contains("场景：无\n\n道具：无"));
    }

    @Test
    void shouldRejectIncompleteDuplicateOrNonChineseComposedContent() {
        var request = new StoryboardDtos.ComposePromptsRequest("剧本", "分镜", VISUAL_STYLE, "model",
                List.of(shot("one", 1), shot("two", 2)), List.of());
        for (var result : List.of(
                new StoryboardDtos.PromptContentResult(List.of(new StoryboardDtos.ComposedShotContent("one", "雨夜"))),
                new StoryboardDtos.PromptContentResult(List.of(new StoryboardDtos.ComposedShotContent("one", "雨夜"), new StoryboardDtos.ComposedShotContent("one", "街道"))),
                new StoryboardDtos.PromptContentResult(List.of(new StoryboardDtos.ComposedShotContent("one", "雨夜"), new StoryboardDtos.ComposedShotContent("wrong", "街道"))),
                new StoryboardDtos.PromptContentResult(List.of(new StoryboardDtos.ComposedShotContent("one", "A person walks down the street."), new StoryboardDtos.ComposedShotContent("two", "街道"))),
                new StoryboardDtos.PromptContentResult(List.of(new StoryboardDtos.ComposedShotContent("one", " "), new StoryboardDtos.ComposedShotContent("two", "街道"))))) {
            Assertions.assertThrows(BusinessException.class, () -> invoke("renderComposedPrompts",
                    new Class<?>[]{StoryboardDtos.ComposePromptsRequest.class, StoryboardDtos.PromptContentResult.class}, request, result));
        }
    }

    /**
     * 合成结果应按输入镜头顺序回写，且保留稳定镜头标识。
     */
    @Test
    void shouldOrderChinesePromptMappingsByInputShotIdentifier() {
        List<StoryboardDtos.StoryboardShot> shots = List.of(shot("shot-1", 1), shot("shot-2", 2));
        StoryboardDtos.PromptCompositionResult result = new StoryboardDtos.PromptCompositionResult(List.of(
                new StoryboardDtos.StoryboardPrompt("shot-2", formattedPrompt("雨夜街道，角色快步穿过霓虹倒影")),
                new StoryboardDtos.StoryboardPrompt("shot-1", formattedPrompt("清晨公园，角色站在树下，柔和逆光"))));

        List<StoryboardDtos.StoryboardPrompt> prompts = invokePromptValidation(shots, result);

        Assertions.assertEquals(List.of("shot-1", "shot-2"), prompts.stream().map(StoryboardDtos.StoryboardPrompt::shotId).toList());
        Assertions.assertTrue(prompts.getFirst().finalPrompt().contains("清晨公园"));
    }

    /**
     * 最终提示词以英文为主时应被拒绝，避免中文工作流返回英文提示词。
     */
    @Test
    void shouldRejectPredominantlyLatinPrompt() {
        List<StoryboardDtos.StoryboardShot> shots = List.of(shot("shot-1", 1));
        StoryboardDtos.PromptCompositionResult result = new StoryboardDtos.PromptCompositionResult(List.of(
                new StoryboardDtos.StoryboardPrompt("shot-1", """
                        镜头规格：远景，5 秒。

                        画面内容：A warrior walks through a rain-soaked street under cinematic lighting.

                        场景：A dark street with neon signs and reflective puddles.

                        道具：A sword and a lantern.

                        光影氛围：Cold blue lighting with deep shadows.

                        运镜：Slow push-in toward the character.

                        声音：Rainfall and distant thunder.

                        视觉风格：%s
                        """.formatted(VISUAL_STYLE).trim())));

        BusinessException exception = Assertions.assertThrows(BusinessException.class, () -> invokePromptValidation(shots, result));

        Assertions.assertEquals("分镜Agent返回的最终提示词必须以中文为主", exception.getMessage());
    }

    /**
     * 用户指定视觉风格中的技术标识应原样保留，不能被中文校验误判。
     */
    @Test
    void shouldAllowTechnicalLatinCharactersInVisualStyle() {
        String visualStyle = "国风动漫3D";
        List<StoryboardDtos.StoryboardShot> shots = List.of(shot("shot-1", 1));
        StoryboardDtos.PromptCompositionResult result = new StoryboardDtos.PromptCompositionResult(List.of(
                new StoryboardDtos.StoryboardPrompt("shot-1", formattedPrompt("雨夜街道中的角色缓慢前行", visualStyle))));

        List<StoryboardDtos.StoryboardPrompt> prompts = invokePromptValidation(shots, visualStyle, result);

        Assertions.assertEquals("视觉风格：国风动漫3D", prompts.getFirst().finalPrompt().lines().reduce((first, second) -> second).orElseThrow());
    }

    /**
     * 多行视觉风格中的空行不应破坏固定提示词段落校验。
     */
    @Test
    void shouldAllowMultilineVisualStyleWithBlankLines() {
        String visualStyle = "暖琥珀色电影风格。\n\n主色调：低饱和暖棕色。\n\n光线：柔和自然光。";
        List<StoryboardDtos.StoryboardShot> shots = List.of(shot("shot-1", 1));
        StoryboardDtos.PromptCompositionResult result = new StoryboardDtos.PromptCompositionResult(List.of(
                new StoryboardDtos.StoryboardPrompt("shot-1", formattedPrompt("旧书店中的来客", visualStyle))));

        List<StoryboardDtos.StoryboardPrompt> prompts = invokePromptValidation(shots, visualStyle, result);

        Assertions.assertTrue(prompts.getFirst().finalPrompt().endsWith("视觉风格：" + visualStyle));
    }

    /**
     * 最终提示词必须以固定八段格式回传，且保留用户输入的视觉风格。
     */
    @Test
    void shouldRejectPromptWithoutRequiredVisualStyleSection() {
        List<StoryboardDtos.StoryboardShot> shots = List.of(shot("shot-1", 1));
        StoryboardDtos.PromptCompositionResult result = new StoryboardDtos.PromptCompositionResult(List.of(
                new StoryboardDtos.StoryboardPrompt("shot-1", formattedPrompt("雨夜街道").replace(VISUAL_STYLE, "赛博霓虹风格"))));

        BusinessException exception = Assertions.assertThrows(BusinessException.class, () -> invokePromptValidation(shots, result));

        Assertions.assertEquals("分镜Agent返回的最终提示词未按固定格式生成", exception.getMessage());
    }

    /**
     * 合成结果缺失输入镜头或携带额外镜头标识时应拒绝回写。
     */
    @Test
    void shouldRejectMissingOrExtraPromptShotIdentifier() {
        List<StoryboardDtos.StoryboardShot> shots = List.of(shot("shot-1", 1), shot("shot-2", 2));
        StoryboardDtos.PromptCompositionResult result = new StoryboardDtos.PromptCompositionResult(List.of(
                new StoryboardDtos.StoryboardPrompt("shot-1", formattedPrompt("清晨公园，角色站在树下")),
                new StoryboardDtos.StoryboardPrompt("extra-shot", formattedPrompt("雨夜街道，角色奔跑"))));

        BusinessException exception = Assertions.assertThrows(BusinessException.class, () -> invokePromptValidation(shots, result));

        Assertions.assertEquals("分镜Agent返回了缺失、重复或额外的镜头标识", exception.getMessage());
    }

    /**
     * 分镜Agent返回非法景别或资产类别时应拒绝其结构化结果。
     */
    @Test
    void shouldRejectIllegalGeneratedShotSizeAndAssetKind() {
        StoryboardDtos.GeneratedStoryboardResult invalidShot = new StoryboardDtos.GeneratedStoryboardResult(List.of(
                new StoryboardDtos.GeneratedStoryboardShot(1, 5, "雨夜街道", "鸟瞰景", "霓虹光", "", "雨声", "推进", List.of())), List.of());
        StoryboardDtos.GeneratedStoryboardResult invalidAsset = new StoryboardDtos.GeneratedStoryboardResult(List.of(
                new StoryboardDtos.GeneratedStoryboardShot(1, 5, "雨夜街道", "远景", "霓虹光", "", "雨声", "推进", List.of())), List.of(
                new StoryboardDtos.GeneratedStoryboardAsset("vehicle", "car", "汽车", "黑色轿车")));

        BusinessException shotException = Assertions.assertThrows(BusinessException.class, () -> invokeGeneratedStoryboardValidation(invalidShot));
        BusinessException assetException = Assertions.assertThrows(BusinessException.class, () -> invokeGeneratedStoryboardValidation(invalidAsset));

        Assertions.assertTrue(shotException.getMessage().contains("第1镜头景别无法识别（鸟瞰景）"));
        Assertions.assertEquals("分镜Agent返回了不支持的资产类别", assetException.getMessage());
    }

    /**
     * Agent返回的资产类别应去除首尾空白后再写入画布数据。
     */
    @Test
    void shouldTrimGeneratedStoryboardAssetKind() {
        StoryboardDtos.GeneratedStoryboardResult result = new StoryboardDtos.GeneratedStoryboardResult(List.of(
                new StoryboardDtos.GeneratedStoryboardShot(1, 5, "雨夜街道", "远景", "霓虹光", "", "雨声", "推进", List.of("detective"))), List.of(
                new StoryboardDtos.GeneratedStoryboardAsset(" character ", "detective", "侦探", "黑色风衣")));

        Object normalized = invokeGeneratedStoryboardValidation(result);

        Assertions.assertEquals("character", JSON.parseObject(JSON.toJSONString(normalized))
                .getJSONArray("assets").getJSONObject(0).getString("kind"));
    }

    /**
     * Agent偶尔返回中文、复数或同义类别时应兼容并写入标准类别。
     */
    @Test
    void shouldNormalizeGeneratedStoryboardAssetKindAliases() {
        StoryboardDtos.GeneratedStoryboardResult result = new StoryboardDtos.GeneratedStoryboardResult(List.of(
                new StoryboardDtos.GeneratedStoryboardShot(1, 5, "雨夜街道", "远景", "霓虹光", "", "雨声", "推进", List.of("detective", "street", "flashlight"))), List.of(
                new StoryboardDtos.GeneratedStoryboardAsset("人物", "detective", "侦探", "黑色风衣"),
                new StoryboardDtos.GeneratedStoryboardAsset("Locations", "street", "雨夜街道", "潮湿路面"),
                new StoryboardDtos.GeneratedStoryboardAsset("items", "flashlight", "手电筒", "金属外壳")));

        var normalized = JSON.parseObject(JSON.toJSONString(invokeGeneratedStoryboardValidation(result)));

        Assertions.assertEquals(List.of("character", "scene", "prop"), normalized.getJSONArray("assets").stream()
                .map(item -> ((com.alibaba.fastjson2.JSONObject) item).getString("kind"))
                .toList());
    }

    /**
     * Agent偶尔返回中英文常见景别别名时应兼容并写入标准景别。
     */
    @Test
    void shouldNormalizeGeneratedStoryboardShotSizeAliases() {
        StoryboardDtos.GeneratedStoryboardResult result = new StoryboardDtos.GeneratedStoryboardResult(List.of(
                new StoryboardDtos.GeneratedStoryboardShot(1, 5, "人物肩部以上近景", "中近景", "柔光", "", "", "", List.of()),
                new StoryboardDtos.GeneratedStoryboardShot(2, 5, "人物全身", "Full Shot", "日光", "", "", "", List.of()),
                new StoryboardDtos.GeneratedStoryboardShot(3, 5, "城市建立镜头", "establishing-shot", "晨光", "", "", "", List.of())), List.of());

        var normalized = JSON.parseObject(JSON.toJSONString(invokeGeneratedStoryboardValidation(result)));

        Assertions.assertEquals(List.of("头肩景", "全景", "大全景"), normalized.getJSONArray("shots").stream()
                .map(item -> ((com.alibaba.fastjson2.JSONObject) item).getString("shotSize"))
                .toList());
    }

    @Test
    void shouldOnlyApplyRequestedClassificationCorrectionsAndPreserveContent() {
        var result = new StoryboardDtos.GeneratedStoryboardResult(List.of(
                new StoryboardDtos.GeneratedStoryboardShot(7, 5, "车辆驶过街道", "俯拍", "日光", "对白", "引擎", "推进", List.of("car"))),
                List.of(new StoryboardDtos.GeneratedStoryboardAsset("vehicle", "car", "汽车", "蓝色卡车")));
        var corrections = new StoryboardDtos.StoryboardFieldCorrections(
                List.of(new StoryboardDtos.AssetKindCorrection(0, StoryboardDtos.GeneratedAssetKind.prop)),
                List.of(new StoryboardDtos.ShotSizeCorrection(0, StoryboardDtos.GeneratedShotSize.远景, List.of("car"))));
        var corrected = (StoryboardDtos.GeneratedStoryboardResult) invoke("applyGeneratedFieldCorrections",
                new Class<?>[]{StoryboardDtos.GeneratedStoryboardResult.class, StoryboardDtos.StoryboardFieldCorrections.class, java.util.Set.class, java.util.Set.class},
                result, corrections, java.util.Set.of(0), java.util.Set.of(0));
        Assertions.assertEquals("prop", corrected.assets().getFirst().kind());
        Assertions.assertEquals("car", corrected.assets().getFirst().referenceKey());
        Assertions.assertEquals("蓝色卡车", corrected.assets().getFirst().description());
        Assertions.assertEquals("远景", corrected.shots().getFirst().shotSize());
        Assertions.assertEquals("景别说明：俯拍；推进", corrected.shots().getFirst().cameraMovement());
        Assertions.assertEquals(result.shots().getFirst().assetReferenceKeys(), corrected.shots().getFirst().assetReferenceKeys());
        Assertions.assertEquals("对白", corrected.shots().getFirst().dialogueVoiceover());
        Assertions.assertNotNull(invokeGeneratedStoryboardValidation(corrected));
        Assertions.assertEquals("俯拍", result.shots().getFirst().shotSize());
        Assertions.assertEquals("vehicle", result.assets().getFirst().kind());
        for (var invalid : List.of(
                new StoryboardDtos.StoryboardFieldCorrections(List.of(), corrections.shots()),
                new StoryboardDtos.StoryboardFieldCorrections(List.of(new StoryboardDtos.AssetKindCorrection(9, StoryboardDtos.GeneratedAssetKind.prop)), corrections.shots()),
                new StoryboardDtos.StoryboardFieldCorrections(corrections.assets(), List.of(new StoryboardDtos.ShotSizeCorrection(0, null, List.of("car")))))) {
            Assertions.assertThrows(BusinessException.class, () -> invoke("applyGeneratedFieldCorrections",
                    new Class<?>[]{StoryboardDtos.GeneratedStoryboardResult.class, StoryboardDtos.StoryboardFieldCorrections.class, java.util.Set.class, java.util.Set.class},
                    result, invalid, java.util.Set.of(0), java.util.Set.of(0)));
        }
    }

    @Test
    void shouldRepairMissingReferencesWithoutChangingValidSize() {
        var result = new StoryboardDtos.GeneratedStoryboardResult(List.of(
                new StoryboardDtos.GeneratedStoryboardShot(1, 5, "汽车", "远景转中景", "", "", "", "推进", null)),
                List.of(new StoryboardDtos.GeneratedStoryboardAsset("prop", "car", "汽车", "蓝色")));
        var corrections = new StoryboardDtos.StoryboardFieldCorrections(List.of(),
                List.of(new StoryboardDtos.ShotSizeCorrection(0, StoryboardDtos.GeneratedShotSize.特写, List.of("car"))));
        var corrected = (StoryboardDtos.GeneratedStoryboardResult) invoke("applyGeneratedFieldCorrections",
                new Class<?>[]{StoryboardDtos.GeneratedStoryboardResult.class, StoryboardDtos.StoryboardFieldCorrections.class, java.util.Set.class, java.util.Set.class},
                result, corrections, java.util.Set.of(), java.util.Set.of(0));
        var shot = JSON.parseObject(JSON.toJSONString(invokeGeneratedStoryboardValidation(corrected)))
                .getJSONArray("shots").getJSONObject(0);
        Assertions.assertEquals("远景", shot.getString("shotSize"));
        Assertions.assertEquals("景别说明：远景转中景；推进", shot.getString("cameraMovement"));
        Assertions.assertEquals(1, shot.getJSONArray("assetIds").size());
        Assertions.assertNull(result.shots().getFirst().assetReferenceKeys());
    }

    @Test
    void shouldPreserveLiveModelShotSizeTransitionInCameraMovement() {
        for (String value : List.of("远景转中景", "从远景到中景", "远景→中景", "远景 -> 中景")) {
            StoryboardDtos.GeneratedStoryboardResult result = new StoryboardDtos.GeneratedStoryboardResult(List.of(
                    new StoryboardDtos.GeneratedStoryboardShot(7, 5, "角色走近", value, "日光", "", "", "缓慢推进", List.of())), List.of());
            var shot = JSON.parseObject(JSON.toJSONString(invokeGeneratedStoryboardValidation(result)))
                    .getJSONArray("shots").getJSONObject(0);
            Assertions.assertEquals("远景", shot.getString("shotSize"));
            Assertions.assertEquals("景别说明：" + value + "；缓慢推进", shot.getString("cameraMovement"));
        }
        Assertions.assertNull(invoke("normalizeGeneratedShotSize", new Class<?>[]{String.class}, "远景转未知"));
        Assertions.assertNull(invoke("normalizeGeneratedShotSize", new Class<?>[]{String.class}, "远景转"));
    }

    @Test
    void shouldNormalizeAnnotatedSizesWithoutConfusingAnglesOrConflictingSizes() {
        for (String value : List.of("特写（CU）", "特写 / Close-up", "特写（俯拍）")) {
            Assertions.assertEquals("特写", invoke("normalizeGeneratedShotSize", new Class<?>[]{String.class}, value));
        }
        for (String value : List.of("特写/远景", "俯拍", "俯拍（特写参考）", "未知")) {
            Assertions.assertNull(invoke("normalizeGeneratedShotSize", new Class<?>[]{String.class}, value));
        }
    }

    /**
     * 当前资产标识重复时应在调用Agent前拒绝请求。
     */
    @Test
    void shouldRejectDuplicateStoryboardAssetIdentifiers() {
        StoryboardDtos.ComposePromptsRequest request = new StoryboardDtos.ComposePromptsRequest(
                "剧本文本", "生成追逐片段", VISUAL_STYLE, "channel::story-model", List.of(shot("shot-1", 1)), List.of(
                new StoryboardDtos.StoryboardAsset("asset-1", "character", "主角", "年轻侦探"),
                new StoryboardDtos.StoryboardAsset("asset-1", "prop", "手电筒", "金属手电筒")));

        BusinessException exception = Assertions.assertThrows(BusinessException.class, () -> invoke("validateComposeRequest", new Class<?>[]{StoryboardDtos.ComposePromptsRequest.class}, request));

        Assertions.assertEquals("资产标识不能重复", exception.getMessage());
    }

    /**
     * Agent初始分镜的资产引用键应映射为画布资产标识。
     */
    @Test
    void shouldMapGeneratedAssetReferenceKeysToCanvasAssetIdentifiers() {
        StoryboardDtos.GeneratedStoryboardResult result = new StoryboardDtos.GeneratedStoryboardResult(List.of(
                new StoryboardDtos.GeneratedStoryboardShot(1, 5, "雨夜街道", "远景", "霓虹光", "", "雨声", "推进", List.of("detective", "street"))), List.of(
                new StoryboardDtos.GeneratedStoryboardAsset("character", "detective", "侦探", "黑色风衣"),
                new StoryboardDtos.GeneratedStoryboardAsset("scene", "street", "雨夜街道", "潮湿的霓虹街道")));

        var normalized = JSON.parseObject(JSON.toJSONString(invokeGeneratedStoryboardValidation(result)));
        List<String> assetIds = normalized.getJSONArray("assets").stream()
                .map(item -> ((com.alibaba.fastjson2.JSONObject) item).getString("id"))
                .toList();
        List<String> shotAssetIds = normalized.getJSONArray("shots").getJSONObject(0).getList("assetIds", String.class);

        Assertions.assertEquals(assetIds, shotAssetIds);
    }

    /**
     * Agent引用未声明的资产时应拒绝整次生成结果。
     */
    @Test
    void shouldRejectUnknownGeneratedAssetReferenceKey() {
        StoryboardDtos.GeneratedStoryboardResult result = new StoryboardDtos.GeneratedStoryboardResult(List.of(
                new StoryboardDtos.GeneratedStoryboardShot(1, 5, "雨夜街道", "远景", "霓虹光", "", "雨声", "推进", List.of("unknown"))), List.of());

        BusinessException exception = Assertions.assertThrows(BusinessException.class, () -> invokeGeneratedStoryboardValidation(result));

        Assertions.assertEquals("分镜Agent返回了不存在的镜头资产引用", exception.getMessage());
    }

    /**
     * Agent返回重复资产引用键时应拒绝整次生成结果。
     */
    @Test
    void shouldRejectDuplicateGeneratedAssetReferenceKeys() {
        StoryboardDtos.GeneratedStoryboardResult result = new StoryboardDtos.GeneratedStoryboardResult(List.of(
                new StoryboardDtos.GeneratedStoryboardShot(1, 5, "雨夜街道", "远景", "霓虹光", "", "雨声", "推进", List.of("detective"))), List.of(
                new StoryboardDtos.GeneratedStoryboardAsset("character", "detective", "侦探", "黑色风衣"),
                new StoryboardDtos.GeneratedStoryboardAsset("character", "detective", "搭档", "深色夹克")));

        BusinessException exception = Assertions.assertThrows(BusinessException.class, () -> invokeGeneratedStoryboardValidation(result));

        Assertions.assertEquals("分镜Agent返回了重复的资产引用键", exception.getMessage());
    }

    /**
     * 合成Agent只应接收当前镜头关联的资产。
     */
    @Test
    void shouldPassOnlyAssociatedAssetsToComposeAgent() {
        StoryboardDtos.StoryboardShot shot = new StoryboardDtos.StoryboardShot(
                "shot-1", 1, 5, "雨夜街道中的角色", "远景", "霓虹反光", "", "雨声", "推进", "", List.of("asset-1"));
        StoryboardDtos.ComposePromptsRequest request = new StoryboardDtos.ComposePromptsRequest(
                "剧本文本", "生成追逐片段", VISUAL_STYLE, "channel::story-model", List.of(shot), List.of(
                new StoryboardDtos.StoryboardAsset("asset-1", "character", "主角", "年轻侦探"),
                new StoryboardDtos.StoryboardAsset("asset-2", "prop", "手电筒", "金属手电筒")));

        var shots = JSON.parseArray(JSON.toJSONString(invoke("buildComposeAgentShots", new Class<?>[]{StoryboardDtos.ComposePromptsRequest.class}, request)));
        var associatedAssets = shots.getJSONObject(0).getJSONArray("associatedAssets");

        Assertions.assertEquals(1, associatedAssets.size());
        Assertions.assertEquals("asset-1", associatedAssets.getJSONObject(0).getString("id"));
    }

    @Test
    void shouldRepairMissingChapterEndingOnceThenReviewTheCompleteReplacement() {
        var initial = plannedResult(plannedShot(1, "establish", "屋内", "现在", ""));
        var complete = plannedResult(plannedShot(1, "establish", "屋内", "现在", ""),
                plannedShot(2, "continue", "屋内", "现在", "我们终于可以一起回家了。"));
        var service = scriptedGeneration(List.of(initial, review(1, false, "原文末段家人团聚没有任何镜头，须在还钥匙之后拍出结果"),
                complete, review(2, true)));
        var response = service.generateStoryboard(new StoryboardDtos.GenerateStoryboardRequest(
                "主角走进屋内，归还钥匙，最后与家人团聚。", "拍完整章", VISUAL_STYLE, "channel::text")).block();
        Assertions.assertNotNull(response);
        Assertions.assertEquals(2, response.shots().size());
        Assertions.assertEquals("continue", response.shots().getLast().continuity().transition());
        Assertions.assertEquals(List.of("generateStoryboard", "reviewStoryboardProduction", "repairStoryboardContinuity", "reviewStoryboardProduction"),
                service.calls.stream().map(item -> item.get("action")).toList());
        Assertions.assertTrue(service.calls.get(2).get("validationIssues").toString().contains("家人团聚"));
        Assertions.assertEquals("主角走进屋内，归还钥匙，最后与家人团聚。", service.calls.get(3).get("scriptContent"));
        verify(creditService).chargeOperation(eq(1L), anyString(), eq(1), eq("分镜首次生成"));
    }

    @Test
    void shouldRejectStillIncompleteRepairWithoutRetryingForever() {
        var initial = plannedResult(plannedShot(1, "establish", "屋内", "现在", ""));
        var service = scriptedGeneration(List.of(initial, review(1, false, "缺少小说结尾的团聚结果"),
                initial, review(1, false, "仍缺少团聚结果")));
        StepVerifier.create(service.generateStoryboard(new StoryboardDtos.GenerateStoryboardRequest(
                        "归还钥匙后终于团聚", "拍完整章", VISUAL_STYLE, "channel::text")))
                .expectErrorMatches(error -> error instanceof BusinessException && error.getMessage().contains("仍缺少团聚结果"))
                .verify();
        Assertions.assertEquals(4, service.calls.size());
        verify(creditService).refundOperation(eq(1L), anyString(), eq("分镜首次生成"));
    }

    @Test
    void shouldRepairMissingContinuityEvenWhenTheSemanticReviewPassed() {
        var old = new StoryboardDtos.GeneratedStoryboardShot(1, 5, "人物推门走进屋内", "中景", "暖光", "", "开门声", "推进", List.of());
        var service = scriptedGeneration(List.of(plannedResult(old), review(1, true),
                plannedResult(plannedShot(1, "establish", "屋内", "现在", "")), review(1, true)));
        var response = service.generateStoryboard(new StoryboardDtos.GenerateStoryboardRequest("主角进屋。", "完整章节", VISUAL_STYLE, "channel::text")).block();
        Assertions.assertNotNull(response.shots().getFirst().continuity());
        Assertions.assertEquals(1, service.calls.stream().filter(item -> "repairStoryboardContinuity".equals(item.get("action"))).count());
    }

    @Test
    void shouldCheckSceneTimeTransitionsDialogueRepetitionAndSpeakingTime() {
        String speech = "我终于找到失散多年的家人今天就带大家回家永远不再分开。";
        var result = plannedResult(plannedShot(1, "continue", "院子", "现在", speech),
                plannedShot(2, "continue", "屋内", "昨天", speech));
        var issues = continuityIssues(result);
        Assertions.assertTrue(issues.stream().anyMatch(value -> value.contains("没有本章前镜")));
        Assertions.assertTrue(issues.stream().anyMatch(value -> value.contains("场景或时间改变")));
        Assertions.assertTrue(issues.stream().anyMatch(value -> value.contains("重复完整长台词")));
        Assertions.assertTrue(issues.stream().anyMatch(value -> value.contains("无法自然说完")));
        Assertions.assertThrows(BusinessException.class, () -> invoke("requireGeneratedContinuity",
                new Class<?>[]{StoryboardDtos.GeneratedStoryboardResult.class}, result));
    }

    @Test
    void shouldPermitExplicitFlashbacksAndReturnsWithoutForcingSameScene() {
        var result = plannedResult(plannedShot(1, "establish", "车站", "现在", "车终于来了。"),
                plannedShot(2, "flashback", "故乡", "十年前", ""),
                plannedShot(3, "return", "车站", "现在", ""));
        Assertions.assertTrue(continuityIssues(result).isEmpty());
        var invalid = plannedResult(plannedShot(1, "dissolve", "车站", "现在", ""));
        Assertions.assertTrue(continuityIssues(invalid).stream().anyMatch(value -> value.contains("转场类型")));
    }

    @Test
    void shouldCountMixedLanguageSpeechAndIgnoreSpeakerLabelsAndStageDirections() {
        Assertions.assertEquals(7, invoke("spokenUnits", new Class<?>[]{String.class}, "Hello你好world。走"));
        var result = plannedResult(plannedShot(1, "establish", "屋内", "现在", "旁白（轻声）：欢迎回家。"),
                plannedShot(2, "continue", "屋内", "现在", "父亲：好。"));
        Assertions.assertTrue(continuityIssues(result).isEmpty());
    }

    @Test
    void shouldRespectTheSelectedVideoModelsMaximumShotDuration() {
        var state = new StoryboardDtos.ShotContinuity("院子", "现在", "establish", "站在门口", "走进院子", "建立人物目标");
        var longShot = new StoryboardDtos.GeneratedStoryboardShot(1, 15, "人物走进院子", "远景", "阳光", "", "", "跟拍", List.of(), state);
        Assertions.assertTrue(continuityIssues(plannedResult(longShot)).stream().anyMatch(value -> value.contains("1到10秒")));
        Assertions.assertTrue(((List<?>) invoke("generatedContinuityIssues", new Class<?>[]{StoryboardDtos.GeneratedStoryboardResult.class, int.class}, plannedResult(longShot), 15)).isEmpty());
        var request = new StoryboardDtos.GenerateStoryboardRequest("完整原文", "分镜", VISUAL_STYLE, "text", null, List.of(), 8);
        var input = JSON.parseObject(JSON.toJSONString(invoke("buildGenerateAgentInput", new Class<?>[]{StoryboardDtos.GenerateStoryboardRequest.class}, request)));
        Assertions.assertEquals(8, input.getIntValue("maxShotSeconds"));
        Assertions.assertThrows(BusinessException.class, () -> invoke("validateGenerateRequest",
                new Class<?>[]{StoryboardDtos.GenerateStoryboardRequest.class}, new StoryboardDtos.GenerateStoryboardRequest("原文", "分镜", VISUAL_STYLE, "text", null, List.of(), 31)));
    }

    @Test
    void shouldOnlyAcceptDurationsActuallySupportedByFixedAndDiscreteVideoModels() {
        var fixedIssues = (List<?>) invoke("generatedContinuityIssues",
                new Class<?>[]{StoryboardDtos.GeneratedStoryboardResult.class, int.class, List.class},
                plannedResult(plannedDuration(5)), 10, List.of(10));
        Assertions.assertTrue(fixedIssues.toString().contains("5秒不受视频模型支持"));
        var discreteIssues = (List<?>) invoke("generatedContinuityIssues",
                new Class<?>[]{StoryboardDtos.GeneratedStoryboardResult.class, int.class, List.class},
                plannedResult(plannedDuration(7)), 15, List.of(5, 10, 15));
        Assertions.assertTrue(discreteIssues.toString().contains("7秒不受视频模型支持"));
        for (int duration : List.of(5, 10, 15)) {
            Assertions.assertTrue(((List<?>) invoke("generatedContinuityIssues",
                    new Class<?>[]{StoryboardDtos.GeneratedStoryboardResult.class, int.class, List.class},
                    plannedResult(plannedDuration(duration)), 15, List.of(5, 10, 15))).isEmpty());
        }
    }

    @Test
    void shouldRetainFixedDurationConstraintAcrossRepairAndRejectAnInvalidReplacement() {
        var initial = plannedResult(plannedDuration(5));
        var request = new StoryboardDtos.GenerateStoryboardRequest("主角走进院子。", "完整章节", VISUAL_STYLE, "channel::text", null, List.of(), 10, List.of(10));
        var validService = scriptedGeneration(List.of(initial, review(1, true), plannedResult(plannedDuration(10)), review(1, true)));
        var result = validService.generateStoryboard(request).block();
        Assertions.assertEquals(10, result.shots().getFirst().durationSeconds());
        Assertions.assertEquals(List.of(10), validService.calls.getFirst().get("allowedShotSeconds"));
        Assertions.assertEquals(List.of(10), validService.calls.get(2).get("allowedShotSeconds"));
        var invalidService = scriptedGeneration(List.of(initial, review(1, true), initial, review(1, true)));
        StepVerifier.create(invalidService.generateStoryboard(request))
                .expectErrorMatches(error -> error instanceof BusinessException && error.getMessage().contains("5秒不受视频模型支持"))
                .verify();
        Assertions.assertEquals(4, invalidService.calls.size());
    }

    @Test
    void shouldValidateDurationChoicesAndKeepLegacyOrEmptyChoicesCompatible() {
        for (List<Integer> choices : List.of(List.of(0), List.of(11), List.of(31),
                java.util.Arrays.asList((Integer) null), java.util.Collections.nCopies(31, 5))) {
            var request = new StoryboardDtos.GenerateStoryboardRequest("原文", "分镜", VISUAL_STYLE, "text", null, List.of(), 10, choices);
            Assertions.assertThrows(BusinessException.class, () -> invoke("validateGenerateRequest",
                    new Class<?>[]{StoryboardDtos.GenerateStoryboardRequest.class}, request));
        }
        for (var request : List.of(new StoryboardDtos.GenerateStoryboardRequest("原文", "分镜", VISUAL_STYLE, "text", null, List.of(), 3),
                new StoryboardDtos.GenerateStoryboardRequest("原文", "分镜", VISUAL_STYLE, "text", null, List.of(), 3, List.of()))) {
            Assertions.assertDoesNotThrow(() -> invoke("validateGenerateRequest", new Class<?>[]{StoryboardDtos.GenerateStoryboardRequest.class}, request));
            var input = JSON.parseObject(JSON.toJSONString(invoke("buildGenerateAgentInput", new Class<?>[]{StoryboardDtos.GenerateStoryboardRequest.class}, request)));
            Assertions.assertEquals(List.of(1, 2, 3), input.getList("allowedShotSeconds", Integer.class));
        }
        var modern = new StoryboardDtos.GenerateStoryboardRequest("原文", "分镜", VISUAL_STYLE, "text", null, List.of(), 15, List.of(5, 10, 15));
        Assertions.assertEquals(modern, JSON.parseObject(JSON.toJSONString(modern), StoryboardDtos.GenerateStoryboardRequest.class));
    }

    private static StoryboardDtos.GeneratedStoryboardShot plannedDuration(int seconds) {
        var shot = plannedShot(1, "establish", "院子", "现在", "");
        return new StoryboardDtos.GeneratedStoryboardShot(shot.shotNumber(), seconds, shot.visualDescription(), shot.shotSize(),
                shot.lightingAtmosphere(), shot.dialogueVoiceover(), shot.soundEffect(), shot.cameraMovement(), shot.assetReferenceKeys(), shot.continuity());
    }

    @Test
    void shouldAllowAChapterModelCallToCompleteAfterTheOldNinetySecondLimit() {
        var agent = mock(ReActAgent.class);
        var model = mock(Model.class);
        var result = plannedResult(plannedDuration(10));
        var response = ChatResponse.builder().content(List.of(TextBlock.builder().text(JSON.toJSONString(result)).build())).finishReason("stop").build();
        when(model.stream(anyList(), anyList(), any()))
                .thenAnswer(ignored -> Mono.delay(Duration.ofSeconds(120)).thenReturn(response).flux());
        var service = timeoutTestService(agent, new InspireProperties());
        StepVerifier.withVirtualTime(() -> service.callAgent(1L, "slow-chapter", testTextModel(model), Map.of("action", "generateStoryboard"),
                        StoryboardDtos.GeneratedStoryboardResult.class))
                .expectSubscription()
                .expectNoEvent(Duration.ofSeconds(91))
                .thenAwait(Duration.ofSeconds(29))
                .expectNext(result)
                .verifyComplete();
        verify(model).stream(anyList(), anyList(), any());
        verify(agent).close();
    }

    @Test
    void shouldCancelAHungModelAtTheNewLimitWithAChineseErrorAndNoAutomaticRetry() {
        var agent = mock(ReActAgent.class);
        var model = mock(Model.class);
        var cancelled = new AtomicBoolean();
        when(model.stream(anyList(), anyList(), any()))
                .thenAnswer(ignored -> Flux.<ChatResponse>never().doOnCancel(() -> cancelled.set(true)));
        var service = timeoutTestService(agent, new InspireProperties());
        StepVerifier.withVirtualTime(() -> service.callAgent(1L, "hung-chapter", testTextModel(model), Map.of("action", "generateStoryboard"),
                        StoryboardDtos.GeneratedStoryboardResult.class))
                .expectSubscription()
                .expectNoEvent(Duration.ofSeconds(179))
                .thenAwait(Duration.ofSeconds(1))
                .expectErrorMatches(error -> error instanceof BusinessException
                        && error.getMessage().contains("超过180秒") && error.getMessage().contains("原分镜保持不变")
                        && !error.getMessage().contains("Did not observe"))
                .verify();
        Assertions.assertTrue(cancelled.get());
        verify(model).stream(anyList(), anyList(), any());
        verify(agent).close();
    }

    @Test
    void shouldCloseTheActiveModelWhenTheUserCancelsBeforeTimeout() {
        var agent = mock(ReActAgent.class);
        var model = mock(Model.class);
        var cancelled = new AtomicBoolean();
        when(model.stream(anyList(), anyList(), any()))
                .thenAnswer(ignored -> Flux.<ChatResponse>never().doOnCancel(() -> cancelled.set(true)));
        var service = timeoutTestService(agent, new InspireProperties());
        StepVerifier.withVirtualTime(() -> service.callAgent(1L, "cancel-chapter", testTextModel(model), Map.of("action", "generateStoryboard"),
                        StoryboardDtos.GeneratedStoryboardResult.class))
                .expectSubscription().thenAwait(Duration.ofSeconds(20)).thenCancel().verify();
        Assertions.assertTrue(cancelled.get());
        verify(model).stream(anyList(), anyList(), any());
        verify(agent).close();
    }

    @Test
    void shouldBoundEveryModelCallAndTheEntireChapterEvenWithInvalidConfiguration() {
        var properties = new InspireProperties();
        Assertions.assertEquals(180, properties.getAi().getStoryboardAgent().getTimeoutSeconds());
        storyboardAgentService = timeoutTestService(mock(ReActAgent.class), properties);
        Assertions.assertEquals(180L, invoke("storyboardCallTimeoutSeconds", new Class<?>[]{}));
        Assertions.assertEquals(600L, invoke("storyboardOperationTimeoutSeconds", new Class<?>[]{}));
        properties.getAi().getStoryboardAgent().setTimeoutSeconds(Integer.MAX_VALUE);
        Assertions.assertEquals(300L, invoke("storyboardCallTimeoutSeconds", new Class<?>[]{}));
        Assertions.assertEquals(600L, invoke("storyboardOperationTimeoutSeconds", new Class<?>[]{}));
        properties.getAi().getStoryboardAgent().setTimeoutSeconds(-1);
        Assertions.assertEquals(180L, invoke("storyboardCallTimeoutSeconds", new Class<?>[]{}));
        properties.getAi().getStoryboardAgent().setTimeoutSeconds(1);
        Assertions.assertEquals(1L, invoke("storyboardCallTimeoutSeconds", new Class<?>[]{}));
        Assertions.assertEquals(120L, invoke("storyboardOperationTimeoutSeconds", new Class<?>[]{}));
    }

    private StoryboardAgentService timeoutTestService(ReActAgent agent, InspireProperties properties) {
        var factory = mock(AgentScopeAgentFactory.class);
        when(factory.storyboardAgent(any())).thenReturn(agent);
        when(agent.getSysPrompt()).thenReturn("按请求返回完整分镜 JSON");
        return new StoryboardAgentService(mock(CurrentUserProvider.class), mock(AgentScopeModelFactory.class), factory,
                properties, creditService, mock(SystemPromptTemplateService.class), mock(AiTaskService.class));
    }

    private static AgentScopeModelFactory.TextModelSelection testTextModel(Model model) {
        return new AgentScopeModelFactory.TextModelSelection(model, "channel::text", "text", "test", 1);
    }

    @Test
    void shouldPreserveCanonicalAssetIdentityAndContinuityWhenNormalizing() {
        var state = new StoryboardDtos.ShotContinuity("院子", "现在", "establish", "红衣人物在门口", "红衣人物走进院子", "建立人物目标");
        var generated = new StoryboardDtos.GeneratedStoryboardResult(List.of(new StoryboardDtos.GeneratedStoryboardShot(
                1, 5, "红衣人物走进院子", "中景", "阳光", "", "脚步", "跟拍", List.of("canonical", "alias"), state)), List.of(
                new StoryboardDtos.GeneratedStoryboardAsset("character", "canonical", "误写姓名", "错误白衣"),
                new StoryboardDtos.GeneratedStoryboardAsset("character", "alias", "林舟", "另一套错误描述")));
        var canonical = new StoryboardDtos.StoryboardAsset("canonical", "character", "林舟", "红色外衣，左手旧表");
        var normalized = JSON.parseObject(JSON.toJSONString(invoke("normalizeGeneratedStoryboard",
                new Class<?>[]{StoryboardDtos.GeneratedStoryboardResult.class, List.class}, generated, List.of(canonical))));
        Assertions.assertEquals(1, normalized.getJSONArray("assets").size());
        Assertions.assertEquals(canonical.description(), normalized.getJSONArray("assets").getJSONObject(0).getString("description"));
        Assertions.assertEquals(List.of("canonical"), normalized.getJSONArray("shots").getJSONObject(0).getList("assetIds", String.class));
        Assertions.assertEquals(state, normalized.getJSONArray("shots").getJSONObject(0).getObject("continuity", StoryboardDtos.ShotContinuity.class));
    }

    @Test
    void shouldKeepConfirmedContinuityThroughAssetReviewAndFieldCorrection() {
        var shot = plannedShot(1, "establish", "院子", "现在", "");
        var result = plannedResult(shot);
        var reviewed = (StoryboardDtos.GeneratedStoryboardResult) invoke("applyAssetCoverage",
                new Class<?>[]{StoryboardDtos.GeneratedStoryboardResult.class, StoryboardDtos.AssetCoverageResult.class}, result, review(1, true));
        var corrected = (StoryboardDtos.GeneratedStoryboardResult) invoke("applyGeneratedFieldCorrections",
                new Class<?>[]{StoryboardDtos.GeneratedStoryboardResult.class, StoryboardDtos.StoryboardFieldCorrections.class, java.util.Set.class, java.util.Set.class},
                result, new StoryboardDtos.StoryboardFieldCorrections(List.of(), List.of(new StoryboardDtos.ShotSizeCorrection(0, StoryboardDtos.GeneratedShotSize.中景, List.of()))),
                java.util.Set.of(), java.util.Set.of(0));
        Assertions.assertEquals(shot.continuity(), reviewed.shots().getFirst().continuity());
        Assertions.assertEquals(shot.continuity(), corrected.shots().getFirst().continuity());
    }

    @Test
    void shouldUseConfirmedStatesRatherThanAllowThePromptModelToInventNewOnes() {
        var state = new StoryboardDtos.ShotContinuity("车站", "现在", "return", "主角左手握钥匙", "主角已将钥匙交给父亲", "回到现实完成团聚");
        var shot = new StoryboardDtos.StoryboardShot("one", 1, 5, "主角归还钥匙", "中景", "暖光", "", "", "缓推", "", List.of(), state);
        var request = new StoryboardDtos.ComposePromptsRequest("完整剧情", "结尾", VISUAL_STYLE, "text", List.of(shot), List.of());
        var generated = new StoryboardDtos.PromptContentResult(List.of(new StoryboardDtos.ComposedShotContent("one", "主角与父亲在车站相逢", "错误首帧", "错误结束", "错误转场")));
        var rendered = (StoryboardDtos.PromptCompositionResult) invoke("renderComposedPrompts",
                new Class<?>[]{StoryboardDtos.ComposePromptsRequest.class, StoryboardDtos.PromptContentResult.class}, request, generated);
        Assertions.assertTrue(rendered.prompts().getFirst().finalPrompt().contains(state.openingState()));
        Assertions.assertTrue(rendered.prompts().getFirst().finalPrompt().contains(state.closingState()));
        Assertions.assertTrue(rendered.prompts().getFirst().finalPrompt().contains("结束回忆，回到当前故事时间"));
        Assertions.assertFalse(rendered.prompts().getFirst().finalPrompt().contains("错误"));
    }

    @Test
    void shouldRejectMissingOrContradictoryNarrativeAuditResults() {
        Assertions.assertThrows(BusinessException.class, () -> invoke("narrativeReviewIssues",
                new Class<?>[]{StoryboardDtos.AssetCoverageResult.class}, new StoryboardDtos.AssetCoverageResult(List.of(), List.of(), null, null)));
        Assertions.assertFalse(((List<?>) invoke("narrativeReviewIssues", new Class<?>[]{StoryboardDtos.AssetCoverageResult.class}, review(1, false))).isEmpty());
        Assertions.assertFalse(((List<?>) invoke("narrativeReviewIssues", new Class<?>[]{StoryboardDtos.AssetCoverageResult.class}, review(1, true, "实际有缺失"))).isEmpty());
    }

    @SuppressWarnings("unchecked")
    private List<String> continuityIssues(StoryboardDtos.GeneratedStoryboardResult result) {
        return (List<String>) invoke("generatedContinuityIssues", new Class<?>[]{StoryboardDtos.GeneratedStoryboardResult.class}, result);
    }

    private static StoryboardDtos.GeneratedStoryboardShot plannedShot(int number, String transition, String scene, String time, String speech) {
        return new StoryboardDtos.GeneratedStoryboardShot(number, 5, "主角完成当前动作并望向门外", "中景", "暖光", speech, "环境声", "跟随", List.of(),
                new StoryboardDtos.ShotContinuity(scene, time, transition, "主角站在原地，左手拿钥匙", "主角完成动作，左手仍拿钥匙", "主角完成本阶段目标并留下下一步动作"));
    }

    private static StoryboardDtos.GeneratedStoryboardResult plannedResult(StoryboardDtos.GeneratedStoryboardShot... shots) {
        return new StoryboardDtos.GeneratedStoryboardResult(List.of(shots), List.of());
    }

    private static StoryboardDtos.AssetCoverageResult review(int count, boolean complete, String... issues) {
        return new StoryboardDtos.AssetCoverageResult(List.of(), java.util.stream.IntStream.range(0, count)
                .mapToObj(index -> new StoryboardDtos.CoverageShot(index, List.of())).toList(), complete, List.of(issues));
    }

    private ScriptedStoryboardService scriptedGeneration(List<Object> responses) {
        var currentUser = mock(CurrentUserProvider.class);
        var models = mock(AgentScopeModelFactory.class);
        when(currentUser.currentUserId()).thenReturn(Mono.just(1L));
        when(models.resolveTextModel("channel::text", 1L)).thenReturn(Mono.just(new AgentScopeModelFactory.TextModelSelection(null, "channel::text", "text", "test", 1)));
        when(creditService.chargeOperation(eq(1L), anyString(), eq(1), anyString())).thenReturn(Mono.empty());
        when(creditService.refundOperation(eq(1L), anyString(), anyString())).thenReturn(Mono.empty());
        return new ScriptedStoryboardService(currentUser, models, creditService, responses);
    }

    private static class ScriptedStoryboardService extends StoryboardAgentService {
        private final ArrayDeque<Object> responses;
        private final List<Map<String, Object>> calls = new ArrayList<>();
        ScriptedStoryboardService(CurrentUserProvider user, AgentScopeModelFactory models, CreditService credits, List<Object> responses) {
            super(user, models, mock(AgentScopeAgentFactory.class), new InspireProperties(), credits, mock(SystemPromptTemplateService.class), mock(AiTaskService.class));
            this.responses = new ArrayDeque<>(responses);
        }
        @Override
        <T> Mono<T> callAgent(Long userId, String operationId, AgentScopeModelFactory.TextModelSelection model, Map<String, Object> input, Class<T> resultType) {
            calls.add(input);
            return Mono.just(resultType.cast(responses.removeFirst()));
        }
    }

    @Test
    void shouldPreserveTheFullStoryAndTargetChapterSeparatelyIncludingItsEnding() {
        String fullStory = "前文".repeat(18000) + "最后主角归还钥匙，重逢家人。";
        var context = new StoryboardDtos.StoryContext("归途", fullStory, "重逢", 3, 3, "第二章结束", null);
        var request = new StoryboardDtos.GenerateStoryboardRequest("主角归还钥匙，重逢家人。", "生成完整章节", VISUAL_STYLE, "model", context);
        var input = JSON.parseObject(JSON.toJSONString(invoke("buildGenerateAgentInput",
                new Class<?>[]{StoryboardDtos.GenerateStoryboardRequest.class}, request)));
        Assertions.assertEquals(request.scriptContent(), input.getString("scriptContent"));
        Assertions.assertEquals(fullStory, input.getJSONObject("storyContext").getString("fullStory"));
        Assertions.assertEquals(3, input.getJSONObject("storyContext").getIntValue("chapterIndex"));
        Assertions.assertTrue(input.getString("storyRequirements").contains("中间章节承接前章结果"));
    }

    @Test
    void shouldDeserializeOldRequestsWithoutRequiringNewContext() {
        var old = JSON.parseObject("{\"scriptContent\":\"完整故事\",\"instruction\":\"分镜\",\"visualStyle\":\"写实\",\"model\":\"text\"}",
                StoryboardDtos.GenerateStoryboardRequest.class);
        Assertions.assertNull(old.storyContext());
        Assertions.assertDoesNotThrow(() -> invoke("validateGenerateRequest", new Class<?>[]{StoryboardDtos.GenerateStoryboardRequest.class}, old));
        var modern = new StoryboardDtos.ComposePromptsRequest("剧本", "分镜", VISUAL_STYLE, "model",
                List.of(shot("middle", 20)), List.of(), new StoryboardDtos.StoryContext("标题", "全剧", "第二章", 2, 3, "前章", "后章"),
                List.of(shot("first", 10), shot("middle", 20), shot("last", 30)));
        var roundTrip = JSON.parseObject(JSON.toJSONString(modern), StoryboardDtos.ComposePromptsRequest.class);
        Assertions.assertEquals(modern, roundTrip);
    }

    @Test
    void shouldUseFullSequenceNeighborsWhenComposingOnlyTheSelectedShot() {
        var before = new StoryboardDtos.StoryboardShot("before", 8, 5, "人物推开门，左手仍握着钥匙", "中景", "暖光", "", "开门声", "推进", "不能嵌套此旧提示词", List.of("outside"));
        var current = shot("selected", 2);
        var after = shot("after", 1);
        var request = new StoryboardDtos.ComposePromptsRequest("剧本", "分镜", VISUAL_STYLE, "model",
                List.of(current), List.of(), null, List.of(before, current, after));
        Assertions.assertDoesNotThrow(() -> invoke("validateComposeRequest", new Class<?>[]{StoryboardDtos.ComposePromptsRequest.class}, request));
        var input = JSON.parseArray(JSON.toJSONString(invoke("buildComposeAgentShots", new Class<?>[]{StoryboardDtos.ComposePromptsRequest.class}, request)));
        Assertions.assertEquals(1, input.size());
        Assertions.assertEquals("selected", input.getJSONObject(0).getString("id"));
        Assertions.assertEquals(2, input.getJSONObject(0).getIntValue("sequenceIndex"));
        Assertions.assertEquals(3, input.getJSONObject(0).getIntValue("sequenceCount"));
        Assertions.assertEquals("before", input.getJSONObject(0).getJSONObject("previousShot").getString("id"));
        Assertions.assertEquals("after", input.getJSONObject(0).getJSONObject("nextShot").getString("id"));
        Assertions.assertFalse(input.toJSONString().contains("不能嵌套此旧提示词"));
        Assertions.assertTrue(input.getJSONObject(0).getJSONArray("associatedAssets").isEmpty());
    }

    @Test
    void shouldRejectMissingOrDuplicateSequenceMembersBeforeCallingAnAgent() {
        var selected = shot("selected", 2);
        for (var sequence : List.of(List.<StoryboardDtos.StoryboardShot>of(), List.of(shot("other", 1)),
                List.of(shot("selected", 1), selected))) {
            var request = new StoryboardDtos.ComposePromptsRequest("剧本", "分镜", VISUAL_STYLE, "model",
                    List.of(selected), List.of(), null, sequence);
            Assertions.assertThrows(BusinessException.class, () -> invoke("validateComposeRequest", new Class<?>[]{StoryboardDtos.ComposePromptsRequest.class}, request));
        }
    }

    @Test
    void shouldRejectOversizedOrImpossibleStoryContextWithoutTruncation() {
        for (var context : List.of(
                new StoryboardDtos.StoryContext("标题", "完整故事", "章节", 4, 3, null, null),
                new StoryboardDtos.StoryContext("标题", "文".repeat(120001), "章节", 1, 1, null, null),
                new StoryboardDtos.StoryContext("标题", "完整故事", "章节", 1, 2, "文".repeat(12001), null))) {
            var request = new StoryboardDtos.GenerateStoryboardRequest("剧本", "分镜", VISUAL_STYLE, "model", context);
            Assertions.assertThrows(BusinessException.class, () -> invoke("validateGenerateRequest", new Class<?>[]{StoryboardDtos.GenerateStoryboardRequest.class}, request));
        }
    }

    @Test
    void shouldCarryFirstAndLastFrameStatesIntoTheFinalPromptWithoutAddingNeighborAssets() {
        var current = new StoryboardDtos.StoryboardShot("current", 2, 5, "主角走进屋内", "中景", "暖光", "", "脚步声", "跟随", "", List.of("hero"));
        var request = new StoryboardDtos.ComposePromptsRequest("剧本", "分镜", VISUAL_STYLE, "model", List.of(current), List.of(
                new StoryboardDtos.StoryboardAsset("hero", "character", "林川", "短发、黑色外套"),
                new StoryboardDtos.StoryboardAsset("unused", "character", "陌生人", "红色帽子")));
        var content = new StoryboardDtos.PromptContentResult(List.of(new StoryboardDtos.ComposedShotContent("current",
                "林川继续跨过门槛，镜头跟随进入室内。", "左手握钥匙，右脚已跨入门内", "站定在木桌前，钥匙仍在左手", "同场接续开门结果，不再次开门")));
        var rendered = (StoryboardDtos.PromptCompositionResult) invoke("renderComposedPrompts",
                new Class<?>[]{StoryboardDtos.ComposePromptsRequest.class, StoryboardDtos.PromptContentResult.class}, request, content);
        var prompt = invokePromptValidation(request.shots(), VISUAL_STYLE, rendered).getFirst().finalPrompt();
        Assertions.assertTrue(prompt.contains("首帧状态：左手握钥匙，右脚已跨入门内"));
        Assertions.assertTrue(prompt.contains("结束状态：站定在木桌前，钥匙仍在左手"));
        Assertions.assertTrue(prompt.contains("镜头衔接：同场接续开门结果，不再次开门"));
        Assertions.assertTrue(prompt.contains("角色身份与外观保持一致：林川（短发、黑色外套）"));
        Assertions.assertFalse(prompt.contains("陌生人"));
        Assertions.assertEquals(8, prompt.split("\\n\\n").length);
    }

    /**
     * 用户提交未知镜头资产关联时应在调用Agent前拒绝。
     */
    @Test
    void shouldRejectUnknownAssociatedAssetIdentifier() {
        StoryboardDtos.StoryboardShot shot = new StoryboardDtos.StoryboardShot(
                "shot-1", 1, 5, "雨夜街道中的角色", "远景", "霓虹反光", "", "雨声", "推进", "", List.of("missing-asset"));
        StoryboardDtos.ComposePromptsRequest request = new StoryboardDtos.ComposePromptsRequest(
                "剧本文本", "生成追逐片段", VISUAL_STYLE, "channel::story-model", List.of(shot), List.of());

        BusinessException exception = Assertions.assertThrows(BusinessException.class, () -> invoke("validateComposeRequest", new Class<?>[]{StoryboardDtos.ComposePromptsRequest.class}, request));

        Assertions.assertEquals("镜头关联了不存在的资产", exception.getMessage());
    }

    /**
     * 分镜生成请求缺少视觉风格时应在调用Agent前拒绝。
     */
    @Test
    void shouldRejectGenerateRequestWithoutVisualStyle() {
        StoryboardDtos.GenerateStoryboardRequest request = new StoryboardDtos.GenerateStoryboardRequest(
                "剧本文本", "生成追逐片段", "", "channel::story-model");

        BusinessException exception = Assertions.assertThrows(BusinessException.class,
                () -> invoke("validateGenerateRequest", new Class<?>[]{StoryboardDtos.GenerateStoryboardRequest.class}, request));

        Assertions.assertEquals("视觉风格不能为空", exception.getMessage());
    }

    /**
     * 分镜Agent调用失败后必须触发原操作标识的全额退款。
     */
    @Test
    void shouldRefundChargedStoryboardOperationAfterFailure() {
        when(creditService.chargeOperation(eq(8L), anyString(), eq(6), eq("测试分镜操作"))).thenReturn(Mono.empty());
        when(creditService.refundOperation(eq(8L), anyString(), eq("测试分镜操作"))).thenReturn(Mono.empty());
        @SuppressWarnings("unchecked")
        Mono<String> result = (Mono<String>) invoke(
                "executeChargedOperation",
                new Class<?>[]{Long.class, int.class, String.class, Function.class},
                8L,
                6,
                "测试分镜操作",
                (Function<String, Mono<String>>) ignored -> Mono.error(new IllegalStateException("Agent调用失败")));

        StepVerifier.create(result)
                .expectError(IllegalStateException.class)
                .verify();

        verify(creditService).refundOperation(eq(8L), anyString(), eq("测试分镜操作"));
    }

    /**
     * 构造有效镜头。
     *
     * @param id String 稳定镜头标识
     * @param shotNumber Integer 镜号
     * @return StoryboardShot 有效镜头
     */
    private StoryboardDtos.StoryboardShot shot(String id, int shotNumber) {
        return new StoryboardDtos.StoryboardShot(id, shotNumber, 5, "雨夜街道中的角色", "远景", "霓虹反光", "", "雨声", "推进", "", List.of());
    }

    /**
     * 构造满足固定段落格式的中文最终提示词。
     *
     * @param visualContent String 画面内容
     * @return String 固定格式的最终提示词
     */
    private String formattedPrompt(String visualContent) {
        return formattedPrompt(visualContent, VISUAL_STYLE);
    }

    /**
     * 构造满足固定段落格式的中文最终提示词。
     *
     * @param visualContent String 画面内容
     * @param visualStyle String 整体视觉风格
     * @return String 固定格式的最终提示词
     */
    private String formattedPrompt(String visualContent, String visualStyle) {
        return """
                镜头规格：远景，5 秒。

                画面内容：%s。

                场景：雨夜街道。

                道具：无。

                光影氛围：霓虹反光。

                运镜：推进。

                声音：雨声。

                视觉风格：%s
                """.formatted(visualContent, visualStyle).trim();
    }

    /**
     * 反射调用提示词结构化结果校验。
     *
     * @param shots List<StoryboardShot> 输入镜头
     * @param result PromptCompositionResult Agent返回结果
     * @return List<StoryboardPrompt> 校验后的提示词映射
     */
    private List<StoryboardDtos.StoryboardPrompt> invokePromptValidation(
            List<StoryboardDtos.StoryboardShot> shots, StoryboardDtos.PromptCompositionResult result) {
        return invokePromptValidation(shots, VISUAL_STYLE, result);
    }

    /**
     * 反射调用提示词结构化结果校验。
     *
     * @param shots List<StoryboardShot> 输入镜头
     * @param visualStyle String 用户指定的整体视觉风格
     * @param result PromptCompositionResult Agent返回结果
     * @return List<StoryboardPrompt> 校验后的提示词映射
     */
    @SuppressWarnings("unchecked")
    private List<StoryboardDtos.StoryboardPrompt> invokePromptValidation(
            List<StoryboardDtos.StoryboardShot> shots, String visualStyle, StoryboardDtos.PromptCompositionResult result) {
        return (List<StoryboardDtos.StoryboardPrompt>) invoke("validatePromptComposition",
                new Class<?>[]{List.class, String.class, StoryboardDtos.PromptCompositionResult.class}, shots, visualStyle, result);
    }

    /**
     * 反射调用首次生成结构化结果校验。
     *
     * @param result GeneratedStoryboardResult Agent返回结果
     * @return Object 已规范化分镜结果
     */
    private Object invokeGeneratedStoryboardValidation(StoryboardDtos.GeneratedStoryboardResult result) {
        return invoke("normalizeGeneratedStoryboard", new Class<?>[]{StoryboardDtos.GeneratedStoryboardResult.class}, result);
    }

    /**
     * 调用私有方法并保留业务异常语义。
     *
     * @param methodName String 方法名称
     * @param parameterTypes Class<?>[] 参数类型
     * @param arguments Object[] 调用参数
     * @return Object 方法返回值
     */
    private Object invoke(String methodName, Class<?>[] parameterTypes, Object... arguments) {
        try {
            Method method = StoryboardAgentService.class.getDeclaredMethod(methodName, parameterTypes);
            method.setAccessible(true);
            return method.invoke(storyboardAgentService, arguments);
        } catch (InvocationTargetException exception) {
            Throwable cause = exception.getCause();
            if (cause instanceof RuntimeException runtimeException) {
                throw runtimeException;
            }
            throw new AssertionError("调用分镜服务私有方法失败", cause);
        } catch (ReflectiveOperationException exception) {
            throw new AssertionError("读取分镜服务私有方法失败", exception);
        }
    }
}
