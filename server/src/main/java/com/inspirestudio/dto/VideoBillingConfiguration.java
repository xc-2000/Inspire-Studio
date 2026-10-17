package com.inspirestudio.dto;

import java.util.Map;
import java.util.List;

/**
 * 视频模型的模式分辨率分档计费配置。
 *
 * @param billingUnit String 计费方式，generation 按次或 second 按秒
 * @param minimumDurationSeconds Integer 最短可生成时长秒数
 * @param modePrices Map<String, Map<String, Integer>> 模式到分辨率单价表
 * @date 2026-08-18 00:00
 */
public record VideoBillingConfiguration(
        String billingUnit,
        Integer minimumDurationSeconds,
        Map<String, Map<String, Integer>> modePrices,
        List<Integer> supportedDurationsSeconds,
        String defaultResolution
) {
    public VideoBillingConfiguration(String billingUnit, Integer minimumDurationSeconds,
                                     Map<String, Map<String, Integer>> modePrices, List<Integer> supportedDurationsSeconds) {
        this(billingUnit, minimumDurationSeconds, modePrices, supportedDurationsSeconds, null);
    }
    /** 兼容未设置时长档位的历史模型。空列表沿用协议默认能力。 */
    public VideoBillingConfiguration(String billingUnit, Integer minimumDurationSeconds,
                                     Map<String, Map<String, Integer>> modePrices) {
        this(billingUnit, minimumDurationSeconds, modePrices, null);
    }
}
