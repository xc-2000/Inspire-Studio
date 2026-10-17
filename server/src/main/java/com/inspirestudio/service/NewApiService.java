package com.inspirestudio.service;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.common.SensitiveDataCrypto;
import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.dto.AiTaskDtos.AiChannelConfig;
import com.inspirestudio.dto.NewApiDtos.*;
import com.inspirestudio.dto.PersistenceDtos;
import com.inspirestudio.dto.VideoBillingConfiguration;
import com.inspirestudio.repository.AiTaskRepository;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;
import lombok.RequiredArgsConstructor;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Service
@RequiredArgsConstructor
public class NewApiService {
    private final NewApiClient client;
    private final PersistenceService persistence;
    private final DatabaseClient database;
    private final InspireProperties properties;
    private final AiTaskRepository tasks;
    private final AtomicBoolean changing = new AtomicBoolean();
    static final Set<Integer> TYPES = Set.of(1, 14, 24, 25, 35, 40, 43, 45, 50, 51, 52, 54, 55, 60, 61);
    static final Set<String> VIDEO_PROTOCOLS = Set.of("minimax", "muse", "autodl-comfyui", "dola", "openai-video-json");
    private static final String GATEWAY_PREFIX = "studio-newapi-";

    public Mono<Status> status() {
        if (!client.configured()) return Mono.just(new Status(false, "尚未初始化 New API 服务"));
        return client.admin("GET", "/api/channel/?p=1&page_size=1", null).then(client.models())
                .map(ignored -> new Status(true, "已连接 · 管理令牌与调用令牌均有效"))
                .onErrorResume(e -> Mono.just(new Status(false, e.getMessage())));
    }

    public Mono<Page<Channel>> channels(int page, int size, String keyword) {
        int safePage = Math.max(1, Math.min(10000, page));
        int safeSize = Math.max(1, Math.min(100, size));
        String query = keyword == null ? "" : keyword.trim();
        String path = query.isEmpty() ? "/api/channel/?" : "/api/channel/search?keyword=" + encode(query) + "&";
        return client.admin("GET", path + "p=" + safePage + "&page_size=" + safeSize, null).map(result -> {
            JSONObject data = result.getJSONObject("data");
            return new Page<>(objects(data.getJSONArray("items")).stream().map(NewApiService::safeChannel).toList(), data.getIntValue("total"));
        });
    }

    static Channel safeChannel(JSONObject source) {
        return new Channel(source.getIntValue("id"), source.getString("name"), source.getIntValue("type"),
                source.getString("base_url"), allModelNames(source), source.getIntValue("status"),
                source.getIntValue("priority"), source.getIntValue("weight"),
                source.getString("model_mapping"), source.getString("tag"), pluginKey(source));
    }

    static String pluginKey(JSONObject source) {
        if (!Set.of(60, 61).contains(source.getIntValue("type"))) return null;
        JSONObject setting = source.getJSONObject("setting");
        return setting == null ? null : setting.getString("task_plugin_key");
    }

    public Mono<List<TaskPlugin>> plugins() {
        return client.admin("GET", "/api/task_plugin_options", null).map(response -> objects(response.getJSONArray("data")).stream()
                .map(p -> new TaskPlugin(p.getString("key"), p.getString("name"), p.getList("models", String.class))).toList());
    }

    public Mono<String> save(SaveChannel input) {
        return configurationChange(() -> saveChannel(input));
    }

    private Mono<String> saveChannel(SaveChannel input) {
        JSONObject body = channelBody(input);
        if (input.id() != null && input.id() > 0) {
            body.put("id", input.id());
            // PUT deliberately omits status and hidden provider settings.
            return client.admin("GET", "/api/channel/" + input.id(), null).flatMap(existing -> {
                String group = existing.getJSONObject("data").getString("group");
                if (group != null && !group.isBlank()) body.put("group", group);
                if (input.type() == 61) {
                    JSONObject savedSettings = existing.getJSONObject("data").getJSONObject("setting");
                    JSONObject settings = savedSettings == null ? new JSONObject() : new JSONObject(savedSettings);
                    settings.put("task_plugin_key", input.pluginKey());
                    body.put("setting", settings.toJSONString());
                }
                JSONObject before = existing.getJSONObject("data");
                JSONObject after = new JSONObject(before);
                after.putAll(body);
                return routingChannels(1).flatMap(rows -> {
                    preserveStandbyModels(body, before, rows);
                    after.putAll(body);
                    return protectChange(before, after).then(Mono.defer(() -> client.admin("PUT", "/api/channel/", body)));
                });
            }).thenReturn("ok");
        }
        if (input.apiKey() == null || input.apiKey().isBlank()) return Mono.error(invalid("新增渠道需要填写 API Key"));
        body.put("status", 1);
        return routingChannels(1).flatMap(rows -> {
            preserveStandbyModels(body, null, rows);
            return client.admin("POST", "/api/channel/", JSONObject.of("mode", "single", "channel", body));
        }).thenReturn("ok");
    }

