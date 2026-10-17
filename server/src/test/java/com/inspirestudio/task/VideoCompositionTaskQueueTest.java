package com.inspirestudio.task;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

/**
 * 视频合成任务队列键测试。
 *
 * @date     2026-08-11 00:00
 */
class VideoCompositionTaskQueueTest {

    /**
     * 全站合成队列的等待、去重、活动和并发键应固定在同一Redis哈希槽。
     */
    @Test
    void shouldBuildGlobalVideoCompositionQueueKeys() {
        Assertions.assertEquals("Inspire:video-composition:queue:{global}:pending", VideoCompositionTaskQueue.pendingQueueKey());
        Assertions.assertEquals("Inspire:video-composition:queue:{global}:queued", VideoCompositionTaskQueue.queuedTaskKey());
        Assertions.assertEquals("Inspire:video-composition:queue:{global}:active", VideoCompositionTaskQueue.activeTaskKey());
        Assertions.assertEquals("Inspire:video-composition:queue:{global}:concurrency", VideoCompositionTaskQueue.concurrencyKey());
    }
}
