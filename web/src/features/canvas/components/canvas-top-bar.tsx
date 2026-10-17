"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Bot, Keyboard, MoreHorizontal, PanelLeftOpen } from "lucide-react";
import { Button, Modal, Popover, Tooltip } from "antd";

import { UserStatusActions } from "@/features/app-shell/components/user-status-actions";
import { UserCreditMenu } from "@/features/app-shell/components/user-credit-menu";
import { ThemePreferenceMenu } from "@/features/theme/components/theme-preference-menu";
import { useCanvasTheme } from "./canvas-theme-provider";
import { CanvasSaveIndicator } from "./canvas-save-indicator";

type CanvasTopBarProps = {
    documentId: string;
    taskActions?: ReactNode;
    title: string;
    titleDraft: string;
    isTitleEditing: boolean;
    onTitleDraftChange: (value: string) => void;
    onStartTitleEditing: () => void;
    onFinishTitleEditing: () => void;
    onCancelTitleEditing: () => void;
    onBackToProjects: () => void;
    navigationPanelHidden: boolean;
    onOpenNavigationPanel: () => void;
    agentOpen: boolean;
    onToggleAgent: () => void;
};

const SHORTCUT_GROUPS = [
    {
        title: "视图",
        items: [
            ["拖动画布", "平移视图"],
            ["滚轮 / 缩放滑杆", "缩放画布"],
        ],
    },
    {
        title: "选择与编辑",
        items: [
            ["Ctrl / Cmd + 拖动", "框选节点"],
            ["Shift / Ctrl / Cmd + 点击", "追加选择"],
            ["Ctrl / Cmd + A", "全选节点"],
            ["Ctrl / Cmd + C / V", "复制或粘贴节点、文本、图片"],
            ["Ctrl / Cmd + D", "复制选区及内部连线"],
            ["Delete / Backspace", "删除选中内容"],
            ["Esc", "取消选择并关闭浮层"],
        ],
    },
    {
        title: "历史与协作",
        items: [
            ["Ctrl / Cmd + Z", "撤销"],
            ["Ctrl / Cmd + Shift + Z / Y", "重做"],
            ["Ctrl / Cmd + Shift + 拖动节点", "发送节点到画布Agent"],
            ["拖入图片或视频", "上传到画布"],
        ],
    },
] as const;

