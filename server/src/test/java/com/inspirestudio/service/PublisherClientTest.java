package com.inspirestudio.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import com.alibaba.fastjson2.JSON;
import org.junit.jupiter.api.Test;

class PublisherClientTest {
    @Test
    void unwrapsFastApiAndNestedErrors() {
        assertEquals("登录已过期", PublisherClient.safeMessage("{\"detail\":\"登录已过期\"}"));
        assertEquals("请重试", PublisherClient.safeMessage("{\"error\":{\"message\":\"请重试\"}}"));
        assertEquals("登录已过期", PublisherClient.safeMessage(JSON.toJSONString("{\"detail\":\"登录已过期\"}")));
    }

    @Test
    void keepsPlainMessagesAndHidesValidationPayloads() {
        assertEquals("视频号登录态可用", PublisherClient.safeMessage("视频号登录态可用"));
        assertEquals("内容发布服务调用失败，请稍后重试", PublisherClient.safeMessage("{\"detail\":[{\"input\":\"secret\"}]}"));
        assertEquals(500, PublisherClient.safeMessage("长".repeat(600)).length());
    }
}
