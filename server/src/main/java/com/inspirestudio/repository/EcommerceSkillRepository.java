package com.inspirestudio.repository;

import com.alibaba.fastjson2.JSON;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.dto.EcommerceSkillDtos;
import io.r2dbc.spi.Row;
import lombok.RequiredArgsConstructor;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Repository
@RequiredArgsConstructor
public class EcommerceSkillRepository {
    private final DatabaseClient db;
    private static final String COLUMNS = "id,revision,name,description,type,platforms::text AS platforms_payload,output_types::text AS outputs_payload,system_prompt,status,sort_order,created_at::text AS created,updated_at::text AS updated";

    public Flux<EcommerceSkillDtos.Skill> listEnabled(String platform, String output, String keyword) {
        return db.sql("SELECT " + COLUMNS + " FROM ecommerce_skills WHERE NOT deleted AND status=1"
                        + " AND (:platform='' OR platforms @> CAST(:platform_json AS jsonb))"
                        + " AND (:output='' OR output_types @> CAST(:output_json AS jsonb))"
                        + " AND (name ILIKE :keyword OR description ILIKE :keyword) ORDER BY sort_order,id")
                .bind("platform", platform).bind("platform_json", JSON.toJSONString(java.util.List.of(platform)))
                .bind("output", output).bind("output_json", JSON.toJSONString(java.util.List.of(output)))
                .bind("keyword", search(keyword)).map((r, m) -> skill(r)).all();
    }

    public Mono<EcommerceSkillDtos.SkillPage> listAdmin(String keyword, String type, Integer status, int page, int size) {
        String filter = " FROM ecommerce_skills WHERE NOT deleted AND (:type='' OR type=:type) AND (:status=-1 OR status=:status) AND (name ILIKE :keyword OR description ILIKE :keyword)";
        var rows = db.sql("SELECT " + COLUMNS + filter + " ORDER BY sort_order,id LIMIT :limit OFFSET :offset")
                .bind("type", type).bind("status", status == null ? -1 : status).bind("keyword", search(keyword))
                .bind("limit", size).bind("offset", (long) (page - 1) * size).map((r, m) -> skill(r)).all().collectList();
        var count = db.sql("SELECT count(*) AS total" + filter)
                .bind("type", type).bind("status", status == null ? -1 : status).bind("keyword", search(keyword))
                .map((r, m) -> r.get("total", Long.class)).one();
        return Mono.zip(rows, count).map(pair -> new EcommerceSkillDtos.SkillPage(pair.getT1(), pair.getT2()));
    }

    public Mono<EcommerceSkillDtos.Skill> get(String id) {
        return db.sql("SELECT " + COLUMNS + " FROM ecommerce_skills WHERE id=:id AND NOT deleted")
                .bind("id", id).map((r, m) -> skill(r)).one().switchIfEmpty(missing());
    }

    public Mono<EcommerceSkillDtos.Skill> save(EcommerceSkillDtos.SaveRequest request) {
        boolean create = request.revision() == null || request.revision() == 0;
        String sql = create
                ? "INSERT INTO ecommerce_skills(id,name,description,type,platforms,output_types,system_prompt,status,sort_order) VALUES(:id,:name,:description,:type,CAST(:platforms AS jsonb),CAST(:outputs AS jsonb),:prompt,:status,:sort) ON CONFLICT(id) DO NOTHING RETURNING " + COLUMNS
                : "UPDATE ecommerce_skills SET name=:name,description=:description,type=:type,platforms=CAST(:platforms AS jsonb),output_types=CAST(:outputs AS jsonb),system_prompt=:prompt,status=:status,sort_order=:sort,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=:id AND revision=:revision AND NOT deleted RETURNING " + COLUMNS;
        var query = db.sql(sql).bind("id", request.id()).bind("name", request.name()).bind("description", request.description())
                .bind("type", request.type()).bind("platforms", JSON.toJSONString(request.platforms()))
                .bind("outputs", JSON.toJSONString(request.outputTypes())).bind("prompt", request.systemPrompt())
                .bind("status", request.status()).bind("sort", request.sortOrder());
        if (!create) query = query.bind("revision", request.revision());
        return query.map((r, m) -> skill(r)).one().switchIfEmpty(create ? conflict() : get(request.id()).flatMap(ignored -> conflict()));
    }

    public Mono<EcommerceSkillDtos.Skill> setStatus(String id, int revision, int status) {
        return db.sql("UPDATE ecommerce_skills SET status=:status,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=:id AND revision=:revision AND NOT deleted RETURNING " + COLUMNS)
                .bind("id", id).bind("revision", revision).bind("status", status).map((r, m) -> skill(r)).one()
                .switchIfEmpty(get(id).flatMap(ignored -> conflict()));
    }

    public Mono<Void> delete(String id, int revision) {
        return db.sql("UPDATE ecommerce_skills SET deleted=TRUE,status=0,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=:id AND revision=:revision AND NOT deleted")
                .bind("id", id).bind("revision", revision).fetch().rowsUpdated()
                .flatMap(count -> count == 1 ? Mono.empty() : get(id).flatMap(ignored -> EcommerceSkillRepository.<Void>conflict()));
    }

    private static EcommerceSkillDtos.Skill skill(Row r) {
        return new EcommerceSkillDtos.Skill(r.get("id", String.class), r.get("revision", Integer.class), r.get("name", String.class),
                r.get("description", String.class), r.get("type", String.class), JSON.parseArray(r.get("platforms_payload", String.class), String.class),
                JSON.parseArray(r.get("outputs_payload", String.class), String.class), r.get("system_prompt", String.class),
                r.get("status", Short.class).intValue(), r.get("sort_order", Integer.class), r.get("created", String.class), r.get("updated", String.class));
    }
    private static String search(String value) { return "%" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"; }
    private static <T> Mono<T> missing() { return Mono.error(new BusinessException(ErrorCode.RESOURCE_NOT_FOUND, "电商技能不存在或已删除，请重新选择")); }
    private static <T> Mono<T> conflict() { return Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR, "技能已被更新，请刷新后重试")); }
}
