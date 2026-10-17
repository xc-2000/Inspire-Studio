package com.inspirestudio.service;

import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.dto.AiTaskDtos.AiChannelConfig;
import java.time.Duration;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.LinkedHashMap;
import java.util.Arrays;
import java.util.Set;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

/** Reads live relay availability without changing saved model configuration. */
@Service
@RequiredArgsConstructor
@Slf4j
public class NewApiModelAvailability {
    private final NewApiClient client;

    public Mono<List<AiChannelConfig>> annotate(List<AiChannelConfig> channels) {
        if (channels.stream().noneMatch(this::isGateway)) return Mono.just(channels);
        return Mono.zip(client.models().timeout(Duration.ofSeconds(5)),
                routeNames(1).timeout(Duration.ofSeconds(5)).onErrorReturn(Map.of())).map(tuple -> {
            var response = tuple.getT1();
            JSONArray data = response.getJSONArray("data");
            if (data == null) throw new IllegalStateException("Missing relay model catalog");
            Set<String> available = new HashSet<>();
            for (int i = 0; i < data.size(); i++) {
                String id = data.getJSONObject(i).getString("id");
                if (id != null) available.add(id);
            }
            return withAvailability(channels, available, tuple.getT2());
        }).onErrorResume(error -> {
            // An unavailable catalog must not revive disabled models. Do not log credentials or upstream bodies.
            log.warn("无法读取 New API 可用模型目录，暂时隐藏网关模型");
            return Mono.just(withAvailability(channels, Set.of(), Map.of()));
        });
    }

    public Mono<List<AiChannelConfig>> available(List<AiChannelConfig> channels) {
        return annotate(channels).map(items -> items.stream().map(channel ->
                channel.availableModels() == null ? channel : new AiChannelConfig(channel.id(), channel.name(),
                        channel.baseUrl(), channel.apiKey(), channel.apiFormat(), channel.availableModels(), channel.availableModels(), channel.modelChannelNames()))
                .toList());
    }

    private List<AiChannelConfig> withAvailability(List<AiChannelConfig> channels, Set<String> available, Map<String, String> names) {
        return channels.stream().map(channel -> !isGateway(channel) ? channel : new AiChannelConfig(
                channel.id(), channel.name(), channel.baseUrl(), channel.apiKey(), channel.apiFormat(), channel.models(),
                channel.models() == null ? List.of() : channel.models().stream().filter(available::contains).toList(),
                names.entrySet().stream().filter(entry -> channel.models() != null && channel.models().contains(entry.getKey())
                        && available.contains(entry.getKey())).collect(java.util.stream.Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue)))).toList();
    }

    /** A gateway can route different models to different suppliers. Only expose display names. */
    private Mono<Map<String, String>> routeNames(int page) {
        return client.admin("GET", "/api/channel/?p=" + page + "&page_size=100", null).flatMap(response -> {
            JSONObject data = response.getJSONObject("data");
            if (data == null || !data.containsKey("total") || data.getIntValue("total") > 10000)
                return Mono.error(new IllegalStateException("Incomplete channel catalog"));
            Map<String, String> names = new LinkedHashMap<>();
            JSONArray rows = data.getJSONArray("items");
            if (rows == null) return Mono.error(new IllegalStateException("Missing channel catalog"));
            for (int i = 0; i < rows.size(); i++) {
                JSONObject row = rows.getJSONObject(i);
                String name = row.getString("name");
                if (row.getIntValue("status") != 1 || name == null || name.isBlank()
                        || !Arrays.asList(String.valueOf(row.getString("group")).split(",")).contains("default")) continue;
                for (String model : NewApiService.publishedModels(row)) names.merge(model, name, NewApiModelAvailability::joinNames);
            }
            if (page * 100 >= data.getIntValue("total")) return Mono.just(names);
            return routeNames(page + 1).map(rest -> {
                rest.forEach((model, name) -> names.merge(model, name, NewApiModelAvailability::joinNames));
                return names;
            });
        });
    }

    private static String joinNames(String first, String second) {
        return first.equals(second) ? first : first + " / " + second;
    }

    private boolean isGateway(AiChannelConfig channel) {
        return normalize(channel.baseUrl()).equals(normalize(client.relayBaseUrl()));
    }

    private String normalize(String url) {
        return url == null ? "" : url.trim().replaceAll("/+$", "");
    }
}
