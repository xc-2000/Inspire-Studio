package com.inspirestudio.ai;

import static org.junit.jupiter.api.Assertions.*;
import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.dto.AiTaskDtos;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ImagePromptReverseSupportTest {
    @Test
    void requiresExplicitVisionMetadataAndSupportedTransportAndAnUploadedImage() {
        var task = request();
        assertDoesNotThrow(() -> ImagePromptReverseSupport.validate(task, List.of("vision"), "openai", false));
        assertThrows(BusinessException.class, () -> ImagePromptReverseSupport.validate(task, List.of(), "openai", false));
        assertThrows(BusinessException.class, () -> ImagePromptReverseSupport.validate(task, List.of("vision"), "newapi", false));
        assertThrows(BusinessException.class, () -> ImagePromptReverseSupport.validate(task, List.of("vision"), "openai", true));
        var empty = new AiTaskDtos.CreateAiTaskRequest("text", "rules", "model", Map.of(), List.of(), List.of(), ImagePromptReverseSupport.SOURCE);
        assertThrows(BusinessException.class, () -> ImagePromptReverseSupport.validate(empty, List.of("vision"), "openai", false));
    }

    @Test
    void validatesAndNormalizesStructuredResultWithoutLosingTokenUsage() {
        JSONObject result = new JSONObject();
        result.put("content", "```json\n{\"promptZh\":\"中文提示词\",\"promptEn\":\"English prompt\",\"negativePrompt\":\"blur, noise\",\"style\":\"摄影\"}\n```");
        result.put("tokenUsage", Map.of("inputTokens", 100, "outputTokens", 50));
        ImagePromptReverseSupport.result(request(), result);
        assertEquals("中文提示词", JSON.parseObject(result.getString("content")).getString("promptZh"));
        assertEquals("摄影", result.getJSONObject("reverseImage").getString("style"));
        assertTrue(result.containsKey("tokenUsage"));
    }

    @Test
    void invalidOrUnreadableImageResponsesCannotBecomeSuccessfulPromptResults() {
        for (String content : List.of("无法读取图片", "{}", "{\"promptZh\":\"x\",\"promptEn\":[],\"negativePrompt\":\"blur\"}")) {
            JSONObject result = new JSONObject(); result.put("content", content);
            assertThrows(BusinessException.class, () -> ImagePromptReverseSupport.result(request(), result));
        }
    }

    private static AiTaskDtos.CreateAiTaskRequest request() {
        return new AiTaskDtos.CreateAiTaskRequest("text", "rules", "model", Map.of(),
                List.of(new AiTaskDtos.AiTaskMediaReference("i", "image.png", "image/png", "owned", null)), List.of(), ImagePromptReverseSupport.SOURCE);
    }
}
