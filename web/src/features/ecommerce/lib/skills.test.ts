import assert from "node:assert/strict";
import test from "node:test";
import { resolveCommerceSkill } from "./skills.ts";
import type { CommerceSkill } from "../api/skills.ts";

const skill = (id: string, patch: Partial<CommerceSkill> = {}): CommerceSkill => ({
    id,
    revision: 1,
    name: id,
    description: "",
    type: "text",
    platforms: ["taobao"],
    outputTypes: ["copy"],
    systemPrompt: "",
    status: 1,
    sortOrder: 1,
    createdAt: "",
    updatedAt: "",
    ...patch,
});
test("automatic recommendation uses the ordered enabled matching catalog", () => {
    const result = resolveCommerceSkill([skill("disabled", { status: 0 }), skill("wrong-platform", { platforms: ["jd"] }), skill("wrong-output", { outputTypes: ["detail-copy"] }), skill("recommended"), skill("alternative")], "taobao", "copy");
    assert.equal(result.selected?.id, "recommended");
    assert.deepEqual(
        result.available.map((s) => s.id),
        ["recommended", "alternative"],
    );
});
test("saved explicit selection overrides the recommendation and uses current revision", () => {
    assert.equal(resolveCommerceSkill([skill("first"), skill("saved", { revision: 3 })], "taobao", "copy", "saved").selected?.revision, 3);
});
test("disabled deleted or incompatible saved skills block instead of silently changing technique", () => {
    for (const saved of [skill("saved", { status: 0 }), skill("saved", { platforms: ["jd"] }), skill("saved", { outputTypes: ["detail-copy"] })]) {
        const result = resolveCommerceSkill([skill("fallback"), saved], "taobao", "copy", "saved");
        assert.equal(result.selected, undefined);
        assert.match(result.issue, /重新选择/);
    }
    assert.equal(resolveCommerceSkill([skill("fallback")], "taobao", "copy", "missing").selected, undefined);
});
test("empty matching catalog cannot submit a skill-less creation", () => {
    const result = resolveCommerceSkill([], "taobao", "copy");
    assert.equal(result.selected, undefined);
    assert.match(result.issue, /暂无/);
});
