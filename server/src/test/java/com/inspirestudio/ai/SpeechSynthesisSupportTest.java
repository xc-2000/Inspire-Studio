package com.inspirestudio.ai;

import com.inspirestudio.ai.provider.NewApiProviderAdapter;
import com.inspirestudio.ai.provider.OpenAiProviderAdapter;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.config.InspireProperties;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class SpeechSynthesisSupportTest {
    @Test void mapsSpeechInputWithoutReadingInstructionsAsDialogue() {
        var payload = SpeechSynthesisSupport.buildPayload("grok-voice-latest", "  你好，世界。  ",
                Map.of("voice", "rex", "format", "mp3", "instructions", "温暖自然", "speed", 1.2));
        assertEquals("你好，世界。", payload.get("input"));
        assertEquals("grok-voice-latest", payload.get("model"));
        assertEquals("rex", payload.get("voice"));
        assertEquals("温暖自然", payload.get("instructions"));
        assertEquals("mp3", payload.get("response_format"));
        assertFalse(payload.containsKey("prompt"));
        assertEquals(1.2, ((Number) payload.get("speed")).doubleValue(), 0.001);
    }

    @Test void usesSupportedDefaultsAndLimitsOptionalParameters() {
        var defaults = SpeechSynthesisSupport.buildPayload("grok-voice-latest", "Hello", null);
        assertEquals("eve", defaults.get("voice"));
        assertEquals("mp3", defaults.get("response_format"));
        assertFalse(defaults.containsKey("speed"));
        var payload = SpeechSynthesisSupport.buildPayload("model", "Hello",
                Map.of("format", "opus", "speed", 100, "instructions", "x".repeat(1500)));
        assertEquals("mp3", payload.get("response_format"));
        assertEquals(2.0, payload.get("speed"));
        assertEquals(1000, ((String) payload.get("instructions")).length());
        assertEquals("wav", SpeechSynthesisSupport.format(Map.of("format", "WAV")));
    }

    @Test void rejectsEmptyAndOversizedSpeech() {
        assertThrows(BusinessException.class, () -> SpeechSynthesisSupport.buildPayload("m", "  ", Map.of()));
        assertThrows(BusinessException.class, () -> SpeechSynthesisSupport.buildPayload("m", "x".repeat(4001), Map.of()));
    }

    @Test void rejectsJsonAndTextErrorsEvenWhenGatewayReturnsSuccess() {
        for (String mime : new String[] { "audio/mpeg", "application/json", "application/octet-stream" }) {
            var binary = new GeneratedBinary("  {\"error\":{\"message\":\"voice unavailable\"}}".getBytes(StandardCharsets.UTF_8), mime);
            assertTrue(assertThrows(BusinessException.class, () -> SpeechSynthesisSupport.verifiedAudio(binary, "mp3", null)).getMessage().contains("voice unavailable"));
        }
        assertThrows(BusinessException.class, () -> SpeechSynthesisSupport.verifiedAudio(new GeneratedBinary(new byte[0], "audio/mpeg"), "mp3", null));
        assertThrows(BusinessException.class, () -> SpeechSynthesisSupport.verifiedAudio(new GeneratedBinary("upstream failed".getBytes(StandardCharsets.UTF_8), "text/plain"), "mp3", null));
    }

    @Test void gatewaySupportsSpeechTasks() {
        assertTrue(new NewApiProviderAdapter(null, null, new InspireProperties()).supports(AiTaskTypes.AUDIO));
    }
}
