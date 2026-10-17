export const commercePlatforms = [
    { id: "taobao", name: "淘宝 / 天猫", mark: "淘", color: "#ee7135", description: "视觉吸引 · 卖点解释 · 完整详情", ratio: "1:1", videoRatio: "9:16", copy: "商品标题与卖点", detail: "详情页文案", image: "商品主图" },
    { id: "jd", name: "京东", mark: "京", color: "#d74c55", description: "参数清晰 · 细节质感 · 购买依据", ratio: "1:1", videoRatio: "16:9", copy: "商品标题与参数卖点", detail: "详情页说明", image: "品质主图" },
    { id: "pinduoduo", name: "拼多多", mark: "拼", color: "#eb5757", description: "直观展示 · 规格明了 · 实用价值", ratio: "1:1", videoRatio: "9:16", copy: "商品标题与利益点", detail: "规格与详情", image: "直观商品图" },
    { id: "douyin", name: "抖音", mark: "抖", color: "#343b4a", description: "开场吸引 · 使用演示 · 节奏带货", ratio: "9:16", videoRatio: "9:16", copy: "带货口播与标题", detail: "商品卖点说明", image: "短视频封面" },
    { id: "xiaohongshu", name: "小红书", mark: "小", color: "#df536f", description: "生活场景 · 真实表达 · 有用的分享", ratio: "3:4", videoRatio: "9:16", copy: "种草笔记与标题", detail: "图文笔记内容", image: "种草封面" },
] as const;

export type CommercePlatform = (typeof commercePlatforms)[number]["id"];
export type CommerceKind = "copy" | "detail-copy" | "image" | "video-script" | "video";
export type CommerceVariant = "hero" | "scene" | "detail";
export const commerceOutputs: { id: string; kind: CommerceKind; variant?: CommerceVariant; name: string; description: string; taskType: "text" | "image" | "video" }[] = [
    { id: "copy", kind: "copy", name: "卖点文案", description: "从商品事实提炼购买理由", taskType: "text" },
    { id: "hero", kind: "image", variant: "hero", name: "商品主图", description: "呈现商品外观，突出视觉主体", taskType: "image" },
    { id: "scene", kind: "image", variant: "scene", name: "场景图", description: "把商品放进适合的使用场景", taskType: "image" },
    { id: "detail", kind: "image", variant: "detail", name: "细节图", description: "展示材质、工艺与真实结构", taskType: "image" },
    { id: "detail-copy", kind: "detail-copy", name: "详情页文案", description: "组织完整的商品介绍与模块", taskType: "text" },
    { id: "video-script", kind: "video-script", name: "带货脚本", description: "开场、演示、卖点到行动引导", taskType: "text" },
    { id: "video", kind: "video", name: "商品视频", description: "以商品参考图制作动态演示", taskType: "video" },
];

export function commerceOutputLabel(kind: string, variant?: string) {
    return commerceOutputs.find((item) => item.kind === kind && (kind !== "image" || item.variant === variant))?.name || "创作结果";
}
