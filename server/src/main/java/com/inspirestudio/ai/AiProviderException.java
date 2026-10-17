package com.inspirestudio.ai;

import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;

/**
 * 携带供应商结构化错误详情的业务异常。
 *
 * @date     2026-08-01 00:00
 */
public class AiProviderException extends BusinessException {

    /** 结构化错误详情 */
    private final AiErrorDetails details;

    private final boolean terminalTaskFailure;

    /**
     * 创建AI供应商异常。
     *
     * @param details AiErrorDetails 结构化错误详情
     */
    public AiProviderException(AiErrorDetails details) {
        this(details, false);
    }

    public AiProviderException(AiErrorDetails details, boolean terminalTaskFailure) {
        super(ErrorCode.THIRD_PARTY_CALL_ERROR, details.message());
        this.details = details;
        this.terminalTaskFailure = terminalTaskFailure;
    }

    public boolean isTerminalTaskFailure() { return terminalTaskFailure; }

    /**
     * 获取结构化错误详情。
     *
     * @return AiErrorDetails 错误详情
     */
    public AiErrorDetails getDetails() {
        return details;
    }
}
