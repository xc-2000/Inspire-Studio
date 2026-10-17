"use client";

import { Button, Tag, Tooltip } from "antd";
import { Copy, Download, PencilLine, RotateCcw, Star, Trash2 } from "lucide-react";

import { formatBytes } from "@/features/generation/lib/image-utils";
import type { Asset } from "../stores/use-asset-store";
import { AssetVideoCover } from "./asset-video-cover";
import styles from "./asset-library-card.module.css";

type AssetLibraryCardProps = {
    asset: Asset;
    onPreview: () => void;
    onEdit: () => void;
    onCopy: () => void;
    onDownload: () => void;
    onDelete: () => void;
    onFavorite?: () => void;
    onRestore?: () => void;
    trashed?: boolean;
};

export function AssetLibraryCard({ asset, onPreview, onEdit, onCopy, onDownload, onDelete, onFavorite, onRestore, trashed = false }: AssetLibraryCardProps) {
    const cover = asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "");
    const favorite = asset.metadata?.favorite === true;
    const category = typeof asset.metadata?.assetCategory === "string" ? asset.metadata.assetCategory : "";
    return (
        <article className="studio-library-card group relative flex min-w-0 flex-col overflow-hidden rounded-[20px] border border-[var(--studio-line)] bg-[var(--studio-glass)] backdrop-blur-[20px] transition-all duration-300 hover:-translate-y-1 hover:border-[var(--studio-primary-line)] hover:shadow-[0_8px_32px_rgba(125,211,216,0.13),0_0_0_1px_var(--studio-primary-soft)] motion-reduce:transform-none">
            <button type="button" className="block w-full text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--studio-action)]" onClick={onPreview} aria-label={`预览资产 ${asset.title}`}>
                <div className="relative aspect-[4/3] overflow-hidden bg-[var(--studio-media)]">
                    {asset.kind === "video" ? (
                        <AssetVideoCover asset={asset} className="size-full" mediaClassName="transition duration-500 group-hover:scale-[1.04] motion-reduce:transition-none" />
                    ) : cover ? (
                        <img src={cover} alt={asset.title} loading="lazy" className="size-full object-cover transition duration-500 group-hover:scale-[1.04] motion-reduce:transition-none" />
                    ) : (
                        <div className="studio-empty relative size-full overflow-hidden border-0">
                            <div className="absolute inset-0 flex items-center justify-center p-5 text-center text-sm leading-6">
                                <span className="line-clamp-6 w-full break-words">{asset.kind === "text" ? asset.data.content : "暂无封面"}</span>
                            </div>
                        </div>
                    )}
                </div>
                <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <h2 className="studio-title truncate text-sm font-semibold">{asset.title}</h2>
                            <p className="studio-caption mt-1 truncate text-xs">{asset.source || "未标注来源"}</p>
                        </div>
                        <Tag className="m-0 shrink-0">{assetCategoryLabel(category) || assetKindLabel(asset)}</Tag>
                    </div>
                    <p className="studio-subtitle mt-2 line-clamp-2 min-h-10 break-words text-xs leading-5">{assetSummary(asset)}</p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        {asset.tags.length ? (
                            asset.tags.slice(0, 3).map((tag) => (
                                <Tag key={tag} className="m-0 text-[11px]">
                                    {tag}
                                </Tag>
                            ))
                        ) : (
                            <Tag className="m-0 text-[11px]">无标签</Tag>
                        )}
                    </div>
                </div>
            </button>
            {!trashed && onFavorite ? (
                <Tooltip title={favorite ? "取消收藏" : "收藏资产"} placement="left">
                    <button type="button" onClick={onFavorite} className={styles.favoriteButton} aria-label={favorite ? "取消收藏" : "收藏资产"} aria-pressed={favorite}>
                        <Star size={18} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                </Tooltip>
            ) : null}
            <footer className="mt-auto flex flex-wrap gap-1.5 border-t border-[var(--studio-line)] px-4 py-3">
                <Button size="small" onClick={onPreview}>
                    查看
                </Button>
                {!trashed && asset.kind !== "video" ? (
                    <Button size="small" icon={<PencilLine className="size-3.5" />} onClick={onEdit}>
                        编辑
                    </Button>
                ) : null}
                {!trashed && asset.kind === "text" ? (
                    <Button size="small" icon={<Copy className="size-3.5" />} onClick={onCopy}>
                        复制
                    </Button>
                ) : null}
                {!trashed && asset.kind !== "text" ? (
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={onDownload}>
                        下载
                    </Button>
                ) : null}
                {trashed && onRestore ? (
                    <Button size="small" icon={<RotateCcw className="size-3.5" />} onClick={onRestore}>
                        恢复
                    </Button>
                ) : null}
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
                    {trashed ? "永久删除" : "删除"}
                </Button>
            </footer>
        </article>
    );
}

function assetCategoryLabel(category: string): string {
    return ({ role: "角色", scene: "场景", prop: "道具", shotImage: "分镜图", shotVideo: "分镜视频", finished: "成片", script: "剧本" } as Record<string, string>)[category] || "";
}

function assetSummary(asset: Asset): string {
    if (asset.kind === "text") return asset.data.content;
    const dimensions = asset.data.width > 0 && asset.data.height > 0 ? `${asset.data.width} × ${asset.data.height}` : "尺寸未知";
    return `${dimensions}，${formatBytes(asset.data.bytes) || "大小未知"}，${asset.data.mimeType}`;
}

function assetKindLabel(asset: Asset): string {
    return asset.kind === "image" ? "图片" : asset.kind === "video" ? "视频" : "文本";
}
