package com.inspirestudio.service;

import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.dto.EcommerceSkillDtos;
import com.inspirestudio.repository.EcommerceSkillRepository;
import com.inspirestudio.security.AdminGuard;
import com.inspirestudio.security.CurrentUserProvider;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

@Service
@RequiredArgsConstructor
public class EcommerceSkillService {
    private static final Set<String> PLATFORMS = Set.of("taobao", "jd", "pinduoduo", "douyin", "xiaohongshu");
    private static final Map<String, String> OUTPUT_TYPES = Map.of("copy", "text", "detail-copy", "text", "video-script", "text", "hero", "image", "scene", "image", "detail", "image", "video", "video");
    private final EcommerceSkillRepository repository;
    private final CurrentUserProvider users;
    private final AdminGuard admins;

    public Mono<EcommerceSkillDtos.SkillList> listUser(String platform, String outputType, String keyword) {
        return users.currentUserId().flatMap(uid -> Mono.defer(() -> {
            String p = text(platform, 20, "平台", false), o = text(outputType, 20, "创作类型", false);
            if (!p.isEmpty() && !PLATFORMS.contains(p)) throw invalid("请选择支持的电商平台");
            if (!o.isEmpty() && !OUTPUT_TYPES.containsKey(o)) throw invalid("不支持的创作类型");
            return repository.listEnabled(p, o, text(keyword, 200, "关键词", false)).collectList().map(EcommerceSkillDtos.SkillList::new);
        }));
    }

    public Mono<EcommerceSkillDtos.SkillPage> listAdmin(EcommerceSkillDtos.ListRequest request) {
        return admins.requireAdmin().flatMap(admin -> Mono.defer(() -> {
            if (request == null) throw invalid("列表参数不能为空");
            String type = text(request.type(), 10, "技能分类", false);
            if ("all".equals(type)) type = "";
            if (!type.isEmpty() && !Set.of("text", "image", "video").contains(type)) throw invalid("技能分类不合法");
            if (request.status() != null) status(request.status());
            return repository.listAdmin(text(request.keyword(), 200, "关键词", false), type, request.status(),
                    Math.max(1, request.page() == null ? 1 : request.page()), Math.clamp(request.pageSize() == null ? 20 : request.pageSize(), 1, 100));
        }));
    }

    public Mono<EcommerceSkillDtos.Skill> save(EcommerceSkillDtos.SaveRequest request) {
        return admins.requireAdmin().flatMap(admin -> Mono.defer(() -> repository.save(normalize(request))));
    }

    public Mono<EcommerceSkillDtos.Skill> setStatus(EcommerceSkillDtos.StatusRequest request) {
        return admins.requireAdmin().flatMap(admin -> Mono.defer(() -> {
            if (request == null) throw invalid("技能参数不能为空");
            return repository.setStatus(identifier(request.id()), revision(request.revision()), status(request.status()));
        }));
    }

    public Mono<Void> delete(EcommerceSkillDtos.DeleteRequest request) {
        return admins.requireAdmin().flatMap(admin -> Mono.defer(() -> {
            if (request == null) throw invalid("技能参数不能为空");
            return repository.delete(identifier(request.id()), revision(request.revision()));
        }));
    }

    /** Only saved, enabled, compatible server instructions can enter a paid generation. */
    public Mono<EcommerceSkillDtos.Skill> resolveForGeneration(String id, Integer expectedRevision, String platform, String kind, String variant) {
        return Mono.defer(() -> {
            String output = "image".equals(kind) ? variant : kind;
            Mono<EcommerceSkillDtos.Skill> selected = id == null || id.isBlank()
                    ? repository.listEnabled(platform, output, "").next().switchIfEmpty(Mono.error(invalid("当前平台与创作类型没有可用技能，请联系管理员配置")))
                    : repository.get(identifier(id));
            return selected.map(skill -> {
                if (skill.status() != 1) throw invalid("该技能已停用，请重新选择");
                if (!skill.platforms().contains(platform) || !skill.outputTypes().contains(output)
                        || !skill.type().equals(OUTPUT_TYPES.get(output))) throw invalid("该技能不适用于当前平台或创作类型，请重新选择");
                if (expectedRevision != null && skill.revision() != expectedRevision) throw invalid("技能内容已更新，请刷新技能列表后重试");
                if (skill.systemPrompt() == null || skill.systemPrompt().isBlank()) throw invalid("技能内容为空，请联系管理员配置");
                return skill;
            });
        });
    }

    static EcommerceSkillDtos.SaveRequest normalize(EcommerceSkillDtos.SaveRequest request) {
        if (request == null) throw invalid("技能参数不能为空");
        String id = request.id() == null || request.id().isBlank() ? UUID.randomUUID().toString() : identifier(request.id());
        if (request.revision() != null && request.revision() < 0) throw invalid("技能版本不合法");
        String type = text(request.type(), 10, "技能分类", true);
        if (!Set.of("text", "image", "video").contains(type)) throw invalid("技能分类不合法");
        List<String> platforms = scope(request.platforms(), PLATFORMS, "适用平台");
        List<String> outputs = scope(request.outputTypes(), OUTPUT_TYPES.keySet(), "创作类型");
        if (outputs.stream().anyMatch(output -> !type.equals(OUTPUT_TYPES.get(output)))) throw invalid("创作类型与技能分类不一致");
        int sort = request.sortOrder() == null ? 0 : request.sortOrder();
        if (sort < 0 || sort > 100000) throw invalid("排序应在0到100000之间");
        return new EcommerceSkillDtos.SaveRequest(id, request.revision(), text(request.name(), 100, "技能名称", true),
                text(request.description(), 600, "技能说明", false), type, platforms, outputs,
                text(request.systemPrompt(), 12000, "技能正文", true), status(request.status()), sort);
    }
    private static List<String> scope(List<String> values, Set<String> allowed, String label) {
        if (values == null || values.isEmpty() || values.size() > allowed.size() || values.stream().anyMatch(value -> value == null || !allowed.contains(value))) throw invalid("请选择有效的" + label);
        return values.stream().distinct().toList();
    }
    private static int status(Integer value) { if (value == null || value < 0 || value > 1) throw invalid("技能状态不合法"); return value; }
    private static int revision(Integer value) { if (value == null || value < 1) throw invalid("请提供当前技能版本"); return value; }
    private static String identifier(String value) { if (value == null || !value.matches("[a-zA-Z0-9_-]{1,100}")) throw invalid("技能标识不合法"); return value; }
    private static String text(String value, int max, String label, boolean required) {
        String normalized = value == null ? "" : value.trim();
        if (normalized.length() > max) throw invalid(label + "过长，最多" + max + "字符");
        if (required && normalized.isBlank()) throw invalid("请填写" + label);
        return normalized;
    }
    private static BusinessException invalid(String message) { return new BusinessException(ErrorCode.PARAM_INVALID, message); }
}
