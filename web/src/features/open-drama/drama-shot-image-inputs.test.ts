import assert from "node:assert/strict";
import test from "node:test";
import { createStoryboardNode } from "@/features/canvas/constants";
import type { CanvasStoryboardAsset, CanvasStoryboardShot } from "@/features/canvas/types";
import { buildDramaShotImageInputs } from "./drama-shot-image-inputs";

const asset = (id: string, kind: CanvasStoryboardAsset["kind"], name: string, source = `/open-drama/${id}.webp`): CanvasStoryboardAsset => ({
    id, kind, name, description: "", image: { source },
});
function fixture(assets: CanvasStoryboardAsset[], ids = assets.map(asset => asset.id)) {
    const board = createStoryboardNode({ id: "board", title: "第一章", position: { x: 0, y: 0 } });
    board.storyboard.assets = assets;
    const shot: CanvasStoryboardShot = { id: "shot", shotNumber: 2, durationSeconds: 5, visualDescription: "", shotSize: "中景", lightingAtmosphere: "", dialogueVoiceover: "", soundEffect: "", cameraMovement: "", finalPrompt: "原提示词", imagePrompt: "林岁安在院子洗衣服，赵金花走来。", assetIds: ids };
    board.storyboard.shots = [shot];
    return { board, shot };
}

test("人物参考排在环境和道具之前，图号映射与实际图片顺序一致", () => {
    const { board, shot } = fixture([
        asset("yard", "scene", "院子"), asset("mother", "character", "赵金花"), asset("basin", "prop", "水盆"), asset("daughter", "character", "林岁安"),
    ]);
    const before = JSON.stringify({ board, shot });
    const input = buildDramaShotImageInputs(board, shot);
    assert.deepEqual(input.references.map(ref => ref.id), ["mother", "daughter", "yard", "basin"]);
    assert.deepEqual(input.references.map(ref => ref.dataUrl), ["/open-drama/mother.webp", "/open-drama/daughter.webp", "/open-drama/yard.webp", "/open-drama/basin.webp"]);
    assert.match(input.prompt, /图片1 = 角色「赵金花」/);
    assert.match(input.prompt, /图片2 = 角色「林岁安」/);
    assert.match(input.prompt, /图片3 = 场景「院子」/);
    assert.match(input.prompt, /图片4 = 道具「水盆」/);
    assert.match(input.prompt, /脸型、五官比例、年龄、体型、发型、发色、服装和配饰一致/);
    assert.equal(input.references[0].type, "image/webp");
    assert.equal(JSON.stringify({ board, shot }), before);
});

test("角色设定三视图与场景无人物模板不会拼入镜头提示词", () => {
    const role = asset("daughter", "character", "林岁安");
    role.description = "20岁，双麻花辫。左区：角色正脸特写。右区：标准角色设定三视图。纯灰背景；角色无动作，双手自然下垂。";
    const scene = asset("yard", "scene", "院子");
    scene.description = "无人物；全景广角镜头；灰色空院子。";
    const { board, shot } = fixture([role, scene]);
    const input = buildDramaShotImageInputs(board, shot);
    assert.ok(!input.prompt.includes(role.description));
    assert.ok(!input.prompt.includes("左区："));
    assert.ok(!input.prompt.includes("无人物；全景"));
    assert.match(input.prompt, /输出一张连续的镜头画面/);
    assert.match(input.prompt, /不复制成三视图、分屏、拼贴、重复人物/);
    assert.match(input.prompt, /即使场景参考是空景，也必须保留当前镜头要求出场的人物/);
});

test("不扫描对白或衣物姓名追加角色，只使用当前镜头已绑定资产", () => {
    const { board, shot } = fixture([asset("daughter", "character", "林岁安"), asset("brother", "character", "林耀祖")], ["daughter"]);
    shot.imagePrompt = "林岁安洗着林耀祖的衣服，听见母亲说起林耀祖。";
    shot.image = { source: "/previous-inconsistent-result.png" };
    const input = buildDramaShotImageInputs(board, shot);
    assert.deepEqual(input.references.map(ref => ref.id), ["daughter"]);
    assert.ok(!input.prompt.includes("= 角色「林耀祖」"));
    assert.match(input.prompt, /衣物归属中提到的姓名不代表本人出场/);
    assert.ok(!input.references.some(ref => ref.dataUrl === shot.image?.source));
});

test("没有绑定资产允许文生图，并保留调用方正在编辑的提示词", () => {
    const { board, shot } = fixture([asset("daughter", "character", "林岁安")], []);
    assert.deepEqual(buildDramaShotImageInputs(board, shot), { prompt: shot.imagePrompt, references: [] });
    assert.deepEqual(buildDramaShotImageInputs(board, shot, "  清晨的空院子  "), { prompt: "清晨的空院子", references: [] });
    assert.deepEqual(buildDramaShotImageInputs(board, shot, ""), { prompt: "", references: [] });
});

test("无身份参考的代词标记阻止出图，即使已有场景参考也不能猜人物", () => {
    const { board, shot } = fixture([asset("yard", "scene", "院子")]);
    shot.imagePrompt = "@[她]掀开棉门帘走进@[院子]。";
    assert.throws(() => buildDramaShotImageInputs(board, shot), /镜头 2.*她.*没有关联角色.*不会猜测/);
    shot.assetIds = [];
    assert.throws(() => buildDramaShotImageInputs(board, shot), /没有关联角色/);
});

