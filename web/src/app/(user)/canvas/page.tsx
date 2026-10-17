"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Input, Select } from "antd";
import { Download, FileUp, PanelsTopLeft, Plus, Search, Trash2, ArrowDownWideNarrow, RotateCcw, X } from "lucide-react";

import { CanvasDeleteProjectsDialog } from "@/features/canvas/components/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "@/features/canvas/components/canvas-project-card";
import cardStyles from "@/features/canvas/components/canvas-project-card.module.css";
import { CANVAS_EXPORT_APP_ID, CANVAS_EXPORT_MANIFEST_NAME, CANVAS_EXPORT_VERSION, type CanvasExportFile } from "@/features/canvas/export-types";
import { useCanvasStore } from "@/features/canvas/stores/use-canvas-store";
import { useCanvasLibrary } from "@/features/canvas/hooks/use-canvas-library";
import { useCanvasUiStore } from "@/features/canvas/stores/use-canvas-ui-store";
import { setMediaBlob } from "@/features/storage/services/file-storage";
import { setImageBlob } from "@/features/storage/services/image-storage";
import { ListPagination } from "@/shared/components/list-pagination";
import { paginateItems } from "@/shared/lib/pagination";
import { PageShell } from "@/shared/components/page-shell";
import { readZip } from "@/shared/lib/zip";
import { readInitialPromptFromLocation, storeInitialPromptForNavigation } from "@/shared/lib/initial-prompt";

const NEW_PROJECT_TITLE_PREFIX = "无限画布";
const IMPORT_ERROR_MESSAGE = "导入失败，请选择有效的画布压缩包";

