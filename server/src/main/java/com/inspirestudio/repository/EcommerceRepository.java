package com.inspirestudio.repository;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.dto.EcommerceDtos;
import com.inspirestudio.dto.EcommerceSkillDtos;
import io.r2dbc.spi.Row;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** All project and job access is scoped to the authenticated owner. */
@Repository
@RequiredArgsConstructor
public class EcommerceRepository {
    private final DatabaseClient db;
    private final TransactionalOperator transaction;
    private static final String PROJECT_COLUMNS = "id, platform, title, data::text AS payload, revision, created_at::text AS created, updated_at::text AS updated";
    private static final String JOB_COLUMNS = "id, task_id, kind, variant, platform, skill_id, skill_name, skill_revision, request_data::text AS request_payload, failure_message, created_at::text AS created";

    public record StoredJob(EcommerceDtos.Job job, JSONObject request, String failureMessage) {}
    public record Reservation(EcommerceDtos.Project project, StoredJob stored, boolean acquired) {}

    public Mono<EcommerceDtos.ProjectPage> listProjects(Long userId, int page, int size, String platform, String keyword) {
        String filter = " WHERE user_id=:uid AND (:platform='' OR platform=:platform) AND title ILIKE :keyword";
        String search = "%" + keyword.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
        var rows = db.sql("SELECT " + PROJECT_COLUMNS + " FROM ecommerce_projects" + filter + " ORDER BY updated_at DESC, id LIMIT :limit OFFSET :offset")
                .bind("uid", userId).bind("platform", platform).bind("keyword", search)
                .bind("limit", size).bind("offset", (long) (page - 1) * size).map((r, m) -> project(r)).all().collectList();
        var count = db.sql("SELECT count(*) AS total FROM ecommerce_projects" + filter)
                .bind("uid", userId).bind("platform", platform).bind("keyword", search)
                .map((r, m) -> r.get("total", Long.class)).one();
        return Mono.zip(rows, count).map(pair -> new EcommerceDtos.ProjectPage(pair.getT1(), pair.getT2(), page, size));
    }

    public Mono<EcommerceDtos.Project> getProject(Long userId, String id) {
        return selectProject(userId, id, false).switchIfEmpty(missing());
    }

    private Mono<EcommerceDtos.Project> selectProject(Long userId, String id, boolean lock) {
        return db.sql("SELECT " + PROJECT_COLUMNS + " FROM ecommerce_projects WHERE user_id=:uid AND id=:id" + (lock ? " FOR UPDATE" : ""))
                .bind("uid", userId).bind("id", id).map((r, m) -> project(r)).one();
    }

    public Mono<EcommerceDtos.Project> saveProject(Long userId, EcommerceDtos.SaveProjectRequest request) {
        boolean create = request.revision() == null || request.revision() == 0;
        String sql = create
                ? "INSERT INTO ecommerce_projects(id,user_id,platform,title,data) VALUES(:id,:uid,:platform,:title,CAST(:data AS jsonb)) ON CONFLICT(id) DO NOTHING RETURNING " + PROJECT_COLUMNS
                : "UPDATE ecommerce_projects SET platform=:platform,title=:title,data=CAST(:data AS jsonb),revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=:id AND user_id=:uid AND revision=:revision RETURNING " + PROJECT_COLUMNS;
        var query = db.sql(sql).bind("id", request.id()).bind("uid", userId).bind("platform", request.platform())
                .bind("title", request.title()).bind("data", request.data().toJSONString());
        if (!create) query = query.bind("revision", request.revision());
        Mono<EcommerceDtos.Project> conflict = create ? conflict() : getProject(userId, request.id()).flatMap(ignored -> conflict());
        return query.map((r, m) -> project(r)).one().switchIfEmpty(conflict);
    }

    public Mono<Void> deleteProject(Long userId, String id, int revision) {
        return db.sql("DELETE FROM ecommerce_projects WHERE id=:id AND user_id=:uid AND revision=:revision")
                .bind("id", id).bind("uid", userId).bind("revision", revision).fetch().rowsUpdated()
                .flatMap(rows -> rows > 0 ? Mono.empty() : getProject(userId, id).flatMap(ignored -> EcommerceRepository.<Void>conflict()));
    }

