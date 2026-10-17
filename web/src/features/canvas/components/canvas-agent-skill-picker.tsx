"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Modal, Segmented } from "antd";
import { Check, ImageIcon, LoaderCircle, RefreshCw, Search, Sparkles, Video, WandSparkles, X } from "lucide-react";

import { useUserStore } from "@/features/auth/stores/use-user-store";
import { listSkills, type SkillOption, type SkillType } from "@/services/api/server";
import { ListPagination } from "@/shared/components/list-pagination";
import type { CanvasTheme } from "@/shared/lib/canvas-theme";
import type { CanvasAgentSkillSelection } from "../types";
import { CANVAS_AGENT_SKILL_TYPE_LABELS, findCanvasAgentSkills, isDedicatedCanvasAgentSkill, MAX_CANVAS_AGENT_SKILLS } from "../domain/canvas-agent-skill-library";

const TYPES: SkillType[] = ["image", "video", "canvasSettingGraph"];
const skillIcons = { image: ImageIcon, video: Video, canvasSettingGraph: WandSparkles };

export function CanvasAgentSkillChips({ skills, onRemove, theme, className = "" }: {
    skills: CanvasAgentSkillSelection[];
    onRemove?: (id: number) => void;
    theme: CanvasTheme;
    className?: string;
}) {
    if (!skills.length) return null;
    return <div className={`flex min-w-0 flex-wrap gap-1.5 ${className}`} aria-label="选中的创作技能">
        {skills.map((skill) => {
            const Icon = skillIcons[skill.targetType] || Sparkles;
            const label = CANVAS_AGENT_SKILL_TYPE_LABELS[skill.targetType];
            return <span key={skill.id} className="inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px]" style={{ background: theme.toolbar.activeBg, borderColor: theme.toolbar.border, color: theme.node.text }} title={`${label}技能 · ${skill.name}`}>
                <Icon className="size-3 shrink-0" style={{ color: theme.toolbar.activeText }} />
                <span className="shrink-0" style={{ color: theme.node.muted }}>{label}</span>
                <span className="max-w-36 truncate font-medium">{skill.name}</span>
                {onRemove ? <button type="button" aria-label={`移除技能 ${skill.name}`} className="grid size-4 shrink-0 place-items-center rounded focus-visible:outline-2 hover:opacity-60" onClick={() => onRemove(skill.id)}><X className="size-3" /></button> : null}
            </span>;
        })}
    </div>;
}

