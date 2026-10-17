import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { SkillOption, SkillType } from "@/services/api/server";
import type { CanvasAgentSkillSelection } from "../types";
import { CANVAS_AGENT_TOOLS } from "./upstream/canvas-agent-tools";
import { CanvasAgentSkillLoadError, loadCanvasAgentSkills, MAX_SKILL_FILE_CHARACTERS, MAX_SKILL_GROUP_ROOT_CHARACTERS, MAX_SKILL_ROOT_CHARACTERS, type CanvasAgentSkillLibrary } from "./skill-library";

function detail(id: number, systemPrompt = "完整创作正文", targetType: SkillType = "image"): SkillOption {
    return { id, name: `实时技能${id}`, description: "介绍", targetType, coverUrl: "", systemPrompt, aspectRatio: "16:9" };
}

function selection(id: number, targetType: SkillType = "image"): CanvasAgentSkillSelection {
    return { id, name: `旧技能${id}`, targetType };
}

function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }

function reconstruct(library: CanvasAgentSkillLibrary, skillId: string) {
    return library.fileManifest.filter((file) => file.skillId === skillId).map((file) => file.paths.map((path, index) => {
        const result = library.readSkillFile({ skillId, path });
        assert.equal(result.ok, true);
        assert.equal(result.readOnly, true);
        assert.equal(result.part, index + 1);
        assert.equal(result.sourcePath, file.sourcePath);
        assert.ok(typeof result.content === "string");
        assert.ok(result.content.length <= MAX_SKILL_FILE_CHARACTERS);
        assert.ok(typeof result.hostConstraints === "string" && result.hostConstraints.includes("不执行脚本"));
        assert.equal(result.nextPath, file.paths[index + 1]);
        return result.content;
    }).join("")).join("");
}

test("no selection leaves the upstream default skills active without fetching any detail", async () => {
    let requests = 0;
    const library = await loadCanvasAgentSkills(undefined, async () => { requests += 1; return detail(1); });
    assert.equal(requests, 0);
    assert.deepEqual(library.activeSkillContents, []);
    assert.equal(library.hasFiles, false);
    assert.equal(library.readSkillFile({ skillId: "1", path: "SKILL.md" }).code, "skill_not_loaded");
});

test("skill IDs are deduplicated in selection order and revalidated on every submitted run", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const fetchSkill = async (id: number, targetType: SkillType, signal?: AbortSignal) => {
        assert.equal(signal, controller.signal);
        calls.push(`${id}:${targetType}`);
        return detail(id, `完整正文${calls.length}`, targetType);
    };
    const selected = [selection(2, "video"), selection(1), selection(2, "video")];
    const first = await loadCanvasAgentSkills(selected, fetchSkill, { signal: controller.signal });
    const second = await loadCanvasAgentSkills(selected, fetchSkill, { signal: controller.signal });
    assert.deepEqual(calls, ["2:video", "1:image", "2:video", "1:image"]);
    assert.deepEqual(first.activeSkillContents.map((skill) => skill.id), ["2", "1"]);
    assert.deepEqual(first.activeSkillContents.map((skill) => skill.name), ["实时技能2", "实时技能1"]);
    assert.ok(second.activeSkillContents[0].content.includes("完整正文3"));
});

test("five unique selections are allowed and invalid or excessive selections fail before fetching", async () => {
    let requests = 0;
    const fetchSkill = async (id: number) => { requests += 1; return detail(id); };
    const selected = Array.from({ length: 5 }, (_, index) => selection(index + 1));
    const library = await loadCanvasAgentSkills([...selected, selection(1)], fetchSkill);
    assert.equal(library.activeSkillContents.length, 5);
    assert.equal(requests, 5);
    for (const invalid of [[...selected, selection(6)], [selection(0)], [selection(1), selection(1, "video")]]) {
        await assert.rejects(loadCanvasAgentSkills(invalid, fetchSkill), CanvasAgentSkillLoadError);
    }
    assert.equal(requests, 5);
});