    static JSONObject channelBody(SaveChannel input) {
        if (!TYPES.contains(input.type())) throw invalid("该渠道类型请使用 New API 完整控制台配置");
        JSONObject body = JSONObject.of("type", input.type(), "name", input.name().trim(),
                "base_url", normalizeUpstreamUrl(input.baseUrl()), "models", String.join(",", cleanModels(input.models())),
                "group", "default", "priority", input.priority(), "weight", input.weight());
        if (input.apiKey() != null && !input.apiKey().isBlank()) body.put("key", input.apiKey().trim());
        String mapping = input.modelMapping() == null || input.modelMapping().isBlank() ? "{}" : input.modelMapping().trim();
        try {
            JSONObject map = JSON.parseObject(mapping);
            if (map == null || map.values().stream().anyMatch(v -> !(v instanceof String s) || s.isBlank())) throw new IllegalArgumentException();
        } catch (Exception e) { throw invalid("模型映射必须为 JSON 对象，例如 {\"对外模型名\":\"上游模型名\"}"); }
        body.put("model_mapping", mapping);
        if (input.type() == 61) {
            if (input.pluginKey() == null || !input.pluginKey().matches("[a-z0-9_-]{1,30}")) throw invalid("请选择视频协议插件");
            body.put("setting", JSONObject.of("task_plugin_key", input.pluginKey()).toJSONString());
        }
        return body;
    }

    public Mono<List<String>> fetchModels(FetchModels input) {
        if (input.type() != null && input.type() == 61) return plugins().map(items -> items.stream()
                .filter(p -> p.key().equals(input.pluginKey())).findFirst().orElseThrow(() -> invalid("视频插件不存在"))).map(TaskPlugin::models);
        if (input.id() != null && input.id() > 0) {
            return client.admin("GET", "/api/channel/" + input.id(), null).flatMap(response -> {
                JSONObject row = response.getJSONObject("data");
                if (row.getIntValue("type") == 61) return fetchModels(new FetchModels(null, 61, null, null, pluginKey(row)));
                return client.admin("GET", "/api/channel/fetch_models/" + input.id(), null).map(NewApiService::modelResponse);
            });
        }
        if (input.type() == null || !TYPES.contains(input.type()) || input.apiKey() == null || input.apiKey().isBlank())
            return Mono.error(invalid("请先填写渠道类型、地址和密钥"));
        return client.admin("POST", "/api/channel/fetch_models", JSONObject.of("type", input.type(),
                "base_url", normalizeUpstreamUrl(input.baseUrl()), "key", input.apiKey().trim())).map(NewApiService::modelResponse);
    }

    public Mono<String> setStatus(StatusRequest input) {
        return configurationChange(() -> client.admin("GET", "/api/channel/" + input.id(), null).flatMap(response -> {
            JSONObject before = response.getJSONObject("data");
            if (before == null) return Mono.error(invalid("渠道不存在"));
            // Status is an operator control, even for the last route or an in-flight task.
            // Retain the credentials and task bindings for polling and later re-enable.
            Mono<Void> prepare = input.enabled() ? routingChannels(1).flatMap(rows -> {
                List<String> active = publishedModels(before).stream().filter(name -> rows.stream()
                        .noneMatch(row -> row.getIntValue("id") != input.id() && routes(row, name))).toList();
                if (active.equals(publishedModels(before))) return Mono.empty();
                // Re-enable must not create two primaries or silently switch suppliers.
                return writeRoute(routePatch(before, active, routingSettings(before))).then();
            }) : Mono.empty();
            int requestedStatus = input.enabled() ? 1 : 2;
            return prepare.then(Mono.defer(() -> client.admin("POST", "/api/channel/" + input.id() + "/status",
                    Map.of("status", requestedStatus))))
                    .then(Mono.defer(() -> client.admin("GET", "/api/channel/" + input.id(), null)))
                    .map(saved -> {
                        JSONObject channel = saved.getJSONObject("data");
                        if (channel == null || channel.getIntValue("status") != requestedStatus)
                            throw invalid("渠道状态未生效，请刷新后重试");
                        return "ok";
                    });
        }));
    }

    static List<String> allModelNames(JSONObject channel) {
        LinkedHashSet<String> names = new LinkedHashSet<>(modelNames(channel.getString("models")));
        JSONObject setting = routingSettings(channel);
        List<String> standby = setting.getList("studio_standby_models", String.class);
        if (standby != null) names.addAll(standby);
        return List.copyOf(names);
    }

    static JSONObject routingSettings(JSONObject channel) {
        try {
            JSONObject value = channel.getJSONObject("setting");
            return value == null ? new JSONObject() : new JSONObject(value);
        } catch (Exception ignored) { return new JSONObject(); }
    }

    static List<String> publishedModels(JSONObject channel) {
        return routingSettings(channel).getBooleanValue("studio_standby_only") ? List.of() : modelNames(channel.getString("models"));
    }

    static String activeGroups(JSONObject channel) {
        JSONObject settings = routingSettings(channel);
        return settings.getBooleanValue("studio_standby_only") ? settings.getString("studio_active_groups") : channel.getString("group");
    }