export default function CanvasPage() {
    const { message } = App.useApp();
    const router = useRouter();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const { hydrated, documents, error, loading, reload } = useCanvasLibrary();
    const createDocument = useCanvasStore((state) => state.createDocument);
    const importDocument = useCanvasStore((state) => state.importDocument);
    const selectedDocumentIds = useCanvasUiStore((state) => state.selectedDocumentIds);
    const setDocumentSelected = useCanvasUiStore((state) => state.setDocumentSelected);
    const requestDocumentDeletion = useCanvasUiStore((state) => state.requestDocumentDeletion);
    const initialPromptHandledRef = useRef(false);
    const [isImporting, setIsImporting] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    const [keyword, setKeyword] = useState("");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [sortBy, setSortBy] = useState<"updated" | "name">("updated");
    const visibleDocuments = useMemo(() => {
        const query = keyword.trim().toLocaleLowerCase();
        return documents
            .filter((document) => document.identity.title.toLocaleLowerCase().includes(query))
            .sort((first, second) => (sortBy === "name" ? first.identity.title.localeCompare(second.identity.title, "zh-CN") : second.identity.updatedAt.localeCompare(first.identity.updatedAt)));
    }, [documents, keyword, sortBy]);
    const result = useMemo(() => paginateItems(visibleDocuments, page, pageSize), [visibleDocuments, page, pageSize]);
    useEffect(() => {
        if (page !== result.page) setPage(result.page);
    }, [page, result.page]);
    const changeKeyword = (value: string) => {
        setKeyword(value);
        setPage(1);
    };
    const selectedDocuments = useMemo(() => documents.filter((document) => selectedDocumentIds.includes(document.identity.id)), [documents, selectedDocumentIds]);

    useEffect(() => {
        if (!hydrated || initialPromptHandledRef.current) return;
        const initialPrompt = readInitialPromptFromLocation();
        if (!initialPrompt) return;
        initialPromptHandledRef.current = true;
        const documentId = createDocument(`${NEW_PROJECT_TITLE_PREFIX} ${documents.length + 1}`);
        storeInitialPromptForNavigation(initialPrompt);
        router.replace(`/canvas/${documentId}`);
    }, [createDocument, documents.length, hydrated, router]);

    const createAndOpenProject = () => {
        const documentId = createDocument(`${NEW_PROJECT_TITLE_PREFIX} ${documents.length + 1}`);
        const initialPrompt = readInitialPromptFromLocation();
        if (initialPrompt) storeInitialPromptForNavigation(initialPrompt);
        router.push(`/canvas/${documentId}`);
    };

    const importCanvasArchive = async (file?: File) => {
        if (!file || isImporting) return;
        setIsImporting(true);
        try {
            const archive = await readZip(file);
            const exportFile = await readArchiveExportFile(archive);
            await restoreArchiveFiles(archive, exportFile);
            exportFile.documents.forEach((item) => importDocument(item.document));
            message.success(`已导入 ${exportFile.documents.length} 个画布`);
        } catch {
            message.error(IMPORT_ERROR_MESSAGE);
        } finally {
            setIsImporting(false);
            resetFileInput(fileInputRef.current);
        }
    };

    const exportSelectedCanvasArchives = async () => {
        if (isExporting) return;
        setIsExporting(true);
        try {
            const { exportCanvasDocuments } = await import("@/features/canvas/utils/canvas-export");
            const fullDocuments = [];
            // Export loads only the requested projects, with bounded network concurrency.
            for (const summary of selectedDocuments) fullDocuments.push(await useCanvasStore.getState().loadDocument(summary.identity.id));
            await exportCanvasDocuments(fullDocuments, `无限画布-${selectedDocuments.length}个项目`);
        } catch {
            message.error("导出失败，请稍后重试");
        } finally {
            setIsExporting(false);
        }
    };

    return (
        <PageShell icon={<PanelsTopLeft />}
            eyebrow="画布库"
            title="无限画布"
            description="集中管理作品，随时继续创作。"
            width="wide"
            actions={
                <>
                    <Button disabled={!hydrated || isImporting || isExporting} icon={<FileUp className="size-4" />} loading={isImporting} onClick={() => fileInputRef.current?.click()}>
                        导入画布
                    </Button>
                    <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={createAndOpenProject}>
                        新建画布
                    </Button>
                </>
            }
            scrollKey={JSON.stringify([page, pageSize, keyword, sortBy])}
            toolbar={
                <>
                    <section className="studio-toolbar flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4" aria-label="画布筛选">
                        <div className="w-full sm:max-w-[380px]">
                            <Input allowClear aria-label="搜索画布" prefix={<Search className="size-4 text-[var(--studio-faint)]" />} placeholder="搜索画布名称" value={keyword} onChange={(event) => changeKeyword(event.target.value)} />
                        </div>
                        <Select
                            className="w-full sm:w-[160px]"
                            aria-label="画布排序"
                            prefix={<ArrowDownWideNarrow />}
                            value={sortBy}
                            onChange={(value) => {
                                setSortBy(value);
                                setPage(1);
                            }}
                            options={[
                                { value: "updated", label: "最近更新" },
                                { value: "name", label: "名称排序" },
                            ]}
                        />
                    </section>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm text-[var(--studio-muted)]" role="status">
                            {hydrated ? <>共 <span className="font-medium tabular-nums text-[var(--studio-ink)]">{visibleDocuments.length}</span> 个画布{keyword.trim() ? ` · 全部 ${documents.length} 个` : ""}</> : error ? "列表暂时无法加载" : "正在读取画布列表"}
                        </p>
                        {keyword.trim() ? (
                            <Button type="text" size="small" icon={<RotateCcw className="size-3.5" />} onClick={() => changeKeyword("")}>
                                清除搜索
                            </Button>
                        ) : (
                            <p className="text-xs text-[var(--studio-faint)]">勾选卡片，批量导出或删除</p>
                        )}
                    </div>

                    {selectedDocuments.length ? (
                        <section className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-[var(--studio-primary-line)] bg-[var(--studio-primary-soft)] px-4 py-3" aria-label="画布批量操作">
                            <div className="flex items-center gap-2">
                                <p className="text-sm font-medium text-[var(--studio-action)]">已选中 {selectedDocuments.length} 个画布</p>
                                <Button type="text" size="small" icon={<X className="size-3.5" />} onClick={() => selectedDocumentIds.forEach((id) => setDocumentSelected(id, false))}>
                                    取消选择
                                </Button>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                <Button disabled={!hydrated || isImporting || isExporting} icon={<Download className="size-4" />} loading={isExporting} onClick={() => void exportSelectedCanvasArchives()}>
                                    导出选中
                                </Button>
                                <Button danger disabled={!hydrated} icon={<Trash2 className="size-4" />} onClick={() => requestDocumentDeletion(selectedDocuments.map((document) => document.identity.id))}>
                                    删除选中
                                </Button>
                            </div>
                        </section>
                    ) : null}
                </>
            }
            footer={
                <ListPagination
                    current={result.page}
                    pageSize={result.pageSize}
                    total={result.total}
                    label="画布"
                    disabled={!hydrated}
                    onChange={(nextPage, nextPageSize) => {
                        setPage(nextPageSize === pageSize ? nextPage : 1);
                        setPageSize(nextPageSize);
                    }}
                />
            }
        >
            {!hydrated && error ? (
                <section role="alert" className="flex min-h-[280px] flex-col items-center justify-center gap-4 rounded-[20px] border border-[var(--studio-line)] text-sm text-[var(--studio-muted)]">
                    <p>画布列表加载失败，已保存的作品不受影响。</p>
                    <Button loading={loading} icon={<RotateCcw className="size-4" />} onClick={() => void reload()}>重新加载</Button>
                </section>
            ) : !hydrated ? (
                <section className={cardStyles.grid} aria-label="正在读取画布列表" aria-busy="true">
                    {Array.from({ length: 8 }, (_, index) => <div key={index} className="studio-skeleton aspect-[4/3] rounded-[16px]" />)}
                </section>
            ) : visibleDocuments.length ? (
                <section className={cardStyles.grid} aria-label="画布列表">
                    {result.items.map((document) => (
                        <CanvasProjectCard key={document.identity.id} document={document} />
                    ))}
                </section>
            ) : documents.length ? (
                <section className="flex min-h-[320px] flex-col items-center justify-center rounded-[20px] border border-dashed border-[var(--studio-line-strong)] bg-[var(--studio-surface-soft)] px-6 py-10 text-center">
                    <Search className="mb-4 size-7 text-[var(--studio-faint)]" />
                    <h2 className="text-base font-medium text-[var(--studio-ink)]">没有找到匹配的画布</h2>
                    <p className="mt-2 text-sm text-[var(--studio-muted)]">试试其他名称，或查看全部画布。</p>
                    <Button className="mt-5" icon={<RotateCcw className="size-4" />} onClick={() => changeKeyword("")}>
                        清除搜索
                    </Button>
                </section>
            ) : (
                <section className="flex min-h-[360px] flex-col items-center justify-center rounded-[20px] border border-dashed border-[var(--studio-line-strong)] bg-[var(--studio-surface-soft)] px-6 py-10 text-center">
                    <div className="mb-5 rounded-[16px] bg-[var(--studio-primary-soft)] p-4 text-[var(--studio-action)]">
                        <PanelsTopLeft className="size-7" />
                    </div>
                    <h2 className="text-xl font-medium text-[var(--studio-ink)]">还没有画布</h2>
                    <p className="mt-3 text-sm text-[var(--studio-muted)]">新建一个画布后，就可以独立保存节点、连线和画布外观。</p>
                    <div className="mt-6 flex flex-wrap justify-center gap-2">
                        <Button type="primary" icon={<Plus className="size-4" />} onClick={createAndOpenProject}>
                            新建画布
                        </Button>
                        <Button icon={<FileUp className="size-4" />} loading={isImporting} disabled={isImporting || isExporting} onClick={() => fileInputRef.current?.click()}>
                            导入已有画布
                        </Button>
                    </div>
                </section>
            )}

            <input ref={fileInputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvasArchive(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
        </PageShell>
    );
}

async function readArchiveExportFile(archive: Awaited<ReturnType<typeof readZip>>) {
    const manifestFile = archive.get(CANVAS_EXPORT_MANIFEST_NAME);
    if (!manifestFile) {
        throw new Error("缺少项目清单");
    }
    const parsedFile = JSON.parse(await manifestFile.text()) as CanvasExportFile;
    if (parsedFile.app !== CANVAS_EXPORT_APP_ID || parsedFile.version !== CANVAS_EXPORT_VERSION || !Array.isArray(parsedFile.documents)) {
        throw new Error("画布压缩包格式无效");
    }
    return parsedFile;
}

async function restoreArchiveFiles(archive: Awaited<ReturnType<typeof readZip>>, exportFile: CanvasExportFile) {
    await Promise.all(
        exportFile.documents.flatMap((documentItem) =>
            documentItem.files.map(async (fileItem) => {
                const fileBlob = archive.get(fileItem.path);
                if (!fileBlob) return;
                const typedBlob = fileBlob.type ? fileBlob : fileBlob.slice(0, fileBlob.size, fileItem.mimeType);
                if (fileItem.storageKey.startsWith("image:")) {
                    await setImageBlob(fileItem.storageKey, typedBlob);
                    return;
                }
                await setMediaBlob(fileItem.storageKey, typedBlob);
            }),
        ),
    );
}

function resetFileInput(input: HTMLInputElement | null) {
    if (input) {
        input.value = "";
    }
}
