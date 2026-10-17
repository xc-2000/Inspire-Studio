package com.inspirestudio.ai;

/**
 * @title        AiTaskTypes.java
 * @description  AI任务类型常量
 * @createTime   2026-06-24 20:35:00
 */
public final class AiTaskTypes {

    /** 文本任务类型 */
    public static final String TEXT = "text";

    /** 图片任务类型 */
    public static final String IMAGE = "image";

    /** 视频任务类型 */
    public static final String VIDEO = "video";

    /** 音频（语音合成）任务类型 */
    public static final String AUDIO = "audio";

    /**
     * 禁止实例化
     */
    private AiTaskTypes() {
    }
}
