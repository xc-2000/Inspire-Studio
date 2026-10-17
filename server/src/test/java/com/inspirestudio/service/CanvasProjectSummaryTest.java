package com.inspirestudio.service;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class CanvasProjectSummaryTest {
    @Test void largeProjectsHaveBoundedSummariesWithoutPromptsOrEmbeddedMedia() {
        JSONObject project = JSON.parseObject("""
            {"identity":{"id":"one","title":"作品","createdAt":"2026-10-13","updatedAt":"2026-10-13"},
             "scene":{"nodes":[],"connections":[{"id":"edge"}]},"conversation":{},"preferences":{}}
            """);
        JSONArray nodes = project.getJSONObject("scene").getJSONArray("nodes");
        for (int i = 0; i < 40; i++) nodes.add(JSONObject.of("id", "image-"+i, "kind", "image",
            "content", JSONObject.of("source", "data:image/png;base64,"+"a".repeat(100_000), "instruction", "PRIVATE_PROMPT")));
        nodes.add(JSONObject.of("id", "cover", "kind", "image", "content", JSONObject.of("source", "/media/cover.png")));
        project.put("conversation", JSONObject.of("messages", "PRIVATE_CHAT".repeat(100_000)));
        JSONObject result = CanvasProjectSummary.from(project);
        assertEquals(41, result.getIntValue("nodeCount"));
        assertEquals(1, result.getIntValue("connectionCount"));
        assertEquals("/media/cover.png", result.getJSONArray("covers").getJSONObject(0).getString("url"));
        assertTrue(result.toJSONString().length() < 2000);
        assertFalse(result.toJSONString().contains("PRIVATE"));
        assertFalse(result.containsKey("scene"));
        assertFalse(result.containsKey("conversation"));
    }

    @Test void completedFilmRetainsCountsAndCoverWhileEmptyProjectsRemainValid() {
        JSONObject project = JSON.parseObject("""
            {"identity":{"id":"film","title":"影片"},"scene":{"nodes":[
              {"kind":"videoComposition","composition":{"resultVideoNodeId":"video"}},
              {"id":"video","kind":"video","execution":{"phase":"succeeded"},"content":{"source":"/media/film.mp4","storageKey":"video:file"}},
              {"kind":"image","content":{"objectStorage":{"url":"https://example.com/cover.jpg"}}}
            ]}}
            """);
        JSONObject result = CanvasProjectSummary.from(project);
        assertEquals("已成片", result.getJSONObject("media").getString("label"));
        assertEquals(1, result.getJSONObject("media").getIntValue("videos"));
        assertEquals("image", result.getJSONArray("covers").getJSONObject(0).getString("kind"));
        assertEquals(0, CanvasProjectSummary.from(new JSONObject()).getIntValue("nodeCount"));
    }
}
