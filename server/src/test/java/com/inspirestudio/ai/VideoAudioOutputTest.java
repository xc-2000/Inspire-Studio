package com.inspirestudio.ai;

import com.inspirestudio.dto.AiTaskDtos;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class VideoAudioOutputTest {
    @Test
    void shouldOnlyMuteExplicitOffWithoutReferenceAudio() {
        for (boolean hasReference : List.of(false, true)) for (Object value : List.of(true, false, "false", "true")) {
            var request = new AiTaskDtos.CreateAiTaskRequest(AiTaskTypes.VIDEO, "test", "model", Map.of("generate_audio", value),
                    List.of(), List.of(), "canvas", null, null, "reference-to-video",
                    hasReference ? List.of(new AiTaskDtos.AiTaskMediaReference("ref", "audio", "audio/wav", "key", "https://example.invalid/a.wav")) : List.of());
            Assertions.assertEquals(!hasReference && "false".equals(String.valueOf(value)), VideoAudioOutput.shouldMute(request));
        }
    }
}
