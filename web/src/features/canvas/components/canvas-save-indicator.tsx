"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Check, CloudUpload, LoaderCircle, RotateCw } from "lucide-react";
import { Tooltip } from "antd";

import { useCanvasStore } from "../stores/use-canvas-store";
import { useCanvasTheme } from "./canvas-theme-provider";

export function CanvasSaveIndicator({ documentId }: { documentId: string }) {
    const theme = useCanvasTheme();
    const status = useCanvasStore(state => state.saveStatuses[documentId]);
    const [retrying, setRetrying] = useState(false);

    useEffect(() => {
        const retry = () => { void useCanvasStore.getState().retryPendingSaves(); };
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if (!useCanvasStore.getState().hasUnsavedChanges(documentId)) return;
            event.preventDefault();
            event.returnValue = "";
        };
        const saveWhenHidden = () => {
            const store = useCanvasStore.getState();
            if (document.visibilityState === "hidden" && store.hasUnsavedChanges(documentId)) {
                void store.flushDocument(documentId).catch(() => undefined);
            }
        };
        window.addEventListener("online", retry);
        window.addEventListener("beforeunload", beforeUnload);
        document.addEventListener("visibilitychange", saveWhenHidden);
        return () => {
            window.removeEventListener("online", retry);
            window.removeEventListener("beforeunload", beforeUnload);
            document.removeEventListener("visibilitychange", saveWhenHidden);
        };
    }, [documentId]);

    const phase = retrying ? "saving" : status?.phase || "saved";
    const label = phase === "failed" ? "保存失败" : phase === "saving" ? "保存中" : phase === "pending" ? "待保存" : "已保存";
    const Icon = phase === "failed" ? AlertCircle : phase === "saving" ? LoaderCircle : phase === "pending" ? CloudUpload : Check;
    const savedTime = status?.savedAt ? new Date(status.savedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
    const detail = phase === "failed" ? `${status?.error || "网络或服务器暂时不可用"}。正在自动重试，点击可立即重试。` : phase === "saved" ? `修改已保存${savedTime ? ` · ${savedTime}` : ""}` : "正在同步最新修改，请稍候";

    return <Tooltip title={detail}>
        <button
            type="button"
            data-canvas-save-status={phase}
            aria-label={phase === "failed" ? "画布保存失败，点击重试" : label}
            aria-live="polite"
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--studio-action)]"
            style={{ color: phase === "failed" ? "var(--studio-danger, #dc2626)" : theme.node.muted }}
            disabled={phase !== "failed"}
            onClick={async () => {
                setRetrying(true);
                try { await useCanvasStore.getState().flushDocument(documentId); }
                catch { /* The retained failed status exposes the retry action again. */ }
                finally { setRetrying(false); }
            }}
        >
            <Icon className={`size-3 ${phase === "saving" ? "animate-spin motion-reduce:animate-none" : ""}`} />
            <span className={phase === "failed" ? "" : "hidden sm:inline"}>{label}</span>
            {phase === "failed" ? <RotateCw className="size-3" /> : null}
        </button>
    </Tooltip>;
}
