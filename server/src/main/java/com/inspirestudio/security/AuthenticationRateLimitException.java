package com.inspirestudio.security;

import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;

/** Carries the server's remaining wait time to the client. */
public class AuthenticationRateLimitException extends BusinessException {
    private final long retryAfterSeconds;

    public AuthenticationRateLimitException(long retryAfterSeconds, String action) {
        super(ErrorCode.BUSINESS_ERROR, action + "过于频繁，请在 "
                + (retryAfterSeconds < 60 ? retryAfterSeconds + " 秒" : (retryAfterSeconds + 59) / 60 + " 分钟")
                + "后重试");
        this.retryAfterSeconds = Math.max(1, retryAfterSeconds);
    }

    public long getRetryAfterSeconds() { return retryAfterSeconds; }
}
