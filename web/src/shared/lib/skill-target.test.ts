import assert from "node:assert/strict";
import test from "node:test";
import { filterSkillsForTarget } from "./skill-target.ts";

test("图片、视频和画布技能分别筛选，分页总数只包含对应类型", () => {
    const skills = [
        { id: 1, name: "视频封面", targetType: "image" },
        { id: 2, name: "参考视频复刻", targetType: "video" },
        { id: 3, name: "角色设定", targetType: "canvasSettingGraph" },
        { id: 4, name: "错误类型", targetType: "unknown" },
    ];
    assert.deepEqual(filterSkillsForTarget(skills, "image"), [skills[0]]);
    assert.deepEqual(filterSkillsForTarget(skills, "video"), [skills[1]]);
    assert.deepEqual(filterSkillsForTarget(skills, "canvasSettingGraph"), [skills[2]]);
    assert.equal(skills.length, 4);
    assert.deepEqual(filterSkillsForTarget([], "image"), []);
});
