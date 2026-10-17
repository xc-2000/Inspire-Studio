package com.inspirestudio.ai;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.config.InspireProperties;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.springframework.util.StringUtils;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/**
 * @title        SpeechSynthesisSupport.java
 * @description  OpenAI 兼容 /audio/speech 语音合成：组装请求、校验返回音频、探测时长并转存对象存储。
 *               New API 与 OpenAI 格式渠道共用，避免两处各写一份协议细节。
 */
public final class SpeechSynthesisSupport {

    /** OpenAI 兼容语音合成路径（相对渠道 baseUrl，baseUrl 已含 /v1）。 */
    public static final String SPEECH_PATH = "/audio/speech";
    /** 单次合成文本上限，超过时应由调用方拆句。 */
    public static final int MAXIMUM_INPUT_CHARACTERS = 4000;
    /** 默认音色。 */
    public static final String DEFAULT_VOICE = "eve";
    /** 允许的输出格式；与站内音频媒体（上传、探测、合成）支持的 MP3/WAV 一致。 */
    private static final Set<String> FORMATS = Set.of("mp3", "wav");

    private SpeechSynthesisSupport() {
    }

    /**
     * 组装 /audio/speech 请求体。
     *
     * @param model String 模型名
     * @param text String 要朗读的文本
     * @param parameters Map 任务参数：voice、format、speed、instructions
     * @return Map 请求体
     */
    public static Map<String, Object> buildPayload(String model, String text, Map<String, Object> parameters) {
        String input = text == null ? "" : text.trim();
        if (!StringUtils.hasText(input)) throw new BusinessException(ErrorCode.PARAM_INVALID, "配音文本不能为空");
        if (input.length() > MAXIMUM_INPUT_CHARACTERS) throw new BusinessException(ErrorCode.PARAM_INVALID, "单段配音文本不能超过" + MAXIMUM_INPUT_CHARACTERS + "字");
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("model", model);
        payload.put("input", input);
        payload.put("voice", AiTaskParameterReader.firstNonEmpty(AiTaskParameterReader.stringParameter(parameters, "voice", ""), DEFAULT_VOICE));
        payload.put("response_format", format(parameters));
        double speed = AiTaskParameterReader.floatParameter(parameters, "speed", 1.0);
        if (Double.isFinite(speed) && Math.abs(speed - 1.0) > 0.001) payload.put("speed", Math.max(0.5, Math.min(2.0, speed)));
        String instructions = AiTaskParameterReader.stringParameter(parameters, "instructions", "").trim();
        if (StringUtils.hasText(instructions)) payload.put("instructions", instructions.length() > 1000 ? instructions.substring(0, 1000) : instructions);
        return payload;
    }

    /** 读取并校验输出格式，默认 mp3。 */
    public static String format(Map<String, Object> parameters) {
        String value = AiTaskParameterReader.stringParameter(parameters, "format", "mp3").trim().toLowerCase(Locale.ROOT);
        return FORMATS.contains(value) ? value : "mp3";
    }

    /** 输出格式对应的 MIME 类型。 */
    public static String mimeType(String format) {
        return "wav".equals(format) ? "audio/wav" : "audio/mpeg";
    }

    /**
     * 调用渠道语音合成并把音频保存到全站对象存储。
     *
     * @param context AiTaskExecutionContext 任务上下文
     * @param httpClient AiHttpClient HTTP客户端
     * @param mediaSupport AiMediaSupport 媒体存储
     * @param properties InspireProperties 配置（ffprobe路径）
     * @return Mono<JSONObject> {"item": 媒体}
     */
    public static Mono<JSONObject> execute(AiTaskExecutionContext context, AiHttpClient httpClient, AiMediaSupport mediaSupport, InspireProperties properties) {
        Map<String, Object> payload;
        try {
            payload = buildPayload(context.model(), context.request().prompt(), context.request().parameters());
        } catch (BusinessException exception) {
            return Mono.error(exception);
        }
        String format = String.valueOf(payload.get("response_format"));
        Object body = AiRequestBodySupport.mergeCustomBodyParameters(payload, context.customBodyParameters());
        return context.updateRunningProgress(10)
                .then(httpClient.postJsonForBinary(context.channel(), SPEECH_PATH, body, mimeType(format), "语音合成"))
                .flatMap(binary -> Mono.fromCallable(() -> verifiedAudio(binary, format, properties)).subscribeOn(Schedulers.boundedElastic()))
                .flatMap(audio -> mediaSupport.storeGeneratedMedia(context.task().getUserId(), AiTaskTypes.AUDIO,
                        "generated-speech." + format, audio.binary(), null, null, audio.durationMs()))
                .map(media -> AiJsonUtils.jsonObject(Map.of("item", media)));
    }

    /** 已校验的音频与时长。 */
    record VerifiedAudio(GeneratedBinary binary, int durationMs) {
    }

    /**
     * 部分网关失败时仍返回 200 + JSON 错误，或返回异步任务描述；这类响应不能当作音频保存。
     */
    static VerifiedAudio verifiedAudio(GeneratedBinary binary, String format, InspireProperties properties) {
        byte[] data = binary == null ? null : binary.data();
        if (data == null || data.length == 0) throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "语音合成没有返回音频");
        String contentType = binary.mimeType() == null ? "" : binary.mimeType().toLowerCase(Locale.ROOT);
        if (contentType.contains("json") || contentType.startsWith("text/") || looksLikeJson(data)) {
            String text = new String(data, 0, Math.min(data.length, 2000), StandardCharsets.UTF_8);
            JSONObject json = parseObject(text);
            String message = json == null ? text : AiTaskParameterReader.firstNonEmpty(
                    json.getJSONObject("error") == null ? null : json.getJSONObject("error").getString("message"),
                    json.getString("message"), json.getString("msg"), text);
            throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "语音合成失败：" + message);
        }
        AudioMediaProbe.ProbeResult probe = AudioMediaProbe.probe(data, "speech." + format, properties);
        return new VerifiedAudio(new GeneratedBinary(data, AiTaskParameterReader.firstNonEmpty(probe.mimeType(), mimeType(format))), probe.durationMs());
    }

    private static boolean looksLikeJson(byte[] data) {
        for (byte value : data) {
            if (value == ' ' || value == '\n' || value == '\r' || value == '\t') continue;
            return value == '{' || value == '[';
        }
        return false;
    }

    private static JSONObject parseObject(String text) {
        try {
            Object parsed = JSON.parse(text);
            return parsed instanceof JSONObject object ? object : null;
        } catch (RuntimeException exception) {
            return null;
        }
    }
}
