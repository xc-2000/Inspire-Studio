package com.inspirestudio.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * 分镜脚本接口与Agent结构化结果数据结构。
 *
 * @date     2026-08-08 00:00
 */
public final class StoryboardDtos {

    /** 分镜脚本最多允许的镜头数量。 */
    public static final int MAX_SHOT_COUNT = 100;

    /** 禁止实例化工具类。 */
    private StoryboardDtos() {
    }

    /**
     * 生成分镜脚本请求。
     *
     * @param scriptContent String 来源剧本文本
     * @param instruction String 用户指定的剧情或片段描述
     * @param visualStyle String 分镜整体视觉风格
     * @param model String 选择的channelId::model文本模型
     */
    public record GenerateStoryboardRequest(
            @NotBlank(message = "剧本文本不能为空") @Size(max = 40000, message = "剧本文本不能超过40000字") String scriptContent,
            @NotBlank(message = "分镜描述不能为空") @Size(max = 8000, message = "分镜描述不能超过8000字") String instruction,
            @NotBlank(message = "视觉风格不能为空") @Size(max = 8000, message = "视觉风格不能超过8000字") String visualStyle,
            @NotBlank(message = "文本模型不能为空") @Size(max = 256, message = "文本模型长度不合法") String model,
            @Valid StoryContext storyContext,
            @Size(max = 300, message = "已有资产数量不能超过300") List<@Valid StoryboardAsset> existingAssets,
            @Min(value = 1, message = "单镜头时长至少1秒") @Max(value = 30, message = "单镜头时长最多30秒") Integer maxShotSeconds,
            @Size(max = 30, message = "可用镜头时长最多30项")
            List<@NotNull(message = "可用镜头时长不能为空") @Min(value = 1, message = "可用镜头时长至少1秒") @Max(value = 30, message = "可用镜头时长最多30秒") Integer> allowedShotSeconds) {
        public GenerateStoryboardRequest(String scriptContent, String instruction, String visualStyle, String model) {
            this(scriptContent, instruction, visualStyle, model, null, null, null, null);
        }
        public GenerateStoryboardRequest(String scriptContent, String instruction, String visualStyle, String model,
                                         StoryContext storyContext) {
            this(scriptContent, instruction, visualStyle, model, storyContext, null, null, null);
        }
        public GenerateStoryboardRequest(String scriptContent, String instruction, String visualStyle, String model,
                                         StoryContext storyContext, List<StoryboardAsset> existingAssets) {
            this(scriptContent, instruction, visualStyle, model, storyContext, existingAssets, null, null);
        }
        public GenerateStoryboardRequest(String scriptContent, String instruction, String visualStyle, String model,
                                         StoryContext storyContext, List<StoryboardAsset> existingAssets, Integer maxShotSeconds) {
            this(scriptContent, instruction, visualStyle, model, storyContext, existingAssets, maxShotSeconds, null);
        }
    }

    /**
     * 合成全部提示词请求。
     *
     * @param scriptContent String 来源剧本文本
     * @param instruction String 用户指定的剧情或片段描述
     * @param visualStyle String 分镜整体视觉风格
     * @param model String 选择的channelId::model文本模型
     * @param shots List<StoryboardShot> 当前可编辑镜头
     * @param assets List<StoryboardAsset> 当前可编辑资产
     */
    public record ComposePromptsRequest(
            @NotBlank(message = "剧本文本不能为空") @Size(max = 40000, message = "剧本文本不能超过40000字") String scriptContent,
            @NotBlank(message = "分镜描述不能为空") @Size(max = 8000, message = "分镜描述不能超过8000字") String instruction,
            @NotBlank(message = "视觉风格不能为空") @Size(max = 8000, message = "视觉风格不能超过8000字") String visualStyle,
            @NotBlank(message = "文本模型不能为空") @Size(max = 256, message = "文本模型长度不合法") String model,
            @NotEmpty(message = "至少需要一个镜头") @Size(max = MAX_SHOT_COUNT, message = "镜头数量不能超过100") List<@Valid StoryboardShot> shots,
            @Size(max = 300, message = "资产数量不能超过300") List<@Valid StoryboardAsset> assets,
            @Valid StoryContext storyContext,
            @Size(max = MAX_SHOT_COUNT, message = "章节镜头数量不能超过100") List<@Valid StoryboardShot> sequenceShots) {
        public ComposePromptsRequest(String scriptContent, String instruction, String visualStyle, String model,
                                     List<StoryboardShot> shots, List<StoryboardAsset> assets) {
            this(scriptContent, instruction, visualStyle, model, shots, assets, null, null);
        }
        public ComposePromptsRequest(String scriptContent, String instruction, String visualStyle, String model,
                                     List<StoryboardShot> shots, List<StoryboardAsset> assets, StoryContext storyContext) {
            this(scriptContent, instruction, visualStyle, model, shots, assets, storyContext, null);
        }
    }

