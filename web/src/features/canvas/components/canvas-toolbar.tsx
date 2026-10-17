import type { ReactNode } from "react";
import { Button, Dropdown, Tooltip } from "antd";
import { Eraser, FolderOpen, Frame, Hand, Image as ImageIcon, Redo2, Trash2, Type, Undo2, Upload, AudioLines, Video, MoreHorizontal, MousePointer2, Plus } from "lucide-react";

import type { CanvasTheme } from "@/shared/lib/canvas-theme";
import type { CanvasBackgroundNode } from "../types";
import { useCanvasTheme } from "./canvas-theme-provider";
import { canvasEditorStyle } from "./canvas-tool-dialog";
import styles from "./canvas-editor.module.css";

type ToolButtonStyle = {
    background?: string;
    color?: string;
    opacity?: number;
};

type CanvasToolbarProps = {
    selectedCount: number;
    canUndo: boolean;
    canRedo: boolean;
    onAddImage: () => void;
    onAddVideo: () => void;
    onAddAudio: () => void;
    onAddText: () => void;
    onAddBackground: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onUpload: () => void;
    onDelete: () => void;
    onClear: () => void;
    onDeselect: () => void;
    onOpenMyAssets: () => void;
    editingActions?: ReactNode;
    selectedBackground?: CanvasBackgroundNode | null;
    onBackgroundTitleChange?: (nodeId: string, title: string) => void;
    onBackgroundColorChange?: (nodeId: string, color: string) => void;
};

type ToolbarAction = {
    key: string;
    label: string;
    icon: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    danger?: boolean;
    active?: boolean;
    dividerBefore?: boolean;
};

export function CanvasToolbar(props: CanvasToolbarProps) {
    const theme = useCanvasTheme();
    const toolActions = buildToolbarActions(props);

    return (
        <div
            data-canvas-toolbar
            role="group"
            aria-label="画布编辑工具"
            className={`${styles.dock} absolute bottom-3 left-1/2 z-50 flex min-h-12 -translate-x-1/2 items-center border sm:bottom-4`}
            style={{ ...canvasEditorStyle(theme), background: theme.toolbar.panel, borderColor: theme.toolbar.border, marginBottom: "env(safe-area-inset-bottom, 0px)" }}
        >
            {props.selectedBackground ? <BackgroundToolbarSettings node={props.selectedBackground} onTitleChange={props.onBackgroundTitleChange} onColorChange={props.onBackgroundColorChange} /> : null}
            {props.selectedCount > 0 ? <div className={styles.selectionBadge}><MousePointer2 className="size-3" />已选 {props.selectedCount} 个节点</div> : null}
            <div className={styles.dockGroup}>{['move', 'undo', 'redo'].map((key) => <ToolbarActionItem key={key} action={{ ...toolActions.find((action) => action.key === key)!, dividerBefore: false }} />)}</div>
            <div className={styles.dockGroup}>
                {props.selectedCount ? <Dropdown trigger={["click"]} placement="top" menu={{ items: toolActions.filter((action) => ['text', 'image', 'video', 'audio', 'background'].includes(action.key)).map((action) => ({ key: action.key, label: action.label, icon: action.icon, onClick: action.onClick })) }}>
                    <Button type="text" className={styles.labelAction} aria-label="添加节点" icon={<Plus className="size-4" />}>添加</Button>
                </Dropdown> : ['text', 'image', 'video', 'audio', 'background'].map((key) => <ToolbarActionItem key={key} action={{ ...toolActions.find((action) => action.key === key)!, dividerBefore: false }} />)}
            </div>
            <div className={styles.dockGroup}>
                {toolActions.filter((action) => ['upload', 'assets'].includes(action.key)).map((action) => <ToolbarActionItem key={action.key} action={{ ...action, dividerBefore: false }} />)}
                <Dropdown trigger={["click"]} placement="top" menu={{ items: toolActions.filter((action) => action.danger).map((action) => ({ key: action.key, label: action.label, icon: action.icon, danger: true, onClick: action.onClick })) }}>
                    <Button type="text" aria-label="更多画布操作" icon={<MoreHorizontal className="size-4" />} style={{ color: theme.toolbar.item }} />
                </Dropdown>
            </div>
            {props.editingActions}
        </div>
    );
}

