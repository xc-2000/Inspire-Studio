"use client";

import { useState } from "react";
import { Modal } from "antd";
import { ModelPicker } from "@/features/settings/components/model-picker";
import type { AiConfig } from "@/features/settings/stores/use-config-store";
import { availableVideoModelsForMode } from "@/features/generation/lib/video-billing";
import { resolveVideoResolution } from "@/features/settings/lib/video-resolution-configuration";
import { defaultFilmModels, filmModelSelectionError, type FilmModelSelection } from "../infinite-agent/film-model-selection";
import { useCanvasTheme } from "./canvas-theme-provider";

export function FilmModelDialog({ config, brief, busy, onConfirm, onClose }: {
    config: AiConfig; brief: string; busy: boolean;
    onConfirm: (models: FilmModelSelection) => void; onClose: () => void;
}) {
    const theme = useCanvasTheme();
    const [models, setModels] = useState(() => defaultFilmModels(config));
    const error = filmModelSelectionError(config, models);
    const fields = [
        { key: "textModel", capability: "text", label: "文本模型", hint: "编写剧本 · 编排分镜" },
        { key: "imageModel", capability: "image", label: "图像模型", hint: "角色设定 · 分镜画面" },
        { key: "videoModel", capability: "video", label: "视频模型", hint: `画面转视频 · ${resolveVideoResolution(config, models.videoModel, "image-to-video").toUpperCase()}` },
    ] as const;
    return <Modal open centered title="一键成片 · 选择模型" width={580} onCancel={onClose}
        maskClosable={!busy} closable={!busy} keyboard={!busy}
        okText="开始成片" cancelText="返回编辑" confirmLoading={busy}
        okButtonProps={{ disabled: Boolean(error) }} cancelButtonProps={{ disabled: busy }}
        onOk={() => { if (!error && !busy) onConfirm(models); }}
        styles={{ container: { background: theme.node.panel, color: theme.node.text }, header: { background: "transparent" }, title: { color: theme.node.text } }}>
        <p className="mb-4 text-xs leading-6" style={{ color: theme.node.muted }}>为这次创作选择模型，AI 将自动编排故事、镜头和时长。</p>
        <div className="mb-4 line-clamp-3 rounded-xl border px-3 py-2.5 text-xs leading-6" style={{ borderColor: theme.toolbar.border }}>{brief.replace(/^【(?:一句话|一键)成片】\s*/, "")}</div>
        <div className="grid grid-cols-1 gap-3">
            {fields.map(field => <div key={field.key} className="min-w-0 rounded-xl border p-3" style={{ borderColor: theme.toolbar.border }}>
                <div className="mb-1 flex items-center justify-between text-xs font-medium">
                    <span>{field.label}</span>
                </div>
                <p className="mb-3 text-[11px]" style={{ color: theme.node.muted }}>{field.hint}</p>
                <ModelPicker config={config} value={models[field.key]} capability={field.capability} fullWidth
                    ariaLabel={field.label} disabled={busy}
                    className="h-9 rounded-lg text-xs" placeholder={`选择${field.label}`}
                    modelOptions={field.key === "videoModel" ? availableVideoModelsForMode(config, "image-to-video") : undefined}
                    onChange={value => setModels(current => ({ ...current, [field.key]: value }))} />
            </div>)}
        </div>
        {error ? <p role="alert" className="mt-3 text-xs text-red-500">{error}</p> : null}
        <p className="mb-0 mt-4 text-[11px]" style={{ color: theme.node.muted }}>本次选择会随成片保存，继续生成时沿用。</p>
    </Modal>;
}
