package com.inspirestudio.ai;

import com.alibaba.fastjson2.JSONObject;

/** Normalizes provider counters without estimating missing usage from characters. */
public final class TextTokenUsage {
    private TextTokenUsage() {}
    public static JSONObject openAi(JSONObject response) {
        JSONObject u = response.getJSONObject("usage");
        return counters(u, "prompt_tokens", "completion_tokens", false);
    }
    public static JSONObject gemini(JSONObject response) {
        JSONObject u = response.getJSONObject("usageMetadata");
        JSONObject result = counters(u, "promptTokenCount", "candidatesTokenCount", false);
        if (u != null && result.getLongValue("outputTokens", -1) >= 0)
            result.put("outputTokens", Math.addExact(result.getLongValue("outputTokens"), u.getLongValue("thoughtsTokenCount", 0)));
        return result;
    }
    public static JSONObject anthropic(JSONObject usage) {
        return counters(usage, "input_tokens", "output_tokens", true);
    }
    private static JSONObject counters(JSONObject u, String inputKey, String outputKey, boolean cacheSeparate) {
        long input = u == null ? -1 : u.getLongValue(inputKey, -1);
        long output = u == null ? -1 : u.getLongValue(outputKey, -1);
        // Anthropic reports uncached input separately; our disclosed baseline charges total input.
        if (input >= 0 && cacheSeparate) input = Math.addExact(input,
                Math.addExact(u.getLongValue("cache_read_input_tokens", 0), u.getLongValue("cache_creation_input_tokens", 0)));
        JSONObject result = new JSONObject();
        result.put("inputTokens", input); result.put("outputTokens", output);
        return result;
    }
    public static JSONObject result(String content, JSONObject usage) {
        JSONObject result = new JSONObject(); result.put("content", content); result.put("tokenUsage", usage); return result;
    }
}
