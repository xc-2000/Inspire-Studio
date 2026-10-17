package com.inspirestudio.controller;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.common.ApiResponse;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.repository.PersistenceRepository;
import com.inspirestudio.security.CurrentUserProvider;
import java.util.List;
import java.util.Set;
import lombok.RequiredArgsConstructor;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;

/** Durable canvas templates, immutable versions and revision-checked execution journals. */
@RestController
@RequestMapping("/api/v1/canvas/workspace")
@RequiredArgsConstructor
public class CanvasWorkspaceController {
    private final DatabaseClient db;
    private final CurrentUserProvider users;
    private final PersistenceRepository projects;
    public record Query(String kind, String projectId, String search, String scope, Integer page, Integer pageSize) {}
    public record Save(String id, String kind, String projectId, String title, String visibility, Integer revision, JSONObject data) {}
    public record Id(String id) {}
    public record Entry(String id, String kind, String projectId, String title, String visibility, int revision,
                        JSONObject data, String createdAt, String updatedAt, boolean owned) {}
    public record Page(List<Entry> items, long total) {}
    private static final String COLUMNS = "id, user_id, kind, project_id, title, visibility, revision, data::text AS payload, created_at::text AS created, updated_at::text AS updated";

    @PostMapping("/list")
    public Mono<ApiResponse<Page>> list(@RequestBody Query request) {
        checkKind(request.kind());
        int page = Math.max(1, request.page() == null ? 1 : request.page());
        int size = Math.clamp(request.pageSize() == null ? 20 : request.pageSize(), 1, 100);
        boolean publicTemplates = "public".equals(request.scope()) && "template".equals(request.kind());
        return users.currentUserId().flatMap(uid -> {
            String filter = " WHERE kind = :kind AND " + (publicTemplates ? "visibility = 'public'" : "user_id = :uid")
                + " AND (:project = '' OR project_id = :project) AND title ILIKE :search";
            var rows = query("SELECT " + COLUMNS + " FROM canvas_workspace_records" + filter + " ORDER BY updated_at DESC, id LIMIT :limit OFFSET :offset", request, uid, publicTemplates)
                .bind("limit", size).bind("offset", (long)(page - 1) * size).map((row, meta) -> entry(row, uid)).all().collectList();
            var count = query("SELECT count(*) AS total FROM canvas_workspace_records" + filter, request, uid, publicTemplates)
                .map((row, meta) -> row.get("total", Long.class)).one();
            return Mono.zip(rows, count).map(values -> ApiResponse.ok(new Page(values.getT1(), values.getT2())));
        });
    }

    @PostMapping("/get")
    public Mono<ApiResponse<Entry>> get(@RequestBody Id request) {
        return users.currentUserId().flatMap(uid -> db.sql("SELECT " + COLUMNS + " FROM canvas_workspace_records WHERE id=:id AND (user_id=:uid OR (kind='template' AND visibility='public'))")
            .bind("id", request.id()).bind("uid", uid).map((row, meta) -> entry(row, uid)).one().switchIfEmpty(missing()).map(ApiResponse::ok));
    }

