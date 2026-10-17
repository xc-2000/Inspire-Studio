package com.inspirestudio.security;

import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.function.Supplier;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

/**
 * @title        AuthenticationRateLimitService.java
 * @description  认证接口分布式限流服务
 * @createTime   2026-07-15 10:00:00
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class AuthenticationRateLimitService {

    /** 限流键前缀 */
    private static final String KEY_PREFIX = "Inspire:security:rate-limit:";

    /** 登录来源地址窗口时长 */
    private static final Duration LOGIN_ADDRESS_WINDOW = Duration.ofMinutes(15);

    /** 邮箱验证码邮箱窗口时长 */
    private static final Duration EMAIL_CODE_EMAIL_WINDOW = Duration.ofHours(1);

    /** 邮箱验证码来源地址窗口时长 */
    private static final Duration EMAIL_CODE_ADDRESS_WINDOW = Duration.ofHours(1);

    /** 登录来源地址最大请求数 */
    private static final long LOGIN_ADDRESS_MAX_REQUESTS = 20;

    /** 邮箱验证码邮箱最大请求数 */
    private static final long EMAIL_CODE_EMAIL_MAX_REQUESTS = 3;

    /** 邮箱验证码来源地址最大请求数 */
    private static final long EMAIL_CODE_ADDRESS_MAX_REQUESTS = 10;

    /** 拒绝请求不增加计数，也不延长固定窗口。 */
    private static final RedisScript<Long> FIXED_WINDOW_SCRIPT = RedisScript.of("""
            local count = tonumber(redis.call('get', KEYS[1]) or '0')
            local ttl = redis.call('ttl', KEYS[1])
            if count > 0 and ttl < 0 then
                redis.call('expire', KEYS[1], ARGV[1])
                ttl = tonumber(ARGV[1])
            end
            if count >= tonumber(ARGV[2]) then return -math.max(1, ttl) end
            local count = redis.call('incr', KEYS[1])
            if count == 1 then
                redis.call('expire', KEYS[1], ARGV[1])
            end
            return count
            """, Long.class);

    /** 一次性检查所有维度，再预留名额，避免邮箱被拦截后继续消耗 IP 配额。 */
    static final RedisScript<Long> EMAIL_CODE_SCRIPT = RedisScript.of("""
            local wait = 0
            if redis.call('exists', KEYS[1]) == 1 then wait = math.max(1, redis.call('ttl', KEYS[1])) end
            for i = 2, 3 do
                local count = tonumber(redis.call('get', KEYS[i]) or '0')
                local ttl = redis.call('ttl', KEYS[i])
                if count > 0 and ttl < 0 then
                    redis.call('expire', KEYS[i], 3600)
                    ttl = 3600
                end
                if count >= tonumber(ARGV[i]) then wait = math.max(wait, math.max(1, ttl)) end
            end
            if wait > 0 then return -wait end
            redis.call('set', KEYS[1], ARGV[1], 'EX', 60)
            for i = 2, 3 do
                local count = redis.call('incr', KEYS[i])
                if count == 1 then redis.call('expire', KEYS[i], 3600) end
            end
            return 1
            """, Long.class);

    /** 发送失败释放邮箱名额；IP 请求配额仍保留，避免持续无效请求。 */
    static final RedisScript<Long> RELEASE_EMAIL_CODE_SCRIPT = RedisScript.of("""
            if redis.call('get', KEYS[1]) == ARGV[1] then
                redis.call('del', KEYS[1])
                local count = tonumber(redis.call('get', KEYS[2]) or '0')
                if count > 0 then redis.call('decr', KEYS[2]) end
                return 1
            end
            return 0
            """, Long.class);

    /** Redis模板 */
    private final ReactiveStringRedisTemplate redisTemplate;

    private final ClientAddressResolver clientAddressResolver;

    /**
     * 校验邮箱密码登录请求频率。
     *
     * @param request ServerHttpRequest HTTP请求
     * @return Mono<Void> 限流通过时完成信号
     */
    public Mono<Void> checkLogin(ServerHttpRequest request) {
        String sourceAddress = clientAddressResolver.resolve(request);
        return checkLimit("login:address", sourceAddress, LOGIN_ADDRESS_MAX_REQUESTS, LOGIN_ADDRESS_WINDOW);
    }

    /**
     * 校验发送邮箱验证码请求频率。
     *
     * @param request ServerHttpRequest HTTP请求
     * @param email String 接收验证码的邮箱
     * @return Mono<Void> 限流通过时完成信号
     */
    public Mono<Void> sendEmailCode(ServerHttpRequest request, String email, Supplier<Mono<Void>> send) {
        return Mono.defer(() -> {
            String normalizedEmail = normalizeEmail(email);
            List<String> keys = List.of(
                    buildRateLimitKey("email-code:cooldown", normalizedEmail),
                    buildRateLimitKey("email-code:email", normalizedEmail),
                    buildRateLimitKey("email-code:address", clientAddressResolver.resolve(request)));
            String reservation = UUID.randomUUID().toString();
            // 每邮箱 60 秒一次、每小时 10 次；每 IP 每小时 30 次。
            return executeLimit(EMAIL_CODE_SCRIPT, keys, List.of(reservation, "10", "30"), "验证码发送")
                    .then(Mono.defer(send).onErrorResume(error ->
                            redisTemplate.execute(RELEASE_EMAIL_CODE_SCRIPT, keys, List.of(reservation))
                                    .then()
                                    .onErrorResume(releaseError -> {
                                        log.warn("释放验证码发送名额失败", releaseError);
                                        return Mono.empty();
                                    })
                                    .then(Mono.error(error))));
        });
    }

    /**
     * 校验请求密码重置邮件的频率。
     *
     * @param request ServerHttpRequest HTTP请求
     * @param email String 接收邮件的邮箱
     * @return Mono<Void> 限流通过时完成信号
     */
    public Mono<Void> checkPasswordReset(ServerHttpRequest request, String email) {
        String sourceAddress = clientAddressResolver.resolve(request);
        return checkLimit("password-reset:address", sourceAddress, EMAIL_CODE_ADDRESS_MAX_REQUESTS, EMAIL_CODE_ADDRESS_WINDOW)
                .then(checkLimit("password-reset:email", normalizeEmail(email), EMAIL_CODE_EMAIL_MAX_REQUESTS, EMAIL_CODE_EMAIL_WINDOW));
    }

    /**
     * 对固定窗口内的指定维度执行原子限流。
     *
     * @param scope String 业务限流范围
     * @param identifier String 限流标识
     * @param maxRequests long 窗口内最大请求数
     * @param window Duration 窗口时长
     * @return Mono<Void> 限流通过时完成信号
     */
    private Mono<Void> checkLimit(String scope, String identifier, long maxRequests, Duration window) {
        String key = buildRateLimitKey(scope, identifier);
        return executeLimit(FIXED_WINDOW_SCRIPT, List.of(key),
                List.of(String.valueOf(window.toSeconds()), String.valueOf(maxRequests)), "操作");
    }

    private Mono<Void> executeLimit(RedisScript<Long> script, List<String> keys, List<String> args, String action) {
        return redisTemplate.execute(script, keys, args)
                .next()
                .switchIfEmpty(Mono.error(new IllegalStateException("Redis未返回限流计数")))
                .flatMap(requestCount -> {
                    if (requestCount > 0) {
                        return Mono.<Void>empty();
                    }
                    log.info("认证接口触发限流: action={}, retryAfter={}", action, -requestCount);
                    return Mono.error(new AuthenticationRateLimitException(-requestCount, action));
                })
                .onErrorMap(exception -> {
                    if (exception instanceof BusinessException) {
                        return exception;
                    }
                    log.error("认证接口限流服务异常: action={}", action, exception);
                    return new BusinessException(ErrorCode.BUSINESS_ERROR, "认证服务暂不可用，请稍后再试");
                });
    }

    /**
     * 构建不包含邮箱明文的Redis限流键。
     *
     * @param scope String 业务限流范围
     * @param identifier String 限流标识
     * @return String Redis限流键
     */
    private String buildRateLimitKey(String scope, String identifier) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(identifier.getBytes(StandardCharsets.UTF_8));
            return KEY_PREFIX + scope + ":" + HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("当前Java运行时不支持SHA-256", exception);
        }
    }

    /**
     * 标准化邮箱作为Redis限流键的一部分。
     *
     * @param email String 邮箱
     * @return String 标准化后的邮箱
     */
    private String normalizeEmail(String email) {
        return email == null ? "unknown" : email.trim().toLowerCase(java.util.Locale.ROOT);
    }
}
