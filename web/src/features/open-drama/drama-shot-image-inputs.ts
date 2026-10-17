import type { CanvasStoryboardAsset, CanvasStoryboardNode, CanvasStoryboardShot } from "@/features/canvas/types";
import type { ReferenceImage } from "@/features/generation/types/image";

export type DramaShotImageInputs = { prompt: string; references: ReferenceImage[] };

const kindLabels = { character: "角色", scene: "场景", prop: "道具" } as const;
const blockStart = "【短剧镜头参考约束·开始】";
const blockEnd = "【短剧镜头参考约束·结束】";

/** Bind each visible asset to its actual reference image; asset-sheet prompts are never shot instructions. */
export function buildDramaShotImageInputs(
    board: CanvasStoryboardNode,
    shot: CanvasStoryboardShot,
    promptOverride?: string,
): DramaShotImageInputs {
    const prompt = (promptOverride ?? shot.imagePrompt ?? shot.finalPrompt)
        .replace(/\n*【短剧镜头参考约束·开始】[\s\S]*?【短剧镜头参考约束·结束】/g, "").trim();
    const assetsById = new Map(board.storyboard.assets.map(asset => [asset.id, asset]));
    const assets = [...new Set(shot.assetIds)].map(id => {
        const asset = assetsById.get(id);
        if (!asset) throw new Error(`镜头 ${shot.shotNumber} 关联的素材不存在，请重新选择该镜头的角色和场景素材。`);
        return asset;
    });
    // Preserve user order within each group. Characters must stay ahead of environments and props.
    const ordered = [...assets.filter(asset => asset.kind === "character"), ...assets.filter(asset => asset.kind !== "character")];
    const missing = ordered.filter(asset => asset.kind === "character" && !referenceSource(asset));
    if (missing.length) {
        throw new Error(`镜头 ${shot.shotNumber} 的角色「${missing.map(asset => assetName(asset)).join("、")}」缺少参考图，请先在项目素材中上传或生成角色定妆图，再生成镜头图片。`);
    }
    assertResolvedAssetMarkers(prompt, assets, shot.shotNumber);

    const references: ReferenceImage[] = [];
    const numbersBySource = new Map<string, number>();
    const characterByNumber = new Map<number, CanvasStoryboardAsset>();
    const mappings: string[] = [];
    for (const asset of ordered) {
        const source = referenceSource(asset);
        if (!source || !asset.image) continue;
        const image = asset.image;
        const keys = [image.storageKey?.trim(), image.objectStorage?.url?.trim(), image.source?.trim()].filter((value): value is string => Boolean(value));
        let number = keys.map(key => numbersBySource.get(key)).find((value): value is number => value !== undefined);
        if (number === undefined) {
            number = references.length + 1;
            references.push({
                id: asset.id,
                name: `${kindLabels[asset.kind]}-${assetName(asset)}`,
                type: image.mimeType?.trim() || inferMimeType(image.source || image.objectStorage?.url || source),
                dataUrl: image.source?.trim() || image.objectStorage?.url?.trim() || "",
                storageKey: image.storageKey,
                objectStorage: image.objectStorage,
            });
        }
        const referenceNumber = number;
        const sharedCharacter = characterByNumber.get(referenceNumber);
        if (asset.kind === "character" && sharedCharacter && sharedCharacter.id !== asset.id) {
            throw new Error(`镜头 ${shot.shotNumber} 的角色「${assetName(sharedCharacter)}」和「${assetName(asset)}」使用了同一张参考图，请在项目素材中分别设置正确的角色定妆图。`);
        }
        if (asset.kind === "character") characterByNumber.set(referenceNumber, asset);
        keys.forEach(key => numbersBySource.set(key, referenceNumber));
        mappings.push(`图片${number} = ${kindLabels[asset.kind]}「${assetName(asset)}」${asset.kind === "character" ? "的身份与造型参考" : asset.kind === "scene" ? "的空间与环境参考" : "的外形与材质参考"}。`);
    }
    if (!references.length) return { prompt, references };

    return {
        prompt: [
            prompt, blockStart,
            "【参考图对应关系】", ...mappings,
            "【镜头一致性要求】",
            "角色参考图用于锁定同一身份：保持脸型、五官比例、年龄、体型、发型、发色、服装和配饰一致，不换脸、不混合不同角色的面貌；只有当前镜头明确要求换装或年代变化时才调整相应部分。动作、表情、视角、人物位置和镜头景别以当前镜头内容为准。",
            "仅呈现当前镜头实际出场的人物。对白、旁白、回忆叙述或衣物归属中提到的姓名不代表本人出场，不因提供了参考图而新增人物。",
            "角色或道具参考图中的多个视角属于同一个对象，仅用于识别外观；输出一张连续的镜头画面，不复制成三视图、分屏、拼贴、重复人物或并排设定图，不继承参考图的站姿、纯色背景、标注文字与排版。",
            "场景参考只约束空间、建筑、环境和光线；即使场景参考是空景，也必须保留当前镜头要求出场的人物，不把场景设定中的空景要求用于删除人物。道具按当前剧情摆放，不照搬物品展示构图。",
            blockEnd,
        ].join("\n\n"),
        references,
    };
}

/** An explicit marker is an input dependency. Never silently discard an unresolved one. */
function assertResolvedAssetMarkers(prompt: string, assets: CanvasStoryboardAsset[], shotNumber: number): void {
    const names = new Set(assets.map(asset => assetName(asset)));
    const hasCharacter = assets.some(asset => asset.kind === "character");
    const markers = [...new Set([...prompt.matchAll(/@\[([^\]\r\n]+)\]/g)].map(match => match[1].trim().replace(/\s+/g, " ")))];
    const unresolved = markers.filter(name => !names.has(name) && !(hasCharacter && /^(?:他|她|我|你|您)(?:们)?$/.test(name)));
    if (!unresolved.length) return;
    const pronouns = unresolved.filter(name => /^(?:他|她|我|你|您)(?:们)?$/.test(name));
    if (pronouns.length && !hasCharacter) {
        throw new Error(`镜头 ${shotNumber} 的人物标记「${pronouns.join("、")}」没有关联角色，请先为本镜头关联对应角色的定妆图；不会猜测上一镜头的人物身份。`);
    }
    throw new Error(`镜头 ${shotNumber} 存在未关联的素材标记「${unresolved.join("、")}」，请先关联对应角色、场景或道具素材；若只是普通描述，请移除该素材标记后再生成。`);
}

function referenceSource(asset: CanvasStoryboardAsset): string {
    return asset.image?.storageKey?.trim() || asset.image?.objectStorage?.url?.trim() || asset.image?.source?.trim() || "";
}

function assetName(asset: CanvasStoryboardAsset): string {
    return asset.name.trim().replace(/\s+/g, " ") || "未命名素材";
}

function inferMimeType(source: string): string {
    if (/\.webp(?:[?#]|$)/i.test(source)) return "image/webp";
    if (/\.jpe?g(?:[?#]|$)/i.test(source)) return "image/jpeg";
    if (/\.gif(?:[?#]|$)/i.test(source)) return "image/gif";
    return "image/png";
}
