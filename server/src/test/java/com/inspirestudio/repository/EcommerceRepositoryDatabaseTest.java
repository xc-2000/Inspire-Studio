package com.inspirestudio.repository;

import static org.junit.jupiter.api.Assertions.*;

import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.dto.EcommerceDtos;
import com.inspirestudio.dto.EcommerceSkillDtos;
import io.r2dbc.spi.ConnectionFactories;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.core.io.ClassPathResource;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.r2dbc.connection.R2dbcTransactionManager;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Flux;

/** Only the explicitly named disposable test database may run these destructive schema fixtures. */
@EnabledIfEnvironmentVariable(named = "ECOMMERCE_TEST_R2DBC_URL", matches = "r2dbc:postgresql://postgres@ecommerce-backend-test-db:5432/ecommerce_test")
class EcommerceRepositoryDatabaseTest {
    DatabaseClient db;
    EcommerceRepository repository;
    EcommerceSkillRepository skills;

    @BeforeEach void setup() throws Exception {
        var factory = ConnectionFactories.get(System.getenv("ECOMMERCE_TEST_R2DBC_URL"));
        db = DatabaseClient.create(factory);
        repository = new EcommerceRepository(db, TransactionalOperator.create(new R2dbcTransactionManager(factory)));
        skills = new EcommerceSkillRepository(db);
        for (String sql : List.of("DROP TABLE IF EXISTS ecommerce_skills,ecommerce_jobs,ecommerce_projects,user_credit_transactions,users CASCADE",
                "CREATE TABLE users(id BIGINT PRIMARY KEY)", "INSERT INTO users VALUES(1),(2)",
                "CREATE TABLE user_credit_transactions(generation_source TEXT CONSTRAINT ck_user_credit_transactions_generation_source CHECK(generation_source IN ('canvas')))")
        ) run(sql);
        for (String resource : List.of("V52__Ecommerce_Workspace.sql", "V53__Ecommerce_Skills.sql")) {
            try (var input = new ClassPathResource("db/migration/" + resource).getInputStream()) {
                String migration = new String(input.readAllBytes(), StandardCharsets.UTF_8);
                for (String sql : migration.replaceAll("(?m)--[^\\r\\n]*", "").split(";")) if (!sql.isBlank()) run(sql);
            }
        }
    }

    @Test void paginationOwnershipAndRevisionConflicts() {
        create(1L, "a", "jd", "项目_100%"); create(1L, "b", "jd", "项目二"); create(1L, "c", "taobao", "项目三"); create(2L, "foreign", "jd", "其他用户");
        var page = repository.listProjects(1L, 1, 1, "jd", "").block();
        assertEquals(2, page.total()); assertEquals(1, page.items().size());
        assertEquals(1, repository.listProjects(1L, 1, 20, "", "_100%").block().total());
        assertThrows(BusinessException.class, () -> repository.getProject(2L, "a").block());
        var updated = repository.saveProject(1L, save("a", 1, "jd", "更新")).block(); assertEquals(2, updated.revision());
        assertThrows(BusinessException.class, () -> repository.saveProject(1L, save("a", 1, "jd", "过期")).block());
        assertThrows(BusinessException.class, () -> repository.saveProject(2L, save("a", 2, "jd", "越权")).block());
        assertThrows(BusinessException.class, () -> repository.deleteProject(1L, "a", 1).block());
        assertThrows(BusinessException.class, () -> repository.deleteProject(2L, "a", 2).block());
        assertEquals("更新", repository.getProject(1L, "a").block().title());
        repository.deleteProject(1L, "a", 2).block();
        assertThrows(BusinessException.class, () -> repository.getProject(1L, "a").block());
    }

