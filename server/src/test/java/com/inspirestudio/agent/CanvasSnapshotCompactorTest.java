package com.inspirestudio.agent;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

/**
 * 画布快照裁剪器测试。
 *
 * @date     2026-09-15 23:00
 */
class CanvasSnapshotCompactorTest {

    /**
     * 验证图片节点保留生成所需字段并移除大型媒体字段。
     */
    @Test
    void shouldCompactImageNodeAndPreserveResolution() {
        CanvasSnapshotCompactor compactor = new CanvasSnapshotCompactor();
        Map<String, Object> imageNode = Map.of(
                "id", "image-1",
                "kind", "image",
                "title", "测试图片",
                "frame", Map.of("position", Map.of("x", 10, "y", 20), "width", 320, "height", 240),
                "execution", Map.of("phase", "succeeded", "taskId", "task-1"),
                "content", Map.of("source", "data:image/png;base64,large-content", "mimeType", "image/png"),
                "generation", Map.of(
                        "prompt", "一只站在雪山上的白色狐狸",
                        "model", "image-model",
                        "size", "16:9",
                        "quality", "high",
                        "resolution", "2K",
                        "count", 1,
                        "references", List.of("data:image/png;base64,reference")));

        Map<String, Object> compacted = compactor.compact(Map.of(
                "projectId", "project-1",
                "nodes", List.of(imageNode),
                "connections", List.of(),
                "selectedNodeIds", List.of("image-1")));

        Map<String, Object> compactedNode = firstNode(compacted);
        Map<String, Object> compactedContent = objectMap(compactedNode.get("content"));
        Map<String, Object> compactedGeneration = objectMap(compactedNode.get("generation"));
        Assertions.assertEquals("image/png", compactedContent.get("mimeType"));
        Assertions.assertFalse(compactedContent.containsKey("source"));
        Assertions.assertEquals("2K", compactedGeneration.get("resolution"));
        Assertions.assertEquals(1, compactedGeneration.get("referenceCount"));
        Assertions.assertFalse(compactedGeneration.containsKey("references"));
    }

    /**
     * 验证空画布快照返回空结果。
     */
    @Test
    void shouldReturnEmptyMapForEmptySnapshot() {
        CanvasSnapshotCompactor compactor = new CanvasSnapshotCompactor();

        Assertions.assertTrue(compactor.compact(null).isEmpty());
        Assertions.assertTrue(compactor.compact(Map.of()).isEmpty());
    }

    @Test
    void shouldIncludeSelectedUpstreamContentWithinBudgetAndReportStaleSelection() {
        var compactor = new CanvasSnapshotCompactor();
        String script = "真实剧本".repeat(200);
        var upstream = Map.of("id", "script", "kind", "text", "content", Map.of("text", script));
        var selected = Map.of("id", "video", "kind", "video", "execution",
                Map.of("phase", "failed", "taskId", "task-1", "errorMessage", "模型返回错误"));
        var other = Map.of("id", "other", "kind", "text", "content", Map.of("text", script));
        var result = compactor.compact(Map.of("nodes", List.of(upstream, selected, other),
                "selectedNodeIds", List.of("video", "deleted"), "connections", List.of(
                        Map.of("source", Map.of("nodeId", "script"), "target", Map.of("nodeId", "video")),
                        Map.of("source", Map.of("nodeId", "other"), "target", Map.of("nodeId", "deleted")))));
        var focus = objectMap(result.get("contextFocus"));
        Assertions.assertEquals(List.of("video", "script"), focus.get("detailedNodeIds"));
        Assertions.assertEquals(List.of("deleted"), focus.get("missingSelectedNodeIds"));
        var nodes = (List<?>) result.get("nodes");
        Assertions.assertEquals(script, objectMap(objectMap(nodes.get(0)).get("content")).get("text"));
        Assertions.assertNotEquals(script, objectMap(objectMap(nodes.get(2)).get("content")).get("text"));
        Assertions.assertEquals("模型返回错误", objectMap(objectMap(nodes.get(1)).get("execution")).get("errorMessage"));
    }

    @Test
    void shouldPrioritizeSelectionOrderOverGraphOrderAndBoundDetailedNodes() {
        var nodes = new java.util.ArrayList<Map<String, Object>>();
        for (int i = 0; i < 6; i++) nodes.add(Map.of("id", "n" + i, "kind", "text", "content", Map.of("text", "文".repeat(1000))));
        var result = new CanvasSnapshotCompactor().compact(Map.of("nodes", nodes,
                "selectedNodeIds", List.of("n5", "n4", "n3", "n2", "n1")));
        Assertions.assertEquals(List.of("n5", "n4", "n3", "n2"), objectMap(result.get("contextFocus")).get("detailedNodeIds"));
    }

    @Test
    void shouldKeepSelectedNodeFactsWithoutExpandingEveryNode() {
        CanvasSnapshotCompactor compactor = new CanvasSnapshotCompactor();
        String text = "剧".repeat(600);
        Map<String, Object> selectedText = Map.of("id", "text-1", "kind", "text", "title", "剧本", "content", Map.of("text", text));
        Map<String, Object> otherText = Map.of("id", "text-2", "kind", "text", "title", "其他", "content", Map.of("text", text));
        Map<String, Object> shot = Map.of("id", "shot-1", "shotNumber", 1, "visualDescription", "主角走入雨中的街道");
        Map<String, Object> selectedStoryboard = Map.of("id", "board-1", "kind", "storyboard", "title", "分镜", "storyboard", Map.of("shots", List.of(shot)));
        Map<String, Object> otherStoryboard = Map.of("id", "board-2", "kind", "storyboard", "title", "其他分镜", "storyboard", Map.of("shots", List.of(shot)));

        Map<String, Object> compacted = compactor.compact(Map.of(
                "nodes", List.of(selectedText, otherText, selectedStoryboard, otherStoryboard),
                "selectedNodeIds", List.of("text-1", "board-1")));
        List<?> nodes = (List<?>) compacted.get("nodes");
        Assertions.assertEquals(text, objectMap(objectMap(nodes.get(0)).get("content")).get("text"));
        Assertions.assertTrue(((String) objectMap(objectMap(nodes.get(1)).get("content")).get("text")).length() < text.length());

        List<?> selectedShots = (List<?>) objectMap(objectMap(nodes.get(2)).get("storyboard")).get("shots");
        List<?> otherShots = (List<?>) objectMap(objectMap(nodes.get(3)).get("storyboard")).get("shots");
        Assertions.assertEquals("主角走入雨中的街道", objectMap(selectedShots.getFirst()).get("visualDescription"));
        Assertions.assertFalse(objectMap(otherShots.getFirst()).containsKey("visualDescription"));
    }

    /**
     * 读取裁剪结果中的首个节点。
     *
     * @param compacted Map<String, Object> 裁剪后的画布快照
     * @return Map<String, Object> 首个节点
     */
    private Map<String, Object> firstNode(Map<String, Object> compacted) {
        List<?> nodes = (List<?>) compacted.get("nodes");
        return objectMap(nodes.getFirst());
    }

    /**
     * 将测试对象转换为字符串键映射。
     *
     * @param value Object 待转换对象
     * @return Map<String, Object> 字符串键映射
     */
    @SuppressWarnings("unchecked")
    private Map<String, Object> objectMap(Object value) {
        return (Map<String, Object>) value;
    }
}
