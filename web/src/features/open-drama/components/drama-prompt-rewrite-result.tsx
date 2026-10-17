"use client";

import { Button, Modal, Tag } from "antd";
import { Check, Clapperboard, Undo2 } from "lucide-react";

type Result = { shotNumber: number; before: string; after: string };

export function DramaPromptRewriteResult({ result, onClose, onUndo, onGenerate }: {
    result: Result | null;
    onClose: () => void;
    onUndo: () => void;
    onGenerate: () => void;
}) {
    return <Modal title={result ? `镜头 ${result.shotNumber} · 提示词已改写` : "提示词改写"}
        open={Boolean(result)} onCancel={onClose} width={960} destroyOnHidden
        footer={<div className="flex flex-wrap items-center justify-between gap-2">
            <Button icon={<Undo2 size={14} />} onClick={onUndo}>撤销本次改写</Button>
            <div className="flex gap-2"><Button onClick={onClose}>完成</Button><Button type="primary" icon={<Clapperboard size={14} />} onClick={onGenerate}>重新生成视频</Button></div>
        </div>}>
        {result && <div className="space-y-4 py-2">
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--studio-muted)]">
                <Tag color="success" icon={<Check size={12} className="inline" />}>已应用到当前镜头</Tag>
                <span>可对照查看，或继续检查视频生成设置。</span>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
                <section className="min-w-0 rounded-xl border border-[var(--studio-line)] bg-[var(--studio-panel)] p-4">
                    <h3 className="mb-3 text-xs font-semibold text-[var(--studio-muted)]">改写前</h3>
                    <p className="max-h-[48vh] overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-7 text-[var(--studio-muted)]">{result.before}</p>
                </section>
                <section className="min-w-0 rounded-xl border border-[var(--studio-action)] bg-[var(--studio-panel)] p-4">
                    <h3 className="mb-3 text-xs font-semibold text-[var(--studio-action)]">改写后</h3>
                    <p className="max-h-[48vh] overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-7">{result.after}</p>
                </section>
            </div>
        </div>}
    </Modal>;
}