    static void publishSelection(JSONObject body, List<String> all, Collection<String> active, JSONObject settings, String groups) {
        settings.put("studio_standby_models", all.stream().filter(name -> !active.contains(name)).toList());
        // New API's struct update ignores an empty model string. Park an all-standby channel
        // outside the Studio token group instead; retain its complete catalog and key.
        if (active.isEmpty()) {
            settings.put("studio_standby_only", true);
            settings.put("studio_active_groups", groups);
            body.put("models", String.join(",", all));
            body.put("group", "studio-standby");
        } else {
            settings.remove("studio_standby_only"); settings.remove("studio_active_groups");
            body.put("models", String.join(",", active)); body.put("group", groups);
        }
        body.put("setting", settings.toJSONString());
    }

    // New API routes only published models; standby entries stay persisted in its channel settings.
    // Saving a channel must never accidentally republish its standby models.
    static void preserveStandbyModels(JSONObject body, JSONObject before, List<JSONObject> rows) {
        List<String> requested = modelNames(body.getString("models"));
        Set<String> previousActive = before == null ? Set.of() : new HashSet<>(publishedModels(before));
        Set<String> previousAll = before == null ? Set.of() : new HashSet<>(allModelNames(before));
        List<String> active = new ArrayList<>(), standby = new ArrayList<>();
        for (String name : requested) {
            boolean elsewhere = rows.stream().anyMatch(row -> (before == null || row.getIntValue("id") != before.getIntValue("id"))
                    && modelNames(activeGroups(row)).contains("default") && publishedModels(row).contains(name));
            if (previousActive.contains(name) || (!previousAll.contains(name) && !elsewhere)) active.add(name);
            else standby.add(name);
        }
        JSONObject setting = before == null ? new JSONObject() : routingSettings(before);
        if (body.containsKey("setting")) setting.putAll(body.getJSONObject("setting"));
        publishSelection(body, requested, active, setting, before == null ? body.getString("group") : activeGroups(before));
    }

    public Mono<List<ModelRoute>> modelRoutes() {
        return Mono.zip(routingChannels(1), persistence.listModelConfigs(), persistence.listChannels()).map(tuple -> {
            List<JSONObject> rows = tuple.getT1().stream().filter(row -> row.getIntValue("status") == 1
                    && modelNames(activeGroups(row)).contains("default")).toList();
            Set<String> gatewayIds = new HashSet<>();
            tuple.getT3().stream().filter(c -> Objects.equals(c.baseUrl(), client.relayBaseUrl())).forEach(c -> gatewayIds.add(c.id()));
            Map<String, List<RouteOption>> grouped = new TreeMap<>();
            for (JSONObject row : rows) {
                for (String name : allModelNames(row)) grouped.computeIfAbsent(name, ignored -> new ArrayList<>())
                        .add(new RouteOption(row.getIntValue("id"), row.getString("name"), row.getIntValue("status"), routes(row, name)));
            }
            return grouped.entrySet().stream().map(entry -> new ModelRoute(entry.getKey(), entry.getValue(),
                    modelTypes(entry.getKey(), rows, tuple.getT2().stream()
                            .filter(m -> gatewayIds.contains(m.channelId()) && m.modelName().equals(entry.getKey()))
                            .map(PersistenceDtos.ModelConfig::modelType).toList()))).toList();
        });
    }

    static List<String> modelTypes(String name, List<JSONObject> rows, List<String> configured) {
        List<String> known = List.of("text", "image", "video", "audio");
        List<String> types = known.stream().filter(configured::contains).toList();
        if (!types.isEmpty()) return types;
        Set<String> inferred = new HashSet<>();
        List<JSONObject> matching = rows.stream().filter(row -> allModelNames(row).contains(name)).toList();
        List<JSONObject> primary = matching.stream().filter(row -> routes(row, name)).toList();
        for (JSONObject row : primary.isEmpty() ? matching : primary) {
            JSONObject profiles = routingSettings(row).getJSONObject("studio_model_profiles");
            if (profiles == null) continue;
            JSONObject profile = profiles.getJSONObject(name);
            if (profile == null) profile = profiles.getJSONObject(mappedModel(row.getJSONObject("model_mapping"), name));
            if (profile == null) continue;
            List<String> capabilities = profile.getList("capabilities", String.class);
            if (capabilities == null) continue;
            if (capabilities.stream().anyMatch(c -> c.endsWith("-to-video"))) inferred.add("video");
            if (capabilities.stream().anyMatch(c -> c.endsWith("-to-image"))) inferred.add("image");
            if (capabilities.contains("chat")) inferred.add("text");
            if (capabilities.contains("text-to-speech")) inferred.add("audio");
        }
        if (!inferred.isEmpty()) return known.stream().filter(inferred::contains).toList();
        // Unconnected models may have no profile yet. Recognize explicit media names before chat families.
        String id = name.toLowerCase(Locale.ROOT);
        if (id.matches(".*(?:seedance|veo|sora|kling|vidu|hailuo|wan[._-]?[0-9]|minimax[._-]?h[0-9]|doubao-video|grok-imagine-video).*")) return List.of("video");
        // 语音合成模型要在聊天模型前识别，否则 grok-voice-*、gpt-4o-mini-tts 等会被当作文本模型。
        if (id.matches(".*(?:tts|text-to-speech|grok-voice|speech-[0-9]|cosyvoice|fish-speech|-voice-).*")) return List.of("audio");
        if (id.matches(".*(?:gpt-image|image-preview|image-generation|imagen|nano-banana|flux|dall-e|midjourney|seedream|stable-diffusion).*")) return List.of("image");
        if (id.matches("^(?:gpt-|chatgpt-|claude-|gemini-|deepseek-|glm-|qwen[0-9.-]|kimi-|moonshot-|mistral-|llama-|grok-|o[134](?:-|$)).*")) return List.of("text");
        return List.of("other");
    }