    @Test void concurrentReservationsAcquireExactlyOnceAndOnlyOwnerCanAttach() {
        create(1L, "a", "jd", "项目");
        var request = new EcommerceDtos.GenerateRequest("a", "request", "copy", "", "", Map.of());
        var reservations = Flux.range(0, 12).flatMap(i -> repository.reserveJob(1L, request, JSONObject.from(request)), 12).collectList().block(Duration.ofSeconds(20));
        assertEquals(1, reservations.stream().filter(EcommerceRepository.Reservation::acquired).count());
        assertEquals(1, reservations.stream().map(reservation -> reservation.stored().job().id()).distinct().count());
        String jobId = reservations.getFirst().stored().job().id();
        assertThrows(BusinessException.class, () -> repository.attachTask(2L, jobId, "foreign-task").block());
        repository.attachTask(1L, jobId, "task").block();
        assertEquals("task", repository.findJob(1L, "a", "request").block().job().taskId());
        assertNull(repository.findJob(2L, "a", "request").block());
        assertThrows(BusinessException.class, () -> repository.reserveJob(2L, request, JSONObject.from(request)).block());
        assertEquals(1, repository.listJobs(1L, "a").count().block());
        assertEquals(0, repository.listJobs(2L, "a").count().block());
    }

    @Test void sourceMigrationAcceptsCommerceAndExistingSources() {
        for (String source : List.of("ecommerce", "imagePage", "videoPage", "canvas", "storyboard"))
            db.sql("INSERT INTO user_credit_transactions VALUES(:source)").bind("source", source).fetch().rowsUpdated().block();
        assertThrows(RuntimeException.class, () -> run("INSERT INTO user_credit_transactions VALUES('unknown')"));
    }

    @Test void skillCatalogScopesPaginationOptimisticUpdatesAndSoftDeletion() {
        var initial = skills.save(skillSave("copy", null, "文案_100%", "text", List.of("taobao", "jd"), List.of("copy"), 1, 10)).block();
        skills.save(skillSave("image", null, "商品主图", "image", List.of("taobao"), List.of("hero"), 1, 0)).block();
        skills.save(skillSave("disabled", null, "停用文案", "text", List.of("taobao"), List.of("copy"), 0, 0)).block();
        assertEquals(1, skills.listEnabled("taobao", "copy", "").count().block());
        assertEquals(0, skills.listEnabled("douyin", "copy", "").count().block());
        assertEquals("image", skills.listEnabled("taobao", "", "").blockFirst().id());
        assertEquals(1, skills.listAdmin("_100%", "", null, 1, 20).block().total());
        assertEquals(3, skills.listAdmin("", "", null, 1, 1).block().total());
        assertEquals(1, skills.listAdmin("", "", null, 1, 1).block().items().size());
        var revised = skills.save(skillSave("copy", initial.revision(), "更新文案", "text", List.of("jd"), List.of("copy"), 1, 10)).block();
        assertEquals(2, revised.revision());
        assertThrows(BusinessException.class, () -> skills.setStatus("copy", 1, 0).block());
        assertThrows(BusinessException.class, () -> skills.delete("copy", 1).block());
        var disabled = skills.setStatus("copy", 2, 0).block();
        assertEquals(3, disabled.revision());
        assertEquals(0, skills.listEnabled("jd", "copy", "").count().block());
        skills.delete("copy", 3).block();
        assertThrows(BusinessException.class, () -> skills.get("copy").block());
        assertEquals(2, skills.listAdmin("", "", null, 1, 20).block().total());
        assertEquals(1L, db.sql("SELECT count(*) AS n FROM ecommerce_skills WHERE id='copy' AND deleted").map((r, m) -> r.get("n", Long.class)).one().block());
    }

    @Test void jobSnapshotsRemainStableAfterSkillChangesAndAreOwnerScoped() {
        create(1L, "a", "taobao", "商品");
        var original = skills.save(skillSave("copy", null, "初始技能", "text", List.of("taobao"), List.of("copy"), 1, 0)).block();
        var request = new EcommerceDtos.GenerateRequest("a", "req", "copy", "", "", Map.of(), "copy", 1);
        var reserved = repository.reserveJob(1L, request, JSONObject.from(request)).block();
        String jobId = reserved.stored().job().id();
        assertThrows(BusinessException.class, () -> repository.saveSkillSnapshot(2L, jobId, original).block());
        var snapshot = repository.saveSkillSnapshot(1L, jobId, original).block();
        assertEquals("copy", snapshot.skillId()); assertEquals("初始技能", snapshot.skillName()); assertEquals(1, snapshot.skillRevision());
        assertThrows(BusinessException.class, () -> repository.saveSkillSnapshot(1L, jobId, original).block());
        repository.attachTask(1L, jobId, "task").block();
        skills.save(skillSave("copy", 1, "新技能", "text", List.of("taobao"), List.of("copy"), 0, 0)).block();
        skills.delete("copy", 2).block();
        var retried = repository.reserveJob(1L, request, JSONObject.from(request)).block();
        assertFalse(retried.acquired());
        assertEquals("初始技能", retried.stored().job().skillName());
        assertEquals(1, repository.listJobs(1L, "a").blockFirst().skillRevision());
    }