export function CanvasTopBar(props: CanvasTopBarProps) {
    const theme = useCanvasTheme();
    const headerRef = useRef<HTMLElement>(null);
    const [compactToolbar, setCompactToolbar] = useState(true);
    const titleAreaRef = useRef<HTMLDivElement>(null);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);

    useEffect(() => {
        const header = headerRef.current;
        if (!header) return;
        const updateLayout = () => setCompactToolbar(header.clientWidth < 640);
        updateLayout();
        const observer = new ResizeObserver(updateLayout);
        observer.observe(header);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!props.isTitleEditing) return;
        const finishWhenClickingOutside = (event: PointerEvent) => {
            if (!titleAreaRef.current?.contains(event.target as Node)) props.onFinishTitleEditing();
        };
        document.addEventListener("pointerdown", finishWhenClickingOutside, true);
        return () => document.removeEventListener("pointerdown", finishWhenClickingOutside, true);
    }, [props.isTitleEditing, props.onFinishTitleEditing]);

    const toolbarButtonStyle = { color: theme.node.text };
    const accountActions = (
        <div className="flex items-center gap-1.5">
            <UserStatusActions variant="canvas" onOpenShortcuts={() => setShortcutsOpen(true)} />
            <ThemePreferenceMenu variant="toolbar" />
            <UserCreditMenu />
        </div>
    );

    return (
        <>
            <header
                ref={headerRef}
                data-canvas-topbar
                className="pointer-events-none absolute inset-x-3 top-3 z-[140] flex h-12 items-center justify-between gap-3 rounded-2xl border px-2.5 sm:px-3.5"
                style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}
            >
                <div className="pointer-events-auto flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
                    <Tooltip title="返回画布列表">
                        <Button type="text" className="!size-9 !shrink-0 !p-0" aria-label="返回画布列表" icon={<ArrowLeft className="size-4" />} onClick={props.onBackToProjects} style={toolbarButtonStyle} />
                    </Tooltip>
                    <div className="h-4 w-px shrink-0" style={{ background: theme.toolbar.border }} />
                    <div ref={titleAreaRef} className="min-w-0 flex-1">
                        {props.isTitleEditing ? (
                            <input
                                autoFocus
                                value={props.titleDraft}
                                aria-label="画布名称"
                                className="w-full max-w-80 rounded-md border bg-transparent px-2 py-1 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-action)]"
                                style={{ color: theme.node.text }}
                                onChange={(event) => props.onTitleDraftChange(event.target.value)}
                                onBlur={props.onFinishTitleEditing}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") props.onFinishTitleEditing();
                                    else if (event.key === "Escape") props.onCancelTitleEditing();
                                }}
                            />
                        ) : (
                            <button
                                type="button"
                                className="block max-w-full truncate rounded-md text-left text-[13px] font-semibold tracking-[-0.01em] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--studio-action)] sm:max-w-80"
                                onDoubleClick={props.onStartTitleEditing}
                                title="双击修改画布名称"
                            >
                                {props.title}
                            </button>
                        )}
                    </div>
                    <CanvasSaveIndicator documentId={props.documentId} />
                </div>

                <div className="pointer-events-auto flex shrink-0 items-center gap-1 sm:gap-2">
                    {props.taskActions}
                    {props.navigationPanelHidden ? (
                        <Tooltip title="显示画布导航">
                            <Button type="text" aria-label="显示画布导航" icon={<PanelLeftOpen className="size-4" />} onClick={props.onOpenNavigationPanel} style={toolbarButtonStyle} />
                        </Tooltip>
                    ) : null}
                    {!compactToolbar ? (
                        accountActions
                    ) : (
                        <Popover placement="bottomRight" trigger="click" content={accountActions}>
                            <Button type="text" className="!size-9 !p-0" icon={<MoreHorizontal className="size-4" />} aria-label="画布设置与账户" style={toolbarButtonStyle} />
                        </Popover>
                    )}
                    <Button
                        type="text"
                        className="canvas-agent-toggle !h-9 !rounded-lg !px-2 sm:!px-3"
                        icon={<Bot className="size-4" />}
                        aria-pressed={props.agentOpen}
                        aria-label={props.agentOpen ? "关闭 Agent" : "打开 Agent"}
                        onClick={props.onToggleAgent}
                    >
                        {!compactToolbar ? <span>Agent</span> : null}
                    </Button>
                </div>
            </header>

            <Modal
                title={
                    <span className="inline-flex items-center gap-2">
                        <Keyboard className="size-4" />
                        画布快捷键
                    </span>
                }
                open={shortcutsOpen}
                onCancel={() => setShortcutsOpen(false)}
                footer={null}
                centered
                width={560}
            >
                <div className="space-y-5 pt-2">
                    {SHORTCUT_GROUPS.map((group) => (
                        <section key={group.title} aria-label={group.title}>
                            <h3 className="mb-2 text-sm font-semibold" style={{ color: theme.node.text }}>
                                {group.title}
                            </h3>
                            <dl className="divide-y" style={{ borderColor: theme.node.stroke }}>
                                {group.items.map(([keys, description]) => (
                                    <div key={keys} className="flex items-center justify-between gap-6 py-2 text-sm">
                                        <dt>
                                            <kbd className="rounded-md px-2 py-1 font-mono text-xs" style={{ background: theme.node.fill, color: theme.node.text }}>
                                                {keys}
                                            </kbd>
                                        </dt>
                                        <dd className="text-right" style={{ color: theme.node.muted }}>
                                            {description}
                                        </dd>
                                    </div>
                                ))}
                            </dl>
                        </section>
                    ))}
                </div>
            </Modal>
        </>
    );
}
