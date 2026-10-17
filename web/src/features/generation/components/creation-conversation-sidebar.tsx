"use client";

import type { MenuProps } from "antd";
import { App, Button, Checkbox, Dropdown, Input, Modal, Tooltip } from "antd";
import { CheckSquare, LoaderCircle, MoreHorizontal, Pencil, Plus, Trash2, History, MessageSquareText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ListPagination } from "@/shared/components/list-pagination";
import { usePaginatedList } from "@/shared/hooks/use-paginated-list";
import { EmptyGlyph } from "@/shared/components/icon-label";
import styles from "./creation-workspace.module.css";

import type { CreationConversationItem, CreationSidebarProps } from "@/features/generation/components/creation-workspace-types";
import { MAX_CONVERSATION_TITLE_LENGTH, normalizeConversationTitle, validateConversationTitle } from "@/features/generation/lib/conversation-title";

type CreationConversationSidebarProps = CreationSidebarProps & {
    compact?: boolean;
};

type RenameTarget = {
    id: string;
    title: string;
};

export function CreationConversationSidebar({
    heading,
    items,
    managementMode,
    hasSelection,
    onCreate,
    onToggleManagement,
    onToggleSelectAll,
    onDeleteSelected,
    onSelectConversation,
    onToggleConversation,
    onRenameConversation,
    onDeleteConversation,
    compact = false,
}: CreationConversationSidebarProps) {
    const { message, modal } = App.useApp();
    const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
    const [renameTitle, setRenameTitle] = useState("");
    const [renameError, setRenameError] = useState("");
    const [renaming, setRenaming] = useState(false);
    const pagination = usePaginatedList(items, 10);
    const activeId = items.find((item) => item.active)?.id;
    const itemsRef = useRef(items);
    itemsRef.current = items;
    useEffect(() => {
        const index = itemsRef.current.findIndex((item) => item.id === activeId);
        if (index >= 0) pagination.setPage(Math.floor(index / pagination.pageSize) + 1);
    }, [activeId, pagination.setPage]);

    const openRenameDialog = (item: CreationConversationItem) => {
        setRenameTarget({ id: item.id, title: item.title });
        setRenameTitle(item.title);
        setRenameError("");
    };

    const closeRenameDialog = () => {
        if (renaming) {
            return;
        }
        setRenameTarget(null);
        setRenameTitle("");
        setRenameError("");
    };

    const submitRename = async () => {
        if (!renameTarget) {
            return;
        }
        const nextError = validateConversationTitle(renameTitle);
        if (nextError) {
            setRenameError(nextError);
            return;
        }
        const normalizedTitle = normalizeConversationTitle(renameTitle);
        setRenaming(true);
        try {
            await onRenameConversation(renameTarget.id, normalizedTitle);
            setRenameTarget(null);
            setRenameTitle("");
            setRenameError("");
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "修改标题失败";
            setRenameError(errorMessage);
            message.error(errorMessage);
        } finally {
            setRenaming(false);
        }
    };

    const requestDelete = (item: CreationConversationItem) => {
        modal.confirm({
            title: "删除记录",
            content: `确定删除“${item.title}”吗？删除后无法恢复。`,
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
                try {
                    await onDeleteConversation(item.id);
                    message.success("记录已删除");
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "删除记录失败");
                    throw error;
                }
            },
        });
    };

    return (
        <>
            <div className={`flex h-full min-h-0 flex-col ${compact ? "" : "p-3"}`}>
                <div className="mb-3 flex shrink-0 items-center justify-between gap-2 border-b border-[var(--studio-line)] pb-3">
                    <div className="flex min-w-0 items-center gap-2 pl-1">
                        <History className="size-3.5 shrink-0 text-[var(--studio-muted)]" aria-hidden="true" /><h2 className="m-0 truncate text-xs font-semibold text-[var(--studio-ink)]">{heading}</h2>
                        <span className="rounded-md bg-[var(--studio-surface-hover)] px-1.5 py-0.5 text-[10px] tabular-nums text-[var(--studio-muted)]">{items.length}</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <Tooltip title="新建对话">
                            <Button type="text" size="small" className="!size-8 !rounded-lg !p-0 hover:!bg-[var(--studio-surface-hover)]" icon={<Plus className="size-4" />} onClick={onCreate} aria-label="新建对话" />
                        </Tooltip>
                        <Button
                            type="text"
                            size="small"
                            className="!size-8 !rounded-lg !p-0 hover:!bg-[var(--studio-surface-hover)]"
                            icon={managementMode ? <CheckSquare className="size-4" /> : <MoreHorizontal className="size-4" />}
                            onClick={onToggleManagement}
                            aria-label={managementMode ? "退出对话管理" : "管理对话"}
                            aria-pressed={managementMode}
                        />
                    </div>
                </div>

                {managementMode ? (
                    <div className="mb-3 flex shrink-0 flex-wrap gap-2">
                        <Button size="small" className="!rounded-lg" icon={<CheckSquare className="size-3.5" />} onClick={onToggleSelectAll}>
                            全选所有页
                        </Button>
                        <Button size="small" danger className="!rounded-lg" icon={<Trash2 className="size-3.5" />} disabled={!hasSelection} onClick={onDeleteSelected}>
                            删除已选
                        </Button>
                        <span className="w-full text-xs text-[var(--studio-muted)]">已选 {items.filter((item) => item.selected).length} 条（含其他页）</span>
                    </div>
                ) : null}

                <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto">
                    {items.length ? (
                        <div className="space-y-1 p-0.5">
                            {pagination.items.map((item) => (
                                <ConversationItem
                                    key={item.id}
                                    item={item}
                                    enableContextMenu={!compact}
                                    managementMode={managementMode}
                                    onSelectConversation={onSelectConversation}
                                    onToggleConversation={onToggleConversation}
                                    onRequestRename={openRenameDialog}
                                    onRequestDelete={requestDelete}
                                />
                            ))}
                        </div>
                    ) : (
                        <div className="rounded-lg border border-dashed border-[var(--studio-line)] px-4 py-8 text-center">
                            <EmptyGlyph><MessageSquareText /></EmptyGlyph><p className="text-sm text-[var(--studio-muted)]">暂无对话</p>
                            <button type="button" className="mt-2 text-xs font-medium text-[var(--studio-action)] hover:underline" onClick={onCreate}>
                                开始第一次创作
                            </button>
                        </div>
                    )}
                </div>
                <ListPagination compact label={`${heading}分页`} current={pagination.page} pageSize={pagination.pageSize} total={pagination.total} onChange={pagination.onChange} pageSizeOptions={[10, 20, 50]} className="shrink-0" />
            </div>
            <Modal title="修改标题" open={Boolean(renameTarget)} onCancel={closeRenameDialog} onOk={() => void submitRename()} okText="保存" cancelText="取消" confirmLoading={renaming} destroyOnHidden>
                <div className="space-y-3 pt-2">
                    <Input
                        value={renameTitle}
                        autoFocus
                        status={renameError ? "error" : undefined}
                        placeholder="请输入对话标题"
                        onChange={(event) => {
                            setRenameTitle(event.target.value);
                            if (renameError) {
                                setRenameError("");
                            }
                        }}
                        onPressEnter={() => {
                            if (!renaming) {
                                void submitRename();
                            }
                        }}
                    />
                    <div className="flex items-center justify-between gap-3 text-xs">
                        <span className={renameError ? "text-red-500" : "text-[var(--studio-muted)]"}>{renameError || "标题修改后会立即同步到最近对话列表。"}</span>
                        <span className="shrink-0 text-[var(--studio-faint)]">
                            {normalizeConversationTitle(renameTitle).length}/{MAX_CONVERSATION_TITLE_LENGTH}
                        </span>
                    </div>
                </div>
            </Modal>
        </>
    );
}

