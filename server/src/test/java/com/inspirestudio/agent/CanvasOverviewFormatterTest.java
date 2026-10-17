package com.inspirestudio.agent;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class CanvasOverviewFormatterTest {

    @Test
    void summarizesExistingShotsWithoutTreatingIdleAsMissingGeneration() {
        Map<String, Object> snapshot = Map.of(
                "nodes", List.of(
                        Map.of("id", "script-1", "kind", "text", "title", "1. 第1章 · 剧本"),
                        Map.of("id", "board-1", "kind", "storyboard", "title", "1. 第1章",
                                "storyboard", Map.of("shots", List.of(Map.of("id", "shot-1"))),
                                "execution", Map.of("phase", "failed", "errorMessage", "部分资产图片生成失败")),
                        Map.of("id", "script-3", "kind", "text", "title", "3. 第3章 · 剧本"),
                        Map.of("id", "board-3", "kind", "storyboard", "title", "3. 第3章",
                                "storyboard", Map.of("shots", List.of(Map.of("id", "shot-3"))),
                                "execution", Map.of("phase", "idle"))),
                "connections", List.of(
                        Map.of("source", Map.of("nodeId", "script-1"), "target", Map.of("nodeId", "board-1")),
                        Map.of("source", Map.of("nodeId", "script-3"), "target", Map.of("nodeId", "board-3"))));

        String answer = CanvasOverviewFormatter.format(snapshot);

        Assertions.assertTrue(answer.contains("4 个节点、2 条连线"));
        Assertions.assertTrue(answer.contains("文本→分镜 2 条"));
        Assertions.assertTrue(answer.contains("已有 2 个分镜节点包含镜头"));
        Assertions.assertTrue(answer.contains("部分资产图片生成失败"));
        Assertions.assertTrue(answer.contains("第 2 章是否有意留空"));
        Assertions.assertTrue(answer.contains("下一步建议"));
        Assertions.assertFalse(answer.contains("未生成的 idle"));
    }

    @Test
    void onlyHandlesTheOverviewShortcut() {
        Assertions.assertTrue(CanvasOverviewFormatter.matches("请梳理当前画布的内容和节点关系，给我下一步创作建议。"));
        Assertions.assertFalse(CanvasOverviewFormatter.matches("请删除当前画布的节点"));
        Assertions.assertTrue(CanvasOverviewFormatter.format(Map.of()).contains("还没有节点"));
    }
}