test("small skill bodies stay complete and host output and capability constraints surround legacy instructions", async () => {
    const source = "# 创作技能\n只能返回CreationPlan；去画布；调用MCP或python scripts/render.py。\n首尾帧创意与产品文字应逐字保留。\n### 文件：assets/style.txt\n原始参考文本";
    const tools = CANVAS_AGENT_TOOLS.filter((tool) => ["get_node", "edit_image"].includes(tool.function.name));
    const library = await loadCanvasAgentSkills([selection(1)], async () => detail(1, source), { tools });
    const loaded = library.activeSkillContents[0];
    assert.equal(library.hasFiles, true);
    assert.equal(loaded.hasFiles, true);
    assert.match(library.selectionContext, /和画布节点选择互相独立/);
    assert.match(library.selectionContext, /read_skill_file/);
    assert.equal(loaded.source, "system");
    assert.ok(loaded.content.includes(source));
    assert.ok(loaded.content.startsWith("【当前画布宿主执行约束】"));
    assert.ok(loaded.content.endsWith("不能声称启用了技能提到的私有模型或专用服务。"));
    assert.ok(loaded.content.includes("可用工具：get_node、edit_image"));
    assert.ok(loaded.content.includes("旧CreationPlan"));
    assert.ok(loaded.content.includes("不执行脚本、MCP、CLI"));
    assert.ok(loaded.content.includes("当前真实节点"));
});

test("a registered first-last-frame workflow is blocked by metadata while ordinary matching creative text remains usable", async () => {
    await assert.rejects(loadCanvasAgentSkills([selection(2, "video")], async () => ({ ...detail(2, "专用流程", "video"), workflowType: "first-last-frame" })), (error) => {
        assert.ok(error instanceof CanvasAgentSkillLoadError);
        assert.equal(error.code, "workflow_requires_video_entry");
        assert.match(error.message, /视频创作入口/);
        return true;
    });
    const library = await loadCanvasAgentSkills([selection(2, "video")], async () => detail(2, "为首尾帧创作画面和运镜提示词", "video"));
    assert.ok(library.activeSkillContents[0].content.includes("为首尾帧创作画面和运镜提示词"));
});

test("missing, stale, or mismatched details cannot silently fall back to other skills", async () => {
    const invalid = [detail(2), detail(1, "正文", "video"), detail(1, "  ")];
    for (const skill of invalid) await assert.rejects(loadCanvasAgentSkills([selection(1)], async () => skill), CanvasAgentSkillLoadError);
    await assert.rejects(loadCanvasAgentSkills([selection(1), selection(2)], async (id) => {
        if (id === 2) throw new Error("技能不存在或已停用");
        return detail(id);
    }), /加载失败.*技能不存在或已停用/);
});

test("cancelled skill loading neither starts a request nor yields a partially loaded library", async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    let requests = 0;
    await assert.rejects(loadCanvasAgentSkills([selection(1)], async () => { requests += 1; return detail(1); }, { signal: alreadyAborted.signal }), { name: "AbortError" });
    assert.equal(requests, 0);
    const duringLoad = new AbortController();
    await assert.rejects(loadCanvasAgentSkills([selection(1)], async () => { duringLoad.abort(); return detail(1); }, { signal: duringLoad.signal }), { name: "AbortError" });
});

test("long embedded files use bounded read-only parts that reconstruct every original character", async () => {
    const source = "旧平台适配前缀\r\n### 文件：SKILL.md\r\n# 核心创作\r\n" + "保留镜头与对白。".repeat(4_000)
        + "\r\n### 文件：references/guide.md\r\n# 风格依据\r\n" + "保持人物身份。".repeat(3_000)
        + "\r\n### 文件：scripts/render.py\r\n" + "print('仅为源代码文本')\n".repeat(800) + "\n原平台协议后缀。";
    const library = await loadCanvasAgentSkills([selection(1)], async () => detail(1, source));
    assert.equal(library.hasFiles, true);
    assert.equal(library.activeSkillContents[0].hasFiles, true);
    assert.ok(library.activeSkillContents[0].content.length <= MAX_SKILL_ROOT_CHARACTERS);
    assert.ok(library.activeSkillContents[0].content.includes("尚未展开"));
    assert.ok(!library.activeSkillContents[0].content.includes("print('仅为源代码文本')"));
    const first = library.readSkillFile({ skillId: "1", path: "SKILL.md" });
    assert.equal(first.fullyRead, false);
    assert.equal(first.skillFullyRead, false);
    assert.equal(first.nextPath, "SKILL.part-002.md");
    assert.equal(digest(reconstruct(library, "1")), digest(source));
    const last = library.fileManifest.at(-1)!.paths.at(-1)!;
    assert.equal(library.readSkillFile({ skillId: "1", path: last }).skillFullyRead, true);
});