    /** 全剧作为连续性背景，scriptContent 始终是本次需要生成的章节，章节序号从 1 开始。 */
    public record StoryContext(
            @Size(max = 300, message = "故事名称不能超过300字") String storyTitle,
            @Size(max = 120000, message = "完整故事不能超过120000字") String fullStory,
            @Size(max = 300, message = "章节名称不能超过300字") String chapterTitle,
            @Positive(message = "章节序号必须为正整数") Integer chapterIndex,
            @Positive(message = "章节数量必须为正整数") Integer chapterCount,
            @Size(max = 12000, message = "前章上下文不能超过12000字") String previousChapter,
            @Size(max = 12000, message = "后章上下文不能超过12000字") String nextChapter) {}

    /**
     * 分镜资产图片生成任务请求。
     * <p>提示词由服务端按资产类别模板渲染，前端只提交结构化字段。</p>
     *
     * @param nodeId String 分镜节点标识
     * @param asset StoryboardAsset 待生成的资产
     * @param visualStyle String 分镜整体视觉风格
     * @param model String 选择的channelId::model图片模型
     * @param settings AssetImageSettings 图片生成参数
     */
    public record CreateAssetImageTaskRequest(
            @NotBlank(message = "分镜节点标识不能为空") @Size(max = 128, message = "分镜节点标识长度不合法") String nodeId,
            @NotNull(message = "资产不能为空") @Valid StoryboardAsset asset,
            @NotBlank(message = "视觉风格不能为空") @Size(max = 8000, message = "视觉风格不能超过8000字") String visualStyle,
            @NotBlank(message = "图片模型不能为空") @Size(max = 256, message = "图片模型长度不合法") String model,
            @NotNull(message = "图片生成参数不能为空") @Valid AssetImageSettings settings) {
    }

    /**
     * 分镜资产图片生成参数，直接透传给图片生成渠道。
     *
     * @param quality String 图片质量
     * @param resolution String 图片分辨率
     * @param size String 图片尺寸
     */
    public record AssetImageSettings(String quality, String resolution, String size) {
    }

