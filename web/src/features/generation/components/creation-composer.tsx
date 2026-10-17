"use client";

import { App, Button, Input, Popover, Tooltip } from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowUp, BookOpenText, CircleAlert, LoaderCircle, Search, Square, X } from "lucide-react";

import type { CreationComposerProps } from "@/features/generation/components/creation-workspace-types";
import { CreditCostDisplay } from "@/features/generation/constants/credits";
import { GenerationStyleCover, GenerationStyleMenu } from "@/features/generation/components/generation-style-picker";
import { filterGenerationStyles, GENERATION_STYLE_SELECTION_LIMIT_MESSAGE, MAX_GENERATION_STYLE_SELECTION_COUNT } from "@/features/generation/lib/generation-style-library";
import { getStyleCommandRange, parseGenerationStyleMessage, removeStyleCommand } from "@/features/generation/lib/style-command";
import type { SkillOption } from "@/services/api/server";
import { ListPagination } from "@/shared/components/list-pagination";
import { usePaginatedList } from "@/shared/hooks/use-paginated-list";

export function CreationComposer({
    value,
    placeholder,
    references,
    styleOptions,
    selectedStyles,
    styleLoading,
    styleError,
    skillTargetType,
    skillOptions,
    selectedSkill,
    skillLoading,
    skillError,
    actions,
    running,
    queued = false,
    canSubmit,
    submitDisabledReason,
    submitRecovery,
    creditCost,
    compact,
    focusWhenValueSet,
    stopping,
    onChange,
    onStyleSelect,
    onStyleRemove,
    onSkillSelect,
    onSkillRemove,
    onPasteImages,
    onSubmit,
    onStop,
    notice,
}: CreationComposerProps) {
    const { message } = App.useApp();
    const inputRef = useRef<TextAreaRef>(null);
    const focusedValueRef = useRef(false);
    const [styleMenuOpen, setStyleMenuOpenState] = useState(false);
    const [styleQuery, setStyleQuery] = useState("");
    const [styleCommand, setStyleCommand] = useState<{ start: number; end: number } | null>(null);
    const [highlightedStyleIndex, setHighlightedStyleIndex] = useState(0);
    const [skillMenuOpen, setSkillMenuOpen] = useState(false);
    const toolbarActions = actions.filter((action) => action.placement !== "submit");
    const submitActions = actions.filter((action) => action.placement === "submit");
    const requestActive = running || queued;
    const submitNoticeId = useId();
    const visibleSubmitIssue = !canSubmit && !requestActive ? submitDisabledReason : undefined;
    const availableStyles = styleOptions ?? [];
    const activeStyles = selectedStyles ?? [];
    const availableSkills = skillOptions ?? [];
    const filteredStyles = useMemo(() => {
        return filterGenerationStyles(availableStyles, styleQuery);
    }, [availableStyles, styleQuery]);

    useEffect(() => {
        if (!focusWhenValueSet || !value.trim() || focusedValueRef.current) return;
        focusedValueRef.current = true;
        requestAnimationFrame(() => inputRef.current?.focus({ cursor: "end" }));
    }, [focusWhenValueSet, value]);

    useEffect(() => {
        setHighlightedStyleIndex((current) => Math.min(current, Math.max(0, filteredStyles.length - 1)));
    }, [filteredStyles.length]);

    const updatePrompt = (nextValue: string, cursor: number) => {
        onChange(nextValue);
        const command = getStyleCommandRange(nextValue, cursor);
        if (!command) {
            setStyleCommand(null);
            closeStyleMenu();
            return;
        }
        setStyleCommand({ start: command.start, end: command.end });
        setStyleQuery(command.query);
        setStyleMenuOpenState(true);
    };

    const chooseStyle = (style: NonNullable<CreationComposerProps["styleOptions"]>[number]) => {
        if (activeStyles.some((selected) => selected.id === style.id)) {
            message.info("该风格已选择");
            return;
        }
        onStyleSelect?.(style);
        if (styleCommand) {
            const nextValue = removeStyleCommand(value, styleCommand.start, styleCommand.end);
            onChange(nextValue);
            requestAnimationFrame(() => {
                const textarea = inputRef.current?.resizableTextArea?.textArea;
                textarea?.focus();
                textarea?.setSelectionRange(styleCommand.start, styleCommand.start);
            });
        }
        setStyleCommand(null);
        setStyleQuery("");
        closeStyleMenu();
    };

    const closeStyleMenu = () => {
        setStyleMenuOpenState(false);
        setStyleCommand(null);
        setStyleQuery("");
        setHighlightedStyleIndex(0);
    };
    const openStyleMenu = () => {
        setStyleCommand(null);
        setStyleQuery("");
        setHighlightedStyleIndex(0);
        setStyleMenuOpenState(true);
        requestAnimationFrame(() => inputRef.current?.focus({ cursor: "end" }));
    };

    const pasteStyleMessage = (pastedText: string) => {
        if (!onStyleSelect) return false;
        const parsed = parseGenerationStyleMessage(pastedText, availableStyles);
        if (!parsed) return false;
        const textarea = inputRef.current?.resizableTextArea?.textArea;
        const start = textarea?.selectionStart ?? value.length;
        const end = textarea?.selectionEnd ?? start;
        const additions = parsed.styles.filter((style) => !activeStyles.some((selected) => selected.id === style.id));
        const remaining = Math.max(0, MAX_GENERATION_STYLE_SELECTION_COUNT - activeStyles.length);
        if (additions.length > remaining) {
            message.warning(GENERATION_STYLE_SELECTION_LIMIT_MESSAGE);
        }
        const nextValue = `${value.slice(0, start)}${parsed.prompt}${value.slice(end)}`;
        additions.slice(0, remaining).forEach((style) => onStyleSelect(style));
        onChange(nextValue);
        setStyleCommand(null);
        setStyleQuery("");
        closeStyleMenu();
        requestAnimationFrame(() => {
            const nextTextarea = inputRef.current?.resizableTextArea?.textArea;
            const cursor = start + parsed.prompt.length;
            nextTextarea?.focus();
            nextTextarea?.setSelectionRange(cursor, cursor);
        });
        return true;
    };

    const renderAction = (action: CreationComposerProps["actions"][number]) => {
        const button = (
            <Button
                size="small"
                className={["creation-composer-action", action.iconOnly ? "creation-composer-action-icon" : "", action.className].filter(Boolean).join(" ")}
                icon={action.icon}
                disabled={action.disabled}
                loading={action.loading}
                onClick={action.onClick}
                aria-label={action.iconOnly ? action.label : undefined}
            >
                {action.iconOnly ? null : <span className="creation-composer-action-label">{action.label}</span>}
            </Button>
        );
        if (action.popoverContent) {
            return (
                <Popover key={action.key} content={action.popoverContent} trigger="hover" placement="topLeft" mouseEnterDelay={0.1} mouseLeaveDelay={0.15}>
                    {button}
                </Popover>
            );
        }
        return (
            <Tooltip key={action.key} title={action.label}>
                {button}
            </Tooltip>
        );
    };

    return (
        <div className="creation-composer-band thin-scrollbar !pointer-events-auto max-h-[70%] shrink-0 overflow-y-auto overscroll-contain border-t border-[var(--studio-line)] !px-[var(--studio-content-gutter)] !pb-3 !pt-3 sm:!pb-4">
            <div className="relative w-full min-w-0">
                <div className={`creation-composer-tray px-4 py-3.5 sm:px-5${compact ? " creation-composer-tray-compact" : ""}`}>
                    <div className="creation-composer-head">
                        <strong>创作描述</strong>
                        <span className="ml-auto shrink-0 tabular-nums" role="status">
                            {queued ? "排队中" : running ? "生成中" : `${value.length} / 2000`}
                        </span>
                    </div>
                    {notice}

                    {references.length || activeStyles.length || selectedSkill ? (
                        <div className={`thin-scrollbar flex flex-wrap gap-2 overscroll-contain transition-all duration-200 ${compact ? "invisible mb-0 max-h-0 overflow-hidden opacity-0" : "mb-3 max-h-32 overflow-y-auto opacity-100"}`}>
                            {selectedSkill ? (
                                <div className="creation-composer-chip">
                                    <GenerationStyleCover style={selectedSkill} className="size-5 shrink-0 overflow-hidden rounded-sm" />
                                    <span className="min-w-0 max-w-32 truncate text-xs font-medium text-[var(--studio-muted)]">{selectedSkill.name}</span>
                                    <button type="button" className="creation-composer-chip-remove" onClick={onSkillRemove} aria-label={`移除技能${selectedSkill.name}`}>
                                        <X className="size-3.5" />
                                    </button>
                                </div>
                            ) : null}
                            {activeStyles.map((style) => (
                                <div key={`style-${style.id}`} className="creation-composer-chip">
                                    <GenerationStyleCover style={style} className="size-5 shrink-0 overflow-hidden rounded-sm" />
                                    <span className="min-w-0 max-w-32 truncate text-xs font-medium text-[var(--studio-muted)]">{style.name}</span>
                                    <button type="button" className="creation-composer-chip-remove" onClick={() => onStyleRemove?.(style.id)} aria-label={`移除风格${style.name}`}>
                                        <X className="size-3.5" />
                                    </button>
                                </div>
                            ))}
                            {references.map((item) => (
                                <div key={item.id} className="creation-composer-chip">
                                    <div className="shrink-0">{item.preview}</div>
                                    <span className="min-w-0 max-w-32 truncate text-xs font-medium text-[var(--studio-muted)]">{item.label}</span>
                                    <button type="button" className="creation-composer-chip-remove" onClick={item.onRemove} aria-label={`移除${item.label}`}>
                                        <X className="size-3.5" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    ) : null}

                    <div className={`creation-composer-input-shell relative${compact ? " creation-composer-input-shell-compact" : ""}`}>
                        <Input.TextArea
                            ref={inputRef}
                            value={value}
                            autoSize={compact ? { minRows: 1, maxRows: 6 } : { minRows: 2, maxRows: 6 }}
                            placeholder={placeholder}
                            aria-label="创作提示词"
                            className="creation-composer-textarea"
                            onChange={(event) => updatePrompt(event.target.value, event.target.selectionStart ?? event.target.value.length)}
                            onPaste={(event) => {
                                const pastedText = event.clipboardData.getData("text/plain");
                                if (pasteStyleMessage(pastedText)) {
                                    event.preventDefault();
                                    return;
                                }
                                const images = Array.from(event.clipboardData.items)
                                    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
                                    .map((item) => item.getAsFile())
                                    .filter((file): file is File => file !== null);
                                if (!images.length || !onPasteImages) return;
                                event.preventDefault();
                                onPasteImages(images);
                            }}
                            onKeyDown={(event) => {
                                if (styleMenuOpen) {
                                    if (event.key === "ArrowDown") {
                                        event.preventDefault();
                                        setHighlightedStyleIndex((current) => Math.min(current + 1, Math.max(0, filteredStyles.length - 1)));
                                        return;
                                    }
                                    if (event.key === "ArrowUp") {
                                        event.preventDefault();
                                        setHighlightedStyleIndex((current) => Math.max(0, current - 1));
                                        return;
                                    }
                                    if (event.key === "Enter" && !event.shiftKey) {
                                        event.preventDefault();
                                        const style = filteredStyles[highlightedStyleIndex];
                                        if (style) chooseStyle(style);
                                        return;
                                    }
                                    if (event.key === "Escape") {
                                        event.preventDefault();
                                        closeStyleMenu();
                                        return;
                                    }
                                }
                                if (event.key === "Enter" && !event.shiftKey) {
                                    event.preventDefault();
                                    if (canSubmit && !requestActive) {
                                        onSubmit();
                                    } else if (visibleSubmitIssue) {
                                        message.warning(visibleSubmitIssue);
                                    }
                                }
                            }}
                        />
                    </div>

                    {visibleSubmitIssue ? (
                        <div className="creation-composer-submit-notice" id={submitNoticeId} role="status">
                            <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                            <span className="min-w-0 flex-1">{visibleSubmitIssue}</span>
                            {submitRecovery ? <div className="flex flex-wrap items-center gap-3">{submitRecovery}</div> : null}
                        </div>
                    ) : null}

                    <div className="creation-composer-toolbar flex items-end gap-2">
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                            <GenerationStyleMenu
                                styles={availableStyles}
                                selected={activeStyles}
                                loading={styleLoading}
                                error={styleError}
                                open={styleMenuOpen}
                                query={styleQuery}
                                highlightedIndex={highlightedStyleIndex}
                                placement="topLeft"
                                onOpenChange={(open) => {
                                    if (open) openStyleMenu();
                                    else closeStyleMenu();
                                }}
                                onQueryChange={setStyleQuery}
                                onHighlightedIndexChange={setHighlightedStyleIndex}
                                onSelect={chooseStyle}
                            />
                            <SkillMenu title={skillTargetType === "image" ? "图片技能" : skillTargetType === "video" ? "视频技能" : "技能"} skills={availableSkills} selectedSkill={selectedSkill} loading={skillLoading} error={skillError} open={skillMenuOpen} onOpenChange={setSkillMenuOpen} onSelect={onSkillSelect} />
                            {toolbarActions.map(renderAction)}
                        </div>
                        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
                            {submitActions.map(renderAction)}
                            {requestActive && onStop ? (
                                <Tooltip title={queued ? "取消排队" : "停止生成"}>
                                    <Button
                                        type="primary"
                                        size="small"
                                        className="creation-composer-submit"
                                        disabled={stopping}
                                        loading={stopping}
                                        onClick={onStop}
                                        aria-label={stopping ? "正在停止生成" : queued ? "取消排队" : "停止生成"}
                                        icon={<Square className="size-3.5 fill-current" strokeWidth={2.2} />}
                                    />
                                </Tooltip>
                            ) : (
                                <button
                                    type="button"
                                    className="creation-composer-submit-trigger creation-composer-submit-trigger-cost"
                                    disabled={!canSubmit || requestActive}
                                    onClick={onSubmit}
                                    title={visibleSubmitIssue || (!value.trim() ? "请输入创作提示词" : undefined)}
                                    aria-describedby={visibleSubmitIssue ? submitNoticeId : undefined}
                                    aria-label={visibleSubmitIssue ? `暂不可生成：${visibleSubmitIssue}` : queued ? "排队中" : running ? "生成中" : creditCost === undefined ? "生成" : creditCost === null ? "当前配置无法报价" : `生成，当前会消耗 ${creditCost.toLocaleString()} 积分`}
                                >
                                    {queued || running ? (
                                        queued ? (
                                            "排队中"
                                        ) : (
                                            "生成中"
                                        )
                                    ) : (
                                        <>
                                            {creditCost === undefined ? null : creditCost === null ? <span className="text-xs font-medium">不可报价</span> : <CreditCostDisplay creditCost={creditCost} className="text-xs font-medium" />}
                                            <ArrowUp className="size-[18px] shrink-0" strokeWidth={2.1} />
                                        </>
                                    )}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

/** 技能选择浮层，参照风格库 Popover 交互样式。 */
function SkillMenu({
    title,
    skills,
    selectedSkill,
    loading,
    error,
    open,
    onOpenChange,
    onSelect,
}: {
    title: string;
    skills: SkillOption[];
    selectedSkill?: SkillOption | null;
    loading?: boolean;
    error?: string | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect?: (skill: SkillOption) => void;
}) {
    const [search, setSearch] = useState("");
    useEffect(() => {
        if (!open) setSearch("");
    }, [open]);
    const query = search.trim().toLocaleLowerCase();
    const filteredSkills = useMemo(() => skills.filter((skill) =>
        `${skill.name} ${skill.description ?? ""}`.toLocaleLowerCase().includes(query)
    ), [skills, query]);
    const pagination = usePaginatedList(filteredSkills, 10, `${title}:${open}:${query}`);
    const content = (
        <div className="w-[min(24rem,calc(100vw-24px))] p-1" role="dialog" aria-label={`${title}列表`}>
            <div className="flex items-center justify-between gap-3 px-2 pb-2 pt-1">
                <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-[var(--studio-ink)]">
                    <BookOpenText className="size-4 shrink-0 text-[var(--studio-action)]" />
                    <span>{title}</span>
                </div>
            </div>
            <div className="px-2 pb-3">
                <Input
                    aria-label={`搜索${title}`}
                    placeholder={`搜索${title}名称或描述`}
                    prefix={<Search className="size-4 text-[var(--studio-muted)]" />}
                    allowClear
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                />
            </div>
            {loading ? (
                <div className="flex min-h-28 flex-col items-center justify-center gap-2 text-xs text-[var(--studio-muted)]">
                    <LoaderCircle className="size-5 animate-spin" />
                    <span>技能加载中</span>
                </div>
            ) : error ? (
                <div className="flex min-h-28 flex-col items-center justify-center gap-2 text-xs text-[var(--studio-muted)]">
                    <X className="size-5" />
                    <span>{error}</span>
                </div>
            ) : filteredSkills.length ? (
                <div className="thin-scrollbar max-h-[min(24rem,calc(100vh-190px))] overflow-y-auto pr-1">
                    {pagination.items.map((skill) => {
                        const isSelected = selectedSkill?.id === skill.id;
                        return (
                            <button
                                key={skill.id}
                                type="button"
                                className={`mb-1 flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left transition ${isSelected ? "border-[var(--studio-action)] bg-[var(--studio-primary-soft)]" : "border-[var(--studio-line)] bg-[var(--studio-surface)] hover:border-[var(--studio-line-strong)] hover:bg-[var(--studio-surface-hover)]"}`}
                                onClick={() => {
                                    onSelect?.(skill);
                                    onOpenChange(false);
                                }}
                            >
                                <GenerationStyleCover style={skill} className="h-16 w-12 shrink-0 overflow-hidden rounded-md" fallbackIcon={<BookOpenText className="size-6" />} />
                                <span className="min-w-0 flex-1">
                                    <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-[var(--studio-ink)]">
                                        <span className="truncate">{skill.name}</span>
                                    </span>
                                    {skill.description ? <span className="line-clamp-2 text-xs leading-5 text-[var(--studio-muted)]">{skill.description}</span> : null}
                                </span>
                            </button>
                        );
                    })}
                </div>
            ) : (
                <div className="flex min-h-28 flex-col items-center justify-center gap-2 text-xs text-[var(--studio-muted)]">
                    <BookOpenText className="size-5" />
                    <span>{query ? "没有找到匹配的技能，试试其他关键词" : `暂无可用${title}`}</span>
                </div>
            )}
            {!loading && !error ? <ListPagination compact label="技能列表分页" current={pagination.page} pageSize={pagination.pageSize} total={pagination.total} onChange={pagination.onChange} pageSizeOptions={[10, 20, 50]} /> : null}
        </div>
    );
    return (
        <Popover
            open={open}
            trigger="click"
            placement="topLeft"
            arrow={false}
            autoAdjustOverflow
            getPopupContainer={() => document.body}
            destroyOnHidden
            content={content}
            onOpenChange={onOpenChange}
            styles={{
                root: { filter: "none" },
                container: { padding: 8, background: "var(--studio-surface)", border: "1px solid var(--studio-line)", borderRadius: 8, boxShadow: "var(--studio-shadow)" },
            }}
        >
            <span className="inline-flex">
                <Tooltip title={selectedSkill ? `已选择技能：${selectedSkill.name}` : "选择技能"}>
                    <Button size="small" className="creation-composer-action" icon={<BookOpenText className="size-3.5" />} aria-expanded={open} aria-haspopup="dialog">
                        {title}
                    </Button>
                </Tooltip>
            </span>
        </Popover>
    );
}
