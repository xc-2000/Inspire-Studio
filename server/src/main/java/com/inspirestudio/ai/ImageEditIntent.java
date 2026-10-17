package com.inspirestudio.ai;

import org.springframework.util.StringUtils;

/** Conservative checks for an edit that names a target but gives no replacement. */
public final class ImageEditIntent {
    private ImageEditIntent() {}

    public static boolean needsBackgroundTarget(String message) {
        if (!StringUtils.hasText(message)) return false;
        String text = message.replaceAll("[\\s，。！？!?,、:：]+", "");
        return text.matches("(?i)^(?:(?:请|帮我|给我|麻烦|把|将|在原图上|这张图的|图片的|原图的))*"
                + "(?:(?:修改|更换|替换|换|改|调整)(?:一下|一个|个|下)?(?:背景|背景颜色|背景色)"
                + "|(?:背景|背景颜色|背景色)(?:修改|更换|替换|换|改|调整)(?:一下|一个|个|下)?)"
                + "(?:一下|下|吧)?$")
                || text.matches("(?i)^(?:please)?(?:change|replace|edit)(?:the)?background$");
    }
}