    public Mono<String> selectRoute(SelectRoute input) {
        return configurationChange(() -> Mono.zip(routingChannels(1), persistence.listModelConfigs(), persistence.listChannels())
                .flatMap(tuple -> {
                    String name = input.model();
                    List<JSONObject> rows = tuple.getT1().stream().filter(row -> modelNames(activeGroups(row)).contains("default")
                            && allModelNames(row).contains(name)).toList();
                    JSONObject target = rows.stream().filter(row -> row.getIntValue("id") == input.channelId()).findFirst()
                            .orElseThrow(() -> invalid("该渠道没有配置此模型"));
                    if (target.getIntValue("status") != 1) return Mono.error(invalid("请先启用该渠道，再切换主用模型"));
                    Set<String> gateways = new HashSet<>();
                    tuple.getT3().stream().filter(c -> c.baseUrl().equals(client.relayBaseUrl())).forEach(c -> gateways.add(c.id()));
                    List<PersistenceDtos.ModelConfig> configs = tuple.getT2().stream().filter(m -> gateways.contains(m.channelId()) && m.modelName().equals(name)).toList();
                    List<JSONObject> active = rows.stream().filter(row -> publishedModels(row).contains(name)).toList();
                    JSONObject profiles = routingSettings(target).getJSONObject("studio_model_profiles");
                    JSONObject targetProfile = profiles == null ? null : profiles.getJSONObject(name);
                    if (targetProfile == null && !configs.isEmpty() && active.stream().anyMatch(row -> !sameProtocol(row, target)))
                        return Mono.error(invalid("备用渠道协议不同，请先为该渠道配置此模型的能力与时长，再切换"));
                    Mono<Void> idle = Flux.fromIterable(configs).concatMap(m -> tasks.existsExecutableTasksByModelConfig(m.id()))
                            .any(Boolean.TRUE::equals).flatMap(running -> running ? Mono.error(invalid("此模型仍有生成任务，请完成后切换")) : Mono.empty());
                    // Full channel check also covers tasks submitted outside Studio.
                    idle = idle.thenMany(Flux.fromIterable(rows).concatMap(row -> noGatewayTasks(row.getIntValue("id")))).then();
                    List<JSONObject> changed = new ArrayList<>(active.stream().filter(row -> row != target).toList());
                    changed.add(target); // Remove old routes first: never dispatch to two suppliers at once.
                    List<JSONObject> written = new ArrayList<>();
                    return idle.then(Flux.fromIterable(changed).concatMap(row -> {
                        JSONObject settings = routingSettings(row);
                        JSONObject stored = settings.getJSONObject("studio_model_profiles");
                        stored = stored == null ? new JSONObject() : new JSONObject(stored);
                        if (publishedModels(row).contains(name) && !configs.isEmpty()) stored.put(name, profile(configs.get(0)));
                        settings.put("studio_model_profiles", stored);
                        LinkedHashSet<String> published = new LinkedHashSet<>(publishedModels(row));
                        if (row == target) published.add(name); else published.remove(name);
                        settings.put("studio_standby_models", allModelNames(row).stream().filter(m -> !published.contains(m)).toList());
                        JSONObject patch = routePatch(row, published, settings);
                        written.add(row);
                        Mono<Void> configure = row == target && targetProfile != null
                                ? Flux.fromIterable(configs).concatMap(config -> persistence.updateModelConfig(withProfile(config, targetProfile))).then()
                                : Mono.empty();
                        return configure.then(Mono.defer(() -> writeRoute(patch)));
                    }).then())
                            .thenReturn("ok").onErrorResume(error -> {
                                if (written.isEmpty()) return Mono.error(error);
                                // A timeout may have applied the last write. Restore it first, then prior primaries.
                                Collections.reverse(written);
                                return Flux.fromIterable(configs).concatMap(config -> persistence.updateModelConfig(withProfile(config, profile(config))))
                                        .thenMany(Flux.fromIterable(written).concatMap(row -> writeRoute(
                                        routePatch(row, publishedModels(row), routingSettings(row)))))
                                        .then(Mono.<String>error(error)).onErrorMap(rollbackError -> rollbackError == error ? error
                                                : invalid("渠道切换未完成，恢复配置也失败，请刷新主用 / 备用列表检查"));
                            });
                }));
    }

    static JSONObject routePatch(JSONObject row, Collection<String> published, JSONObject settings) {
        JSONObject body = JSONObject.of("id", row.getIntValue("id"), "type", row.getIntValue("type"), "name", row.getString("name"),
                "base_url", row.getString("base_url"), "models", String.join(",", published), "group", row.getString("group"),
                "priority", row.getIntValue("priority"), "weight", row.getIntValue("weight"),
                "model_mapping", row.getString("model_mapping"), "setting", settings.toJSONString());
        publishSelection(body, allModelNames(row), published, settings, activeGroups(row));
        return body;
    }

