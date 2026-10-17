"use client";

import { Button, Dropdown, Tooltip } from "antd";
import { CopyPlus, GitBranch, LayoutGrid, Scissors, Sparkles, SplitSquareHorizontal } from "lucide-react";
import { CANVAS_ARRANGEMENTS, type CanvasArrangement } from "../domain/canvas-arrangement";
import { canvasEditingCapabilities } from "../domain/canvas-editing-capabilities";
import type { CanvasNode } from "../types";
import { useCanvasTheme } from "./canvas-theme-provider";
import { canvasEditorStyle } from "./canvas-tool-dialog";
import styles from "./canvas-editor.module.css";

export function CanvasEditingActions({ nodes, selectedIds, onArrange, onDuplicate, onTemplates, onCompare, onRefine, onEditVideo }: {
    nodes: CanvasNode[]; selectedIds: ReadonlySet<string>; onArrange: (mode: CanvasArrangement) => void; onDuplicate: () => void; onTemplates: () => void; onCompare: () => void;
    onRefine: (nodeId: string) => void; onEditVideo: () => void;
}) {
    const theme = useCanvasTheme();
    const { selected, selectionCount, canArrange, canDuplicate, canRefine, canEditVideo, canCompare } = canvasEditingCapabilities(nodes, selectedIds);
    const className = "!p-0";
    const arrangementItems = CANVAS_ARRANGEMENTS.map((action) => ({ key: action.value, label: action.label, disabled: (action.value === "dag" || action.value === "grid" ? selectionCount || nodes.length : selectionCount) < action.minimum }));
    return <div className={styles.dockGroup}>
        {canRefine ? <Tooltip title="精修所选图片"><Button type="text" className={styles.labelAction} aria-label="图片精修" icon={<Sparkles className="size-4" />} onClick={() => onRefine(selected[0].id)}>精修</Button></Tooltip> : null}
        {canEditVideo ? <Tooltip title="视频时间轴剪辑"><Button type="text" className={styles.labelAction} aria-label="视频时间轴剪辑" icon={<Scissors className="size-4" />} onClick={onEditVideo}>剪辑</Button></Tooltip> : null}
        {canArrange ? <Dropdown trigger={["click"]} placement="top" classNames={{ root: styles.arrangeMenu }} styles={{ root: canvasEditorStyle(theme) }} menu={{ items: [...arrangementItems.slice(0, 2), { type: "divider" }, ...arrangementItems.slice(2, 8), { type: "divider" }, ...arrangementItems.slice(8)], onClick: ({ key }) => onArrange(key as CanvasArrangement) }}>
            <Button type="text" className={className} aria-label="排列与对齐" style={{ color: theme.toolbar.item }} icon={<LayoutGrid className="size-4" />} />
        </Dropdown> : null}
        {canDuplicate ? <Tooltip title="复制选区及内部连线（Ctrl / ⌘ + D）"><Button type="text" className={className} aria-label="复制选区及连线" onClick={onDuplicate} style={{ color: theme.toolbar.item }} icon={<CopyPlus className="size-4" />} /></Tooltip> : null}
        <Tooltip title="工作流模板"><Button type="text" className={styles.labelAction} aria-label="工作流模板" onClick={onTemplates} icon={<GitBranch className="size-4" />}>模板</Button></Tooltip>
        {canCompare ? <Tooltip title="并排同步对比两个视频"><Button type="text" className={className} aria-label="视频对比" onClick={onCompare} style={{ color: theme.toolbar.item }} icon={<SplitSquareHorizontal className="size-4" />} /></Tooltip> : null}
    </div>;
}
