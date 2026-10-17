package com.inspirestudio.service;

import com.alibaba.fastjson2.JSON;
import com.inspirestudio.dto.AiTaskDtos.AiChannelConfig;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import reactor.core.publisher.Mono;

class NewApiModelAvailabilityTest {
    private final NewApiClient client = mock(NewApiClient.class);
    private final NewApiModelAvailability service = new NewApiModelAvailability(client);
    private final AiChannelConfig gateway = new AiChannelConfig("gateway", "New API", "http://newapi:3000/v1/",
            "key", "openai", List.of("disabled", "active", "shared"));
    private final AiChannelConfig direct = new AiChannelConfig("direct", "Direct", "https://other.example/v1",
            "key", "openai", List.of("disabled"));

    @BeforeEach void emptyRoutes() {
        when(client.admin(eq("GET"), anyString(), isNull())).thenReturn(Mono.just(JSON.parseObject("{\"data\":{\"total\":0,\"items\":[]}}")));
    }

    private void catalog(String json) {
        when(client.relayBaseUrl()).thenReturn("http://newapi:3000/v1");
        when(client.models()).thenReturn(Mono.just(JSON.parseObject(json)));
    }

    @Test void hidesDisabledModelsButRetainsSettingsAndOtherActiveRoutes() {
        catalog("{\"data\":[{\"id\":\"active\"},{\"id\":\"shared\"},{\"id\":\"unconfigured\"}]}");
        var annotated = service.annotate(List.of(gateway, direct)).block();
        assertEquals(gateway.models(), annotated.getFirst().models());
        assertEquals(List.of("active", "shared"), annotated.getFirst().availableModels());
        assertEquals(direct, annotated.get(1));
        assertEquals(List.of("active", "shared"), service.available(List.of(gateway)).block().getFirst().models());
    }

    @Test void restoresModelsAfterReenableWithoutRestartOrConfigurationChanges() {
        catalog("{\"data\":[]}");
        assertTrue(service.available(List.of(gateway)).block().getFirst().models().isEmpty());
        catalog("{\"data\":[{\"id\":\"disabled\"},{\"id\":\"active\"},{\"id\":\"shared\"}]}");
        assertEquals(gateway.models(), service.available(List.of(gateway)).block().getFirst().models());
        assertEquals(3, gateway.models().size());
    }

    @Test void gatewayOutageDoesNotReviveDisabledModelsOrBlockDirectChannels() {
        when(client.relayBaseUrl()).thenReturn("http://newapi:3000/v1");
        when(client.models()).thenReturn(Mono.error(new RuntimeException("unreachable")));
        var channels = service.available(List.of(gateway, direct)).block();
        assertTrue(channels.getFirst().models().isEmpty());
        assertEquals(direct, channels.get(1));
    }

    @Test void directChannelsDoNotRequireGateway() {
        when(client.relayBaseUrl()).thenReturn("http://newapi:3000/v1");
        assertEquals(List.of(direct), service.available(List.of(direct)).block());
        verify(client, never()).models();
    }

    @Test void malformedCatalogFailsClosed() {
        catalog("{}");
        assertTrue(service.available(List.of(gateway)).block().getFirst().models().isEmpty());
    }

    @Test void namesFollowEachModelsActiveSupplierAndRenamesWithoutChangingGatewayIdentity() {
        catalog("{\"data\":[{\"id\":\"active\"},{\"id\":\"shared\"}]}");
        when(client.admin(eq("GET"), anyString(), isNull())).thenReturn(Mono.just(JSON.parseObject("""
                {"data":{"total":4,"items":[
                    {"id":1,"name":"arcads","status":1,"group":"default","models":"active"},
                    {"id":2,"name":"original supplier","status":1,"group":"default","models":"shared"},
                    {"id":3,"name":"disabled supplier","status":2,"group":"default","models":"active,shared"},
                    {"id":4,"name":"standby supplier","status":1,"group":"studio-standby","models":"active,shared"}
                ]}}
                """)));
        var channel = service.available(List.of(gateway)).block().getFirst();
        assertEquals("arcads", channel.modelChannelName("active"));
        assertEquals("original supplier", channel.modelChannelName("shared"));
        assertEquals(gateway.id(), channel.id());
        assertEquals(gateway.name(), channel.name());
        assertEquals(gateway.baseUrl(), channel.baseUrl());
        when(client.admin(eq("GET"), anyString(), isNull())).thenReturn(Mono.just(JSON.parseObject("""
                {"data":{"total":1,"items":[{"id":1,"name":"renamed arcads","status":1,"group":"default","models":"active"}]}}
                """)));
        assertEquals("renamed arcads", service.annotate(List.of(gateway)).block().getFirst().modelChannelName("active"));
    }

    @Test void namingEndpointFailureDoesNotHideOtherwiseAvailableModels() {
        catalog("{\"data\":[{\"id\":\"active\"}]}");
        when(client.admin(eq("GET"), anyString(), isNull())).thenReturn(Mono.error(new RuntimeException("unavailable")));
        var channel = service.available(List.of(gateway)).block().getFirst();
        assertEquals(List.of("active"), channel.models());
        assertEquals(Map.of(), channel.modelChannelNames());
    }
}
