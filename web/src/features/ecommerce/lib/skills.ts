import type { CommerceSkill } from "../api/skills";
import type { CommercePlatform } from "./catalog";

/** Never silently replace an explicitly selected skill after an admin disables or changes its scope. */
export function resolveCommerceSkill(skills: CommerceSkill[], platform: CommercePlatform, outputType: string, selectedId?: string) {
    const available = skills.filter((skill) => skill.status === 1 && skill.platforms.includes(platform) && skill.outputTypes.includes(outputType));
    const selected = selectedId ? available.find((skill) => skill.id === selectedId) : available[0];
    return {
        available,
        selected,
        issue: selected ? "" : selectedId ? "所选技能已停用、删除或不再适用，请重新选择" : "此平台和创作类型暂无可用技能，请联系管理员配置",
    };
}
