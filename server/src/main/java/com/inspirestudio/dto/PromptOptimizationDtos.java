package com.inspirestudio.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * AI 提示词优化接口数据结构。
 *
 * @date     2026-07-17 00:00
 */
public final class PromptOptimizationDtos {

    /**
     * 禁止实例化工具类。
     */
    private PromptOptimizationDtos() {
    }

    /**
     * 提示词优化请求。
     *
     * @param generationType 生成类型，支持 image、video
     * @param prompt 用户原始提示词
     * @param generationStyleIds 用户选择的风格ID
     * @param rewriteForRetry 是否使用独立的提示词改写策略（包括失败重试和分镜改写）
     * @param failureReason 上游失败说明，仅作为不可信参考数据
     * @param storyboardContext 当前分镜和前后镜头的上下文 JSON，仅作为不可信参考数据
     */
    public record OptimizePromptRequest(
            @NotBlank(message = "生成类型不能为空") String generationType,
            @NotBlank(message = "提示词不能为空") String prompt,
            List<Long> generationStyleIds,
            Boolean rewriteForRetry,
            @Size(max = 2000, message = "失败说明不能超过2000个字符") String failureReason,
            @Size(max = 12000, message = "分镜上下文不能超过12000个字符") String storyboardContext) {

        public OptimizePromptRequest(String generationType, String prompt, List<Long> generationStyleIds,
                                     Boolean rewriteForRetry, String failureReason) {
            this(generationType, prompt, generationStyleIds, rewriteForRetry, failureReason, null);
        }

        public OptimizePromptRequest(String generationType, String prompt, List<Long> generationStyleIds) {
            this(generationType, prompt, generationStyleIds, false, null);
        }

        /**
         * 保留无风格的旧版构造方式。
         *
         * @param generationType 生成类型
         * @param prompt 用户原始提示词
         */
        public OptimizePromptRequest(String generationType, String prompt) {
            this(generationType, prompt, null);
        }
    }
}
