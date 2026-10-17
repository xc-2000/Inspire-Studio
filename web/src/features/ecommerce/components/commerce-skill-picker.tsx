"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button, Input, Modal, Spin } from "antd";
import { ArrowUpRight, Check, ChevronRight, FileText, ImageIcon, Clapperboard, RefreshCw, Search, Settings2, WandSparkles } from "lucide-react";
import { ListPagination } from "@/shared/components/list-pagination";
import type { CommerceSkill } from "../api/skills";
import { commercePlatforms, type CommercePlatform } from "../lib/catalog";
import "./commerce-skills.css";

export function CommerceSkillPicker({
    skills,
    selected,
    selectedId,
    platform,
    outputLabel,
    outputId,
    loading,
    issue,
    disabled,
    isAdmin,
    onSelect,
    onRefresh,
}: {
    skills: CommerceSkill[];
    selected?: CommerceSkill;
    selectedId?: string;
    platform: CommercePlatform;
    outputId: string;
    outputLabel: string;
    loading: boolean;
    issue?: string;
    disabled?: boolean;
    isAdmin: boolean;
    onSelect: (id?: string) => void;
    onRefresh: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [details, setDetails] = useState<CommerceSkill>();
    const [keyword, setKeyword] = useState("");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(6);
    const filtered = useMemo(() => {
        const query = keyword.trim().toLocaleLowerCase();
        return skills.filter((skill) => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query));
    }, [skills, keyword]);
    const safePage = Math.max(1, Math.min(page, Math.ceil(filtered.length / pageSize)));
    useEffect(() => {
        setKeyword("");
        setPage(1);
        setDetails(undefined);
    }, [platform, outputId]);
    const platformName = commercePlatforms.find((item) => item.id === platform)?.name;
    const choose = (id?: string) => {
        onSelect(id);
        setOpen(false);
    };
    return (
        <div className="commerce-skill-picker">
            <div className="commerce-skill-label">
                <span>
                    <WandSparkles size={14} />
                    电商技能 <small>SKILL</small>
                </span>
                <button type="button" disabled={!selected} onClick={() => setDetails(selected)}>
                    查看说明
                </button>
            </div>
            <button
                type="button"
                className={`commerce-selected-skill ${issue ? "has-issue" : ""}`}
                disabled={disabled}
                aria-label="选择电商技能"
                onClick={() => {
                    setOpen(true);
                    onRefresh();
                }}
            >
                <span className="commerce-skill-glyph">{loading ? <Spin size="small" /> : <WandSparkles size={19} />}</span>
                <span className="commerce-selected-skill-text">
                    <strong>{loading ? "正在加载技能" : selected?.name || "请选择可用技能"}</strong>
                    <small>{loading ? "读取当前平台的技能库" : issue || selected?.description}</small>
                </span>
                <ChevronRight size={15} />
            </button>
            <div className="commerce-skill-caption">
                <span>{selected && !issue ? `${selectedId ? "已选择" : "自动推荐"} · v${selected.revision}` : "选择技能后，创作会使用对应的方法和要求"}</span>
                <button
                    type="button"
                    onClick={() => {
                        setOpen(true);
                        onRefresh();
                    }}
                    disabled={disabled}
                >
                    更换技能
                </button>
            </div>

            <Modal title="选择电商技能" open={open} onCancel={() => setOpen(false)} width={720} footer={null} className="commerce-skills-modal">
                <p className="commerce-skill-scope">
                    {platformName} · {outputLabel}
                    <span>仅显示适用于当前创作的启用技能</span>
                </p>
                <div className="commerce-skill-search">
                    <Input
                        aria-label="搜索电商技能"
                        prefix={<Search size={14} />}
                        placeholder="搜索技能名称或用途"
                        allowClear
                        value={keyword}
                        onChange={(event) => {
                            setKeyword(event.target.value);
                            setPage(1);
                        }}
                    />
                    <Button aria-label="刷新技能" icon={<RefreshCw size={14} />} loading={loading} onClick={onRefresh} />
                </div>
                {issue && (
                    <p className="commerce-skill-issue" role="status">
                        {issue}
                    </p>
                )}
                {loading ? (
                    <div className="commerce-skills-empty">
                        <Spin size="small" />
                        <p>正在读取技能…</p>
                    </div>
                ) : filtered.length ? (
                    <div className="commerce-skill-options">
                        {filtered.slice((safePage - 1) * pageSize, safePage * pageSize).map((skill) => {
                            const Icon = skill.type === "video" ? Clapperboard : skill.type === "image" ? ImageIcon : FileText;
                            return (
                                <article key={skill.id} className={`commerce-skill-option ${selected?.id === skill.id ? "is-selected" : ""}`}>
                                    <button type="button" disabled={disabled} aria-label={`使用${skill.name}`} aria-pressed={selected?.id === skill.id} onClick={() => choose(skill.id)}>
                                        <span className="commerce-skill-option-title">
                                            <Icon size={18} />
                                            <strong>{skill.name}</strong>
                                            {selected?.id === skill.id && <Check size={15} />}
                                        </span>
                                        <p>{skill.description}</p>
                                    </button>
                                    <div>
                                        <span>
                                            v{skill.revision}
                                            {selected?.id === skill.id ? " · 当前使用" : ""}
                                        </span>
                                        <button type="button" aria-label={`查看${skill.name}说明`} onClick={() => setDetails(skill)}>
                                            查看说明 <ArrowUpRight size={12} />
                                        </button>
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                ) : (
                    <div className="commerce-skills-empty">
                        <WandSparkles size={25} />
                        <p>{keyword ? "没有找到匹配的技能，换个关键词试试" : "暂无适用于当前创作的技能"}</p>
                    </div>
                )}
                <ListPagination
                    label="电商技能分页"
                    current={safePage}
                    pageSize={pageSize}
                    total={filtered.length}
                    pageSizeOptions={[6, 12, 24]}
                    onChange={(next, size) => {
                        setPage(next);
                        setPageSize(size);
                    }}
                />
                <div className="commerce-skills-footer">
                    <Button type="text" disabled={disabled || !skills.length || loading} onClick={() => choose(undefined)}>
                        使用自动推荐
                    </Button>
                    {isAdmin && (
                        <Link href="/admin/system?tab=skills&skillScope=ecommerce">
                            <Settings2 size={14} />
                            管理电商技能 <ArrowUpRight size={13} />
                        </Link>
                    )}
                </div>
            </Modal>
            <Modal title={details?.name || "技能说明"} open={Boolean(details)} onCancel={() => setDetails(undefined)} footer={<Button onClick={() => setDetails(undefined)}>关闭</Button>} width={640}>
                {details && (
                    <div className="commerce-skill-detail">
                        <p>{details.description}</p>
                        <div className="commerce-skill-detail-meta">
                            <span>版本 v{details.revision}</span>
                            <span>{details.platforms.map((id) => commercePlatforms.find((item) => item.id === id)?.name || id).join(" / ")}</span>
                        </div>
                        <h3>技能执行内容</h3>
                        <div className="commerce-skill-prompt">{details.systemPrompt}</div>
                    </div>
                )}
            </Modal>
        </div>
    );
}
