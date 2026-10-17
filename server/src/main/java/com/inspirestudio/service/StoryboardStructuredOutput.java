package com.inspirestudio.service;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.dto.StoryboardDtos;
import io.agentscope.core.message.Msg;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Set;

/** Reads a complete storyboard response from native metadata or compatible providers' JSON text. */
final class StoryboardStructuredOutput {
    private static final int MAX_RESPONSE_CHARS = 2_000_000;
    private static final ObjectMapper MAPPER = new ObjectMapper()
            .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);

    private StoryboardStructuredOutput() {}

    static <T> T parse(Msg message, Class<T> resultType) {
        if (message == null) throw invalid();
        try {
            Object metadata = message.getMetadata() == null ? null : message.getMetadata().get("_structured_output");
            if (metadata != null) {
                JsonNode root = MAPPER.valueToTree(metadata);
                validate(root, resultType);
                return MAPPER.treeToValue(root, resultType);
            }
            T structured = message.getStructuredData(resultType);
            if (structured != null) {
                validate(MAPPER.valueToTree(structured), resultType);
                return structured;
            }
        } catch (Exception ignored) {
            // Some OpenAI-compatible channels return the requested object as plain text.
            // Only a complete, independently validated object can recover the result.
        }
        try {
            String text = message.getTextContent();
            JsonNode root = MAPPER.readTree(extractObject(text));
            validate(root, resultType);
            return MAPPER.treeToValue(root, resultType);
        } catch (Exception ignored) {
            // Do not expose provider output, prompt text, or parser internals to the browser.
            throw invalid();
        }
    }

    private static String extractObject(String text) {
        if (text == null || text.isBlank() || text.length() > MAX_RESPONSE_CHARS) throw invalid();
        String value = text.strip();
        int start = value.indexOf('{');
        if (start < 0) throw invalid();
        Deque<Character> brackets = new ArrayDeque<>();
        boolean quoted = false;
        boolean escaped = false;
        int end = -1;
        for (int index = start; index < value.length(); index++) {
            char character = value.charAt(index);
            if (quoted) {
                if (escaped) escaped = false;
                else if (character == '\\') escaped = true;
                else if (character == '"') quoted = false;
                continue;
            }
            if (character == '"') quoted = true;
            else if (character == '{' || character == '[') brackets.push(character);
            else if (character == '}' || character == ']') {
                if (brackets.isEmpty() || brackets.pop() != (character == '}' ? '{' : '[')) throw invalid();
                if (brackets.isEmpty()) { end = index + 1; break; }
            }
        }
        if (end < 0 || quoted) throw invalid();
        String before = value.substring(0, start);
        String after = value.substring(end);
        boolean openingFence = before.matches("(?is).*```(?:json)?\\s*$");
        boolean closingFence = after.matches("(?s)^\\s*```.*");
        if (openingFence != closingFence) throw invalid();
        String prefix = before.replaceFirst("(?is)```(?:json)?\\s*$", "");
        String suffix = after.replaceFirst("(?s)^\\s*```", "");
        // A second JSON value, array envelope, or broken fence is ambiguous, never a fallback.
        if (containsJsonBoundary(prefix) || containsJsonBoundary(suffix)
                || prefix.contains("```") || suffix.contains("```")
                || isJsonPrimitive(prefix) || isJsonPrimitive(suffix)) throw invalid();
        return value.substring(start, end);
    }

    private static boolean isJsonPrimitive(String value) {
        if (value.isBlank()) return false;
        try {
            JsonNode parsed = MAPPER.readTree(value.strip());
            return parsed != null && parsed.isValueNode();
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean containsJsonBoundary(String value) {
        return value.chars().anyMatch(character -> character == '{' || character == '}'
                || character == '[' || character == ']');
    }

    private static void validate(JsonNode root, Class<?> type) {
        object(root);
        if (type == StoryboardDtos.GeneratedStoryboardResult.class) {
            array(root, "shots", true);
            if (root.hasNonNull("assets")) array(root, "assets", false);
            for (JsonNode shot : root.get("shots")) {
                object(shot);
                positive(shot, "shotNumber");
                positive(shot, "durationSeconds");
                text(shot, "visualDescription");
                if (shot.hasNonNull("assetReferenceKeys")) strings(shot, "assetReferenceKeys");
                optionalStrings(shot, "shotSize", "lightingAtmosphere", "dialogueVoiceover", "soundEffect", "cameraMovement");
                JsonNode continuity = shot.get("continuity");
                if (continuity != null && !continuity.isNull()) {
                    object(continuity);
                    optionalStrings(continuity, "sceneId", "time", "transition", "openingState", "closingState", "storyBeat");
                }
            }
            if (root.hasNonNull("assets")) for (JsonNode asset : root.get("assets")) asset(asset, false);
        } else if (type == StoryboardDtos.AssetCoverageResult.class) {
            array(root, "additions", false);
            array(root, "shots", false);
            if (!root.path("narrativeComplete").isBoolean()) throw invalid();
            strings(root, "narrativeIssues");
            for (JsonNode asset : root.get("additions")) asset(asset, true);
            for (JsonNode shot : root.get("shots")) {
                object(shot); index(shot); strings(shot, "assetReferenceKeys");
            }
        } else if (type == StoryboardDtos.StoryboardFieldCorrections.class) {
            array(root, "assets", false);
            array(root, "shots", false);
            for (JsonNode asset : root.get("assets")) {
                object(asset); index(asset); text(asset, "kind");
                if (!Set.of("character", "scene", "prop").contains(asset.get("kind").textValue())) throw invalid();
            }
            for (JsonNode shot : root.get("shots")) {
                object(shot); index(shot); text(shot, "shotSize");
                if (shot.hasNonNull("assetReferenceKeys")) strings(shot, "assetReferenceKeys");
            }
        } else if (type == StoryboardDtos.PromptContentResult.class
                || type == StoryboardDtos.PromptCompositionResult.class) {
            array(root, "prompts", true);
            for (JsonNode prompt : root.get("prompts")) {
                object(prompt); text(prompt, "shotId");
                text(prompt, type == StoryboardDtos.PromptContentResult.class ? "visualDescription" : "finalPrompt");
                optionalStrings(prompt, "openingState", "closingState", "transitionFromPrevious");
            }
        } else throw invalid();
    }

    private static void asset(JsonNode asset, boolean enumKind) {
        object(asset); text(asset, "referenceKey"); text(asset, "name");
        optionalStrings(asset, "kind", "description");
        if (enumKind) text(asset, "kind");
        if (enumKind && !Set.of("character", "scene", "prop").contains(asset.get("kind").textValue())) throw invalid();
    }

    private static void object(JsonNode node) { if (node == null || !node.isObject()) throw invalid(); }
    private static void text(JsonNode parent, String key) {
        JsonNode node = parent.path(key);
        if (!node.isTextual() || node.textValue().isBlank()) throw invalid();
    }
    private static void optionalStrings(JsonNode parent, String... keys) {
        for (String key : keys) if (parent.hasNonNull(key) && !parent.get(key).isTextual()) throw invalid();
    }
    private static void array(JsonNode parent, String key, boolean nonEmpty) {
        JsonNode node = parent.path(key);
        if (!node.isArray() || (nonEmpty && node.isEmpty())) throw invalid();
    }
    private static void strings(JsonNode parent, String key) {
        array(parent, key, false);
        for (JsonNode entry : parent.get(key)) if (!entry.isTextual()) throw invalid();
    }
    private static void positive(JsonNode parent, String key) {
        JsonNode node = parent.path(key);
        if (!node.isIntegralNumber() || !node.canConvertToInt() || node.intValue() <= 0) throw invalid();
    }
    private static void index(JsonNode parent) {
        JsonNode node = parent.path("index");
        if (!node.isIntegralNumber() || !node.canConvertToInt() || node.intValue() < 0) throw invalid();
    }
    private static BusinessException invalid() {
        return new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR,
                "分镜模型未返回完整有效的结构化结果，原分镜保持不变。请重试本章或切换文本模型");
    }
}
