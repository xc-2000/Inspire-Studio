package com.inspirestudio.ai;

import com.alibaba.fastjson2.JSONObject;
import com.alibaba.fastjson2.JSON;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.dto.AiTaskDtos;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Supplier;
import org.springframework.util.StringUtils;
import reactor.core.publisher.Mono;

/** 图片反推任务的能力与请求约束，不根据模型名称推测视觉能力。 */
public final class ImagePromptReverseSupport {
    public static final String SOURCE = "image-prompt-reverse";
    private static final List<String> FORMATS = List.of("openai", "agnes", "anthropic", "gemini");

    private ImagePromptReverseSupport() {}

    public static boolean isReverseTask(AiTaskDtos.CreateAiTaskRequest request) {
        return SOURCE.equals(request.generationSource());
    }

    public static boolean supports(String taskType, List<String> capabilities, String apiFormat, boolean customModel) {
        String format = StringUtils.hasText(apiFormat) ? apiFormat.trim().toLowerCase(Locale.ROOT) : "openai";
        return AiTaskTypes.TEXT.equals(taskType) && !customModel && capabilities != null
                && capabilities.contains("vision") && FORMATS.contains(format);
    }

    public static void validate(AiTaskDtos.CreateAiTaskRequest request, List<String> capabilities, String apiFormat, boolean customModel) {
        if (!isReverseTask(request)) return;
        if (!supports(request.taskType(), capabilities, apiFormat, customModel)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "图片反推需要已启用图像理解（vision）能力的文本模型，请选择其他模型或联系管理员配置");
        }
        if (request.references() == null || request.references().size() != 1 || request.references().get(0) == null
                || !StringUtils.hasText(request.references().get(0).storageKey())) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "图片反推需要一张已上传的图片，请先上传图片后重试");
        }
    }

    /** 反推必须保留原图和任务指令；其他文本请求保持原有自定义参数行为。 */
    public static Map<String, Object> requestBody(AiTaskExecutionContext context, Map<String, Object> payload) {
        Map<String, Object> merged = AiRequestBodySupport.mergeCustomBodyParameters(payload, context.customBodyParameters());
        if (isReverseTask(context.request())) {
            for (String key : List.of("model", "messages", "contents", "system", "systemInstruction", "stream", "stream_options")) {
                if (payload.containsKey(key)) merged.put(key, payload.get(key));
                else merged.remove(key);
            }
        }
        return merged;
    }

    /** 取图期间发生取消时，不能继续提交新的供应商调用。空结果让既有取消终态保持不变。 */
    public static <T> Mono<T> submit(AiTaskExecutionContext context, Supplier<Mono<T>> invoke) {
        if (!isReverseTask(context.request())) return Mono.defer(invoke);
        return Mono.defer(context::isCancelRequested)
                .filter(cancelled -> !Boolean.TRUE.equals(cancelled))
                .flatMap(ignored -> Mono.defer(invoke));
    }

    /** 供应商无法看图或未遵循输出格式时任务失败，避免把猜测或错误消息当作提示词。 */
    public static JSONObject result(AiTaskDtos.CreateAiTaskRequest request, JSONObject result) {
        if (!isReverseTask(request)) return result;
        try {
            String content = result.getString("content").trim();
            if (content.startsWith("```")) content = content.replaceFirst("^```(?:json)?\\s*", "").replaceFirst("\\s*```$", "").trim();
            JSONObject parsed = JSON.parseObject(content);
            String language = AiTaskParameterReader.stringParameter(request.parameters(), "reverseImageLanguage", "bilingual");
            if (parsed == null || (!"en".equals(language) && !hasString(parsed, "promptZh"))
                    || (!"zh".equals(language) && !hasString(parsed, "promptEn")) || !hasString(parsed, "negativePrompt")) {
                throw new IllegalArgumentException("missing prompt fields");
            }
            JSONObject structured = new JSONObject();
            structured.put("promptZh", "en".equals(language) ? "" : parsed.getString("promptZh").trim());
            structured.put("promptEn", "zh".equals(language) ? "" : parsed.getString("promptEn").trim());
            structured.put("negativePrompt", parsed.getString("negativePrompt").trim());
            if (hasString(parsed, "style")) structured.put("style", parsed.getString("style").trim());
            result.put("content", structured.toJSONString());
            result.put("reverseImage", structured);
            return result;
        } catch (Exception exception) {
            throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "图片反推模型未返回有效提示词，请确认该模型能读取图片后重试");
        }
    }

    private static boolean hasString(JSONObject value, String key) {
        return value.get(key) instanceof String text && StringUtils.hasText(text);
    }
}