    private Mono<JSONObject> writeRoute(JSONObject patch) {
        return client.admin("PUT", "/api/channel/", patch)
                .then(client.admin("GET", "/api/channel/" + patch.getIntValue("id"), null)).map(response -> {
                    JSONObject saved = response.getJSONObject("data");
                    if (saved == null || !Objects.equals(saved.getString("models"), patch.getString("models"))
                            || !Objects.equals(saved.getString("group"), patch.getString("group")))
                        throw invalid("网关未保存预期的模型路由，已中止切换");
                    return response;
                });
    }

    static JSONObject profile(PersistenceDtos.ModelConfig config) {
        return JSONObject.of("capabilities", config.capabilities(), "videoBillingConfiguration", config.videoBillingConfiguration(),
                "customBodyParameters", config.customBodyParameters());
    }

    static PersistenceDtos.UpdateModelConfigRequest withProfile(PersistenceDtos.ModelConfig config, JSONObject profile) {
        JSONObject updated = JSON.parseObject(JSON.toJSONString(config));
        for (String key : List.of("capabilities", "videoBillingConfiguration", "customBodyParameters"))
            if (profile.containsKey(key)) updated.put(key, profile.get(key));
        return updated.toJavaObject(PersistenceDtos.UpdateModelConfigRequest.class);
    }

    public Mono<String> delete(int id) {
        return configurationChange(() -> client.admin("GET", "/api/channel/" + id, null)
                .flatMap(response -> protectChange(response.getJSONObject("data"), null))
                .then(Mono.defer(() -> client.admin("DELETE", "/api/channel/" + id, null))).thenReturn("ok"));
    }

    // One guard covers edits, removals, migration and model admission in this Studio instance.
    // Complete the read/check/write before another administrative change can start.
    private <T> Mono<T> configurationChange(Supplier<Mono<T>> action) {
        return Mono.using(() -> {
            if (!changing.compareAndSet(false, true)) throw invalid("渠道或模型配置正在更新，请稍后重试");
            return true;
        }, ignored -> Mono.defer(action), ignored -> changing.set(false), true);
    }

    private Mono<Void> protectChange(JSONObject before, JSONObject after) {
        if (before == null || before.getIntValue("id") <= 0) return Mono.error(invalid("无法读取渠道，未执行修改"));
        // Model publication is an administrator control, just like enable/disable.
        // Removing an alias only stops new requests; the concrete channel remains
        // available to poll submitted tasks. Availability filtering hides the alias.
        if (!affectsExecution(before, after)) return Mono.empty();
        return Mono.zip(persistence.listChannels(), persistence.listModelConfigs()).flatMap(tuple -> {
            Set<String> gatewayIds = new HashSet<>();
            tuple.getT1().stream().filter(c -> Objects.equals(c.baseUrl(), client.relayBaseUrl()))
                    .forEach(c -> gatewayIds.add(c.id()));
            List<PersistenceDtos.ModelConfig> connected = tuple.getT2().stream()
                    .filter(m -> gatewayIds.contains(m.channelId()) && allModelNames(before).contains(m.modelName())).toList();

            // Changing a protocol under a still-advertised alias can misroute requests even with a backup.
            if (after != null && !sameProtocol(before, after) && connected.stream()
                    .anyMatch(m -> modelNames(after.getString("models")).contains(m.modelName())))
                return Mono.error(invalid("该渠道有已接入模型，不能直接更换协议。请先新增并验证替代渠道，保留原对外模型名"));

            return Flux.fromIterable(connected).concatMap(m -> tasks.existsExecutableTasksByModelConfig(m.id()))
                    .any(Boolean.TRUE::equals).flatMap(running -> running
                            ? Mono.error(invalid("相关模型仍有排队或生成中的任务，请等待完成后修改或删除渠道")) : Mono.empty())
                    .then(noGatewayTasks(before.getIntValue("id")));
        });
    }

    private Mono<Void> noGatewayTasks(int id) {
        // Tasks bind a concrete channel; a replacement route cannot resume the old provider's task.
        return Flux.fromIterable(List.of("NOT_START", "SUBMITTED", "QUEUED", "IN_PROGRESS", "UNKNOWN"))
                .concatMap(status -> client.admin("GET", "/api/task?p=1&page_size=1&channel_id=" + id + "&status=" + status, null)
                        .map(response -> {
                            JSONObject data = response.getJSONObject("data");
                            if (data == null || !data.containsKey("total")) throw invalid("无法确认渠道任务状态，未执行修改");
                            return data.getLongValue("total") > 0;
                        }))
                .any(Boolean.TRUE::equals).flatMap(running -> running
                        ? Mono.error(invalid("此 New API 渠道仍有未完成任务，请等待完成后修改或删除")) : Mono.empty());
    }

    private Mono<List<JSONObject>> routingChannels(int page) {
        return client.admin("GET", "/api/channel/?p=" + page + "&page_size=100", null).flatMap(response -> {
            JSONObject data = response.getJSONObject("data");
            if (data == null || !data.containsKey("total") || data.getIntValue("total") > 10000)
                return Mono.error(invalid("无法完整检查替代渠道，未执行修改"));
            List<JSONObject> rows = objects(data.getJSONArray("items"));
            if (page * 100 >= data.getIntValue("total")) return Mono.just(rows);
            return routingChannels(page + 1).map(rest -> {
                List<JSONObject> all = new ArrayList<>(rows); all.addAll(rest); return all;
            });
        });
    }

