"use client";

import { Handle, NodeToolbar, Position, useStore } from "@xyflow/react";
import { LoaderCircle, AlertTriangle, ImageOff, VideoOff } from "lucide-react";
import { forwardRef, useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type MouseEventHandler, type PointerEvent, type ReactNode, type WheelEvent } from "react";
import { CANVAS_CONNECTION_HANDLE_SIZE } from "../constants";
import type { CanvasNode } from "../types";
import { useNodeActions } from "./node-action-context";
import { useCanvasTheme } from "../components/canvas-theme-provider";
import { useCanvasUiStore } from "../stores/use-canvas-ui-store";
import { formatGenerationError } from "@/shared/lib/generation-error";
import { canvasNodeTitleLayout } from "./node-title-layout";

/** 共享加载状态组件 */
export function NodeLoading() {
    const t = useCanvasTheme();
    return (
        <div className="flex h-full w-full items-center justify-center gap-2" style={{ color: t.node.muted }}>
            <LoaderCircle className="size-5 animate-spin" />
            <span className="text-sm">生成中...</span>
        </div>
    );
}

/** 共享错误状态组件 */
export function NodeError({ node, onRetry }: { node: CanvasNode; onRetry?: (node: CanvasNode) => void }) {
    const t = useCanvasTheme();
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-3 text-center" style={{ color: t.node.muted }}>
            <AlertTriangle className="size-6 text-red-400" />
            <span className="max-w-full break-words text-xs leading-5 text-red-400">{formatGenerationError(node.execution.errorMessage)}</span>
            {onRetry ? (
                <button type="button" className="mt-1 rounded-full border border-red-400/40 px-3 py-0.5 text-xs text-red-400 transition hover:bg-red-400/10" onClick={() => onRetry(node)}>
                    重试
                </button>
            ) : null}
        </div>
    );
}

/**
 * 媒体失效占位。
 * <p>
 * 图片或视频已经加载不出来时，用默认图标替换原始内容。
 */
export function NodeMediaUnavailable({ kind, compact = false }: { kind: "image" | "video"; compact?: boolean }) {
    const t = useCanvasTheme();
    const Icon = kind === "image" ? ImageOff : VideoOff;
    const label = kind === "image" ? "图片加载失败" : "视频加载失败";
    if (compact) {
        return (
            <span role="img" aria-label={label} title={label} className="grid h-full w-full place-items-center" style={{ color: t.node.placeholder }}>
                <Icon className="size-4 opacity-70" aria-hidden="true" />
            </span>
        );
    }
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-sm" style={{ color: t.node.placeholder }}>
            <Icon className="size-7 opacity-60" aria-hidden="true" />
            <span>{label}</span>
        </div>
    );
}

/** 节点默认最小尺寸 */
export const NODE_MIN_WIDTH = 220;
export const NODE_MIN_HEIGHT = 160;

export const selectionBlue = "#2f7d85";

type CanvasNodeTitleProps = {
    nodeId: string;
    title: string;
    defaultTitle: string;
    onTitleChange?: (nodeId: string, title: string) => void;
};

