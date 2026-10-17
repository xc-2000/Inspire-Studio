package com.inspirestudio.dto;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;

/** 画布图片反推请求。 */
public final class ImagePromptReverseDtos {
    private ImagePromptReverseDtos() {}

    public record ReverseImageRequest(
            @NotNull(message = "请先选择需要反推的图片") AiTaskDtos.AiTaskMediaReference image,
            String model,
            @Pattern(regexp = "bilingual|zh|en", message = "输出语言必须是bilingual、zh或en") String language) {}
}
