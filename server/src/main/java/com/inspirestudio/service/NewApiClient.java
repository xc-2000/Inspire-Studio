package com.inspirestudio.service;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpMethod;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

/** Server-only management client. Never forwards dashboard credentials or upstream error bodies. */
@Component
public class NewApiClient {
    private final WebClient client;
    private final String adminToken;
    private final String relayKey;
    private final String userId;
    private final String baseUrl;

    public NewApiClient(@Value("${NEWAPI_BASE_URL:http://newapi:3000}") String baseUrl,
            @Value("${NEWAPI_ADMIN_TOKEN:}") String adminToken,
            @Value("${NEWAPI_RELAY_KEY:}") String relayKey,
            @Value("${NEWAPI_USER_ID:1}") String userId) {
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.adminToken = adminToken;
        this.relayKey = relayKey;
        this.userId = userId;
        client = WebClient.builder().baseUrl(this.baseUrl)
                .codecs(c -> c.defaultCodecs().maxInMemorySize(4 * 1024 * 1024)).build();
    }

    public boolean configured() { return !adminToken.isBlank() && !relayKey.isBlank(); }
    public String relayBaseUrl() { return baseUrl + "/v1"; }
    String relayKey() { return relayKey; }
    public Mono<JSONObject> admin(String method, String path, Object body) {
        return call(method, path, body, adminToken, true);
    }
    public Mono<JSONObject> models() { return call("GET", "/v1/models", null, relayKey, false); }

    private Mono<JSONObject> call(String method, String path, Object body, String token, boolean management) {
        if (token.isBlank()) return Mono.error(error("New API 尚未初始化，请运行部署初始化脚本"));
        return Mono.defer(() -> {
            var request = client.method(HttpMethod.valueOf(method)).uri(path)
                    .header("Authorization", "Bearer " + token)
                    .header("New-Api-User", userId);
            WebClient.RequestHeadersSpec<?> outgoing = body == null ? request
                    : request.header("Content-Type", "application/json").bodyValue(JSON.toJSONString(body));
            return outgoing.exchangeToMono(response -> {
                if (!response.statusCode().is2xxSuccessful()) return response.releaseBody().then(Mono.error(error(
                        response.statusCode().value() == 401 || response.statusCode().value() == 403
                                ? "New API 凭证无效或权限不足，请检查服务端管理令牌"
                                : "New API 请求失败（HTTP " + response.statusCode().value() + "）")));
                return response.bodyToMono(String.class).map(text -> {
                    JSONObject result = JSON.parseObject(text);
                    if (result == null || (management && !result.getBooleanValue("success"))) {
                        throw error("New API 拒绝了操作，请检查渠道类型、地址、密钥和模型配置");
                    }
                    return result;
                });
            });
        }).timeout(Duration.ofSeconds(35)).onErrorMap(e -> e instanceof BusinessException ? e
                : error("无法连接 New API 或响应异常，请检查服务状态后重试"));
    }

    static BusinessException error(String message) { return new BusinessException(ErrorCode.BUSINESS_ERROR, message); }
}