    private static boolean sameProtocol(JSONObject a, JSONObject b) {
        return a.getIntValue("type") == b.getIntValue("type") && Objects.equals(pluginKey(a), pluginKey(b));
    }

    private static boolean routes(JSONObject channel, String name) {
        // setup-newapi.mjs creates Studio's relay token in the default group.
        return channel.getIntValue("status") == 1 && modelNames(channel.getString("group")).contains("default")
                && modelNames(channel.getString("models")).contains(name);
    }

    private static boolean affectsExecution(JSONObject before, JSONObject after) {
        if (after == null || !sameProtocol(before, after)) return true;
        if (before.getIntValue("status") == 1 && after.getIntValue("status") != 1) return true;
        if (after.containsKey("key") && !Objects.equals(before.getString("key"), after.getString("key"))) return true;
        if (!Objects.equals(before.getString("base_url"), after.getString("base_url"))) return true;
        JSONObject oldMap = before.getJSONObject("model_mapping"), newMap = after.getJSONObject("model_mapping");
        return allModelNames(before).stream().anyMatch(name ->
                !Objects.equals(mappedModel(oldMap, name), mappedModel(newMap, name)));
    }

    private static String mappedModel(JSONObject mapping, String name) {
        return mapping == null ? name : mapping.getString(name) == null ? name : mapping.getString(name);
    }

    public Mono<List<CatalogModel>> catalog() {
        return Mono.zip(client.models(), persistence.listModelConfigs(), persistence.listChannels()).map(tuple -> {
            Set<String> gatewayIds = new HashSet<>();
            tuple.getT3().stream().filter(c -> c.baseUrl().equals(client.relayBaseUrl())).forEach(c -> gatewayIds.add(c.id()));
            return objects(tuple.getT1().getJSONArray("data")).stream().map(o -> o.getString("id"))
                    .filter(Objects::nonNull).distinct().sorted().map(id -> new CatalogModel(id, tuple.getT2().stream()
                            .filter(m -> gatewayIds.contains(m.channelId()) && m.modelName().equals(id))
                            .map(PersistenceDtos.ModelConfig::modelType).distinct().toList())).toList();
        });
    }

    @Transactional
    public Mono<SyncResult> sync(SyncRequest input) {
        return configurationChange(() -> doSync(input));
    }

    private Mono<SyncResult> doSync(SyncRequest input) {
        List<String> names = cleanModels(input.models());
        Set<String> allowed = switch (input.modelType()) {
            case "text" -> Set.of("chat", "vision");
            case "image" -> Set.of("text-to-image", "image-to-image");
            case "video" -> Set.of("text-to-video", "image-to-video", "reference-to-video", "first-last-frame-to-video");
            case "audio" -> Set.of("text-to-speech");
            default -> throw invalid("模型类型不支持");
        };
        if (input.capabilities().isEmpty() || !allowed.containsAll(input.capabilities())) throw invalid("请选择该类型支持的模型能力");
        if (input.setDefault() && names.size() != 1) throw invalid("设置默认时只能选择一个模型");
        VideoBillingConfiguration billing = null;
        if ("video".equals(input.modelType())) {
            Set<String> resolutions = Set.of("480P", "720P", "768P", "1080P", "2K", "4K");
            if (input.resolutions() == null || input.resolutions().isEmpty() || !resolutions.containsAll(input.resolutions()))
                throw invalid("请选择视频模型支持的分辨率");
            Map<String, Map<String, Integer>> prices = new LinkedHashMap<>();
            for (String mode : input.capabilities()) {
                Map<String, Integer> perResolution = new LinkedHashMap<>();
                input.resolutions().forEach(res -> perResolution.put(res.toLowerCase(Locale.ROOT), input.creditCost()));
                prices.put(mode, perResolution);
            }
            billing = new VideoBillingConfiguration("second", 1, prices);
        }
        final VideoBillingConfiguration videoBilling = billing;
        String gatewayId = GATEWAY_PREFIX + input.modelType();
        return Mono.zip(catalog(), persistence.listChannels(), persistence.listModelConfigs()).flatMap(tuple -> {
            Set<String> available = new HashSet<>(tuple.getT1().stream().map(CatalogModel::id).toList());
            if (!available.containsAll(names)) return Mono.error(invalid("部分模型已不在 New API 可用列表，请刷新后重试"));
            AiChannelConfig gateway = tuple.getT2().stream().filter(c -> c.id().equals(gatewayId)).findFirst().orElse(null);
            LinkedHashSet<String> all = new LinkedHashSet<>(gateway == null ? List.of() : gateway.models());
            all.addAll(names); // Never prune prices/capabilities of previously connected models on refresh.
            var request = new PersistenceDtos.ChannelMutationRequest(gatewayId, "New API · " + input.modelType(),
                    client.relayBaseUrl(), client.relayKey(), "text".equals(input.modelType()) ? "openai" : "newapi",
                    List.copyOf(all), 0);
            Mono<AiChannelConfig> saved = gateway == null ? persistence.createChannel(request) : persistence.updateChannel(request);
            int[] counts = new int[2];
            return saved.thenMany(Flux.fromIterable(names).concatMap(name -> {
                var existing = tuple.getT2().stream()
                        .filter(c -> c.baseUrl().equals(client.relayBaseUrl())).map(AiChannelConfig::id).toList();
                var model = tuple.getT3().stream().filter(m -> existing.contains(m.channelId())
                        && m.modelName().equals(name) && m.modelType().equals(input.modelType())).findFirst();
                Mono<PersistenceDtos.ModelConfig> result;
                if (model.isPresent()) { counts[1]++; result = Mono.just(model.get()); }
                else {
                    counts[0]++;
                    result = persistence.createModelConfig(new PersistenceDtos.CreateModelConfigRequest(gatewayId, name, input.modelType(),
                            input.capabilities(), 0, input.creditCost(), false, "high",
                            "video".equals(input.modelType()) ? "second" : "generation", 5, new JSONObject(),
                            videoBilling, name, null, false, null));
                }
                // 语音是新类型，后台通常还没有默认项；没有默认时把首个接入的设为默认，否则前端拿不到可用语音模型。
                boolean firstAudioDefault = "audio".equals(input.modelType()) && name.equals(names.getFirst())
                        && tuple.getT3().stream().noneMatch(m -> "audio".equals(m.modelType()) && Boolean.TRUE.equals(m.defaultModel()));
                return result.flatMap(m -> input.setDefault() || firstAudioDefault
                        ? persistence.setDefaultModel(new PersistenceDtos.SetDefaultModelRequest(m.id(), m.modelType())).thenReturn(m)
                        : Mono.just(m));
            })).then(Mono.fromSupplier(() -> new SyncResult(counts[0], counts[1])));
        });
    }

