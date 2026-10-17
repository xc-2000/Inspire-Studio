package com.inspirestudio.service;

import com.alibaba.fastjson2.JSONObject;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Assertions;

class ImageEditChoiceTest {
    @Test
    void resolvesStoredLabelsAndPreservesQuestionConstraints() {
        var round = new JSONObject();
        round.put("prompt", "换个背景");
        round.put("assistantText", "想把背景换成哪一种？人物、机位和 TikTok UI 保持不变。");
        round.put("choices", List.of(Map.of("value", "bedroom_warm", "label", "温馨卧室（暖光、床头灯）"),
                Map.of("value", "cafe", "label", "咖啡馆")));
        String instruction = PersistenceService.imageEditChoiceInstruction(round, "bedroom_warm");
        Assertions.assertTrue(instruction.contains("温馨卧室（暖光、床头灯）"));
        Assertions.assertTrue(instruction.contains("人物、机位和 TikTok UI 保持不变"));
        Assertions.assertTrue(instruction.startsWith("在原图上"));
        Assertions.assertTrue(PersistenceService.imageEditChoiceInstruction(round, "cafe").contains("咖啡馆"));
        Assertions.assertNull(PersistenceService.imageEditChoiceInstruction(round, "取消"));
        round.put("prompt", "生成一张图片");
        Assertions.assertNull(PersistenceService.imageEditChoiceInstruction(round, "cafe"));
    }

    @Test
    void customBackgroundReplyKeepsEditIntentWithoutReusingCompletedOrUnrelatedRounds() {
        var round = new JSONObject();
        round.put("prompt", "修改背景");
        round.put("assistantText", "想把背景换成什么？主体保持不变。");
        round.put("choices", List.of(Map.of("value", "white", "label", "纯白背景")));
        String instruction = PersistenceService.imageEditChoiceInstruction(round, "白雪覆盖的山脉，晴天蓝天");
        Assertions.assertTrue(instruction.startsWith("在原图上修改背景"));
        Assertions.assertTrue(instruction.contains("白雪覆盖的山脉，晴天蓝天"));
        for (String reply : List.of("修改背景", "取消", "不用了", "好的", "生成一张猫咪图片", "为什么？")) {
            Assertions.assertNull(PersistenceService.imageEditChoiceInstruction(round, reply), reply);
        }
        round.put("results", List.of(Map.of("status", "success")));
        Assertions.assertNull(PersistenceService.imageEditChoiceInstruction(round, "雪山"));
    }

    @Test
    void pendingClarificationRestoresSelectedUploadInsteadOfEarlierGeneratedImage() {
        var earlier = new JSONObject();
        earlier.put("results", List.of(Map.of("status", "success", "image", Map.of("url", "https://example.com/old.png"))));
        var pending = new JSONObject();
        pending.put("prompt", "修改背景");
        pending.put("assistantText", "想把背景换成什么？主体保持不变。");
        pending.put("references", List.of(Map.of("storageKey", "image:selected", "dataUrl", "https://example.com/selected.png")));
        var log = new JSONObject();
        log.put("rounds", List.of(earlier, pending));
        var images = PersistenceService.pendingImageEditReferences(log);
        Assertions.assertEquals(1, images.size());
        Assertions.assertEquals("image:selected", images.getFirst().getString("storageKey"));
        Assertions.assertEquals("https://example.com/selected.png", images.getFirst().getString("url"));
        pending.put("results", List.of(Map.of("status", "success")));
        Assertions.assertTrue(PersistenceService.pendingImageEditReferences(log).isEmpty());
    }
}