    @Test void seededCatalogCoversEveryPlatformAndOutputAndDoesNotMixMediaContracts() throws Exception {
        for (String resource : List.of("V54__Seed_Ecommerce_Skills.sql", "V55__Expand_Ecommerce_Skills.sql")) {
            try (var input = new ClassPathResource("db/migration/" + resource).getInputStream()) {
                run(new String(input.readAllBytes(), StandardCharsets.UTF_8));
            }
        }
        assertEquals(60, skills.listAdmin("", "", null, 1, 100).block().total());
        assertEquals(26, skills.listAdmin("", "text", null, 1, 100).block().total());
        assertEquals(20, skills.listAdmin("", "image", null, 1, 100).block().total());
        assertEquals(14, skills.listAdmin("", "video", null, 1, 100).block().total());
        var all = skills.listAdmin("", "", null, 1, 100).block().items();
        assertEquals(60, all.stream().map(EcommerceSkillDtos.Skill::name).distinct().count());
        assertEquals(60, all.stream().map(EcommerceSkillDtos.Skill::systemPrompt).distinct().count());
        for (String platform : List.of("taobao", "jd", "pinduoduo", "douyin", "xiaohongshu")) {
            for (String output : List.of("copy", "detail-copy", "video-script", "hero", "scene", "detail", "video")) {
                var matches = skills.listEnabled(platform, output, "").collectList().block();
                assertTrue(matches.size() >= 6, platform + "/" + output + " requires distinct creative choices");
                for (var skill : matches) {
                    assertFalse(skill.systemPrompt().isBlank());
                    assertEquals(1, skill.revision());
                    if ("video".equals(output)) { assertEquals("video", skill.type()); assertTrue(skill.systemPrompt().length() < 1500); }
                    if (List.of("hero", "scene", "detail").contains(output)) assertEquals("image", skill.type());
                }
            }
        }
        // Existing skills remain the automatic defaults, rather than changing saved project behavior.
        assertEquals("commerce-copy-fabe", skills.listEnabled("taobao", "copy", "").blockFirst().id());
        var original = skills.get("commerce-copy-fabe").block();
        skills.save(skillSave(original.id(), original.revision(), "管理员保留的自定义技能", "text", List.of("taobao"), List.of("copy"), 0, 3)).block();
        var expanded = all.stream().filter(skill -> skill.sortOrder() >= 130).findFirst().orElseThrow();
        skills.delete(expanded.id(), expanded.revision()).block();
        // A rerun must neither overwrite administrators' choices nor resurrect deleted skills.
        try (var input = new ClassPathResource("db/migration/V55__Expand_Ecommerce_Skills.sql").getInputStream()) {
            run(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
        assertEquals("管理员保留的自定义技能", skills.get(original.id()).block().name());
        assertEquals(0, skills.get(original.id()).block().status());
        assertThrows(BusinessException.class, () -> skills.get(expanded.id()).block());
        assertEquals(59, skills.listAdmin("", "", null, 1, 100).block().total());
    }

    private EcommerceSkillDtos.SaveRequest skillSave(String id, Integer revision, String name, String type, List<String> platforms, List<String> outputs, int status, int sort) {
        return new EcommerceSkillDtos.SaveRequest(id, revision, name, "说明", type, platforms, outputs, "服务器技能正文", status, sort);
    }

    private void create(Long uid, String id, String platform, String title) { repository.saveProject(uid, save(id, 0, platform, title)).block(); }
    private EcommerceDtos.SaveProjectRequest save(String id, int revision, String platform, String title) {
        return new EcommerceDtos.SaveProjectRequest(id, revision, platform, title, JSONObject.of("product", JSONObject.of("name", "商品"), "references", List.of()));
    }
    private void run(String sql) { db.sql(sql).fetch().rowsUpdated().block(Duration.ofSeconds(10)); }
}