test("the reader only serves exact current-skill registry paths", async () => {
    const library = await loadCanvasAgentSkills([selection(1)], async () => detail(1, "正".repeat(30_000)));
    for (const path of ["../SKILL.md", "/etc/passwd", "C:\\local\\SKILL.md", "scripts\\test.py", "%2e%2e/SKILL.md", "SKILL.md?x=1", "./SKILL.md", " SKILL.md"]) {
        assert.equal(library.readSkillFile({ skillId: "1", path }).code, "invalid_skill_file_path");
    }
    assert.equal(library.readSkillFile({ skillId: "2", path: "SKILL.md" }).code, "skill_not_loaded");
    assert.equal(library.readSkillFile({ skillId: "1", path: "skill.md" }).code, "skill_file_not_found");
    assert.equal(library.readSkillFile({ skillId: "1", path: "SKILL.md", command: "run" }).code, "invalid_skill_file_path");
    assert.equal(library.readSkillFile({ skillId: "1", path: "SKILL.md" }).ok, true);
});

test("duplicate source names, part-path collisions, and unsafe original names preserve all data", async () => {
    const source = "### 文件：SKILL.md\n" + "根".repeat(14_000)
        + "\n### 文件：SKILL.part-002.md\n实际独立文件\n"
        + "### 文件：references/same.md\n内容一\n"
        + "### 文件：references/same.md\n内容二\n"
        + "### 文件：../../assets/example.txt\n这里只是原始路径标记，不读取本机。";
    const library = await loadCanvasAgentSkills([selection(1)], async () => detail(1, source));
    const paths = library.fileManifest.flatMap((file) => file.paths);
    assert.equal(new Set(paths).size, paths.length);
    assert.equal(digest(reconstruct(library, "1")), digest(source));
    assert.ok(paths.every((path) => !path.split("/").includes("..")));
    assert.equal(library.readSkillFile({ skillId: "1", path: "../../assets/example.txt" }).ok, false);
});

test("Unicode parts do not split a surrogate pair and preserve the complete source", async () => {
    const source = "x".repeat(11_999) + "🎥" + "镜头".repeat(8_000);
    const library = await loadCanvasAgentSkills([selection(1)], async () => detail(1, source));
    const first = library.readSkillFile({ skillId: "1", path: "SKILL.md" });
    assert.ok(typeof first.content === "string" && !/[\uD800-\uDBFF]$/.test(first.content));
    const second = library.readSkillFile({ skillId: "1", path: String(first.nextPath) });
    assert.ok(typeof second.content === "string" && !/^[\uDC00-\uDFFF]/.test(second.content));
    assert.equal(digest(reconstruct(library, "1")), digest(source));
});

test("large directories are also paged without dropping file names or exceeding the root budget", async () => {
    const source = "### 文件：SKILL.md\n# 创作入口\n按需读取参考。\n"
        + Array.from({ length: 400 }, (_, index) => `### 文件：references/guide-${index}-${"a".repeat(60)}.md\n# 风格${index}\n完整参考内容${index}\n`).join("");
    const library = await loadCanvasAgentSkills([selection(1)], async () => detail(1, source));
    const root = library.activeSkillContents[0].content;
    assert.ok(root.length <= MAX_SKILL_ROOT_CHARACTERS);
    const indexPath = root.match(/__skill_index__\/files-\d+\.md/)?.[0];
    assert.ok(indexPath);
    let path: string | undefined = indexPath;
    let directory = "";
    while (path) {
        const result = library.readSkillFile({ skillId: "1", path });
        assert.equal(result.ok, true);
        directory += result.content;
        path = typeof result.nextPath === "string" ? result.nextPath : undefined;
    }
    assert.ok(directory.includes("风格0"));
    assert.ok(directory.includes("风格399"));
    assert.equal(digest(reconstruct(library, "1")), digest(source));
});

test("unread required main-file parts shrink after successful reads and reset for a fresh library", async () => {
    const source = "根".repeat(25_000);
    const load = () => loadCanvasAgentSkills([selection(1)], async () => detail(1, source));
    const library = await load();
    const initial = ["SKILL.md", "SKILL.part-002.md", "SKILL.part-003.md"].map((path) => ({ skillId: "1", path }));
    assert.deepEqual(library.unreadRequiredFiles, initial);
    const externalCopy = library.unreadRequiredFiles;
    externalCopy[0].path = "伪造路径";
    externalCopy.pop();
    assert.deepEqual(library.unreadRequiredFiles, initial);
    assert.equal(library.readSkillFile({ skillId: "1", path: "missing.md" }).ok, false);
    assert.deepEqual(library.unreadRequiredFiles, initial);
    for (let index = 0; index < initial.length; index++) {
        assert.equal(library.readSkillFile(initial[index]).ok, true);
        assert.deepEqual(library.unreadRequiredFiles, initial.slice(index + 1));
    }
    assert.deepEqual(library.unreadRequiredFiles, []);
    assert.deepEqual((await load()).unreadRequiredFiles, initial);
});