function ConversationItem({
    item,
    enableContextMenu,
    managementMode,
    onSelectConversation,
    onToggleConversation,
    onRequestRename,
    onRequestDelete,
}: {
    item: CreationConversationItem;
    enableContextMenu: boolean;
    managementMode: boolean;
    onSelectConversation: (id: string) => void;
    onToggleConversation: (id: string, checked: boolean) => void;
    onRequestRename: (item: CreationConversationItem) => void;
    onRequestDelete: (item: CreationConversationItem) => void;
}) {
    const activeClassName = item.active ? "bg-[var(--studio-primary-soft)] ring-1 ring-[var(--studio-primary-line)]" : "hover:bg-[var(--studio-surface-hover)] hover:border-[var(--studio-line)]";
    const conversationMenuItems: MenuProps["items"] = [
        {
            key: "rename",
            label: "修改标题",
            icon: <Pencil className="size-3.5" />,
        },
        {
            key: "delete",
            label: item.status === "running" ? "生成中不可删除" : "删除记录",
            danger: true,
            disabled: item.status === "running",
            icon: <Trash2 className="size-3.5" />,
        },
    ];

    const itemContent = (
        <div className={`group flex w-full items-center gap-2 border border-transparent px-2.5 py-2.5 text-left transition-colors ${styles.conversationRow} ${activeClassName}`}>
            {managementMode ? <Checkbox className="shrink-0" checked={item.selected} aria-label={`选择对话：${item.title}`} onChange={(event) => onToggleConversation(item.id, event.target.checked)} /> : null}
            <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--studio-action)]"
                onClick={() => onSelectConversation(item.id)}
                aria-current={item.active ? "true" : undefined}
            >
                {item.preview ? <div className={`shrink-0 overflow-hidden ${styles.conversationPreview}`}>{item.preview}</div> : null}
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-[var(--studio-ink)]">{item.title}</div>
                    <div className="mt-1 truncate text-[11px] text-[var(--studio-muted)]">{item.subtitle}</div>
                </div>
            </button>
            {managementMode ? null : <ConversationStatus status={item.status} />}
            {managementMode ? null : (
                <Dropdown
                    trigger={["click"]}
                    menu={{
                        items: conversationMenuItems,
                        onClick: ({ key }) => {
                            if (key === "rename") {
                                onRequestRename(item);
                            } else if (key === "delete") {
                                onRequestDelete(item);
                            }
                        },
                    }}
                >
                    <button
                        type="button"
                        className="grid size-7 shrink-0 place-items-center rounded-md text-[var(--studio-muted)] transition hover:bg-[var(--studio-surface-hover)] focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100"
                        aria-label={`更多操作：${item.title}`}
                        onClick={(event) => {
                            event.stopPropagation();
                        }}
                    >
                        <MoreHorizontal className="size-4" />
                    </button>
                </Dropdown>
            )}
        </div>
    );

    if (managementMode || !enableContextMenu) {
        return itemContent;
    }

    return (
        <Dropdown
            trigger={["contextMenu"]}
            menu={{
                items: conversationMenuItems,
                onClick: ({ key }) => {
                    if (key === "rename") {
                        onRequestRename(item);
                    } else if (key === "delete") {
                        onRequestDelete(item);
                    }
                },
            }}
        >
            {itemContent}
        </Dropdown>
    );
}

function ConversationStatus({ status }: { status: CreationConversationItem["status"] }) {
    if (status === "running") {
        return <LoaderCircle className="size-4 shrink-0 animate-spin text-[var(--studio-primary)]" aria-label="生成中" />;
    }
    if (status === "unreadSuccess") {
        return <span className="size-2 shrink-0 rounded-full bg-blue-500" aria-label="生成完成" />;
    }
    if (status === "unreadFailed") {
        return <span className="size-2 shrink-0 rounded-full bg-red-500" aria-label="生成失败" />;
    }
    return null;
}
