import { paginateItems } from "@/shared/lib/pagination";
import { listHomepageShowcases, type HomepageShowcase } from "@/services/api/server";
import { homepageOriginalComicShowcases } from "./original-comic-showcases";
import { homepageOriginalShowcases, type HomepageVideoShowcase } from "./original-video-showcases";

// Keep the original films' category rotation after the new comic dramas.
const categories = [...new Set(homepageOriginalShowcases.map((item) => item.category))];
const groupedShowcases = categories.map((category) => homepageOriginalShowcases.filter((item) => item.category === category));
const interleavedOriginalShowcases = Array.from(
    { length: Math.max(0, ...groupedShowcases.map((items) => items.length)) },
    (_, index) => groupedShowcases.flatMap((items) => items[index] ? [items[index]] : []),
).flat();
export const homepageFallbackShowcases: HomepageVideoShowcase[] = [...homepageOriginalComicShowcases, ...interleavedOriginalShowcases];
export const homepageFallbackVideoUrls = homepageFallbackShowcases.slice(0, 2).map((item) => item.mediaUrl);

export const homepageTargetPaths: Record<HomepageShowcase["targetType"], string> = {
    image: "/image",
    video: "/video",
    canvas: "/canvas",
    asset: "/assets",
};

export function getHomepageTargetPath(targetType: HomepageShowcase["targetType"]) {
    return homepageTargetPaths[targetType];
}

export function getHomepageCreationHref(item: HomepageShowcase) {
    const path = item.targetPath || getHomepageTargetPath(item.targetType);
    return item.promptContent ? `${path}${path.includes("?") ? "&" : "?"}initialPrompt=${encodeURIComponent(item.promptContent)}` : path;
}

export async function fetchHomepageShowcases() {
    const result = await listHomepageShowcases(24);
    const items = result.items || [];
    if (items.some((item) => !isValidHomepageShowcase(item))) {
        throw new Error("首页精选内容包含无效媒体或入口配置");
    }
    return items.length ? items : homepageFallbackShowcases;
}

export async function fetchHomepageShowcasePage(params: { page: number; pageSize: number; category?: string }) {
    const result = await listHomepageShowcases(params);
    const items = result.items || [];
    if (items.some((item) => !isValidHomepageShowcase(item))) throw new Error("首页精选内容包含无效媒体或入口配置");
    // 只在完全没有已发布内容时使用示例，分类空结果仍保持为空。
    if (!result.total && !result.categories?.length) return paginateHomepageFallback(params);
    return { ...result, items, categories: result.categories || [] };
}

export function paginateHomepageFallback({ page, pageSize, category }: { page: number; pageSize: number; category?: string }, items: HomepageVideoShowcase[] = homepageFallbackShowcases) {
    const filtered = items.filter((item) => !category || item.category === category);
    const result = paginateItems(filtered, page, pageSize);
    return { items: result.items, total: result.total, categories: [...new Set(items.map((item) => item.category))] };
}

function isValidHomepageShowcase(item: HomepageShowcase) {
    return (
        item.mediaType === "video" &&
        (item.targetType === "image" || item.targetType === "video" || item.targetType === "canvas" || item.targetType === "asset") &&
        Boolean(item.mediaUrl) &&
        Boolean(item.targetPath) &&
        item.targetPath.startsWith("/") &&
        !item.targetPath.startsWith("//")
    );
}
