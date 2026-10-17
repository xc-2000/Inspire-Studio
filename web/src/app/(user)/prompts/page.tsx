"use client";

import { useEffect, useState } from "react";
import { App, Button, Empty, Spin } from "antd";
import { ArrowRight, FolderPlus, RefreshCw, BookOpenText, RotateCcw } from "lucide-react";

import { useAssetStore } from "@/features/assets/stores/use-asset-store";
import { ALL_PROMPTS_OPTION, type Prompt } from "@/features/prompts/api/prompts";
import { PromptCard } from "@/features/prompts/components/prompt-card";
import { PromptDetailDialog } from "@/features/prompts/components/prompt-detail-dialog";
import { PromptFilterPanel } from "@/features/prompts/components/prompt-filter-panel";
import { usePromptList } from "@/features/prompts/hooks/use-prompt-list";
import { ListPagination } from "@/shared/components/list-pagination";
import { PageShell } from "@/shared/components/page-shell";
import { useCopyText } from "@/shared/hooks/use-copy-text";

export default function PromptsPage() {
    const { message } = App.useApp();
    const copyText = useCopyText();
    const addAsset = useAssetStore((state) => state.addAsset);
    const [keyword, setKeyword] = useState("");
    const [tags, setTags] = useState<string[]>([]);
    const [category, setCategory] = useState(ALL_PROMPTS_OPTION);
    const [previewPrompt, setPreviewPrompt] = useState<Prompt | null>(null);
    const promptList = usePromptList({ keyword, tags, category });
    const hasFilters = Boolean(keyword.trim() || tags.length || category !== ALL_PROMPTS_OPTION);
    const clearFilters = () => {
        setKeyword("");
        setTags([]);
        setCategory(ALL_PROMPTS_OPTION);
    };

    useEffect(() => {
        if (promptList.query.isError) message.error(promptList.query.error instanceof Error ? promptList.query.error.message : "获取提示词失败");
    }, [message, promptList.query.error, promptList.query.isError]);

    const saveAsAsset = (prompt: Prompt) => {
        addAsset({ kind: "text", title: prompt.title, coverUrl: prompt.coverUrl, tags: prompt.tags, source: prompt.category, data: { content: prompt.prompt }, metadata: { source: "prompt-library", promptId: prompt.id, githubUrl: prompt.githubUrl } });
        message.success("已加入我的资产");
    };

    return (
        <PageShell icon={<BookOpenText />}
            eyebrow="创作参考"
            title="提示词中心"
            description="发现适合你的创作灵感，复制提示词，或收藏到资产库。"
            width="wide"
            actions={
                <Button href="/assets" icon={<ArrowRight className="size-4" />}>
                    我的资产
                </Button>
            }
            scrollKey={JSON.stringify([promptList.page, promptList.pageSize, keyword, tags, category])}
            toolbar={
                <>
                    <PromptFilterPanel keyword={keyword} selectedTags={tags} selectedCategory={category} tags={promptList.tags} categories={promptList.categories} onKeywordChange={setKeyword} onTagsChange={setTags} onCategoryChange={setCategory} />
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm text-[var(--studio-muted)]" role="status">
                            {promptList.query.isPending ? (
                                "正在查找提示词…"
                            ) : (
                                <>
                                    共 <span className="font-medium tabular-nums text-[var(--studio-ink)]">{promptList.total}</span> 条提示词
                                </>
                            )}
                        </p>
                        {hasFilters ? (
                            <Button type="text" size="small" icon={<RotateCcw className="size-3.5" />} onClick={clearFilters}>
                                清除筛选
                            </Button>
                        ) : (
                            <p className="text-xs text-[var(--studio-faint)]">点击卡片查看完整提示词</p>
                        )}
                    </div>
                </>
            }
            footer={
                <ListPagination current={promptList.page} pageSize={promptList.pageSize} total={promptList.total} onChange={promptList.changePage} disabled={promptList.query.isFetching} label="提示词" />
            }
        >
            {promptList.query.isPending ? (
                <div className="flex h-72 items-center justify-center" aria-label="正在加载提示词">
                    <Spin />
                </div>
            ) : null}
            {!promptList.query.isPending && promptList.items.length ? (
                <section className="studio-card-grid" aria-label="提示词列表">
                    {promptList.items.map((prompt) => (
                        <PromptCard
                            key={prompt.id}
                            item={prompt}
                            onOpen={() => setPreviewPrompt(prompt)}
                            onCopy={() => copyText(prompt.prompt, "提示词已复制")}
                            extraAction={
                                <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => saveAsAsset(prompt)}>
                                    存为素材
                                </Button>
                            }
                        />
                    ))}
                </section>
            ) : null}
            {!promptList.query.isPending && !promptList.items.length ? (
                <div className="flex min-h-[320px] items-center justify-center rounded-[20px] border border-dashed border-[var(--studio-line-strong)] bg-[var(--studio-surface-soft)] px-5 py-10">
                    <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={
                            <div>
                                <p className="font-medium text-[var(--studio-ink)]">{promptList.query.isError ? "提示词加载失败" : "没有找到匹配的提示词"}</p>
                                <p className="mt-2 text-sm text-[var(--studio-muted)]">{promptList.query.isError ? "请重新加载，稍后继续寻找灵感。" : hasFilters ? "试试其他关键词、分类或标签。" : "新的创作灵感即将出现在这里。"}</p>
                            </div>
                        }
                    >
                        {promptList.query.isError ? (
                            <Button icon={<RefreshCw className="size-4" />} loading={promptList.query.isFetching} onClick={() => void promptList.query.refetch()}>
                                重新加载
                            </Button>
                        ) : hasFilters ? (
                            <Button icon={<RotateCcw className="size-4" />} onClick={clearFilters}>清除筛选</Button>
                        ) : null}
                    </Empty>
                </div>
            ) : null}

            <PromptDetailDialog prompt={previewPrompt} onClose={() => setPreviewPrompt(null)} onCopy={(value) => copyText(value, "提示词已复制")} onSaveAsset={saveAsAsset} />
        </PageShell>
    );
}