test("every main file is required while unread optional references do not keep the main-file gate closed", async () => {
    const source = `### 文件：SKILL.md\n${"主步骤".repeat(5_000)}\n### 文件：导演/SKILL.md\n${"导演步骤".repeat(4_000)}\n### 文件：references/style.md\n未读的可选风格参考`;
    const library = await loadCanvasAgentSkills([selection(1)], async () => detail(1, source));
    const mainPaths = ["SKILL.md", "SKILL.part-002.md", "导演/SKILL.md", "导演/SKILL.part-002.md"];
    assert.deepEqual(library.unreadRequiredFiles.map((file) => file.path), mainPaths);
    for (const path of mainPaths.slice(0, 2)) assert.equal(library.readSkillFile({ skillId: "1", path }).ok, true);
    assert.deepEqual(library.unreadRequiredFiles.map((file) => file.path), mainPaths.slice(2));
    let last: ReturnType<CanvasAgentSkillLibrary["readSkillFile"]> | undefined;
    for (const path of mainPaths.slice(2)) last = library.readSkillFile({ skillId: "1", path });
    assert.deepEqual(library.unreadRequiredFiles, []);
    assert.equal(last!.skillFullyRead, false, "optional reference stays unread without reopening the main-file gate");
    assert.equal(library.readSkillFile({ skillId: "1", path: "references/style.md" }).skillFullyRead, true);
    assert.deepEqual(library.unreadRequiredFiles, []);
});

test("small inline skills need no explicit main-file reads even when they contain multiple source files", async () => {
    const source = "### 文件：SKILL.md\n主步骤\n### 文件：导演/SKILL.md\n另一主步骤\n### 文件：references/style.md\n风格参考";
    const library = await loadCanvasAgentSkills([selection(1)], async () => detail(1, source));
    assert.ok(library.activeSkillContents[0].content.includes(source));
    assert.deepEqual(library.unreadRequiredFiles, []);
    assert.equal(library.hasFiles, true, "an available reader does not imply unread required content");
    const empty = await loadCanvasAgentSkills([], async () => { throw new Error("不应加载未选技能"); });
    assert.deepEqual(empty.unreadRequiredFiles, []);
});

test("the five longest real imported catalog definitions load within budget and reconstruct without loss", async () => {
    const catalog = await realCatalog();
    const longest = catalog.sort((left, right) => right.systemPrompt!.length - left.systemPrompt!.length).slice(0, 5);
    assert.ok(longest[0].systemPrompt!.length > 300_000);
    const selected = longest.map((skill) => ({ id: skill.id, name: skill.name, targetType: skill.targetType }));
    const library = await loadCanvasAgentSkills(selected, async (id, targetType) => {
        const skill = longest.find((entry) => entry.id === id)!;
        assert.equal(skill.targetType, targetType);
        return skill;
    });
    assert.equal(library.activeSkillContents.length, 5);
    assert.equal(library.hasFiles, true);
    assert.ok(library.activeSkillContents.every((skill) => skill.content.length <= MAX_SKILL_ROOT_CHARACTERS));
    assert.ok(library.activeSkillContents.reduce((sum, skill) => sum + skill.content.length, 0) <= MAX_SKILL_GROUP_ROOT_CHARACTERS);
    for (const original of longest) {
        const reconstructed = reconstruct(library, String(original.id));
        assert.equal(reconstructed.length, original.systemPrompt!.length);
        assert.equal(digest(reconstructed), digest(original.systemPrompt!));
    }
});

async function realCatalog(): Promise<SkillOption[]> {
    try {
        return JSON.parse(await readFile(new URL("../../../../../tmp/canvas-skill-audit-catalog.json", import.meta.url), "utf8"));
    } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        // The immutable seed is available in a clean checkout; no external catalog is required in CI.
        const sql = await readFile(new URL("../../../../../server/src/main/resources/db/migration/V39__Import_Local_Skills.sql", import.meta.url), "utf8");
        const pattern = /INSERT INTO skills\(name,description,target_type,system_prompt,cover_url,import_key,status,sort_order\) SELECT '((?:''|[^'])*)','((?:''|[^'])*)','((?:''|[^'])*)','((?:''|[^'])*)','((?:''|[^'])*)','((?:''|[^'])*)'/g;
        return [...sql.matchAll(pattern)].map((match, index) => ({
            ...detail(index + 1, match[4].replace(/''/g, "'"), match[3] as SkillType),
            name: match[1].replace(/''/g, "'"),
        }));
    }
}