    /**
     * 画布持久化的分镜镜头。
     *
     * @param id String 稳定镜头标识
     * @param shotNumber Integer 镜号
     * @param durationSeconds Integer 时长秒数
     * @param visualDescription String 画面描述
     * @param shotSize String 景别
     * @param lightingAtmosphere String 光影氛围
     * @param dialogueVoiceover String 对白或旁白
     * @param soundEffect String 音效
     * @param cameraMovement String 运镜
     * @param finalPrompt String 最终中文提示词
     * @param assetIds List<String> 关联的画布资产标识
     */
    public record StoryboardShot(
            @NotBlank(message = "镜头标识不能为空") @Size(max = 128, message = "镜头标识长度不合法") String id,
            @NotNull(message = "镜号不能为空") @Positive(message = "镜号必须为正整数") Integer shotNumber,
            @NotNull(message = "时长不能为空") @Positive(message = "时长必须为正整数") Integer durationSeconds,
            @NotBlank(message = "画面描述不能为空") @Size(max = 4000, message = "画面描述不能超过4000字") String visualDescription,
            @NotBlank(message = "景别不能为空") @Size(max = 32, message = "景别长度不合法") String shotSize,
            @Size(max = 2000, message = "光影氛围不能超过2000字") String lightingAtmosphere,
            @Size(max = 2000, message = "对白旁白不能超过2000字") String dialogueVoiceover,
            @Size(max = 2000, message = "音效不能超过2000字") String soundEffect,
            @Size(max = 2000, message = "运镜不能超过2000字") String cameraMovement,
            @Size(max = 8000, message = "最终提示词不能超过8000字") String finalPrompt,
            @NotNull(message = "关联资产不能为空") @Size(max = 300, message = "关联资产数量不能超过300")
            List<@NotBlank(message = "关联资产标识不能为空") @Size(max = 128, message = "关联资产标识长度不合法") String> assetIds,
            @Valid ShotContinuity continuity) {
        public StoryboardShot(String id, Integer shotNumber, Integer durationSeconds, String visualDescription,
                              String shotSize, String lightingAtmosphere, String dialogueVoiceover, String soundEffect,
                              String cameraMovement, String finalPrompt, List<String> assetIds) {
            this(id, shotNumber, durationSeconds, visualDescription, shotSize, lightingAtmosphere,
                    dialogueVoiceover, soundEffect, cameraMovement, finalPrompt, assetIds, null);
        }
    }

    /** 镜头连续性契约。旧镜头可为空，新规划镜头必须明确场景、时间、首尾状态和剧情作用。 */
    public record ShotContinuity(
            @Size(max = 160, message = "场景标识不能超过160字") String sceneId,
            @Size(max = 300, message = "镜头时间不能超过300字") String time,
            @Size(max = 32, message = "转场类型长度不合法") String transition,
            @Size(max = 2000, message = "首帧状态不能超过2000字") String openingState,
            @Size(max = 2000, message = "尾帧状态不能超过2000字") String closingState,
            @Size(max = 1000, message = "剧情作用不能超过1000字") String storyBeat) {}

    /**
     * 画布持久化的分镜资产。
     *
     * @param id String 稳定资产标识
     * @param kind String 资产类别：character、scene、prop
     * @param name String 资产名称
     * @param description String 资产描述
     */
    public record StoryboardAsset(
            @NotBlank(message = "资产标识不能为空") @Size(max = 128, message = "资产标识长度不合法") String id,
            @NotBlank(message = "资产类别不能为空") @Size(max = 32, message = "资产类别长度不合法") String kind,
            @NotBlank(message = "资产名称不能为空") @Size(max = 200, message = "资产名称不能超过200字") String name,
            @Size(max = 4000, message = "资产描述不能超过4000字") String description) {
    }

    /**
     * 分镜Agent首次生成的镜头结构。
     *
     * @param shotNumber Integer 镜号
     * @param durationSeconds Integer 时长秒数
     * @param visualDescription String 画面描述
     * @param shotSize String 景别
     * @param lightingAtmosphere String 光影氛围
     * @param dialogueVoiceover String 对白或旁白
     * @param soundEffect String 音效
     * @param cameraMovement String 运镜
     * @param assetReferenceKeys List<String> 关联资产的稳定引用键
     */
    public record GeneratedStoryboardShot(Integer shotNumber, Integer durationSeconds, String visualDescription,
                                          String shotSize, String lightingAtmosphere, String dialogueVoiceover,
                                          String soundEffect, String cameraMovement, List<String> assetReferenceKeys,
                                          ShotContinuity continuity) {
        public GeneratedStoryboardShot(Integer shotNumber, Integer durationSeconds, String visualDescription,
                                       String shotSize, String lightingAtmosphere, String dialogueVoiceover,
                                       String soundEffect, String cameraMovement, List<String> assetReferenceKeys) {
            this(shotNumber, durationSeconds, visualDescription, shotSize, lightingAtmosphere,
                    dialogueVoiceover, soundEffect, cameraMovement, assetReferenceKeys, null);
        }
    }

