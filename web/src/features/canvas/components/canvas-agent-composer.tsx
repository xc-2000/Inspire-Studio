"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button, Tooltip } from "antd";
import { ArrowUp, ImagePlus, LoaderCircle, X } from "lucide-react";

import { canvasThemes } from "@/shared/lib/canvas-theme";
import type { CanvasAgentChatAttachment } from "../domain/canvas-agent-message";
import { isImageNode } from "../domain/canvas-node";
import type { CanvasAgentSkillSelection, CanvasNode } from "../types";
import { CanvasAgentSkillChips } from "./canvas-agent-skill-picker";
import type { GenerationStyleOption } from "@/services/api/server";
import { GenerationStyleChips, GenerationStyleMenu } from "@/features/generation/components/generation-style-picker";
import { filterGenerationStyles, MAX_GENERATION_STYLE_SELECTION_COUNT } from "@/features/generation/lib/generation-style-library";
import { getStyleCommandRange, parseGenerationStyleMessage, parseGroupedGenerationStyleMessage, removeStyleCommand } from "@/features/generation/lib/style-command";

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

type AgentChatComposerProps = {
    prompt: string;
    attachments?: CanvasAgentChatAttachment[];
    disabled?: boolean;
    sending?: boolean;
    placeholder: string;
    theme: CanvasTheme;
    onPromptChange: (value: string) => void;
    onSubmit: () => void;
    onAddFiles?: (files: FileList | File[] | null) => void | Promise<void>;
    onRemoveAttachment?: (id: string) => void;
    left?: ReactNode;
    modelPicker?: ReactNode;
    droppedNodes?: CanvasNode[];
    onDroppedNodeRemove?: (nodeId: string) => void;
    styleOptions?: GenerationStyleOption[];
    selectedStyles?: GenerationStyleOption[];
    styleLoading?: boolean;
    styleError?: string | null;
    onStyleSelect?: (style: GenerationStyleOption) => void;
    onStyleRemove?: (id: number) => void;
    onStyleLimit?: () => void;
    selectedSkills?: CanvasAgentSkillSelection[];
    onSkillRemove?: (id: number) => void;
};