function BackgroundToolbarSettings({ node, onTitleChange, onColorChange }: { node: CanvasBackgroundNode; onTitleChange?: (nodeId: string, title: string) => void; onColorChange?: (nodeId: string, color: string) => void }) {
    const theme = useCanvasTheme();
    const colors = ["var(--studio-surface-raised)", "var(--studio-surface-hover)", "var(--studio-line)", "var(--studio-info)", "var(--studio-success)", "var(--studio-warning)"];
    return (
        <div className="mr-1 flex items-center gap-1.5 border-r pr-2" style={{ borderColor: theme.toolbar.border }}>
            <label className="sr-only" htmlFor="canvas-background-title">
                背景板名称
            </label>
            <input
                id="canvas-background-title"
                className="h-8 w-28 rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:ring-2"
                style={{ borderColor: theme.toolbar.border, color: theme.node.text, outlineColor: theme.node.activeStroke }}
                value={node.title}
                onChange={(event) => onTitleChange?.(node.id, event.target.value)}
                onBlur={(event) => onTitleChange?.(node.id, event.target.value.trim() || "背景板")}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
            />
            <div className="flex items-center gap-1" role="group" aria-label="背景板颜色">
                {colors.map((color) => {
                    const label = `设置背景板颜色 ${color}`;
                    return (
                        <Tooltip key={color} title={label} placement="top">
                            <button
                                type="button"
                                aria-label={label}
                                className="size-5 rounded-full border transition-transform hover:scale-110 focus-visible:ring-2"
                                style={{ background: color, borderColor: node.backgroundColor === color ? theme.node.activeStroke : theme.toolbar.border, outlineColor: theme.node.activeStroke }}
                                onClick={() => onColorChange?.(node.id, color)}
                            />
                        </Tooltip>
                    );
                })}
            </div>
        </div>
    );
}

function buildToolbarActions(props: CanvasToolbarProps): ToolbarAction[] {
    const actions: ToolbarAction[] = [
        { key: "move", label: "移动/选择", icon: <Hand className="size-4" />, active: !props.selectedCount, onClick: props.onDeselect },
        { key: "undo", label: "撤销", icon: <Undo2 className="size-4" />, disabled: !props.canUndo, onClick: props.onUndo },
        { key: "redo", label: "重做", icon: <Redo2 className="size-4" />, disabled: !props.canRedo, onClick: props.onRedo, dividerBefore: false },
        { key: "text", label: "文本", icon: <Type className="size-4" />, dividerBefore: true, onClick: props.onAddText },
        { key: "image", label: "图片", icon: <ImageIcon className="size-4" />, onClick: props.onAddImage },
        { key: "audio", label: "音频", icon: <AudioLines className="size-4" />, onClick: props.onAddAudio },
        { key: "video", label: "视频", icon: <Video className="size-4" />, onClick: props.onAddVideo },
        { key: "background", label: "背景板", icon: <Frame className="size-4" />, onClick: props.onAddBackground },
        { key: "upload", label: "上传素材", icon: <Upload className="size-4" />, onClick: props.onUpload },
        { key: "assets", label: "我的资产", icon: <FolderOpen className="size-4" />, dividerBefore: true, onClick: props.onOpenMyAssets },
    ];

    if (props.selectedCount) {
        actions.push({
            key: "delete",
            label: `删除选中 ${props.selectedCount}`,
            icon: <Trash2 className="size-4" />,
            dividerBefore: true,
            danger: true,
            onClick: props.onDelete,
        });
    }

    actions.push({
        key: "clear",
        label: "清空画布",
        icon: <Eraser className="size-4" />,
        dividerBefore: true,
        danger: true,
        onClick: props.onClear,
    });

    return actions;
}

function ToolbarActionItem({ action }: { action: ToolbarAction }) {
    const theme = useCanvasTheme();

    return (
        <>
            {action.dividerBefore ? <ToolbarDivider /> : null}
            <Tooltip title={action.label} placement="top" mouseEnterDelay={0.4}>
                <Button
                    type="text"
                    aria-label={action.label}
                    className="canvas-toolbar-action !p-0 transition-colors"
                    aria-pressed={action.key === "move" ? action.active : undefined}
                    disabled={action.disabled}
                    style={resolveToolbarButtonStyle(action, theme)}
                    icon={action.icon}
                    onClick={action.onClick}
                    onMouseEnter={(event) => applyToolbarHover(event.currentTarget, action, theme)}
                    onMouseLeave={(event) => clearToolbarHover(event.currentTarget)}
                />
            </Tooltip>
        </>
    );
}

function ToolbarDivider() {
    const theme = useCanvasTheme();
    return <div className="mx-1 h-5 w-px" style={{ background: theme.toolbar.border }} />;
}

function resolveToolbarButtonStyle(action: ToolbarAction, theme: CanvasTheme): ToolButtonStyle {
    if (action.active) {
        return {
            background: theme.toolbar.activeBg,
            color: theme.toolbar.activeText,
        };
    }
    if (action.disabled) {
        return {
            color: theme.toolbar.item,
            opacity: 0.3,
        };
    }
    return {
        color: action.danger ? "#f87171" : theme.toolbar.item,
    };
}

function applyToolbarHover(element: HTMLElement, action: ToolbarAction, theme: CanvasTheme) {
    if (action.disabled || action.active) return;
    element.style.background = theme.toolbar.itemHover;
    if (!action.danger) {
        element.style.color = theme.toolbar.activeText;
    }
}

function clearToolbarHover(element: HTMLElement) {
    element.style.background = "transparent";
}
