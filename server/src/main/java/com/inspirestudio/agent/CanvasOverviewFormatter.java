package com.inspirestudio.agent;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Creates a read-only overview for the canvas assistant's overview shortcut. */
final class CanvasOverviewFormatter {

    private static final String OVERVIEW_PROMPT = "请梳理当前画布的内容和节点关系，给我下一步创作建议";
    private static final Pattern CHAPTER_NUMBER = Pattern.compile("^(\\d+)\\s*[.．、]");

    private CanvasOverviewFormatter() {
    }

    static boolean matches(String message) {
        if (message == null) return false;
        return OVERVIEW_PROMPT.equals(message.trim().replaceAll("[。.!！\\s]+$", ""));
    }

    static String format(Map<String, Object> snapshot) {
        List<?> nodes = list(snapshot == null ? null : snapshot.get("nodes"));
        if (nodes.isEmpty()) {
            return "当前画布还没有节点。建议先添加剧本或素材节点，再创建分镜和生成流程。";
        }
        List<?> connections = list(snapshot.get("connections"));
        Map<String, String> kindsById = new LinkedHashMap<>();
        Map<String, Integer> counts = new LinkedHashMap<>();
        List<String> failed = new ArrayList<>();
        Set<Integer> chapters = new LinkedHashSet<>();
        int populatedStoryboards = 0;
        for (Object item : nodes) {
            Map<?, ?> node = map(item);
            if (node.isEmpty()) continue;
            String kind = string(node.get("kind"));
            String title = string(node.get("title"));
            kindsById.put(string(node.get("id")), kind);
            counts.merge(kind, 1, Integer::sum);
            if ("text".equals(kind)) {
                Matcher matcher = CHAPTER_NUMBER.matcher(title);
                if (matcher.find() && matcher.group(1).length() <= 3) {
                    int chapter = Integer.parseInt(matcher.group(1));
                    if (chapter > 0 && chapter <= 500) chapters.add(chapter);
                }
            }
            if ("storyboard".equals(kind) && !list(map(node.get("storyboard")).get("shots")).isEmpty()) {
                populatedStoryboards++;
            }
            Map<?, ?> execution = map(node.get("execution"));
            if ("failed".equals(execution.get("phase"))) {
                String error = string(execution.get("errorMessage"));
                failed.add((title.isBlank() ? "未命名节点" : title)
                        + (error.isBlank() ? "生成失败" : "：" + error));
            }
        }
        Map<String, Integer> relationCounts = new LinkedHashMap<>();
        for (Object item : connections) {
            Map<?, ?> edge = map(item);
            String from = kindsById.get(string(map(edge.get("source")).get("nodeId")));
            String to = kindsById.get(string(map(edge.get("target")).get("nodeId")));
            if (from != null && to != null) {
                relationCounts.merge(label(from) + "→" + label(to), 1, Integer::sum);
            }
        }

        StringBuilder answer = new StringBuilder("当前画布有 ").append(nodes.size()).append(" 个节点、")
                .append(connections.size()).append(" 条连线。节点包括：");
        List<String> kindDetails = new ArrayList<>();
        counts.forEach((kind, count) -> kindDetails.add(label(kind) + " " + count + " 个"));
        answer.append(String.join("、", kindDetails)).append("。");
        if (!relationCounts.isEmpty()) {
            List<String> relations = new ArrayList<>();
            relationCounts.forEach((relation, count) -> relations.add(relation + " " + count + " 条"));
            answer.append("节点关系：").append(String.join("、", relations)).append("。");
        }
        if (counts.getOrDefault("storyboard", 0) > 0) {
            answer.append("已有 ").append(populatedStoryboards).append(" 个分镜节点包含镜头；空闲状态仅表示当前没有任务运行。");
        }
        if (!failed.isEmpty()) {
            answer.append("需要处理的失败节点：").append(String.join("；", failed)).append("。");
        }

        answer.append("\n下一步建议：");
        int step = 1;
        if (!failed.isEmpty()) {
            answer.append("\n").append(step++).append(". 先检查并补齐失败节点的素材，再核对对应分镜画面。");
        }
        if (chapters.size() > 1) {
            int min = chapters.stream().mapToInt(Integer::intValue).min().orElse(1);
            int max = chapters.stream().mapToInt(Integer::intValue).max().orElse(min);
            List<Integer> missing = new ArrayList<>();
            for (int chapter = min; chapter <= max; chapter++) if (!chapters.contains(chapter)) missing.add(chapter);
            if (!missing.isEmpty()) {
                answer.append("\n").append(step++).append(". 核对第 ")
                        .append(missing.toString().replace("[", "").replace("]", ""))
                        .append(" 章是否有意留空；如需连续叙事，补上对应剧本与分镜节点。");
            }
        }
        answer.append("\n").append(step).append(". 逐组检查连线和镜头内容，确认画面与剧本一致后再推进视频制作。");
        return answer.toString();
    }

    private static List<?> list(Object value) {
        return value instanceof List<?> items ? items : List.of();
    }

    private static Map<?, ?> map(Object value) {
        return value instanceof Map<?, ?> items ? items : Map.of();
    }

    private static String string(Object value) {
        return value instanceof String text ? text : "";
    }

    private static String label(String kind) {
        return switch (kind) {
            case "text" -> "文本";
            case "storyboard" -> "分镜";
            case "image" -> "图片";
            case "video" -> "视频";
            case "audio" -> "音频";
            case "background" -> "背景板";
            case "videoComposition" -> "成片";
            default -> kind.isBlank() ? "其他" : kind;
        };
    }
}
