"use client";

import { useState } from "react";

/** 生成结果（图片/视频）无法加载时展示的默认占位图（内联 SVG，不依赖静态资源与部署） */
export const MEDIA_FALLBACK_IMAGE = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><rect width="120" height="120" fill="#e9e7e2"/><rect x="28" y="34" width="64" height="52" rx="8" fill="none" stroke="#b0aca4" stroke-width="4"/><circle cx="45" cy="51" r="5" fill="#b0aca4"/><path d="M33 79l16-15 12 11 9-8 17 16" fill="none" stroke="#b0aca4" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
)}`;

/**
 * 媒体加载兜底：地址为空或该地址加载失败时回落到默认占位图。
 * 只记录失败的地址而不缓存布尔值，地址变化后自动重新尝试，避免切换记录时残留失败态。
 */
export function useMediaFallback(src?: string) {
    const [failedSource, setFailedSource] = useState<string | null>(null);
    const empty = !src;
    const failed = Boolean(src && failedSource === src);
    const missing = empty || failed;
    return {
        empty,
        failed,
        missing,
        onError: () => setFailedSource(src ?? null),
        displaySrc: missing ? MEDIA_FALLBACK_IMAGE : (src as string),
    };
}

/** 列表缩略图：地址缺失或加载失败时统一展示默认占位图 */
export function MediaPreview({ kind, src, className }: { kind: "image" | "video"; src?: string; className?: string }) {
    const { empty, failed, missing, onError, displaySrc } = useMediaFallback(src);
    const fallbackLabel = failed ? "缩略图加载失败" : empty ? "暂无缩略图" : "";
    return (
        <span className={`relative block overflow-hidden ${className || ""}`} title={fallbackLabel || undefined}>
            {kind === "video" && !missing ? (
                <video src={displaySrc} className="size-full object-cover" muted onError={onError} />
            ) : (
                <img src={displaySrc} alt={fallbackLabel} className="size-full object-cover" onError={onError} />
            )}
            {failed ? <span className="absolute inset-x-0 bottom-0 bg-black/65 py-0.5 text-center text-[8px] leading-none text-white">加载失败</span> : null}
        </span>
    );
}