/** Administrator-maintained skill summaries. Full prompts are loaded by the request executor only. */
export function CanvasAgentSkillPicker({ open, selected, onToggle, onClose, theme }: {
    open: boolean;
    selected: CanvasAgentSkillSelection[];
    onToggle: (skill: CanvasAgentSkillSelection) => void;
    onClose: () => void;
    theme: CanvasTheme;
}) {
    const userId = useUserStore((store) => store.user?.id || "");
    const [query, setQuery] = useState("");
    const [targetType, setTargetType] = useState<SkillType | "all">("all");
    const [skills, setSkills] = useState<SkillOption[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [revision, setRevision] = useState(0);
    const loadedKey = useRef("");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(12);

    useEffect(() => {
        if (!open) return;
        const key = `${userId}:${revision}`;
        if (loadedKey.current === key) return;
        let active = true;
        setLoading(true);
        setError("");
        void Promise.allSettled(TYPES.map((type) => listSkills(type))).then((responses) => {
            if (!active) return;
            const available = new Map<number, SkillOption>();
            const failed: string[] = [];
            responses.forEach((response, index) => {
                if (response.status === "rejected") { failed.push(CANVAS_AGENT_SKILL_TYPE_LABELS[TYPES[index]]); return; }
                for (const skill of response.value.skills || []) {
                    if (available.has(skill.id)) continue;
                    // Do not retain workflow prompt snapshots returned by older list endpoints.
                    available.set(skill.id, { id: skill.id, name: skill.name, description: skill.description, targetType: skill.targetType, coverUrl: skill.coverUrl, workflowType: skill.workflowType });
                }
            });
            setSkills([...available.values()]);
            setError(failed.length ? `${failed.join("、")}技能暂时无法加载，请重试` : "");
            setLoading(false);
            loadedKey.current = key;
        });
        return () => { active = false; };
    }, [open, revision, userId]);

    useEffect(() => { if (open) { setQuery(""); setTargetType("all"); setPage(1); } }, [open]);
    const filtered = useMemo(() => findCanvasAgentSkills(skills, query, targetType === "all" ? undefined : targetType), [skills, query, targetType]);
    const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)));
    const selectedIds = new Set(selected.map((skill) => skill.id));

    return <Modal open={open} title={<div className="flex items-center gap-2"><span className="grid size-7 place-items-center rounded-lg" style={{ color: theme.toolbar.activeText, background: theme.toolbar.activeBg }}><Sparkles className="size-4" /></span><span>创作技能</span><span className="ml-auto pr-6 text-xs font-normal tabular-nums" aria-live="polite" style={{ color: theme.node.muted }}>已选 {selected.length} / {MAX_CANVAS_AGENT_SKILLS}</span></div>} width={640} onCancel={onClose} styles={{ container: { background: theme.node.panel, color: theme.node.text } }} footer={<div className="flex items-center justify-between gap-3"><p className="text-left text-[11px]" style={{ color: theme.node.muted }}>未手选时助手自动查找并使用技能</p><Button type="primary" onClick={onClose}>完成选择</Button></div>}>
        <div onWheelCapture={(event) => event.stopPropagation()}>
            <Input autoFocus allowClear prefix={<Search className="size-4" />} aria-label="搜索创作技能" placeholder="搜索技能名称、描述或关键词" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
            <div className="mt-3 flex min-w-0 items-center justify-between gap-2">
                <Segmented className="min-w-0" aria-label="技能分类" value={targetType} onChange={(value) => { setTargetType(value as SkillType | "all"); setPage(1); }} options={[{ value: "all", label: "全部" }, ...TYPES.map((type) => ({ value: type, label: CANVAS_AGENT_SKILL_TYPE_LABELS[type] }))]} />
                <button type="button" className="grid size-8 shrink-0 place-items-center rounded-lg focus-visible:outline-2 disabled:opacity-30 hover:opacity-60" style={{ color: theme.node.muted }} onClick={() => setRevision((value) => value + 1)} disabled={loading} aria-label="刷新技能库" title="刷新技能库"><RefreshCw className="size-3.5" /></button>
            </div>
            {selected.length ? <CanvasAgentSkillChips skills={selected} onRemove={(id) => { const skill = selected.find((item) => item.id === id); if (skill) onToggle(skill); }} theme={theme} className="mt-3" /> : null}
            {error ? <p className="mt-3 text-xs leading-5" role="alert" style={{ color: theme.node.muted }}>{error}</p> : null}
            <div className="thin-scrollbar mt-3 max-h-[min(48dvh,380px)] overflow-y-auto overscroll-contain" aria-label="可选创作技能" aria-busy={loading}>
                {loading ? <div className="flex items-center justify-center gap-2 py-16 text-xs" role="status" style={{ color: theme.node.muted }}><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />正在加载技能库</div> : <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((skill) => {
                        const chosen = selectedIds.has(skill.id);
                        const Icon = skillIcons[skill.targetType] || Sparkles;
                        const dedicatedWorkflow = isDedicatedCanvasAgentSkill(skill);
                        return <button key={skill.id} type="button" aria-pressed={chosen} disabled={dedicatedWorkflow && !chosen} title={dedicatedWorkflow ? "此专用流程请在视频创作中使用" : undefined} onClick={() => onToggle({ id: skill.id, name: skill.name, targetType: skill.targetType })} className="group flex min-w-0 items-start gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-2 hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-55" style={{ background: chosen ? theme.toolbar.activeBg : theme.toolbar.itemHover, borderColor: chosen ? theme.node.activeStroke : theme.toolbar.border, color: theme.node.text }}>
                            <span className="relative grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg" style={{ color: theme.node.muted, background: theme.toolbar.panel }}><Icon className="size-5" />{skill.coverUrl ? <img src={skill.coverUrl} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : null}</span>
                            <span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-[12px] font-semibold" title={skill.name}>{skill.name}</span><span className="grid size-4 shrink-0 place-items-center rounded border" style={{ borderColor: chosen ? theme.node.activeStroke : theme.toolbar.border, color: theme.toolbar.activeText }}>{chosen ? <Check className="size-3" /> : null}</span></span><span className="mt-1 block text-[10px]" style={{ color: theme.toolbar.activeText }}>{CANVAS_AGENT_SKILL_TYPE_LABELS[skill.targetType]}技能</span><span className="mt-1 line-clamp-2 text-[11px] leading-4" style={{ color: theme.node.muted }} title={skill.description}>{dedicatedWorkflow ? "此专用流程请在视频创作中使用" : skill.description || "按技能步骤协助完成创作"}</span></span>
                        </button>;
                    })}
                    {!filtered.length ? <p className="col-span-full py-14 text-center text-xs" style={{ color: theme.node.muted }}>{query ? "没有找到匹配的技能，试试其他关键词" : error ? "当前分类暂无可用技能，请重新加载" : "当前分类暂无已启用的技能"}</p> : null}
                </div>}
            </div>
            <ListPagination compact current={currentPage} pageSize={pageSize} total={filtered.length} pageSizeOptions={[12, 24, 48]} disabled={loading} onChange={(next, size) => { setPage(next); setPageSize(size); }} label="技能库分页" />
        </div>
    </Modal>;
}
