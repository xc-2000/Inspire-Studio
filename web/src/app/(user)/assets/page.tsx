"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Empty, Input, Modal, Select } from "antd";
import { Download, Plus, Search, Upload, FolderOpen, Layers3, Star, UserRound, Mountain, Box, Images, Film, Clapperboard, Trash2, ListFilter, ArrowDownWideNarrow, RotateCcw, type LucideIcon } from "lucide-react";

import { AssetEditorDialog } from "@/features/assets/components/asset-editor-dialog";
import { AssetLibraryCard } from "@/features/assets/components/asset-library-card";
import { AssetPreviewDialog } from "@/features/assets/components/asset-preview-dialog";
import { downloadAsset } from "@/features/assets/lib/asset-download";
import { ListPagination } from "@/shared/components/list-pagination";
import { paginateItems } from "@/shared/lib/pagination";
import { queryAssets } from "@/features/assets/lib/asset-query";
import { exportAssets, readAssetPackage } from "@/features/assets/lib/asset-transfer";
import { useAssetStore, type Asset } from "@/features/assets/stores/use-asset-store";
import { PageShell } from "@/shared/components/page-shell";
import { useCopyText } from "@/shared/hooks/use-copy-text";

export default function AssetsPage() {
    const { message } = App.useApp();
    const copyText = useCopyText();
    const importInputRef = useRef<HTMLInputElement>(null);
    const assets = useAssetStore((state) => state.assets);
    const addAsset = useAssetStore((state) => state.addAsset);
    const updateAsset = useAssetStore((state) => state.updateAsset);
    const removeAsset = useAssetStore((state) => state.removeAsset);
    const [keyword, setKeyword] = useState("");
    const [category, setCategory] = useState<AssetCategory>("all");
    const [projectName, setProjectName] = useState("all");
    const [sort, setSort] = useState<"newest" | "oldest">("newest");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [editorOpen, setEditorOpen] = useState(false);
    const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
    const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
    const [deletingAsset, setDeletingAsset] = useState<Asset | null>(null);
    const filteredAssets = useMemo(() => {
        const queried = queryAssets(assets, { keyword, kind: "all" });
        return queried
            .filter((asset) => {
                const metadata = asset.metadata || {};
                const deleted = typeof metadata.deletedAt === "string" && metadata.deletedAt.length > 0;
                const categoryMatch = category === "trash" ? deleted : !deleted && (category === "all" || (category === "favorite" ? metadata.favorite === true : metadata.assetCategory === category));
                return categoryMatch && (projectName === "all" || metadata.projectName === projectName);
            })
            .sort((a, b) => sort === "newest" ? Date.parse(b.updatedAt) - Date.parse(a.updatedAt) : Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    }, [assets, category, keyword, projectName, sort]);
    const result = useMemo(() => paginateItems(filteredAssets, page, pageSize), [filteredAssets, page, pageSize]);

    useEffect(() => {
        if (page !== result.page) setPage(result.page);
    }, [page, result.page]);

    const changeQuery = (next: { keyword?: string; category?: AssetCategory; projectName?: string; sort?: "newest" | "oldest" }) => {
        if (next.keyword !== undefined) setKeyword(next.keyword);
        if (next.category !== undefined) setCategory(next.category);
        if (next.projectName !== undefined) setProjectName(next.projectName);
        if (next.sort !== undefined) setSort(next.sort);
        setPage(1);
    };
    const openCreate = () => {
        setEditingAsset(null);
        setEditorOpen(true);
    };
    const openEdit = (asset: Asset) => {
        setEditingAsset(asset);
        setEditorOpen(true);
    };
    const copyAsset = (asset: Asset) => {
        if (asset.kind === "text") copyText(asset.data.content, "文本已复制");
    };
    const exportAll = async () => {
        const activeAssets = assets.filter((asset) => !asset.metadata?.deletedAt);
        if (!activeAssets.length) return void message.warning("暂无资产可导出");
        await exportAssets(activeAssets);
    };
    const importPackage = async (file?: File) => {
        if (!file) return;
        try {
            const importedAssets = await readAssetPackage(file);
            importedAssets.forEach((asset) => addAsset(createImportedAsset(asset)));
            message.success(`已导入 ${importedAssets.length} 个资产`);
        } catch {
            message.error("导入失败，请选择有效的资产压缩包");
        } finally {
            if (importInputRef.current) importInputRef.current.value = "";
        }
    };
    const confirmDelete = () => {
        if (!deletingAsset) return;
        if (category === "trash") {
            removeAsset(deletingAsset.id);
            message.success("资产已永久删除");
        } else {
            updateAsset(deletingAsset.id, { metadata: { ...deletingAsset.metadata, deletedAt: new Date().toISOString() } });
            message.success("资产已移入回收站");
        }
        setDeletingAsset(null);
    };

    const categoryCounts = useMemo(() => {
        const counts: Record<AssetCategory, number> = { all: 0, favorite: 0, role: 0, scene: 0, prop: 0, shotImage: 0, shotVideo: 0, finished: 0, trash: 0 };
        for (const asset of assets) {
            const metadata = asset.metadata || {};
            if (metadata.deletedAt) { counts.trash += 1; continue; }
            counts.all += 1;
            if (metadata.favorite === true) counts.favorite += 1;
            const key = metadata.assetCategory as AssetCategory;
            if (key in counts && key !== "all" && key !== "favorite" && key !== "trash") counts[key] += 1;
        }
        return counts;
    }, [assets]);

    const projectOptions = useMemo(() => {
        const names = new Set<string>();
        assets.forEach((asset) => { if (typeof asset.metadata?.projectName === "string" && !asset.metadata.deletedAt) names.add(asset.metadata.projectName); });
        return [{ value: "all", label: "全部项目", icon: Layers3 }, ...[...names].sort((a, b) => a.localeCompare(b, "zh-CN")).map((name) => ({ value: name, label: name }))];
    }, [assets]);

    return (
        <PageShell icon={<FolderOpen />}
            eyebrow="内容资源"
            title="我的资产"
            description="集中管理项目文件、角色、场景、道具、分镜与成片，在生成和画布中随时复用。"
            width="wide"
            actions={
                <>
                    <Button icon={<Download className="size-4" />} onClick={() => void exportAll()}>
                        导出
                    </Button>
                    <Button icon={<Upload className="size-4" />} onClick={() => importInputRef.current?.click()}>
                        导入
                    </Button>
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={openCreate}>
                        新增资产
                    </Button>
                </>
            }
            scrollKey={JSON.stringify([page, pageSize, keyword, category, projectName, sort])}
            toolbar={
                <>
                    <section className="studio-toolbar studio-asset-filters p-3 sm:p-4" aria-label="资产筛选">
                        <div className="studio-asset-categories" aria-label="资产分类">
                            {ASSET_CATEGORIES.map((item) => <KindFilter icon={item.icon} key={item.value} label={item.label} value={categoryCounts[item.value]} active={category === item.value} onClick={() => changeQuery({ category: item.value })} />)}
                        </div>
                        <div className="studio-asset-filter-fields">
                            <Input allowClear aria-label="搜索资产" prefix={<Search className="size-4 text-[var(--studio-faint)]" />} value={keyword} placeholder="搜索标题、内容、标签或来源" onChange={(event) => changeQuery({ keyword: event.target.value })} />
                            <Select prefix={<FolderOpen />} value={projectName} options={projectOptions} onChange={(value) => changeQuery({ projectName: value })} showSearch optionFilterProp="label" aria-label="按项目筛选" />
                            <Select prefix={<ArrowDownWideNarrow />} value={sort} options={[{ value: "newest", label: "最近更新" }, { value: "oldest", label: "最早更新" }]} onChange={(value) => changeQuery({ sort: value })} aria-label="时间排序" />
                        </div>
                    </section>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm text-[var(--studio-muted)]" role="status">
                            共 <span className="font-medium tabular-nums text-[var(--studio-ink)]">{result.total}</span> 个资产
                        </p>
                        {keyword || category !== "all" || projectName !== "all" ? (
                            <Button type="text" size="small" icon={<RotateCcw className="size-3.5" />} onClick={() => changeQuery({ keyword: "", category: "all", projectName: "all" })}>
                                清除筛选
                            </Button>
                        ) : (
                            <p className="text-xs text-[var(--studio-faint)]">文本、图片与视频，随时复用</p>
                        )}
                    </div>
                </>
            }
            footer={
                <ListPagination
                    current={result.page}
                    pageSize={result.pageSize}
                    total={result.total}
                    label="资产"
                    onChange={(nextPage, nextPageSize) => {
                        setPage(nextPageSize === pageSize ? nextPage : 1);
                        setPageSize(nextPageSize);
                    }}
                />
            }
        >
            {result.items.length ? (
                <section className="studio-card-grid" aria-label="资产列表">
                    {result.items.map((asset) => (
                        <AssetLibraryCard
                            key={asset.id}
                            asset={asset}
                            onPreview={() => setPreviewAsset(asset)}
                            onEdit={() => openEdit(asset)}
                            onCopy={() => copyAsset(asset)}
                            onDownload={() => downloadAsset(asset)}
                            onDelete={() => setDeletingAsset(asset)}
                            onFavorite={() => updateAsset(asset.id, { metadata: { ...asset.metadata, favorite: asset.metadata?.favorite !== true } })}
                            onRestore={() => { const metadata = { ...asset.metadata }; delete metadata.deletedAt; updateAsset(asset.id, { metadata }); message.success("资产已恢复"); }}
                            trashed={category === "trash"}
                        />
                    ))}
                </section>
            ) : (
                <div className="flex min-h-[320px] items-center justify-center rounded-[20px] border border-dashed border-[var(--studio-line-strong)] bg-[var(--studio-surface-soft)] px-5 py-10">
                    <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={
                            <div>
                                <p className="font-medium text-[var(--studio-ink)]">{assets.length ? "没有找到匹配的资产" : "建立你的创作资产库"}</p>
                                <p className="mt-2 text-sm text-[var(--studio-muted)]">{assets.length ? "试试其他关键词或资产类型。" : "添加常用素材，在每次创作中快速复用。"}</p>
                            </div>
                        }
                    >
                        {assets.length ? (
                            <Button icon={<RotateCcw className="size-4" />} onClick={() => changeQuery({ keyword: "", category: "all", projectName: "all" })}>清除筛选</Button>
                        ) : (
                            <Button type="primary" icon={<Plus className="size-4" />} onClick={openCreate}>
                                新增资产
                            </Button>
                        )}
                    </Empty>
                </div>
            )}

            <AssetEditorDialog open={editorOpen} asset={editingAsset} onClose={() => setEditorOpen(false)} />
            <AssetPreviewDialog asset={previewAsset} onClose={() => setPreviewAsset(null)} onCopy={() => previewAsset && copyAsset(previewAsset)} onDownload={() => previewAsset && downloadAsset(previewAsset)} />
            <input ref={importInputRef} hidden type="file" accept="application/zip,.zip" onChange={(event) => void importPackage(event.target.files?.[0])} />
            <Modal title={category === "trash" ? "永久删除资产？" : "移入回收站？"} open={Boolean(deletingAsset)} okText={category === "trash" ? "永久删除" : "移入回收站"} cancelText="取消" okButtonProps={{ danger: true }} onOk={confirmDelete} onCancel={() => setDeletingAsset(null)}>
                <p>{category === "trash" ? `「${deletingAsset?.title}」将被永久删除，此操作无法撤销。` : `「${deletingAsset?.title}」将移入回收站，之后可以恢复。`}</p>
            </Modal>
        </PageShell>
    );
}

type AssetCategory = "all" | "favorite" | "role" | "scene" | "prop" | "shotImage" | "shotVideo" | "finished" | "trash";

const ASSET_CATEGORIES: Array<{ value: AssetCategory; label: string; icon: LucideIcon }> = [
    { value: "all", label: "全部", icon: Layers3 },
    { value: "favorite", label: "收藏", icon: Star },
    { value: "role", label: "角色", icon: UserRound },
    { value: "scene", label: "场景", icon: Mountain },
    { value: "prop", label: "道具", icon: Box },
    { value: "shotImage", label: "分镜图", icon: Images },
    { value: "shotVideo", label: "分镜视频", icon: Film },
    { value: "finished", label: "成片", icon: Clapperboard },
    { value: "trash", label: "回收站", icon: Trash2 },
];

function KindFilter({ icon: Icon, label, value, active, onClick }: { icon: LucideIcon; label: string; value: number; active: boolean; onClick: () => void }) {
    return <button type="button" onClick={onClick} aria-pressed={active} className="studio-asset-category">
        <Icon aria-hidden="true" /><span className="font-medium">{label}</span><span className="studio-asset-category-count">{value}</span>
    </button>;
}

function createImportedAsset(asset: Asset): Parameters<ReturnType<typeof useAssetStore.getState>["addAsset"]>[0] {
    const payload = { ...asset } as Record<string, unknown>;
    delete payload.id;
    delete payload.createdAt;
    delete payload.updatedAt;
    return payload as Parameters<ReturnType<typeof useAssetStore.getState>["addAsset"]>[0];
}