    /** The short reservation transaction commits before any task is enqueued or any provider is called. */
    public Mono<Reservation> reserveJob(Long userId, EcommerceDtos.GenerateRequest request, JSONObject fingerprint) {
        return selectProject(userId, request.projectId(), true).switchIfEmpty(missing()).flatMap(project ->
                findJob(userId, request.projectId(), request.requestId())
                        .map(existing -> new Reservation(project, existing, false))
                        .switchIfEmpty(Mono.defer(() -> db.sql("""
                                INSERT INTO ecommerce_jobs(id,user_id,project_id,request_id,kind,variant,platform,request_data)
                                VALUES(:id,:uid,:project,:request,:kind,:variant,:platform,CAST(:payload AS jsonb)) RETURNING
                                """ + JOB_COLUMNS)
                                .bind("id", UUID.randomUUID().toString()).bind("uid", userId).bind("project", project.id())
                                .bind("request", request.requestId()).bind("kind", request.kind()).bind("variant", request.variant())
                                .bind("platform", project.platform()).bind("payload", fingerprint.toJSONString())
                                .map((r, m) -> new Reservation(project, storedJob(r), true)).one())))
                .as(transaction::transactional);
    }

    public Mono<StoredJob> findJob(Long userId, String projectId, String requestId) {
        return db.sql("SELECT " + JOB_COLUMNS + " FROM ecommerce_jobs WHERE user_id=:uid AND project_id=:project AND request_id=:request")
                .bind("uid", userId).bind("project", projectId).bind("request", requestId).map((r, m) -> storedJob(r)).one();
    }

    public Mono<Void> attachTask(Long userId, String jobId, String taskId) {
        return db.sql("UPDATE ecommerce_jobs SET task_id=:task WHERE id=:id AND user_id=:uid AND task_id IS NULL AND failure_message IS NULL")
                .bind("task", taskId).bind("id", jobId).bind("uid", userId).fetch().rowsUpdated()
                .flatMap(rows -> rows == 1 ? Mono.empty() : Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR, "电商任务关联失败，请刷新项目后重试")));
    }

    public Mono<EcommerceDtos.Job> saveSkillSnapshot(Long userId, String jobId, EcommerceSkillDtos.Skill skill) {
        return db.sql("UPDATE ecommerce_jobs SET skill_id=:skill,skill_name=:name,skill_revision=:revision WHERE id=:id AND user_id=:uid AND task_id IS NULL AND failure_message IS NULL AND skill_id IS NULL RETURNING " + JOB_COLUMNS)
                .bind("skill", skill.id()).bind("name", skill.name()).bind("revision", skill.revision())
                .bind("id", jobId).bind("uid", userId).map((r, m) -> storedJob(r).job()).one()
                .switchIfEmpty(Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR, "技能记录保存失败，请刷新项目后重试")));
    }

    public Mono<Void> markFailed(Long userId, String jobId, String message) {
        String detail = message == null || message.isBlank() ? "任务创建未完成，请重新发起生成" : message;
        return db.sql("UPDATE ecommerce_jobs SET failure_message=:message WHERE id=:id AND user_id=:uid AND task_id IS NULL AND failure_message IS NULL")
                .bind("message", detail.substring(0, Math.min(500, detail.length()))).bind("id", jobId).bind("uid", userId)
                .fetch().rowsUpdated().then();
    }

    public Flux<EcommerceDtos.Job> listJobs(Long userId, String projectId) {
        return db.sql("SELECT " + JOB_COLUMNS + " FROM ecommerce_jobs WHERE user_id=:uid AND project_id=:project AND task_id IS NOT NULL ORDER BY created_at DESC, id")
                .bind("uid", userId).bind("project", projectId).map((r, m) -> storedJob(r).job()).all();
    }

    private EcommerceDtos.Project project(Row row) {
        return new EcommerceDtos.Project(row.get("id", String.class), row.get("platform", String.class), row.get("title", String.class),
                JSON.parseObject(row.get("payload", String.class)), row.get("revision", Integer.class), row.get("created", String.class), row.get("updated", String.class));
    }

    private StoredJob storedJob(Row row) {
        var job = new EcommerceDtos.Job(row.get("id", String.class), row.get("task_id", String.class), row.get("kind", String.class),
                row.get("variant", String.class), row.get("platform", String.class), row.get("created", String.class),
                row.get("skill_id", String.class), row.get("skill_name", String.class), row.get("skill_revision", Integer.class));
        return new StoredJob(job, JSON.parseObject(row.get("request_payload", String.class)), row.get("failure_message", String.class));
    }

    private static <T> Mono<T> missing() { return Mono.error(new BusinessException(ErrorCode.RESOURCE_NOT_FOUND, "电商项目不存在或无权访问")); }
    private static <T> Mono<T> conflict() { return Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR, "项目已被其他页面更新，请刷新后重试")); }
}