/** 名称受节点屏幕宽度约束；缩略浏览时隐藏过小标签，双击或按 Enter 编辑。 */
export function CanvasNodeTitle({ nodeId, title, defaultTitle, onTitleChange }: CanvasNodeTitleProps) {
    const theme = useCanvasTheme();
    const zoom = useStore((state) => state.transform[2]);
    const selected = useStore((state) => state.nodeLookup.get(nodeId)?.selected ?? false);
    const nodeWidth = useStore((state) => {
        const node = state.nodeLookup.get(nodeId);
        return node?.measured.width ?? node?.width ?? (typeof node?.style?.width === "number" ? node.style.width : NODE_MIN_WIDTH);
    });
    const inputRef = useRef<HTMLInputElement>(null);
    const cancelRef = useRef(false);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(title || defaultTitle);
    const layout = canvasNodeTitleLayout(nodeWidth, zoom, selected, editing);

    useEffect(() => {
        if (!editing) setDraft(title || defaultTitle);
    }, [defaultTitle, editing, title]);

    useEffect(() => {
        if (!editing) cancelRef.current = false;
    }, [editing]);

    useEffect(() => {
        if (!editing) return;
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [editing]);

    const cancel = useCallback(() => {
        cancelRef.current = true;
        setDraft(title || defaultTitle);
        setEditing(false);
    }, [defaultTitle, title]);

    const save = useCallback(() => {
        const nextTitle = draft.trim() || title.trim() || defaultTitle;
        onTitleChange?.(nodeId, nextTitle);
        setDraft(nextTitle);
        setEditing(false);
    }, [defaultTitle, draft, nodeId, onTitleChange, title]);

    const stopCanvasEvent = (event: MouseEvent | PointerEvent | WheelEvent) => {
        event.stopPropagation();
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        event.stopPropagation();
        if (event.key === "Escape") {
            event.preventDefault();
            cancel();
        } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            save();
        }
    };

    if (!layout.visible) return null;

    return (
        <NodeToolbar
            position={Position.Top}
            align="start"
            offset={layout.offset}
            isVisible
            className="canvas-node-title nodrag nopan nowheel pointer-events-auto"
            style={{ width: layout.width, maxWidth: "calc(100vw - 2rem)", zIndex: 65 }}
            data-canvas-no-zoom
            onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setEditing(true);
            }}
            onMouseDown={stopCanvasEvent}
            onPointerDown={stopCanvasEvent}
            onWheel={stopCanvasEvent}
        >
            {editing ? (
                <input
                    ref={inputRef}
                    value={draft}
                    aria-label="节点名称"
                    className="nodrag nopan nowheel h-8 w-full rounded-lg border px-2.5 text-[13px] font-medium outline-none shadow-sm transition-colors focus-visible:ring-2 motion-reduce:transition-none"
                    style={{ background: theme.node.panel, borderColor: theme.node.activeStroke, color: theme.node.text, outlineColor: theme.node.activeStroke }}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => {
                        if (cancelRef.current) {
                            cancelRef.current = false;
                            return;
                        }
                        save();
                    }}
                    onKeyDown={handleKeyDown}
                    onMouseDown={stopCanvasEvent}
                    onPointerDown={stopCanvasEvent}
                    onWheel={stopCanvasEvent}
                />
            ) : (
                <span
                    role="button"
                    tabIndex={0}
                    aria-label={`编辑节点名称：${title || defaultTitle}`}
                    className="block w-full cursor-text truncate rounded-lg border py-1 font-medium leading-4 shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    title={`${title || defaultTitle}，双击编辑节点名称`}
                    style={{ background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text, fontSize: layout.fontSize, paddingInline: layout.paddingInline, outlineColor: theme.node.activeStroke }}
                    onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter" || event.key === "F2") {
                            event.preventDefault();
                            setEditing(true);
                        }
                    }}
                >
                    {title || defaultTitle}
                </span>
            )}
        </NodeToolbar>
    );
}

const connectionHandlePositions = [Position.Left, Position.Right] as const;
const connectionHandleIds: Record<(typeof connectionHandlePositions)[number], string> = {
    [Position.Left]: "left",
    [Position.Right]: "right",
};

/**
 * 画布节点左右两侧通用连接点。
 * <p>
 * 配合 React Flow 的 Loose 连接模式，每侧都可以发起或接收连线。
 *
 * @return React.ReactElement 节点连接点元素
 */
export function CanvasConnectionHandles() {
    const theme = useCanvasTheme();
    const connectionHandleStyle = {
        width: CANVAS_CONNECTION_HANDLE_SIZE,
        height: CANVAS_CONNECTION_HANDLE_SIZE,
        background: theme.node.panel,
        border: `2px solid ${theme.node.activeStroke}`,
    };

    return (
        <>
            {connectionHandlePositions.map((position) => (
                <Handle key={position} id={connectionHandleIds[position]} type="source" position={position} className="!opacity-0 transition-opacity duration-150 group-hover:!opacity-100 motion-reduce:transition-none" style={connectionHandleStyle} />
            ))}
        </>
    );
}

/**
 * React Flow 节点的 hover 热区，用于恢复页面级节点快捷工具栏。
 */
type NodeHoverSurfaceProps = {
    nodeId: string;
    className?: string;
    style?: CSSProperties;
    onMouseEnter?: MouseEventHandler<HTMLDivElement>;
    onMouseLeave?: MouseEventHandler<HTMLDivElement>;
    children: ReactNode;
};

export const NodeHoverSurface = forwardRef<HTMLDivElement, NodeHoverSurfaceProps>(function NodeHoverSurface({ nodeId, className, style, onMouseEnter, onMouseLeave, children }, ref) {
    const actions = useNodeActions();
    const theme = useCanvasTheme();
    const uploading = useCanvasUiStore((state) => state.uploadingNodeIds.has(nodeId));

    return (
        <div
            ref={ref}
            className={`canvas-node-surface group ${className ?? ""}`}
            style={style}
            aria-busy={uploading}
            onMouseEnter={(event) => {
                actions.onKeepToolbar?.(nodeId);
                onMouseEnter?.(event);
            }}
            onMouseLeave={(event) => {
                actions.onHideToolbar?.();
                onMouseLeave?.(event);
            }}
        >
            {children}
            {uploading ? (
                <div
                    role="status"
                    className="nodrag nopan absolute inset-0 z-[60] flex items-center justify-center gap-2 rounded-[inherit]"
                    style={{ background: theme.node.fill, color: theme.node.muted }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                >
                    <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    <span className="text-sm">上传中…</span>
                </div>
            ) : null}
        </div>
    );
});
