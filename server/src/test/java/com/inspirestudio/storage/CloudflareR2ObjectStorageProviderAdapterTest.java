package com.inspirestudio.storage;

import static org.junit.jupiter.api.Assertions.*;

import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.dto.PersistenceDtos;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayInputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import software.amazon.awssdk.services.s3.S3Client;

class CloudflareR2ObjectStorageProviderAdapterTest {

    private static final String ENDPOINT = "https://account123.r2.cloudflarestorage.com";
    private static final String PUBLIC_URL = "https://media.example.com/assets/";
    private final CloudflareR2ObjectStorageProviderAdapter adapter = new CloudflareR2ObjectStorageProviderAdapter();

    @Test
    void shouldRegisterR2AndAllowAutomaticRegion() {
        ObjectStorageService service = new ObjectStorageService(List.of(adapter));
        assertTrue(service.supports("cloudflareR2"));
        assertDoesNotThrow(() -> service.validate(config(ENDPOINT, PUBLIC_URL, "")));
        assertDoesNotThrow(() -> service.validate(config(ENDPOINT, "https://pub-example.r2.dev", "auto")));
        assertThrows(BusinessException.class, () -> service.validate(config(ENDPOINT, PUBLIC_URL, "us-east-1")));
    }

    @ParameterizedTest
    @ValueSource(strings = {"https://account123.eu.r2.cloudflarestorage.com/", "https://account123.fedramp.r2.cloudflarestorage.com:443"})
    void shouldAcceptJurisdictionEndpoints(String endpoint) {
        assertDoesNotThrow(() -> adapter.validate(config(endpoint, PUBLIC_URL, "auto")));
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "http://account123.r2.cloudflarestorage.com", "https://example.com",
            "https://account123.r2.cloudflarestorage.com/bucket", "https://account123.r2.cloudflarestorage.com?token=bad",
            "https://account123.r2.cloudflarestorage.com/#fragment", "https://user:pass@account123.r2.cloudflarestorage.com",
            "https://account123.r2.cloudflarestorage.com:8443", "https://account123.r2.cloudflarestorage.com.evil.example"})
    void shouldRejectNonAccountEndpoints(String endpoint) {
        assertThrows(BusinessException.class, () -> adapter.validate(config(endpoint, PUBLIC_URL, "auto")));
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "http://media.example.com", "https://account123.r2.cloudflarestorage.com",
            "https://account123.eu.r2.cloudflarestorage.com/bucket", "https://r2.cloudflarestorage.com",
            "https://media.example.com?token=bad", "https://media.example.com/#fragment", "https://user:pass@media.example.com"})
    void shouldRequireSeparatePublicHttpsUrl(String publicUrl) {
        assertThrows(BusinessException.class, () -> adapter.validate(config(ENDPOINT, publicUrl, "auto")));
    }

    @Test
    void shouldUploadWithS3SignatureAutoRegionAndPathStyleWithoutOptionalChecksums() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicReference<Headers> headers = new AtomicReference<>();
        AtomicReference<String> path = new AtomicReference<>();
        AtomicReference<byte[]> uploaded = new AtomicReference<>();
        server.createContext("/", exchange -> {
            headers.set(exchange.getRequestHeaders());
            path.set(exchange.getRequestURI().getRawPath());
            uploaded.set(exchange.getRequestBody().readAllBytes());
            exchange.getResponseHeaders().add("ETag", "\"test-etag\"");
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        server.start();
        try {
            byte[] bytes = "R2 upload 测试".getBytes(StandardCharsets.UTF_8);
            String url = localAdapter(server).putObject(config(ENDPOINT, PUBLIC_URL, "auto"), "images/测试 图片.png",
                    new ByteArrayInputStream(bytes), bytes.length, "image/png");

            assertEquals("/test-bucket/images/%E6%B5%8B%E8%AF%95%20%E5%9B%BE%E7%89%87.png", path.get());
            assertArrayEquals(bytes, uploaded.get());
            assertEquals("image/png", headers.get().getFirst("Content-Type"));
            assertEquals(String.valueOf(bytes.length), headers.get().getFirst("Content-Length"));
            String authorization = headers.get().getFirst("Authorization");
            assertTrue(authorization.startsWith("AWS4-HMAC-SHA256 Credential=test-access-key/"));
            assertTrue(authorization.contains("/auto/s3/aws4_request"));
            assertTrue(authorization.contains("Signature="));
            assertFalse(authorization.contains("test-secret-key"));
            assertFalse(headers.get().keySet().stream().anyMatch(name -> name.toLowerCase().contains("checksum")));
            assertNull(headers.get().getFirst("Content-Encoding"));
            assertNull(headers.get().getFirst("x-amz-acl"));
            assertEquals("https://media.example.com/assets/images/%E6%B5%8B%E8%AF%95%20%E5%9B%BE%E7%89%87.png", url);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void shouldTranslateRejectedUploadWithoutExposingServiceDetails() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            exchange.getRequestBody().readAllBytes();
            byte[] body = "<Error><Code>AccessDenied</Code><Message>test-secret-key</Message></Error>".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/xml");
            exchange.sendResponseHeaders(403, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            BusinessException exception = assertThrows(BusinessException.class,
                    () -> localAdapter(server).putObject(config(ENDPOINT, PUBLIC_URL, "auto"), "test.txt",
                            new ByteArrayInputStream(new byte[] {1}), 1, "text/plain"));
            assertEquals(ErrorCode.THIRD_PARTY_CALL_ERROR, exception.getCode());
            assertTrue(exception.getMessage().contains("写入权限"));
            assertFalse(exception.getMessage().contains("test-secret-key"));
        } finally {
            server.stop(0);
        }
    }

    private CloudflareR2ObjectStorageProviderAdapter localAdapter(HttpServer server) {
        return new CloudflareR2ObjectStorageProviderAdapter() {
            @Override
            S3Client createClient(PersistenceDtos.ObjectStorageConfig config) {
                return clientBuilder(config)
                        .endpointOverride(URI.create("http://127.0.0.1:" + server.getAddress().getPort())).build();
            }
        };
    }

    private PersistenceDtos.ObjectStorageConfig config(String endpoint, String publicUrl, String region) {
        return new PersistenceDtos.ObjectStorageConfig("cloudflareR2", "test-access-key", "test-secret-key",
                "test-bucket", region, endpoint, "inspire-studio", publicUrl, "r2-test", "R2测试", "", false);
    }
}