    /**
     * 分镜Agent首次生成的资产结构。
     *
     * @param kind String 资产类别：character、scene、prop
     * @param referenceKey String Agent返回的稳定资产引用键
     * @param name String 资产名称
     * @param description String 资产描述
     */
    public record GeneratedStoryboardAsset(String kind, String referenceKey, String name, String description) {
    }

    /** 纠正模型输出时由结构化 schema 限定枚举，不允许任意字符串。 */
    public enum GeneratedAssetKind { character, scene, prop }
    public enum GeneratedShotSize { 大特写, 特写, 近景, 头肩景, 中景, 中远景, 全景, 远景, 大远景, 大全景 }
    public record AssetKindCorrection(Integer index, GeneratedAssetKind kind) {}
    public record ShotSizeCorrection(Integer index, GeneratedShotSize shotSize, List<String> assetReferenceKeys) {}
    public record StoryboardFieldCorrections(List<AssetKindCorrection> assets, List<ShotSizeCorrection> shots) {}
    public record CoverageAsset(GeneratedAssetKind kind, String referenceKey, String name, String description) {}
    public record CoverageShot(Integer index, List<String> assetReferenceKeys) {}
    /** 资产检查与原文叙事覆盖联合复核，避免完整字段掩盖缺失的剧情和结尾。 */
    public record AssetCoverageResult(List<CoverageAsset> additions, List<CoverageShot> shots,
                                      Boolean narrativeComplete, List<String> narrativeIssues) {
        public AssetCoverageResult(List<CoverageAsset> additions, List<CoverageShot> shots) {
            this(additions, shots, true, List.of());
        }
    }

    /**
     * 分镜Agent首次生成的结构化结果。
     *
     * @param shots List<GeneratedStoryboardShot> 镜头列表
     * @param assets List<GeneratedStoryboardAsset> 资产列表
     */
    public record GeneratedStoryboardResult(List<GeneratedStoryboardShot> shots, List<GeneratedStoryboardAsset> assets) {
    }

    /**
     * 合成提示词Agent返回的单镜头结果。
     *
     * @param shotId String 输入镜头稳定标识
     * @param finalPrompt String 最终中文提示词
     */
    public record StoryboardPrompt(String shotId, String finalPrompt) {
    }

    /**
     * 合成提示词Agent返回的结构化结果。
     *
     * @param prompts List<StoryboardPrompt> 镜头提示词映射
     */
    public record PromptCompositionResult(List<StoryboardPrompt> prompts) {
    }

    /** 模型只负责画面创作，固定段落由服务端依据已确认的分镜组装。 */
    public record ComposedShotContent(String shotId, String visualDescription, String openingState,
                                      String closingState, String transitionFromPrevious) {
        public ComposedShotContent(String shotId, String visualDescription) {
            this(shotId, visualDescription, null, null, null);
        }
    }
    public record PromptContentResult(List<ComposedShotContent> prompts) {}

    /**
     * 首次生成分镜脚本响应。
     *
     * @param shots List<StoryboardShot> 带稳定标识的镜头列表
     * @param assets List<StoryboardAsset> 带稳定标识的资产列表
     * @param chargedCredits int 本次实际扣除积分
     */
    public record GenerateStoryboardResponse(List<StoryboardShot> shots, List<StoryboardAsset> assets, int chargedCredits) {
    }

    /**
     * 合成全部提示词响应。
     *
     * @param prompts List<StoryboardPrompt> 按稳定镜头标识返回的提示词映射
     * @param chargedCredits int 本次实际扣除积分
     */
    public record ComposePromptsResponse(List<StoryboardPrompt> prompts, int chargedCredits) {
    }
}
