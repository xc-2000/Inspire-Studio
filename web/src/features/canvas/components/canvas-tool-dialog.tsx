"use client";

import type { CSSProperties, ReactNode } from "react";
import { Modal } from "antd";
import type { CanvasTheme } from "@/shared/lib/canvas-theme";
import { useCanvasTheme } from "./canvas-theme-provider";
import styles from "./canvas-editor.module.css";

export function canvasEditorStyle(theme: CanvasTheme): CSSProperties {
    return {
        "--ce-surface": theme.node.panel,
        "--ce-soft": theme.toolbar.itemHover,
        "--ce-border": theme.toolbar.border,
        "--ce-text": theme.node.text,
        "--ce-muted": theme.node.muted,
        "--ce-accent": theme.node.activeStroke,
        "--ce-tint": theme.toolbar.activeBg,
    } as CSSProperties;
}

export function CanvasToolDialog({ title, subtitle, icon, width = 900, onClose, children }: {
    title: string; subtitle: string; icon: ReactNode; width?: number; onClose: () => void; children: ReactNode;
}) {
    const theme = useCanvasTheme();
    return <Modal open centered title={<div className={styles.dialogHeading}><span className={styles.headingIcon}>{icon}</span><div><h2>{title}</h2><p>{subtitle}</p></div></div>} width={width} footer={null} onCancel={onClose} className={styles.dialog} style={canvasEditorStyle(theme)} styles={{ container: { padding: 0, background: theme.node.panel, color: theme.node.text, border: `1px solid ${theme.toolbar.border}`, borderRadius: 20 }, header: { margin: 0, padding: "24px 28px 20px", background: "transparent", borderBottom: `1px solid ${theme.toolbar.border}` }, body: { padding: 0 }, mask: { backdropFilter: "blur(5px)" } }}>
        {children}
    </Modal>;
}
