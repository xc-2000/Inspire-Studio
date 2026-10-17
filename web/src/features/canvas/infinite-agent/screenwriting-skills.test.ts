import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { SkillOption } from "@/services/api/server";
import { loadCanvasAgentSkills, MAX_SKILL_GROUP_ROOT_CHARACTERS } from "./skill-library";
import { createCanvasAgentSkillDiscovery } from "./skill-discovery";
import { CANVAS_AGENT_TOOLS } from "./upstream/canvas-agent-tools";

const root = new URL("../../../../../", import.meta.url);
const sql = await readFile(new URL("server/src/main/resources/db/migration/V56__Import_Screenwriting_Skills.sql", root), "utf8");
const records = JSON.parse(sql.split("$screenwriting$")[1]) as Array<{
    import_key: string; name: string; description: string; target_type: "video"; system_prompt: string; aspect_ratio: string;
}>;
const report = JSON.parse(await readFile(new URL("third-party/skills/screenwriting/import-report.json", root), "utf8"));
const catalogue: SkillOption[] = records.map((record, index) => ({
    id: index + 1, name: record.name, description: record.description, targetType: record.target_type,
    systemPrompt: record.system_prompt, aspectRatio: record.aspect_ratio, coverUrl: "",
}));
const fetchSkill = async (id: number) => {
    const skill = catalogue.find((entry) => entry.id === id);
    assert.ok(skill);
    return skill;
};

test("five distinct screenplay skills preserve every source definition and companion guide", async () => {
    assert.equal(records.length, 5);
    assert.equal(new Set(records.map((record) => record.import_key)).size, 5);
    for (const item of report.skills) {
        const record = records.find((entry) => entry.import_key === item.importKey);
        assert.ok(record);
        assert.equal(record.target_type, "video");
        assert.equal(createHash("sha256").update(record.system_prompt).digest("hex"), item.promptSha256);
        assert.equal(item.files.length, 2);
        for (const file of item.files) {
            const bytes = await readFile(new URL(`third-party/skills/screenwriting/${file.path}`, root));
            assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
            assert.ok(record.system_prompt.includes(bytes.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim()));
        }
        assert.match(record.system_prompt, /当前用户要求、已确认的剧情\/角色\/素材/);
        assert.match(record.system_prompt, /不要把完整剧本直接当作一段视频/);
        assert.match(record.system_prompt, /不得硬编码为当前渠道能力/);
    }
    assert.equal(report.attachmentCount, 28);
    for (const file of report.sourceFiles) {
        const bytes = await readFile(new URL(`third-party/skills/screenwriting/${file.path}`, root));
        assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    }
});

test("all five skills load together and their complete guides can be reconstructed without truncation", async () => {
    const library = await loadCanvasAgentSkills(catalogue, fetchSkill, { tools: CANVAS_AGENT_TOOLS });
    assert.equal(library.activeSkillContents.length, 5);
    assert.ok(library.activeSkillContents.reduce((sum, skill) => sum + skill.content.length, 0) <= MAX_SKILL_GROUP_ROOT_CHARACTERS);
    assert.ok(library.unreadRequiredFiles.length > 0, "large Seedance definition should use the lazy reader");
    for (const skill of catalogue) {
        const files = library.fileManifest.filter((file) => file.skillId === String(skill.id));
        assert.equal(files.length, 2);
        const content = files.map((file) => file.paths.map((path) => {
            const result = library.readSkillFile({ skillId: String(skill.id), path });
            assert.equal(result.ok, true);
            assert.equal(result.readOnly, true);
            return result.content;
        }).join("")).join("");
        assert.equal(content, skill.systemPrompt);
    }
    assert.deepEqual(library.unreadRequiredFiles, []);
});

test("Agent discovers the collection and activates actual catalogue IDs with complete content", async () => {
    const discovery = await createCanvasAgentSkillDiscovery({ fetchCatalogue: async () => catalogue, fetchSkill, tools: CANVAS_AGENT_TOOLS });
    const result = await discovery.executeTool("search_skills", { query: "剧本合集", targetType: "video" });
    assert.equal(result.ok, true);
    const matches = result.skills as Array<{ id: number; available: boolean }>;
    assert.equal(matches.length, 5);
    assert.ok(matches.every((skill) => skill.available));
    const activation = await discovery.executeTool("activate_skills", { skillIds: matches.map((skill) => skill.id) });
    assert.equal(activation.ok, true);
    assert.equal(discovery.currentSelections.length, 5);
    assert.equal(discovery.source, "auto");
    const imageResults = await discovery.executeTool("search_skills", { query: "剧本合集", targetType: "image" });
    assert.deepEqual(imageResults.skills, []);
});
