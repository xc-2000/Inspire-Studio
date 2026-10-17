package com.inspirestudio.ai.provider;

import com.inspirestudio.ai.VideoGenerationMode;
import com.inspirestudio.common.BusinessException;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class MuseVideoProviderAdapterTest {

    @Test
    void shouldRequestOnlyTenSecondTargetWithoutSendingUnsupportedDurationEnum() {
        Map<String, Object> payload = MuseVideoProviderAdapter.buildVideoRequestPayload(
                "sora-2", "一只猫在窗边看雨", Map.of("seconds", "10", "size", "1280x720"),
                VideoGenerationMode.TEXT_TO_VIDEO, List.of(), List.of());

        Assertions.assertFalse(payload.containsKey("seconds"));
        Assertions.assertTrue(((String) payload.get("prompt")).startsWith("目标视频时长10秒，请严格控制为10秒。"));
    }

    @Test
    void shouldRejectAnyRequestedDurationOtherThanTenSeconds() {
        for (String seconds : List.of("4", "8", "12", "15")) {
            BusinessException error = Assertions.assertThrows(BusinessException.class,
                    () -> MuseVideoProviderAdapter.buildVideoRequestPayload(
                            "sora-2", "测试", Map.of("seconds", seconds), VideoGenerationMode.TEXT_TO_VIDEO,
                            List.of(), List.of()));
            Assertions.assertEquals("Muse 渠道时长只允许设置为 10 秒", error.getMessage());
        }
    }
}
