import type { ApiCallFormat } from "@/features/settings/stores/use-config-store";

export function resolveModelIcon(model: string, apiFormat?: ApiCallFormat): string {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google") || name.includes("veo") || name.includes("nano-banana")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai") || name.includes("sora")) return "/icons/openai.svg";
    if (name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("seedance") || name.includes("doubao") || name.includes("dreamina")) return "/icons/bytedance.svg";
    if (name.includes("minimax") || name.includes("hailuo")) return "/icons/minimax.svg";
    if (name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm")) return "/icons/glm.svg";
    if (apiFormat === "agnes") return "/icons/agnes.svg";
    if (apiFormat === "seedance") return "/icons/bytedance.svg";
    if (apiFormat === "minimax" || apiFormat === "autodl-comfyui") return "/icons/minimax.svg";
    return "";
}

export function isMonochromeModelIcon(model: string, apiFormat?: ApiCallFormat): boolean {
    return ["/icons/agnes.svg", "/icons/bytedance.svg", "/icons/minimax.svg", "/icons/openai.svg", "/icons/grok.svg"].includes(resolveModelIcon(model, apiFormat));
}

/**
 * 模型展示图标可选项：空串表示自动匹配（按模型名/渠道解析），clapperboard 表示默认图标。
 * 供管理端「模型能力配置」编辑弹窗选择使用。
 */
export const MODEL_ICON_OPTIONS: Array<{ value: string; label: string; path: string }> = [
    { value: "", label: "自动匹配", path: "" },
    { value: "clapperboard", label: "默认（Clapperboard）", path: "" },
    { value: "sparkles", label: "灵感 · 星芒", path: "" },
    { value: "bolt", label: "极速 · 闪电", path: "" },
    { value: "flame", label: "热门 · 火焰", path: "" },
    { value: "crown", label: "精选 · 皇冠", path: "" },
    { value: "agnes", label: "Agnes", path: "/icons/agnes.svg" },
    { value: "seedance", label: "Seedance（字节跳动）", path: "/icons/bytedance.svg" },
    { value: "claude", label: "Claude", path: "/icons/claude.svg" },
    { value: "openai", label: "OpenAI", path: "/icons/openai.svg" },
    { value: "gemini", label: "Gemini", path: "/icons/gemini.svg" },
    { value: "deepseek", label: "DeepSeek", path: "/icons/deepseek.svg" },
    { value: "glm", label: "GLM", path: "/icons/glm.svg" },
    { value: "grok", label: "Grok", path: "/icons/grok.svg" },
    { value: "minimax", label: "MiniMax", path: "/icons/minimax.svg" },
];

/** 按配置的图标标识解析 SVG 路径，自动匹配/默认图标返回空串。 */
export function resolveModelIconByKey(key: string | null | undefined): string {
    if (!key || key === "clapperboard") return "";
    const found = MODEL_ICON_OPTIONS.find((option) => option.value === key);
    return found?.path || "";
}

/** 需要暗色反色处理的品牌图标标识集合。 */
export const MODEL_ICON_MONOCHROME_KEYS = new Set(["agnes", "seedance", "minimax", "openai", "grok"]);