export function AgentChatComposer({
    prompt,
    attachments = [],
    disabled,
    sending,
    placeholder,
    theme,
    onPromptChange,
    onSubmit,
    onAddFiles,
    onRemoveAttachment,
    left,
    modelPicker,
    droppedNodes = [],
    onDroppedNodeRemove,
    styleOptions = [],
    selectedStyles = [],
    styleLoading = false,
    styleError,
    onStyleSelect,
    onStyleRemove,
    onStyleLimit,
    selectedSkills = [],
    onSkillRemove,
}: AgentChatComposerProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [styleMenuOpen, setStyleMenuOpen] = useState(false);
    const [styleCommand, setStyleCommand] = useState<{ start: number; end: number } | null>(null);
    const [styleQuery, setStyleQuery] = useState("");
    const [highlightedStyleIndex, setHighlightedStyleIndex] = useState(0);
    const filteredStyles = useMemo(() => filterGenerationStyles(styleOptions, styleQuery), [styleOptions, styleQuery]);

    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        const resize = () => {
            textarea.style.height = "0px";
            textarea.style.height = `${Math.min(144, Math.max(58, textarea.scrollHeight))}px`;
        };
        resize();
        const observer = new ResizeObserver(resize);
        // Observe the container so panel resizing also reflows multiline drafts.
        if (textarea.parentElement) observer.observe(textarea.parentElement);
        return () => observer.disconnect();
    }, [prompt]);

    useEffect(() => {
        const missingNodeIds = droppedNodes.map((node) => node.id).filter((nodeId) => !containsToken(prompt, nodeId));
        if (missingNodeIds.length === 0) return;
        onPromptChange([prompt.trim(), ...missingNodeIds].filter(Boolean).join(" "));
    }, [droppedNodes, onPromptChange, prompt]);

    const removeNode = (nodeId: string) => {
        onPromptChange(removeToken(prompt, nodeId));
        onDroppedNodeRemove?.(nodeId);
    };
    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        if (!disabled && !sending && (prompt.trim() || attachments.length)) onSubmit();
    };
    const canSubmit = !disabled && !sending && Boolean(prompt.trim() || attachments.length);
    const updatePrompt = (value: string, cursor: number) => {
        onPromptChange(value);
        const command = getStyleCommandRange(value, cursor);
        setStyleCommand(command ? { start: command.start, end: command.end } : null);
        setStyleQuery(command?.query || "");
        setStyleMenuOpen(Boolean(command));
    };
    const closeStyleMenu = () => {
        setStyleMenuOpen(false);
        setStyleCommand(null);
        setStyleQuery("");
        setHighlightedStyleIndex(0);
    };
    const chooseStyle = (style: GenerationStyleOption) => {
        if (selectedStyles.some((item) => item.id === style.id)) {
            closeStyleMenu();
            return;
        }
        onStyleSelect?.(style);
        const next = styleCommand ? removeStyleCommand(prompt, styleCommand.start, styleCommand.end) : prompt;
        onPromptChange(next);
        setStyleCommand(null);
        setStyleQuery("");
        closeStyleMenu();
    };

    return (
        <div className="canvas-agent-composer-wrap px-3 pb-3 pt-2" onWheelCapture={(event) => event.stopPropagation()}>
            <div className="canvas-agent-composer rounded-2xl border p-2.5" style={{ background: theme.node.panel, borderColor: theme.node.stroke }}>
                {selectedStyles.length ? <GenerationStyleChips styles={selectedStyles} onRemove={(id) => onStyleRemove?.(id)} className="mb-2" /> : null}
                {selectedSkills.length ? <CanvasAgentSkillChips skills={selectedSkills} onRemove={onSkillRemove} theme={theme} className="mb-2" /> : null}
                {droppedNodes.length ? <NodeReferenceList nodes={droppedNodes} theme={theme} onRemove={removeNode} /> : null}
                {attachments.length ? <AttachmentList attachments={attachments} theme={theme} onRemove={onRemoveAttachment} /> : null}
                <textarea
                    ref={textareaRef}
                    autoFocus
                    value={prompt}
                    disabled={disabled}
                    rows={2}
                    placeholder={placeholder}
                    aria-label="给画布助手发送消息"
                    className="thin-scrollbar max-h-36 min-h-[58px] w-full resize-none bg-transparent px-1 py-1 text-[13px] leading-5 outline-none"
                    style={{ color: theme.node.text }}
                    onChange={(event) => updatePrompt(event.target.value, event.target.selectionStart ?? event.target.value.length)}
                    onKeyDown={(event) => {
                        if (styleMenuOpen) {
                            if (event.key === "ArrowDown") {
                                event.preventDefault();
                                setHighlightedStyleIndex((value) => Math.min(value + 1, Math.max(0, filteredStyles.length - 1)));
                                return;
                            }
                            if (event.key === "ArrowUp") {
                                event.preventDefault();
                                setHighlightedStyleIndex((value) => Math.max(value - 1, 0));
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
                        handleKeyDown(event);
                    }}
                    onPaste={(event) => {
                        const pastedText = event.clipboardData.getData("text/plain");
                        const parsed = parseGroupedGenerationStyleMessage(pastedText, styleOptions) || parseGenerationStyleMessage(pastedText, styleOptions);
                        if (parsed && onStyleSelect) {
                            event.preventDefault();
                            const additions = parsed.styles.filter((style) => !selectedStyles.some((selected) => selected.id === style.id));
                            const remaining = Math.max(0, MAX_GENERATION_STYLE_SELECTION_COUNT - selectedStyles.length);
                            if (additions.length > remaining) onStyleLimit?.();
                            additions.slice(0, remaining).forEach((style) => onStyleSelect(style as GenerationStyleOption));
                            onPromptChange(parsed.prompt);
                            closeStyleMenu();
                            return;
                        }
                        if (!onAddFiles) return;
                        const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
                        if (!images.length) return;
                        event.preventDefault();
                        void onAddFiles(images);
                    }}
                />
                <div className="canvas-agent-composer-footer mt-2 flex items-center justify-between gap-2">
                    <div className="canvas-agent-composer-tools flex min-w-0 flex-1 items-center gap-1">
                        {onAddFiles ? (
                            <>
                                <input
                                    ref={fileInputRef}
                                    hidden
                                    type="file"
                                    accept="image/*"
                                    multiple
                                    onChange={(event) => {
                                        void onAddFiles(event.target.files);
                                        event.target.value = "";
                                    }}
                                />
                                <Tooltip title="上传图片">
                                    <Button type="text" shape="circle" disabled={sending} icon={<ImagePlus className="size-4" />} style={{ color: theme.node.muted }} onClick={() => fileInputRef.current?.click()} />
                                </Tooltip>
                            </>
                        ) : null}
                        <GenerationStyleMenu
                            iconOnly
                            styles={styleOptions}
                            selected={selectedStyles}
                            loading={styleLoading}
                            error={styleError}
                            open={styleMenuOpen}
                            query={styleQuery}
                            highlightedIndex={highlightedStyleIndex}
                            grouped
                            placement="topLeft"
                            onOpenChange={(open) => {
                                if (open) {
                                    setStyleCommand(null);
                                    setStyleQuery("");
                                    setHighlightedStyleIndex(0);
                                    setStyleMenuOpen(true);
                                } else {
                                    closeStyleMenu();
                                }
                            }}
                            onQueryChange={setStyleQuery}
                            onHighlightedIndexChange={setHighlightedStyleIndex}
                            onSelect={chooseStyle}
                        />
                        {left}
                    </div>
                    <Tooltip title={sending ? "正在生成" : "发送消息（Enter）"}>
                        <Button className="canvas-agent-send shrink-0" type="primary" disabled={!canSubmit} icon={sending ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : <ArrowUp className="size-4" />} onClick={onSubmit} aria-label="发送" style={canSubmit ? { background: theme.toolbar.activeGradient, color: theme.toolbar.activeGradientText, borderColor: "transparent" } : undefined} />
                    </Tooltip>
                </div>
                {modelPicker ? <div className="canvas-agent-model-row"><span>对话模型</span>{modelPicker}</div> : null}
            </div>
            <div className="canvas-agent-composer-hint mt-2 px-1 text-[10px]" style={{ color: theme.node.muted }}><kbd>Enter</kbd> 发送 <span className="mx-1 opacity-40">·</span> <kbd>Shift + Enter</kbd> 换行</div>
        </div>
    );
}

function NodeReferenceList({ nodes, theme, onRemove }: { nodes: CanvasNode[]; theme: CanvasTheme; onRemove: (nodeId: string) => void }) {
    return (
        <div className="mb-2 flex flex-wrap gap-2">
            {nodes.map((node) => (
                <span key={node.id} className="inline-flex max-w-full items-center gap-2 rounded-lg border px-2 py-1 text-xs" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
                    {isImageNode(node) && node.content.source ? <img src={node.content.source} alt="" className="size-6 rounded object-cover" /> : null}
                    <span className="max-w-36 truncate">{node.title || node.id}</span>
                    <button type="button" aria-label={`移除 ${node.title || node.id}`} onClick={() => onRemove(node.id)}>
                        <X className="size-3" />
                    </button>
                </span>
            ))}
        </div>
    );
}

function AttachmentList({ attachments, theme, onRemove }: { attachments: CanvasAgentChatAttachment[]; theme: CanvasTheme; onRemove?: (id: string) => void }) {
    return (
        <div className="mb-2 flex gap-2 overflow-x-auto">
            {attachments.map((attachment) => (
                <div key={attachment.id} className="group relative size-14 shrink-0 overflow-hidden rounded-lg border" style={{ borderColor: theme.node.stroke }}>
                    <img src={attachment.url} alt={attachment.name} className="size-full object-cover" />
                    {onRemove ? (
                        <button
                            type="button"
                            className="absolute right-1 top-1 grid size-5 place-items-center rounded-full opacity-0 group-hover:opacity-100"
                            style={{ background: theme.toolbar.panel }}
                            onClick={() => onRemove(attachment.id)}
                            aria-label="移除图片"
                        >
                            <X className="size-3" />
                        </button>
                    ) : null}
                </div>
            ))}
        </div>
    );
}

function containsToken(value: string, token: string): boolean {
    return value.split(/\s+/).includes(token);
}

function removeToken(value: string, token: string): string {
    return value
        .split(/\s+/)
        .filter((item) => item && item !== token)
        .join(" ");
}
