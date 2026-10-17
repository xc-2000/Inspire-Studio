package com.inspirestudio.service;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.dto.NewApiDtos.SelectRoute;
import com.inspirestudio.repository.AiTaskRepository;
import java.util.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class NewApiModelRouteTest {
    final NewApiClient client = mock(NewApiClient.class);
    final PersistenceService persistence = mock(PersistenceService.class);
    final AiTaskRepository tasks = mock(AiTaskRepository.class);
    final NewApiService service = new NewApiService(client, persistence, null, null, tasks);
    final Map<Integer, JSONObject> rows = new LinkedHashMap<>();
    final List<Integer> writes = new ArrayList<>();
    boolean rejectActivation;
    static JSONObject copy(JSONObject value) { return JSON.parseObject(value.toJSONString()); }
    static JSONObject row(int id, String active, List<String> standby) {
        return JSONObject.of("id",id,"name","channel-"+id,"type",1,"status",1,"base_url","https://example.org",
                "models",active,"group","default","model_mapping","{}","setting",
                JSONObject.of("studio_standby_models",standby,"unrelated","preserve").toJSONString());
    }
    @BeforeEach void setup() {
        rows.put(1,row(1,"same,only-primary",List.of()));
        rows.put(2,row(2,"only-backup",List.of("same")));
        when(client.relayBaseUrl()).thenReturn("http://newapi:3000/v1");
        when(persistence.listChannels()).thenReturn(Mono.just(List.of()));
        when(persistence.listModelConfigs()).thenReturn(Mono.just(List.of()));
        when(client.admin(anyString(),anyString(),any())).thenAnswer(call -> Mono.defer(() -> {
            String method=call.getArgument(0), path=call.getArgument(1);
            if(method.equals("GET") && path.startsWith("/api/task")) return Mono.just(JSONObject.of("data",JSONObject.of("total",0)));
            if(method.equals("GET") && path.matches("/api/channel/[0-9]+")) return Mono.just(JSONObject.of("data",copy(rows.get(Integer.parseInt(path.substring(path.lastIndexOf('/')+1))))));
            if(method.equals("GET")) return Mono.just(JSONObject.of("data",JSONObject.of("total",rows.size(),"items",
                    new JSONArray(rows.values().stream().map(NewApiModelRouteTest::copy).toList()))));
            JSONObject body=call.getArgument(2); int id=body.getIntValue("id");
            writes.add(id);
            // Simulate an uncertain response: the mutation may have reached the gateway.
            rows.get(id).putAll(body);
            if (rejectActivation && id==2) {rejectActivation=false;return Mono.error(new IllegalStateException("gateway unavailable"));}
            long owners=rows.values().stream().filter(r->r.getString("group").equals("default")&&Arrays.asList(r.getString("models").split(",")).contains("same")).count();
            assertTrue(owners<=1,"must never publish two primary routes");
            return Mono.just(JSONObject.of("success",true));
        }));
    }
    @Test void switchesOnlyOneModelAndPreservesEveryChannel() {
        assertEquals("ok",service.selectRoute(new SelectRoute("same",2)).block());
        assertEquals(List.of(1,2),writes);
        assertEquals("only-primary",rows.get(1).getString("models"));
        assertEquals("only-backup,same",rows.get(2).getString("models"));
        assertTrue(NewApiService.allModelNames(rows.get(1)).contains("same"));
        assertEquals("preserve",NewApiService.routingSettings(rows.get(1)).getString("unrelated"));
        var grouped=service.modelRoutes().block().stream().filter(r->r.model().equals("same")).findFirst().orElseThrow();
        assertEquals(2,grouped.channels().size()); assertEquals(1,grouped.channels().stream().filter(c->c.active()).count());
    }
    @Test void failedActivationRestoresPrimaryAndStandbyEvenAfterAnUncertainWrite() {
        rejectActivation=true;
        assertThrows(RuntimeException.class,()->service.selectRoute(new SelectRoute("same",2)).block());
        assertEquals(List.of(1,2,2,1),writes);
        assertEquals("same,only-primary",rows.get(1).getString("models"));
        assertEquals("only-backup",rows.get(2).getString("models"));
    }
    @Test void editingDoesNotEnableStandbyAndNewDuplicateIsKeptAsStandby() {
        JSONObject body=JSONObject.of("models","same,only-backup,new-model");
        NewApiService.preserveStandbyModels(body,rows.get(2),new ArrayList<>(rows.values()));
        assertEquals("only-backup,new-model",body.getString("models"));
        assertEquals(List.of("same"),body.getJSONObject("setting").getList("studio_standby_models",String.class));
        JSONObject create=JSONObject.of("models","same,fresh");
        NewApiService.preserveStandbyModels(create,null,new ArrayList<>(rows.values()));
        assertEquals("fresh",create.getString("models"));
        assertTrue(NewApiService.allModelNames(create).contains("same"));
    }
    @Test void refusesDisabledTarget() {
        rows.get(2).put("status",2);
        assertThrows(RuntimeException.class,()->service.selectRoute(new SelectRoute("same",2)).block());
        assertTrue(writes.isEmpty());
    }

    @Test void routeListHidesDisabledChannelsAndTheirExclusiveModelsUntilReenabled() {
        rows.get(1).put("status", 2);
        var listed = service.modelRoutes().block();
        assertFalse(listed.stream().anyMatch(r -> r.model().equals("only-primary")));
        var shared = listed.stream().filter(r -> r.model().equals("same")).findFirst().orElseThrow();
        assertEquals(List.of(2), shared.channels().stream().map(c -> c.channelId()).toList());
        assertFalse(shared.channels().getFirst().active(), "enabled standby must remain selectable without auto-activation");
        rows.get(2).put("status", 3);
        assertTrue(service.modelRoutes().block().isEmpty(), "automatically disabled channels must also be hidden");
        rows.get(1).put("status", 1);
        assertTrue(service.modelRoutes().block().stream().anyMatch(r -> r.model().equals("only-primary")));
        assertEquals("same,only-primary", rows.get(1).getString("models"));
        assertTrue(writes.isEmpty(), "visibility must not modify channel configuration");
    }
    @Test void singleModelChannelIsParkedAndCanBeSwitchedBackWithoutLosingItsModel() {
        rows.get(1).put("models","same");
        assertEquals("ok",service.selectRoute(new SelectRoute("same",2)).block());
        assertEquals("same",rows.get(1).getString("models"));
        assertEquals("studio-standby",rows.get(1).getString("group"));
        assertEquals(2,service.modelRoutes().block().stream().filter(r->r.model().equals("same")).findFirst().orElseThrow().channels().size());
        assertEquals("ok",service.selectRoute(new SelectRoute("same",1)).block());
        assertEquals("default",rows.get(1).getString("group"));
        assertEquals("only-backup",rows.get(2).getString("models"));
    }
    @Test void runningGatewayTaskBlocksSwitchWithoutChangingAnything() {
        when(client.admin(eq("GET"),startsWith("/api/task"),isNull())).thenReturn(Mono.just(JSONObject.of("data",JSONObject.of("total",1))));
        assertThrows(RuntimeException.class,()->service.selectRoute(new SelectRoute("same",2)).block());
        assertTrue(writes.isEmpty());
    }

    @Test void categorizesConfiguredAndUnconnectedModelsWithoutTreatingUnknownsAsText() {
        assertEquals(List.of("video"), NewApiService.modelTypes("seedance-2.0-mini", List.of(), List.of()));
        assertEquals(List.of("video"), NewApiService.modelTypes("MiniMax-H3", List.of(), List.of()));
        assertEquals(List.of("image"), NewApiService.modelTypes("gpt-image-2.5", List.of(), List.of()));
        assertEquals(List.of("image"), NewApiService.modelTypes("gemini-3-pro-image-preview", List.of(), List.of()));
        assertEquals(List.of("text"), NewApiService.modelTypes("gpt-6-astra", List.of(), List.of()));
        assertEquals(List.of("text"), NewApiService.modelTypes("glm-5.3-flash", List.of(), List.of()));
        assertEquals(List.of("audio"), NewApiService.modelTypes("grok-voice-think-fast-2.0", List.of(), List.of()), "voice models are TTS, not chat");
        assertEquals(List.of("audio"), NewApiService.modelTypes("gpt-4o-mini-tts", List.of(), List.of()));
        assertEquals(List.of("text"), NewApiService.modelTypes("grok-4.1-fast", List.of(), List.of()));
        assertEquals(List.of("other"), NewApiService.modelTypes("custom-unknown", List.of(), List.of()));
        assertEquals(List.of("image"), NewApiService.modelTypes("custom-unknown", List.of(), List.of("image")));
        assertEquals(List.of("text"), NewApiService.modelTypes("gpt-image-custom", List.of(), List.of("text")), "explicit configuration must win");
    }

    @Test void categoryUsesPrimaryCapabilityProfileIncludingMappedNames() {
        JSONObject primary = row(1, "custom", List.of());
        primary.put("model_mapping", "{\"custom\":\"upstream-model\"}");
        primary.put("setting", JSONObject.of("studio_model_profiles", JSONObject.of("upstream-model",
                JSONObject.of("capabilities", List.of("text-to-video", "image-to-video")))).toJSONString());
        JSONObject backup = row(2, "other", List.of("custom"));
        JSONObject settings = NewApiService.routingSettings(backup);
        settings.put("studio_model_profiles", JSONObject.of("custom", JSONObject.of("capabilities", List.of("text-to-image"))));
        backup.put("setting", settings.toJSONString());
        assertEquals(List.of("video"), NewApiService.modelTypes("custom", List.of(primary, backup), List.of()));
        rows.clear(); rows.put(1, primary); rows.put(2, backup);
        var listed = service.modelRoutes().block().stream().filter(r -> r.model().equals("custom")).findFirst().orElseThrow();
        assertEquals(List.of("video"), listed.modelTypes());
        assertEquals(2, listed.channels().size(), "classification must preserve standby routes");
        assertTrue(writes.isEmpty());
    }

    @Test void routeCategoryUsesGatewayConfigurationOnly() {
        when(persistence.listChannels()).thenReturn(Mono.just(List.of(
                new com.inspirestudio.dto.AiTaskDtos.AiChannelConfig("gateway", "gateway", "http://newapi:3000/v1", "unused", "newapi", List.of("same")))));
        when(persistence.listModelConfigs()).thenReturn(Mono.just(List.of(
                new com.inspirestudio.dto.PersistenceDtos.ModelConfig("m", "gateway", "same", "video", List.of(), false, 0, 0, false, "high", "second", 5),
                new com.inspirestudio.dto.PersistenceDtos.ModelConfig("unrelated", "direct", "same", "text", List.of(), false, 0, 0, false, "high", "generation", 5))));
        var listed = service.modelRoutes().block().stream().filter(r -> r.model().equals("same")).findFirst().orElseThrow();
        assertEquals(List.of("video"), listed.modelTypes());
        assertTrue(writes.isEmpty());
    }
}
