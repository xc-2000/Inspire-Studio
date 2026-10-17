package com.inspirestudio.agent.dto;

import com.inspirestudio.ai.AiErrorDetails;

/**
 * 画布生成节点的结构化失败详情。
 *
 * @param nodeId String 失败节点编号
 * @param error AiErrorDetails 节点错误详情
 * @date     2026-08-01 00:00
 */
public record RecoveryNodeFailure(
        String nodeId,
        AiErrorDetails error
) {
}
