package com.inspirestudio.service;

import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** A library entry never contains prompts, conversations, node bodies or embedded media. */
public final class CanvasProjectSummary {
    private CanvasProjectSummary() {}

    public static JSONObject from(JSONObject project) {
        JSONObject identity = object(project, "identity");
        JSONObject scene = object(project, "scene");
        JSONArray nodes = array(scene, "nodes");
        Set<String> images = new LinkedHashSet<>(), videos = new LinkedHashSet<>();
        Map<String, JSONObject> imageCovers = new LinkedHashMap<>(), videoCovers = new LinkedHashMap<>();
        addCover(imageCovers, "image", object(object(project, "preferences"), "drama").getString("cover"), null);
        boolean videoProject = false, completed = false;
        for (int i = 0; i < nodes.size(); i++) {
            JSONObject node = nodes.getJSONObject(i);
            if (node == null) continue;
            String kind = node.getString("kind");
            if ("image".equals(kind) || "video".equals(kind)) {
                JSONObject content = object(node, "content");
                String url = mediaUrl(content);
                if (!url.isEmpty()) ("image".equals(kind) ? images : videos).add(url);
                addCover("image".equals(kind) ? imageCovers : videoCovers, kind, url, content.getString("storageKey"));
            }
            if ("video".equals(kind) || "videoComposition".equals(kind) || "storyboard".equals(kind)) videoProject = true;
            if ("videoComposition".equals(kind)) {
                String resultId = object(node, "composition").getString("resultVideoNodeId");
                for (int j = 0; resultId != null && j < nodes.size(); j++) {
                    JSONObject result = nodes.getJSONObject(j);
                    if (result != null && resultId.equals(result.getString("id")) && "video".equals(result.getString("kind"))
                        && "succeeded".equals(object(result, "execution").getString("phase")) && !mediaUrl(object(result, "content")).isEmpty()) completed = true;
                }
            }
            if ("storyboard".equals(kind)) {
                JSONArray shots = array(object(node, "storyboard"), "shots");
                for (int j = 0; j < shots.size(); j++) {
                    JSONObject shot = shots.getJSONObject(j);
                    if (shot == null) continue;
                    String image = mediaUrl(object(shot, "image")), video = mediaUrl(object(shot, "video"));
                    if (!image.isEmpty()) images.add(image);
                    if (!video.isEmpty()) videos.add(video);
                    addCover(imageCovers, "image", object(shot, "video").getString("poster"), null);
                    addCover(imageCovers, "image", image, null);
                    addCover(videoCovers, "video", video, object(shot, "video").getString("storageKey"));
                }
            }
        }
        List<JSONObject> covers = new ArrayList<>(imageCovers.values());
        covers.addAll(videoCovers.values());
        String label = completed ? "已成片" : videoProject ? "视频创作" : !images.isEmpty() ? "图像创作" : !nodes.isEmpty() ? "创作中" : "新项目";
        return JSONObject.of("identity", JSONObject.of("id", identity.getString("id"), "title", identity.getString("title"),
            "createdAt", identity.getString("createdAt"), "updatedAt", identity.getString("updatedAt")),
            "nodeCount", nodes.size(), "connectionCount", array(scene, "connections").size(),
            "media", JSONObject.of("images", images.size(), "videos", videos.size(), "label", label),
            "covers", covers.stream().limit(3).toList());
    }

    private static void addCover(Map<String, JSONObject> covers, String kind, String url, String storageKey) {
        // Data URLs can contain megabytes. Keep those only in the full project detail.
        if (covers.size() >= 3 || url == null || url.length() > 2048 || !(url.startsWith("https://") || url.startsWith("http://") || (url.startsWith("/") && !url.startsWith("//")))) return;
        JSONObject cover = JSONObject.of("kind", kind, "url", url);
        if (storageKey != null && storageKey.length() < 256) cover.put("storageKey", storageKey);
        covers.putIfAbsent(url, cover);
    }
    private static String mediaUrl(JSONObject content) {
        String stored = object(content, "objectStorage").getString("url");
        String source = content.getString("source");
        return stored != null && !stored.isBlank() ? stored : source != null && !source.startsWith("blob:") ? source : "";
    }
    private static JSONObject object(JSONObject object, String key) {
        return object.get(key) instanceof JSONObject value ? value : new JSONObject();
    }
    private static JSONArray array(JSONObject object, String key) {
        return object.get(key) instanceof JSONArray value ? value : new JSONArray();
    }
}
