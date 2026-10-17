package com.inspirestudio.ai;

import java.util.Set;

/**
 * AI生成任务来源常量。
 *
 * @date     2026-07-19 16:00
 */
public final class AiTaskSources {

    /** 图片创作页来源 */
    public static final String IMAGE_PAGE = "imagePage";

    /** 视频创作页来源 */
    public static final String VIDEO_PAGE = "videoPage";

    /** 无限画布来源 */
    public static final String CANVAS = "canvas";

    /** 分镜来源 */
    public static final String STORYBOARD = "storyboard";

    /** 独立电商工作台来源。 */
    public static final String ECOMMERCE = "ecommerce";

    /** 支持记录的生成来源 */
    private static final Set<String> SUPPORTED_SOURCES = Set.of(IMAGE_PAGE, VIDEO_PAGE, CANVAS, STORYBOARD, ECOMMERCE);

    /**
     * 禁止实例化。
     */
    private AiTaskSources() {
    }

    /**
     * 判断生成来源是否受支持。
     *
     * @param generationSource String 生成来源
     * @return boolean 是否为受支持的来源
     */
    public static boolean isSupported(String generationSource) {
        return generationSource != null && SUPPORTED_SOURCES.contains(generationSource);
    }
}
