package com.inspirestudio.service;

import com.alibaba.fastjson2.JSON;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatusCode;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

/** 内部自动发布服务客户端。 */
@Component
public class PublisherClient {

    private final WebClient client;
    private final String internalToken;

    public PublisherClient(WebClient.Builder builder,
                           @Value("${inspire.publisher.base-url:http://publisher:8090}") String baseUrl,
                           @Value("${inspire.publisher.internal-token:}") String internalToken) {
        this.client = builder.baseUrl(baseUrl).build();
        this.internalToken = internalToken;
    }

    public Mono<Map<String, Object>> check(String platform, String credentials) {
        return post("/accounts/check", Map.of("platform", platform, "credentials", credentials));
    }

    public Mono<Map<String, Object>> startQrLogin(String platform) {
        return post("/accounts/qr/start", Map.of("platform", platform));
    }

    public Mono<Map<String, Object>> qrLoginStatus(String sessionId) {
        return get("/accounts/qr/" + sessionId);
    }

    public Mono<Map<String, Object>> qrLoginAction(String sessionId, Map<String, Object> action) {
        return post("/accounts/qr/" + sessionId + "/action", action);
    }

    public Mono<Void> cancelQrLogin(String sessionId) {
        if (internalToken == null || internalToken.isBlank()) {
            return Mono.error(new BusinessException(ErrorCode.SYSTEM_ERROR, "内容发布服务密钥未配置"));
        }
        return client.delete().uri("/accounts/qr/" + sessionId).header("X-Internal-Token", internalToken)
                .retrieve().onStatus(HttpStatusCode::isError, response -> response.bodyToMono(String.class)
                        .defaultIfEmpty("取消扫码登录失败")
                        .map(message -> new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, safeMessage(message))))
                .bodyToMono(Void.class);
    }

    public Mono<Map<String, Object>> publish(String platform, String credentials, String mediaType,
                                             String title, String description, List<String> mediaUrls,
                                             String coverUrl, List<String> topics, String publishMode,
                                             String visibility, boolean allowDownload, boolean transcode) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("platform", platform);
        body.put("credentials", credentials);
        body.put("media_type", mediaType);
        body.put("title", title);
        body.put("description", description);
        body.put("media_urls", mediaUrls);
        body.put("cover_url", coverUrl);
        body.put("topics", topics);
        body.put("publish_mode", publishMode);
        body.put("visibility", visibility);
        body.put("allow_download", allowDownload);
        body.put("transcode", transcode);
        return post("/publish", body);
    }

    @SuppressWarnings("unchecked")
    private Mono<Map<String, Object>> post(String path, Map<String, Object> body) {
        if (internalToken == null || internalToken.isBlank()) {
            return Mono.error(new BusinessException(ErrorCode.SYSTEM_ERROR, "内容发布服务密钥未配置"));
        }
        return client.post().uri(path).header("X-Internal-Token", internalToken).bodyValue(body)
                .retrieve().onStatus(HttpStatusCode::isError, response -> response.bodyToMono(String.class)
                        .defaultIfEmpty("内容发布服务调用失败")
                        .map(message -> new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, safeMessage(message))))
                .bodyToMono(Map.class).map(value -> (Map<String, Object>) value);
    }

    @SuppressWarnings("unchecked")
    private Mono<Map<String, Object>> get(String path) {
        if (internalToken == null || internalToken.isBlank()) {
            return Mono.error(new BusinessException(ErrorCode.SYSTEM_ERROR, "内容发布服务密钥未配置"));
        }
        return client.get().uri(path).header("X-Internal-Token", internalToken)
                .retrieve().onStatus(HttpStatusCode::isError, response -> response.bodyToMono(String.class)
                        .defaultIfEmpty("内容发布服务调用失败")
                        .map(message -> new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, safeMessage(message))))
                .bodyToMono(Map.class).map(value -> (Map<String, Object>) value);
    }

    static String safeMessage(String message) {
        String value = message == null || message.isBlank() ? "内容发布服务调用失败" : message.trim();
        for (int depth = 0; depth < 4; depth++) {
            if (!value.startsWith("{") && !value.startsWith("\"")) break;
            try {
                Object parsed = JSON.parse(value);
                if (parsed instanceof Map<?, ?> fields) {
                    Object detail = fields.get("detail");
                    if (detail == null) detail = fields.get("message");
                    if (detail == null) detail = fields.get("error");
                    if (detail instanceof Map<?, ?> nested) detail = nested.get("message");
                    value = detail instanceof String text ? text.trim() : "内容发布服务调用失败，请稍后重试";
                } else if (parsed instanceof String text) {
                    value = text.trim();
                } else break;
            } catch (Exception ignored) {
                value = "内容发布服务调用失败，请稍后重试";
                break;
            }
        }
        return value.length() > 500 ? value.substring(0, 500) : value;
    }
}