    @PostMapping("/save")
    public Mono<ApiResponse<Entry>> save(@RequestBody Save request) {
        validate(request);
        return users.currentUserId().flatMap(uid -> {
            Mono<Void> permission = "template".equals(request.kind()) ? Mono.empty() : projects.getProject(uid, request.projectId()).switchIfEmpty(missing()).then();
            if ("run".equals(request.kind()) && (request.revision() == null || request.revision() == 0)) {
                permission = permission.then(db.sql("UPDATE canvas_workspace_records SET data=jsonb_set(data,'{status}','\"stopped\"'::jsonb), revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE user_id=:uid AND project_id=:project AND kind='run' AND data->>'status'='running' AND updated_at < CURRENT_TIMESTAMP - INTERVAL '2 minutes'")
                    .bind("uid", uid).bind("project", request.projectId()).fetch().rowsUpdated().then());
            }
            String sql = "INSERT INTO canvas_workspace_records(id,user_id,kind,project_id,title,visibility,data) VALUES (:id,:uid,:kind,:project,:title,:visibility,CAST(:data AS jsonb)) ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title, visibility=EXCLUDED.visibility, data=EXCLUDED.data, revision=canvas_workspace_records.revision+1, updated_at=CURRENT_TIMESTAMP WHERE canvas_workspace_records.user_id=:uid AND canvas_workspace_records.kind=EXCLUDED.kind AND canvas_workspace_records.project_id=EXCLUDED.project_id AND canvas_workspace_records.kind <> 'version' AND canvas_workspace_records.revision=:revision RETURNING " + COLUMNS;
            return permission.then(db.sql(sql).bind("id", request.id()).bind("uid", uid).bind("kind", request.kind())
                .bind("project", "template".equals(request.kind()) ? "" : request.projectId()).bind("title", request.title().trim())
                .bind("visibility", "template".equals(request.kind()) && "public".equals(request.visibility()) ? "public" : "private")
                .bind("data", request.data().toJSONString()).bind("revision", request.revision() == null ? 0 : request.revision())
                .map((row, meta) -> entry(row, uid)).one().switchIfEmpty(Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR, "记录已更新或不可修改，请刷新后重试"))))
                .onErrorMap(org.springframework.dao.DuplicateKeyException.class, error -> new BusinessException(ErrorCode.BUSINESS_ERROR, "此画布在其他页面有运行中的工作流；若页面已关闭，请两分钟后重试"))
                .map(ApiResponse::ok);
        });
    }

    @PostMapping("/delete")
    public Mono<ApiResponse<String>> delete(@RequestBody Id request) {
        return users.currentUserId().flatMap(uid -> db.sql("DELETE FROM canvas_workspace_records WHERE id=:id AND user_id=:uid")
            .bind("id", request.id()).bind("uid", uid).fetch().rowsUpdated()).thenReturn(ApiResponse.ok("ok"));
    }

    private DatabaseClient.GenericExecuteSpec query(String sql, Query request, Long uid, boolean publicTemplates) {
        var spec = db.sql(sql).bind("kind", request.kind()).bind("project", request.projectId() == null ? "" : request.projectId())
            .bind("search", "%" + (request.search() == null ? "" : request.search().replace("%", "\\%").replace("_", "\\_")) + "%");
        return publicTemplates ? spec : spec.bind("uid", uid);
    }
    private Entry entry(io.r2dbc.spi.Row row, Long uid) {
        return new Entry(row.get("id", String.class), row.get("kind", String.class), row.get("project_id", String.class), row.get("title", String.class),
            row.get("visibility", String.class), row.get("revision", Integer.class), JSON.parseObject(row.get("payload", String.class)),
            row.get("created", String.class), row.get("updated", String.class), uid.equals(row.get("user_id", Long.class)));
    }
    static void validate(Save request) {
        checkKind(request.kind());
        if (request.id() == null || !request.id().matches("[a-zA-Z0-9_-]{1,100}") || request.title() == null || request.title().isBlank() || request.title().length() > 200 || request.data() == null)
            throw new BusinessException(ErrorCode.PARAM_INVALID, "记录名称或内容无效");
        if (!"template".equals(request.kind()) && (request.projectId() == null || request.projectId().isBlank()))
            throw new BusinessException(ErrorCode.PARAM_INVALID, "请选择画布项目");
        if (request.data().toJSONString().length() > 8_000_000) throw new BusinessException(ErrorCode.PARAM_INVALID, "内容超过 8 MB，请先将素材保存到对象存储");
        if ("template".equals(request.kind()) && (request.data().getJSONArray("nodes") == null || request.data().getJSONArray("connections") == null))
            throw new BusinessException(ErrorCode.PARAM_INVALID, "模板缺少节点或连线");
        if ("version".equals(request.kind()) && request.data().getJSONObject("scene") == null)
            throw new BusinessException(ErrorCode.PARAM_INVALID, "版本缺少画布内容");
    }
    private static void checkKind(String kind) {
        if (kind == null || !Set.of("template", "version", "run").contains(kind)) throw new BusinessException(ErrorCode.PARAM_INVALID, "不支持的画布记录类型");
    }
    private static <T> Mono<T> missing() { return Mono.error(new BusinessException(ErrorCode.RESOURCE_NOT_FOUND, "画布记录不存在或无权访问")); }
}
