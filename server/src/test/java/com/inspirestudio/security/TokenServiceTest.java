package com.inspirestudio.security;

import com.inspirestudio.common.BusinessException;
import com.inspirestudio.config.InspireProperties;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

/**
 * @title        TokenServiceTest.java
 * @description  登录令牌安全策略测试
 * @createTime   2026-07-15 10:00:00
 */
class TokenServiceTest {

    /**
     * 应拒绝不足32字节的HMAC密钥。
     */
    @Test
    void shouldRejectShortSecretKey() {
        InspireProperties properties = new InspireProperties();
        properties.getApp().setSecretKey("short-secret-key");
        TokenService service = new TokenService(properties);

        BusinessException exception = Assertions.assertThrows(BusinessException.class, () -> service.sign(1L, "user", 0));

        Assertions.assertTrue(exception.getMessage().contains("至少需要32字节"));
    }

    /**
     * 应签发并解析使用合规密钥签名的令牌。
     */
    @Test
    void shouldSignAndParseWithStrongSecretKey() {
        InspireProperties properties = new InspireProperties();
        properties.getApp().setSecretKey("a".repeat(32));
        TokenService service = new TokenService(properties);

        TokenService.SignedToken signedToken = service.sign(1L, "user", 0);
        TokenService.TokenClaims claims = service.parse(signedToken.token());

        Assertions.assertEquals(1L, claims.userId());
        Assertions.assertEquals("user", claims.role());
        Assertions.assertEquals(0, claims.tokenVersion());
    }
}