    public Mono<List<Importable>> importable() {
        return Mono.zip(persistence.listChannels(), persistence.listModelConfigs(), migrationIds()).map(tuple ->
                tuple.getT1().stream().filter(c -> !c.id().startsWith(GATEWAY_PREFIX)).map(c -> {
                    boolean migrated = tuple.getT3().contains(c.id());
                    boolean supported = canImport(c, tuple.getT2());
                    return new Importable(c.id(), c.name(), c.apiFormat(), c.models().size(), supported, migrated,
                            migrated ? "已由 New API 接管，可恢复直连" : supported ? "保留模型配置、默认项和积分"
                                    : "存在自定义请求模板或缺少模型，暂不能自动迁移");
                }).toList());
    }

    static boolean canImport(AiChannelConfig channel, List<PersistenceDtos.ModelConfig> models) {
        if (channel.models().isEmpty() || models.stream().anyMatch(m -> m.channelId().equals(channel.id()) && Boolean.TRUE.equals(m.isCustomModel()))) return false;
        if (videoPlugin(channel, models) != null && models.stream().anyMatch(m -> m.channelId().equals(channel.id()) && !"video".equals(m.modelType()))) return false;
        return Set.of("newapi", "openai").contains(channel.apiFormat()) || VIDEO_PROTOCOLS.contains(channel.apiFormat());
    }

    static String videoPlugin(AiChannelConfig channel, List<PersistenceDtos.ModelConfig> models) {
        if (VIDEO_PROTOCOLS.contains(channel.apiFormat()) || ("openai".equals(channel.apiFormat()) && models.stream()
                .anyMatch(m -> m.channelId().equals(channel.id()) && "video".equals(m.modelType())))) return "studio-" + channel.apiFormat();
        return null;
    }

    @Transactional
    public Mono<String> migrate(String id, boolean restore) {
        return configurationChange(() -> restore ? restore(id) : importChannel(id));
    }

    private Mono<Void> noRunningTasks(String id) {
        return persistence.listModelConfigs().flatMapMany(Flux::fromIterable).filter(m -> m.channelId().equals(id))
                .concatMap(m -> tasks.existsExecutableTasksByModelConfig(m.id())).any(Boolean.TRUE::equals)
                .flatMap(running -> running ? Mono.error(invalid("该渠道仍有生成任务，请等待完成后切换")) : Mono.empty());
    }

