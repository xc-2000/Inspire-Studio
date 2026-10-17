package com.inspirestudio.agent.dto;

/**
 * 统一主Agent对话提交结果。
 *
 * @param sessionId String Agent会话ID
 * @param requestId String 本次主Agent请求ID
 * @param status String 请求当前状态
 * @date     2026-08-13 00:00
 */
public record CreationAgentChatResponse(String sessionId, String requestId, String status) {
}
