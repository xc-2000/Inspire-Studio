package com.inspirestudio.service;

import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.dto.AiTaskDtos.AiChannelConfig;
import com.inspirestudio.dto.NewApiDtos.*;
import com.inspirestudio.dto.PersistenceDtos.ModelConfig;
import com.inspirestudio.repository.AiTaskRepository;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Sinks;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class NewApiChannelProtectionTest {
    final NewApiClient client = mock(NewApiClient.class);
    final PersistenceService persistence = mock(PersistenceService.class);
    final AiTaskRepository tasks = mock(AiTaskRepository.class);
    final NewApiService service = new NewApiService(client, persistence, null, null, tasks);
    final List<JSONObject> channels = new ArrayList<>();
    JSONObject primary;

    @BeforeEach void fixture() {
        primary = channel(1);
        channels.add(primary);
        when(client.relayBaseUrl()).thenReturn("http://newapi:3000/v1");
        when(persistence.listChannels()).thenReturn(Mono.just(List.of(
                new AiChannelConfig("gateway", "gateway", "http://newapi:3000/v1", "unused", "newapi", List.of("movie")))));
        when(persistence.listModelConfigs()).thenReturn(Mono.just(List.of(model("movie"))));
        when(tasks.existsExecutableTasksByModelConfig(anyString())).thenReturn(Mono.just(false));
        when(client.admin(anyString(), anyString(), any())).thenAnswer(invocation -> {
            String method = invocation.getArgument(0), path = invocation.getArgument(1);
            if (method.equals("GET") && path.equals("/api/channel/?p=1&page_size=100"))
                return Mono.just(JSONObject.of("data", JSONObject.of("total", channels.size(), "items", new JSONArray(channels))));
            if (method.equals("GET") && path.startsWith("/api/channel/")) {
                int id = Integer.parseInt(path.substring("/api/channel/".length()));
                return Mono.just(JSONObject.of("data", channels.stream().filter(c -> c.getIntValue("id") == id).findFirst().orElseThrow()));
            }
            if (method.equals("GET") && path.startsWith("/api/task?"))
                return Mono.just(JSONObject.of("data", JSONObject.of("total", 0, "items", new JSONArray())));
            if (method.equals("POST") && path.endsWith("/status")) {
                int id = Integer.parseInt(path.split("/")[3]);
                Map<String, Integer> status = invocation.getArgument(2);
                channels.stream().filter(c -> c.getIntValue("id") == id).findFirst().orElseThrow().put("status", status.get("status"));
            }
            if (method.equals("PUT")) {
                JSONObject body = invocation.getArgument(2);
                channels.stream().filter(c -> c.getIntValue("id") == body.getIntValue("id")).findFirst().orElseThrow().putAll(body);
            }
            return Mono.just(JSONObject.of("success", true));
        });
    }

    @Test void canEnableAnAllStandbyChannelWithoutPublishingItsModels() {
        JSONObject backup = channel(2);
        backup.put("status", 2);
        backup.put("group", "studio-standby");
        JSONObject settings = backup.getJSONObject("setting");
        settings.put("studio_standby_only", true);
        settings.put("studio_active_groups", "default");
        settings.put("studio_standby_models", List.of("movie", "unused"));
        backup.put("setting", settings.toJSONString());
        channels.add(backup);
        assertEquals("ok", service.setStatus(new StatusRequest(2, true)).block());
        verify(client).admin(eq("POST"), eq("/api/channel/2/status"), eq(Map.of("status", 1)));
        assertEquals("studio-standby", backup.getString("group"));
        assertTrue(NewApiService.publishedModels(backup).isEmpty());
    }

    private static JSONObject channel(int id) {
        return JSONObject.of("id", id, "name", "test-" + id, "type", 61, "base_url", "https://example.org",
                "models", "movie,unused", "group", "default", "status", 1, "model_mapping", "{}",
                "setting", JSONObject.of("task_plugin_key", "studio-muse", "unrelated_setting", true).toJSONString());
    }
    private static ModelConfig model(String name) {
        return new ModelConfig("model-" + name, "gateway", name, "video", List.of("text-to-video"), true,
                0, 7, false, "high", "second", 5);
    }
    private static SaveChannel edit(List<String> models, String plugin, String base, String key, String mapping) {
        return new SaveChannel(1, "renamed", 61, base, key, models, 0, 1, mapping, plugin);
    }
    private void blocked(Mono<?> action, String reason) {
        var e = assertThrows(BusinessException.class, action::block);
        assertTrue(e.getMessage().contains(reason), e.getMessage());
        verify(client, never()).admin(eq("DELETE"), anyString(), any());
        verify(client, never()).admin(eq("POST"), contains("/status"), any());
        verify(client, never()).admin(eq("PUT"), anyString(), any());
    }

    @Test void allowsDeletingLastConnectedRouteWithoutDeletingModelConfiguration() {
        assertEquals("ok", service.delete(1).block());
        verify(client).admin("DELETE", "/api/channel/1", null);
        verify(persistence, never()).deleteModelConfig(any());
        verify(persistence, never()).setDefaultModel(any());
    }
    @Test void allowsDisablingAndEnablingLastRouteWithoutChangingModelConfiguration() {
        assertEquals("ok", service.setStatus(new StatusRequest(1, false)).block());
        assertEquals(2, primary.getIntValue("status"));
        assertEquals("ok", service.setStatus(new StatusRequest(1, true)).block());
        assertEquals(1, primary.getIntValue("status"));
        assertEquals("movie,unused", primary.getString("models"));
        verifyNoInteractions(persistence, tasks);
    }
    @Test void allowsStatusChangesWhileTasksAreRunningOrTaskCheckIsUnavailable() {
        when(tasks.existsExecutableTasksByModelConfig(anyString())).thenReturn(Mono.just(true));
        when(client.admin(eq("GET"), startsWith("/api/task?"), isNull())).thenReturn(Mono.error(new IllegalStateException("unavailable")));
        assertEquals("ok", service.setStatus(new StatusRequest(1, false)).block());
        assertEquals("ok", service.setStatus(new StatusRequest(1, true)).block());
        verify(tasks, never()).existsExecutableTasksByModelConfig(anyString());
        verify(client, never()).admin(eq("GET"), startsWith("/api/task?"), any());
    }
    @Test void reEnabledDuplicateKeepsExistingPrimaryAndRetainsOtherModels() {
        primary.put("status", 2);
        JSONObject other = channel(2); other.put("models", "movie"); channels.add(other);
        assertEquals("ok", service.setStatus(new StatusRequest(1, true)).block());
        assertEquals(1, primary.getIntValue("status"));
        assertEquals("unused", primary.getString("models"));
        assertTrue(NewApiService.allModelNames(primary).contains("movie"));
        assertEquals("movie", other.getString("models"));
    }
    @Test void reEnabledSingleModelDuplicateBecomesStandbyWithoutBlocking() {
        primary.put("status", 2); primary.put("models", "movie"); channels.add(channel(2));
        assertEquals("ok", service.setStatus(new StatusRequest(1, true)).block());
        assertEquals("studio-standby", primary.getString("group"));
        assertEquals(1, primary.getIntValue("status"));
        assertEquals("movie", primary.getString("models"));
    }
    @Test void allowsRemovingLastConnectedModelFromListDuringGeneration() {
        when(tasks.existsExecutableTasksByModelConfig(anyString())).thenReturn(Mono.just(true));
        when(client.admin(eq("GET"), startsWith("/api/task?"), isNull())).thenReturn(Mono.error(new IllegalStateException("unavailable")));
        assertEquals("ok", service.save(edit(List.of("unused"), "studio-muse", "https://example.org", "", "{}")).block());
        assertEquals(List.of("unused"), NewApiService.allModelNames(primary));
        assertEquals("https://example.org", primary.getString("base_url"));
        assertEquals("studio-muse", NewApiService.pluginKey(primary));
        verifyNoInteractions(persistence, tasks);
        verify(client, never()).admin(eq("GET"), startsWith("/api/task?"), any());
    }
    @Test void removalDoesNotEnableDisabledBackup() {
        var spare = channel(2); spare.put("status", 2); channels.add(spare);
        assertEquals("ok", service.save(edit(List.of("unused"), "studio-muse", "https://example.org", "", "{}")).block());
        assertEquals(2, spare.getIntValue("status"));
        verify(client, never()).admin(eq("POST"), contains("/status"), any());
    }
    @Test void lastRouteDeletionDoesNotChangeOtherGroups() {
        var spare = channel(2); spare.put("group", "vip"); channels.add(spare);
        assertEquals("ok", service.delete(1).block());
        assertEquals("vip", spare.getString("group"));
        verify(client, never()).admin(eq("PUT"), anyString(), any());
    }
    @Test void lastRouteDeletionDoesNotPromoteAnotherProtocol() {
        var spare = channel(2); spare.put("setting", "{\"task_plugin_key\":\"studio-openai\"}"); channels.add(spare);
        var image = channel(3); image.put("type", 1); channels.add(image);
        assertEquals("ok", service.delete(1).block());
        verify(client, never()).admin(eq("PUT"), anyString(), any());
    }
    @Test void sameGroupProtocolAndAliasAllowRemovalWithoutChangingProjectModels() {
        var spare = channel(2); spare.put("group", "vip,default"); channels.add(spare);
        assertEquals("ok", service.delete(1).block());
        verify(client).admin("DELETE", "/api/channel/1", null);
        verify(persistence, never()).updateChannel(any());
        verify(persistence, never()).deleteModelConfig(any());
        verify(persistence, never()).setDefaultModel(any());
    }
    @Test void mayDeleteChannelNotUsedByProject() {
        when(persistence.listModelConfigs()).thenReturn(Mono.just(List.of()));
        assertEquals("ok", service.delete(1).block());
    }
    @Test void unrelatedPreviouslyMissingModelDoesNotBlockMaintenance() {
        when(persistence.listModelConfigs()).thenReturn(Mono.just(List.of(model("missing-elsewhere"))));
        assertEquals("ok", service.delete(1).block());
    }
    @Test void studioTasksPreventDestructionEvenWithBackup() {
        channels.add(channel(2));
        when(tasks.existsExecutableTasksByModelConfig("model-movie")).thenReturn(Mono.just(true));
        blocked(service.delete(1), "排队或生成中的任务");
    }
    @Test void gatewayTasksPreventDeletingUnconnectedChannel() {
        when(persistence.listModelConfigs()).thenReturn(Mono.just(List.of()));
        when(client.admin(eq("GET"), contains("status=IN_PROGRESS"), isNull()))
                .thenReturn(Mono.just(JSONObject.of("data", JSONObject.of("total", 1))));
        blocked(service.delete(1), "New API 渠道仍有未完成任务");
    }
    @Test void cannotSkipProtectionWhenTaskCheckFails() {
        channels.add(channel(2));
        when(client.admin(eq("GET"), startsWith("/api/task?"), isNull())).thenReturn(Mono.just(new JSONObject()));
        blocked(service.delete(1), "无法确认渠道任务状态");
    }
    @Test void preservesRunningTasksWhenOnlyAddingModelsOrRenaming() {
        when(tasks.existsExecutableTasksByModelConfig("model-movie")).thenReturn(Mono.just(true));
        assertEquals("ok", service.save(edit(List.of("movie", "unused", "new-model"), "studio-muse", "https://example.org", "", "{}" )).block());
        verify(tasks, never()).existsExecutableTasksByModelConfig(anyString());
        verify(client, never()).admin(eq("GET"), startsWith("/api/task?"), any());
    }
    @Test void protocolCannotChangeUnderConnectedAliasEvenWithBackup() {
        channels.add(channel(2));
        blocked(service.save(edit(List.of("movie"), "studio-dola", "https://example.org", "", "{}")), "不能直接更换协议");
        assertEquals("studio-muse", NewApiService.pluginKey(primary));
    }
    @Test void credentialsEndpointAndMappingAreProtectedDuringGeneration() {
        when(tasks.existsExecutableTasksByModelConfig("model-movie")).thenReturn(Mono.just(true));
        for (var change : List.of(
                edit(List.of("movie", "unused"), "studio-muse", "https://new.example.org", "", "{}"),
                edit(List.of("movie", "unused"), "studio-muse", "https://example.org", "replacement-key", "{}"),
                edit(List.of("movie", "unused"), "studio-muse", "https://example.org", "", "{\"movie\":\"new-name\"}"))) {
            blocked(service.save(change), "排队或生成中的任务");
        }
    }
    @Test void concurrentRemovalsRemainSerializedAndReleaseTheGuard() {
        channels.add(channel(2));
        Sinks.One<JSONObject> deletion = Sinks.one();
        when(client.admin(eq("DELETE"), eq("/api/channel/1"), isNull())).thenReturn(deletion.asMono());
        var running = service.delete(1).subscribe();
        var e = assertThrows(BusinessException.class, () -> service.delete(2).block());
        assertTrue(e.getMessage().contains("正在更新"));
        verify(client, never()).admin(eq("GET"), eq("/api/channel/2"), any());
        channels.remove(primary);
        deletion.tryEmitValue(JSONObject.of("success", true));
        assertEquals("ok", service.delete(2).block());
        verify(client).admin(eq("DELETE"), eq("/api/channel/2"), any());
        running.dispose();
    }
}