test("已绑定角色允许他她指代，但不允许未知专名借已有角色绕过校验", () => {
    const { board, shot } = fixture([asset("daughter", "character", "林岁安")]);
    shot.imagePrompt = "@[林岁安]抬头，@[她]站起身。";
    assert.deepEqual(buildDramaShotImageInputs(board, shot).references.map(ref => ref.id), ["daughter"]);
    shot.imagePrompt = "@[陆廷远]牵起@[林岁安]的手。";
    assert.throws(() => buildDramaShotImageInputs(board, shot), /未关联的素材标记「陆廷远」/);
});

test("同章存在但本镜头未关联的明确人物标记也不能静默丢弃", () => {
    const { board, shot } = fixture([asset("daughter", "character", "林岁安"), asset("mother", "character", "赵金花")], ["daughter"]);
    shot.imagePrompt = "@[林岁安]看向@[赵金花]。";
    assert.throws(() => buildDramaShotImageInputs(board, shot), /未关联的素材标记「赵金花」/);
});

test("未关联场景或道具标记给出素材错误，不误称角色缺图", () => {
    const { board, shot } = fixture([asset("daughter", "character", "林岁安")]);
    shot.imagePrompt = "@[林岁安]提着@[水瓢]走进@[院子]。";
    assert.throws(() => buildDramaShotImageInputs(board, shot), /未关联的素材标记「水瓢、院子」.*角色、场景或道具/);
    const plain = buildDramaShotImageInputs(board, shot, "林岁安提着水瓢走进院子。");
    assert.deepEqual(plain.references.map(ref => ref.id), ["daughter"]);
});

test("当前编辑的提示词替换旧未解析标记后可继续，旧管理块不会参与校验", () => {
    const { board, shot } = fixture([asset("daughter", "character", "林岁安")]);
    shot.imagePrompt = "@[未关联的人物]看向镜头。";
    assert.doesNotThrow(() => buildDramaShotImageInputs(board, shot, "@[林岁安]看向镜头。\n【短剧镜头参考约束·开始】@[旧角色]【短剧镜头参考约束·结束】"));
});

test("缺少已绑定角色图或失效资产ID必须阻止生成，不能降级成文生图", () => {
    for (const image of [undefined, { source: "   " }]) {
        const role = { ...asset("daughter", "character", "林岁安"), image };
        const { board, shot } = fixture([role, asset("yard", "scene", "院子")]);
        assert.throws(() => buildDramaShotImageInputs(board, shot), /镜头 2.*林岁安.*缺少参考图.*角色定妆图/);
    }
    const { board, shot } = fixture([], ["deleted-character"]);
    assert.throws(() => buildDramaShotImageInputs(board, shot), /关联的素材不存在/);
});

test("重复资产和同图仅提交一次，跳过无图场景后图号仍连续", () => {
    const scene = asset("yard", "scene", "院子");
    const alias = asset("yard-alias", "scene", "洗衣区", scene.image!.source);
    const emptyProp = { ...asset("empty-prop", "prop", "未绘制水盆"), image: undefined };
    const { board, shot } = fixture([scene, emptyProp, asset("daughter", "character", "林岁安"), alias], ["yard", "empty-prop", "daughter", "daughter", "yard-alias"]);
    const input = buildDramaShotImageInputs(board, shot);
    assert.deepEqual(input.references.map(ref => ref.id), ["daughter", "yard"]);
    assert.match(input.prompt, /图片1 = 角色「林岁安」/);
    assert.match(input.prompt, /图片2 = 场景「院子」/);
    assert.match(input.prompt, /图片2 = 场景「洗衣区」/);
    assert.ok(!input.prompt.includes("图片3"));
});

test("两个角色误用同一张图时明确报错而不宣称不同身份", () => {
    const { board, shot } = fixture([asset("daughter", "character", "林岁安", "/shared.webp"), asset("mother", "character", "赵金花", "/shared.webp")]);
    assert.throws(() => buildDramaShotImageInputs(board, shot), /林岁安.*赵金花.*同一张参考图/);
});

test("存储键和对象存储元数据完整传递，只有存储键的图片仍可用", () => {
    const role = asset("daughter", "character", "林岁安", "");
    role.image!.storageKey = "image:character-stable";
    role.image!.mimeType = "image/jpeg";
    const scene = asset("yard", "scene", "院子");
    scene.image!.objectStorage = { provider: "cloudflareR2", key: "yard.webp", url: "https://media.example.com/yard.webp", bucket: "fixture", region: "auto", bytes: 100, mimeType: "image/webp", uploadedAt: "2026-10-06" };
    const { board, shot } = fixture([role, scene]);
    const input = buildDramaShotImageInputs(board, shot);
    assert.equal(input.references[0].storageKey, "image:character-stable");
    assert.equal(input.references[0].type, "image/jpeg");
    assert.equal(input.references[1].objectStorage, scene.image!.objectStorage);
});

test("重试不累积管理指令，换图换绑定后覆盖旧映射，移除绑定后清除旧管理块", () => {
    const { board, shot } = fixture([asset("daughter", "character", "林岁安"), asset("mother", "character", "赵金花")], ["daughter"]);
    const first = buildDramaShotImageInputs(board, shot);
    assert.deepEqual(buildDramaShotImageInputs(board, shot, first.prompt), first);
    shot.assetIds = ["mother"];
    const changed = buildDramaShotImageInputs(board, shot, first.prompt);
    assert.match(changed.prompt, /图片1 = 角色「赵金花」/);
    assert.ok(!changed.prompt.includes("图片1 = 角色「林岁安」"));
    assert.equal(changed.prompt.split("【短剧镜头参考约束·开始】").length, 2);
    shot.assetIds = [];
    assert.deepEqual(buildDramaShotImageInputs(board, shot, changed.prompt), { prompt: shot.imagePrompt, references: [] });
});
