package com.inspirestudio.service;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.controller.NewApiController;
import com.inspirestudio.dto.AiTaskDtos.AiChannelConfig;
import com.inspirestudio.dto.NewApiDtos.*;
import com.inspirestudio.dto.PersistenceDtos;
import com.inspirestudio.security.RequireRole;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class NewApiServiceTest {
    @Test void acceptsSpeechModelImportsAtTheHttpValidationBoundary() {
        try (var factory = jakarta.validation.Validation.buildDefaultValidatorFactory()) {
            var request = new SyncRequest(List.of("grok-voice-latest", "grok-voice-think-fast-1.0", "grok-voice-think-fast-2.0"), "audio", List.of("text-to-speech"), 0, List.of(), true);
            assertTrue(factory.getValidator().validate(request).isEmpty());
        }
    }
    @Test void neverReturnsUpstreamSecrets() {
        var raw = JSONObject.of("id", 1, "type", 1, "name", "demo", "models", "a,b,a",
                "key", "private-upstream-key", "header_override", "private-header",
                "setting", "private-setting", "base_url", "https://example.org");
        String serialized = JSON.toJSONString(NewApiService.safeChannel(raw));
        assertFalse(serialized.contains("private-"));
        assertEquals(List.of("a", "b"), NewApiService.safeChannel(raw).models());
    }
    @Test void editingWithoutKeyPreservesSavedCredential() {
        var body = NewApiService.channelBody(new SaveChannel(1, "demo", 1, "https://example.org/v1/",
                "", List.of("a"), 0, 1, "{}"));
        assertFalse(body.containsKey("key"));
        assertFalse(body.containsKey("status"));
        assertEquals("https://example.org", body.getString("base_url"));
    }
    @Test void rejectsCredentialUrlsAndInvalidMapping() {
        for (String value : List.of("file:///etc/passwd", "http://key@example.org", "https://example.org?key=abc", "/relative"))
            assertThrows(RuntimeException.class, () -> NewApiService.normalizeUpstreamUrl(value));
        assertThrows(RuntimeException.class, () -> NewApiService.channelBody(new SaveChannel(null, "demo", 1,
                "https://example.org", "secret", List.of("a"), 0, 1, "{\"a\":123}")));
    }
    @Test void preservesCustomPathPrefixes() {
        assertEquals("https://example.org/proxy", NewApiService.normalizeUpstreamUrl("https://example.org/proxy/v1"));
        assertEquals("https://example.org/proxy", NewApiService.normalizeUpstreamUrl("https://example.org/proxy"));
    }
    @Test void automaticMigrationUsesGatewayVideoPlugins() {
        assertTrue(NewApiService.canImport(new AiChannelConfig("a", "muse", "https://example.org", "key", "muse", List.of("video")), List.of()));
        var video = new PersistenceDtos.ModelConfig("m", "a", "video", "video", List.of(), false, 0, 0, false, "high", "second", 5);
        assertTrue(NewApiService.canImport(new AiChannelConfig("a", "openai", "https://example.org", "key", "openai", List.of("video")), List.of(video)));
        assertEquals("studio-openai", NewApiService.videoPlugin(new AiChannelConfig("a", "openai", "https://example.org", "key", "openai", List.of("video")), List.of(video)));
        var text = new PersistenceDtos.ModelConfig("t", "a", "text", "text", List.of(), false, 0, 0, false, "high", "generation", 5);
        assertFalse(NewApiService.canImport(new AiChannelConfig("a", "mixed", "https://example.org", "key", "openai", List.of("video","text")), List.of(video,text)));
        assertTrue(NewApiService.canImport(new AiChannelConfig("a", "openai", "https://example.org", "key", "openai", List.of("text")), List.of()));
    }
    @Test void taskPluginBindingPreservesProtocolWithoutExposingCredentials() {
        var body = NewApiService.channelBody(new SaveChannel(null, "video", 61, "https://example.org/v1", "secret", List.of("v"), 0, 1, "{}", "studio-muse"));
        assertEquals("studio-muse", body.getJSONObject("setting").getString("task_plugin_key"));
        assertEquals("studio-muse", NewApiService.safeChannel(body).pluginKey());
        assertFalse(com.alibaba.fastjson2.JSON.toJSONString(NewApiService.safeChannel(body)).contains("secret"));
    }
    @Test void everyEndpointRequiresAdmin() {
        for (var method : NewApiController.class.getDeclaredMethods()) {
            if (method.isAnnotationPresent(GetMapping.class) || method.isAnnotationPresent(PostMapping.class)) {
                assertNotNull(method.getAnnotation(RequireRole.class), method.getName());
                assertEquals("admin", method.getAnnotation(RequireRole.class).value());
            }
        }
    }
    @Test void invalidSyncDoesNotLeavePermanentBusyFlag() {
        var service = new NewApiService(mock(NewApiClient.class), mock(PersistenceService.class), null, null, null);
        var request = new SyncRequest(List.of("x"), "video", List.of("chat"), 1, List.of("720P"), false);
        for (int i = 0; i < 2; i++) {
            Exception e = assertThrows(RuntimeException.class, () -> service.sync(request).block());
            assertTrue(e.getMessage().contains("模型能力"));
        }
    }
}