    private Mono<String> importChannel(String id) {
        return noRunningTasks(id).then(Mono.zip(persistence.listChannels(), persistence.listModelConfigs(), migrationIds())).flatMap(tuple -> {
            if (tuple.getT3().contains(id)) return Mono.just("already_imported");
            AiChannelConfig source = tuple.getT1().stream().filter(c -> c.id().equals(id)).findFirst().orElseThrow(() -> invalid("渠道不存在"));
            if (source.baseUrl().equals(client.relayBaseUrl()) || !canImport(source, tuple.getT2())) return Mono.error(invalid("该渠道不能自动迁移"));
            String tag = "inspire-import:" + id;
            String plugin = videoPlugin(source, tuple.getT2());
            return allChannels(1).flatMap(channels -> {
                var existing = channels.stream().filter(c -> tag.equals(c.tag())).findFirst();
                Mono<?> imported;
                if (existing.isPresent()) {
                    int expectedType = plugin != null ? 61 : "newapi".equals(source.apiFormat()) ? 60 : 1;
                    if (existing.get().status() != 1 || !existing.get().models().containsAll(source.models())
                            || existing.get().type() != expectedType || !Objects.equals(existing.get().pluginKey(), plugin))
                        return Mono.error(invalid("已存在的迁入渠道已变更，请检查启用状态、原模型和协议插件后重试"));
                    imported = Mono.just(existing.get());
                } else {
                    JSONObject upstream = channelBody(new SaveChannel(null, source.name(), plugin != null ? 61 : "newapi".equals(source.apiFormat()) ? 60 : 1,
                            source.baseUrl(), source.apiKey(), source.models(), 0, 1, "{}", plugin));
                    upstream.put("tag", tag); upstream.put("status", 1);
                    imported = client.admin("POST", "/api/channel/", JSONObject.of("mode", "single", "channel", upstream));
                }
                return imported.then(database.sql("SELECT sort_order FROM platform_ai_channels WHERE channel_id=:id")
                        .bind("id", id).map(row -> row.get("sort_order", Integer.class)).one().defaultIfEmpty(0))
                        .flatMap(sort -> {
                            var original = new PersistenceDtos.ChannelMutationRequest(id, source.name(), source.baseUrl(),
                                    source.apiKey(), source.apiFormat(), source.models(), sort);
                            String backup = SensitiveDataCrypto.encrypt(JSON.toJSONString(original), properties.getApp().getSecretKey());
                            return database.sql("INSERT INTO new_api_channel_migrations(channel_id, original_config_encrypted) VALUES(:id,:backup)")
                                    .bind("id", id).bind("backup", backup).fetch().rowsUpdated()
                                    .then(persistence.updateChannel(new PersistenceDtos.ChannelMutationRequest(id, source.name(),
                                            client.relayBaseUrl(), client.relayKey(), source.apiFormat(), source.models(), sort)));
                        }).thenReturn("ok");
            });
        });
    }

    private Mono<String> restore(String id) {
        return noRunningTasks(id).then(database.sql("SELECT original_config_encrypted FROM new_api_channel_migrations WHERE channel_id=:id")
                .bind("id", id).map(row -> row.get("original_config_encrypted", String.class)).one())
                .switchIfEmpty(Mono.error(invalid("没有可恢复的直连配置")))
                .flatMap(encrypted -> {
                    var original = JSON.parseObject(SensitiveDataCrypto.decrypt(encrypted, properties.getApp().getSecretKey()), PersistenceDtos.ChannelMutationRequest.class);
                    return persistence.listChannels().flatMap(channels -> {
                        var current = channels.stream().filter(c -> c.id().equals(id)).findFirst().orElseThrow(() -> invalid("渠道不存在"));
                        LinkedHashSet<String> retained = new LinkedHashSet<>(current.models()); retained.addAll(original.models());
                        return persistence.updateChannel(new PersistenceDtos.ChannelMutationRequest(id, original.name(), original.baseUrl(),
                                original.apiKey(), original.apiFormat(), List.copyOf(retained), original.sortOrder()));
                    });
                }).then(database.sql("DELETE FROM new_api_channel_migrations WHERE channel_id=:id").bind("id", id).fetch().rowsUpdated()).thenReturn("ok");
    }

    private Mono<List<String>> migrationIds() {
        return database.sql("SELECT channel_id FROM new_api_channel_migrations").map(row -> row.get("channel_id", String.class)).all().collectList();
    }
    private Mono<List<Channel>> allChannels(int page) {
        return channels(page, 100, "").flatMap(result -> {
            if (result.total() > 10000) return Mono.error(invalid("渠道数量超过简洁管理页处理上限"));
            if (page * 100 >= result.total()) return Mono.just(result.items());
            return allChannels(page + 1).map(rest -> { List<Channel> all = new ArrayList<>(result.items()); all.addAll(rest); return all; });
        });
    }
    static String normalizeUpstreamUrl(String value) {
        try {
            URI uri = URI.create(value.trim());
            if (!Set.of("http", "https").contains(uri.getScheme()) || uri.getHost() == null
                    || uri.getUserInfo() != null || uri.getRawQuery() != null || uri.getFragment() != null) throw new IllegalArgumentException();
            return value.trim().replaceAll("/+$", "").replaceAll("/v1$", "");
        } catch (Exception e) { throw invalid("请填写有效的 HTTP(S) 服务地址，不要包含密钥或查询参数"); }
    }
    static List<String> modelNames(String value) { return value == null ? List.of() : cleanModels(Arrays.asList(value.split(","))); }
    static List<String> cleanModels(List<String> values) {
        return values.stream().filter(Objects::nonNull).map(String::trim).filter(s -> !s.isBlank()).distinct().toList();
    }
    private static List<String> modelResponse(JSONObject response) {
        JSONArray data = response.getJSONArray("data");
        return data == null ? List.of() : cleanModels(data.toJavaList(String.class));
    }
    private static List<JSONObject> objects(JSONArray array) { return array == null ? List.of() : array.toJavaList(JSONObject.class); }
    private static String encode(String value) { return URLEncoder.encode(value, StandardCharsets.UTF_8); }
    static BusinessException invalid(String message) { return new BusinessException(ErrorCode.PARAM_INVALID, message); }
}
