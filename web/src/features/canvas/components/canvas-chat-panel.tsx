"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { App, Drawer, Grid, Tooltip } from "antd";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { AlertTriangle, ArrowDown, ArrowRight, ArrowUpRight, Bot, CheckCircle2, Clapperboard, Copy, Download, FilePlus2, History, ImagePlus, Layers3, LayoutPanelTop, Link2, ListTodo, LoaderCircle, Maximize2, MessageSquare, Minimize2, PanelRightClose, Plus, Sparkles, Square, Wrench } from "lucide-react";
import { ThinkingBlock } from "@/features/chat";
import type { ThinkingBlockState } from "@/features/chat/types";
import { ModelPicker } from "@/features/settings/components/model-picker";
import type { AiConfig } from "@/features/settings/stores/use-config-store";
import { useCopyText } from "@/shared/hooks/use-copy-text";
import type { CanvasTheme } from "@/shared/lib/canvas-theme";
import type { CanvasAgentSkillSelection, CanvasAssistantMessage, CanvasAssistantReference, CanvasAssistantSession, CanvasConnection, CanvasNode } from "../types";
import type { GenerationStyleOption } from "@/services/api/server";
import { formatGroupedGenerationStyleMessage } from "@/features/generation/lib/style-command";
import { GENERATION_STYLE_SELECTION_LIMIT_MESSAGE, MAX_GENERATION_STYLE_SELECTION_COUNT } from "@/features/generation/lib/generation-style-library";
import { GenerationStyleChips, useGenerationStyles } from "@/features/generation/components/generation-style-picker";
import { isImageNode, isTextNode, isVideoNode } from "../domain/canvas-node";
import { canvasAgentTaskStatusLabel, summarizeCanvasAgentProgress, readCanvasAgentPlanProgress } from "../domain/canvas-agent-progress";
import { AgentChatComposer } from "./canvas-agent-chat-ui";
import { useCanvasTheme } from "./canvas-theme-provider";
import { removeAssistantDraftNodes } from "../domain/canvas-assistant-workspace";
import { settleCanvasAssistantDraft, submitCanvasAssistantDraft } from "../domain/canvas-assistant-submission";
import { useCanvasAssistantDraft } from "../hooks/use-canvas-assistant-draft";
import { CanvasAssistantExport, CanvasAssistantHistory, CanvasAssistantNodePicker } from "./canvas-assistant-library";
import { CanvasAgentSkillChips, CanvasAgentSkillPicker } from "./canvas-agent-skill-picker";
import { CANVAS_AGENT_SKILL_LIMIT_MESSAGE, canvasAgentSkillSourceLabel, toggleCanvasAgentSkill } from "../domain/canvas-agent-skill-library";
import { buildOneSentenceFilmMessage, readOneSentenceFilmRun } from "../domain/one-sentence-film-progress";
import { OneSentenceFilmProgress } from "./one-sentence-film-progress";
import { FilmModelDialog } from "./film-model-dialog";
import type { FilmModelSelection } from "../infinite-agent/film-model-selection";
import { resolveOneSentenceFilmRequest } from "../infinite-agent/one-sentence-film";

const DEFAULT_PANEL_WIDTH = 440;
const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 720;
const MIN_CANVAS_WIDTH = 320;
const KEYBOARD_RESIZE_STEP = 24;

// Older saved conversations may still contain the retired generation estimate cards.
const isVisibleAgentMessage = (message: CanvasAssistantMessage) =>
    !(message.role === "system" && message.title?.trim() === "本批生成预估");

const STARTER_ACTIONS = [
    { label: "整理内容", hint: "梳理创作思路", icon: Layers3, prompt: "请梳理当前画布的内容和节点关系，给我下一步创作建议。" },
    { label: "构思分镜", hint: "规划镜头叙事", icon: LayoutPanelTop, prompt: "请根据当前画布内容构思分镜，并先说明镜头安排。" },
    { label: "创作图片", hint: "描绘灵感画面", icon: ImagePlus, prompt: "请根据当前画布内容，帮我构思一张图片的画面。" },
] as const;

type CanvasChatPanelProps = {
    onCollapse: () => void;
    nodes: CanvasNode[];
    connections?: CanvasConnection[];
    selectedNodeIds: ReadonlySet<string>;
    onNodeDropRef?: React.MutableRefObject<((nodeId: string) => void) | null>;
    messages: CanvasAssistantMessage[];
    completedThinkings?: ThinkingBlockState[];
    activeThinking?: ThinkingBlockState | null;
    onSend: (text: string, references?: CanvasAssistantReference[], generationStyleIds?: number[], generationStyles?: GenerationStyleOption[], skills?: CanvasAgentSkillSelection[], filmModels?: FilmModelSelection) => boolean | Promise<boolean>;
    onNewSession: () => void;
    onStop: () => void;
    isStreaming?: boolean;
    isQueued?: boolean;
    isReconnecting?: boolean;
    activity?: string;
    config: AiConfig;
    model: string;
    onModelChange: (model: string) => void;
    onMissingConfig?: () => void;
    initialPrompt?: string;
    promptSuggestion?: { text: string; id: string };
    onPromptSuggestionConsumed?: () => void;
    sessionId?: string | null;
    draftKey: string;
    sessions: CanvasAssistantSession[];
    onSelectSession: (id: string) => boolean;
    onRenameSession: (id: string, title: string) => void;
    onAddTextToCanvas: (text: string) => void;
    onLocateNode: (id: string) => void;
};

/**
 * 基于 assistant-ui 的画布 AI 对话面板
 * 承载画布内的对话、节点引用和模型选择交互
 */
export function CanvasChatPanel({
    onCollapse,
    nodes,
    connections = [],
    selectedNodeIds,
    onNodeDropRef,
    messages: storedMessages,
    completedThinkings = [],
    activeThinking = null,
    onSend,
    onNewSession,
    onStop,
    isStreaming = false,
    isQueued = false,
    isReconnecting = false,
    activity = "",
    config,
    model,
    onModelChange,
    onMissingConfig,
    initialPrompt = "",
    promptSuggestion,
    onPromptSuggestionConsumed,
    sessionId = null,
    draftKey,
    sessions: storedSessions,
    onSelectSession,
    onRenameSession,
    onAddTextToCanvas,
    onLocateNode,
}: CanvasChatPanelProps) {
    const messages = useMemo(() => storedMessages.filter(isVisibleAgentMessage), [storedMessages]);
    const sessions = useMemo(() => storedSessions.map((session) => ({ ...session, messages: session.messages.filter(isVisibleAgentMessage) })), [storedSessions]);
    const theme = useCanvasTheme();
    const screens = Grid.useBreakpoint();
    const isMobile = !screens.md;
    const { message } = App.useApp();
    const copyText = useCopyText();
    const scrollRef = useRef<HTMLDivElement>(null);
    const stopResizeRef = useRef<() => void>(() => undefined);
    const storageWarning = useCallback(() => { message.warning("浏览器无法保存草稿，刷新前请先复制输入内容"); }, [message]);
    const [draft, updateDraft] = useCanvasAssistantDraft(draftKey, storageWarning);
    const submittingRef = useRef(false);
    const [submissionPending, setSubmissionPending] = useState(false);
    const [failedDraftKey, setFailedDraftKey] = useState<string | null>(null);
    const [failedFilmContinuation, setFailedFilmContinuation] = useState(false);
    const [oneSentenceFilmEnabled, setOneSentenceFilmEnabled] = useState(false);
    const [pendingFilm, setPendingFilm] = useState<{ text: string; draftKey: string } | null>(null);
    useEffect(() => setPendingFilm(null), [draftKey]);
    const prompt = draft.prompt;
    const droppedNodeIds = new Set(draft.nodeIds);
    const selectedStyles = draft.styles;
    const selectedSkills = draft.skills || [];
    const setPrompt = useCallback((value: string) => updateDraft((current) => ({ ...current, prompt: value })), [updateDraft]);
    const setDroppedNodeIds = useCallback((value: SetStateAction<Set<string>>) => updateDraft((current) => ({ ...current, nodeIds: [...(typeof value === "function" ? value(new Set(current.nodeIds)) : value)] })), [updateDraft]);
    const setSelectedStyles = useCallback((value: SetStateAction<GenerationStyleOption[]>) => updateDraft((current) => ({ ...current, styles: typeof value === "function" ? value(current.styles) : value })), [updateDraft]);
    const initialPromptAppliedRef = useRef(false);
    useEffect(() => {
        if (promptSuggestion) { setPrompt(promptSuggestion.text); onPromptSuggestionConsumed?.(); }
    }, [promptSuggestion, setPrompt, onPromptSuggestionConsumed]);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [nodePickerOpen, setNodePickerOpen] = useState(false);
    const [skillPickerOpen, setSkillPickerOpen] = useState(false);
    const [exportSession, setExportSession] = useState<CanvasAssistantSession | null>(null);
    const followBottomRef = useRef(true);
    const [showScrollToBottom, setShowScrollToBottom] = useState(false);
    const styleCatalog = useGenerationStyles();
    const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
    const [isExpanded, setIsExpanded] = useState(false);
    const [isResizing, setIsResizing] = useState(false);
    const [mobilePanelOpen, setMobilePanelOpen] = useState(true);
    const collapseCompletedRef = useRef(false);
    // 关闭动画期间保留抽屉，避免横屏或窗口变宽导致卸载并丢失关闭回调。
    const showMobileDrawer = isMobile || !mobilePanelOpen;
    const droppedNodes = nodes.filter((node) => droppedNodeIds.has(node.id));
    const selectedNodes = nodes.filter((node) => selectedNodeIds.has(node.id));
    const unattachedSelectedNodes = selectedNodes.filter((node) => !droppedNodeIds.has(node.id));

    useEffect(() => {
        const liveIds = new Set(nodes.map((node) => node.id));
        const removedIds = new Set(draft.nodeIds.filter((id) => !liveIds.has(id)));
        if (removedIds.size) updateDraft((current) => removeAssistantDraftNodes(current, removedIds));
    }, [nodes, draft.nodeIds, updateDraft]);

    useEffect(() => {
        if (initialPromptAppliedRef.current || !initialPrompt) return;
        initialPromptAppliedRef.current = true;
        if (!prompt && !messages.length) setPrompt(initialPrompt);
    }, [initialPrompt, messages.length, prompt, setPrompt]);

    useEffect(() => {
        followBottomRef.current = true;
        setShowScrollToBottom(false);
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, [draftKey]);

    const handleSend = useCallback(
        async (text: string, continueFilm = false, filmModels?: FilmModelSelection) => {
            if (!text.trim() || isStreaming || isQueued || isReconnecting || submittingRef.current) return;
            const filmMessage = buildOneSentenceFilmMessage(text, oneSentenceFilmEnabled || continueFilm);
            const filmRequest = resolveOneSentenceFilmRequest(filmMessage);
            if (!continueFilm && filmRequest?.film.pipelineMode === "full" && !filmModels) {
                setPendingFilm({ text, draftKey });
                return;
            }
            submittingRef.current = true;
            setSubmissionPending(true);
            setFailedDraftKey(null);
            setFailedFilmContinuation(false);
            const submittedDraft = draft;
            const references = droppedNodes.map(nodeToReference).filter((item): item is CanvasAssistantReference => Boolean(item));
            const accepted = await submitCanvasAssistantDraft(() => onSend(
                filmMessage,
                continueFilm ? [] : references,
                continueFilm ? [] : selectedStyles.map((style) => style.id),
                continueFilm ? [] : selectedStyles,
                continueFilm ? [] : selectedSkills,
                filmModels,
            ));
            if (!continueFilm) updateDraft((current) => settleCanvasAssistantDraft(current, submittedDraft, accepted));
            if (!accepted) { setFailedDraftKey(draftKey); setFailedFilmContinuation(continueFilm); }
            else { followBottomRef.current = true; setPendingFilm(null); }
            submittingRef.current = false;
            setSubmissionPending(false);
        },
        [draft, draftKey, droppedNodes, onSend, selectedStyles, selectedSkills, updateDraft, isStreaming, isQueued, isReconnecting, oneSentenceFilmEnabled],
    );

    const handleNewSession = useCallback(() => {
        onNewSession();
    }, [onNewSession]);

    const toggleSkill = useCallback((skill: CanvasAgentSkillSelection) => {
        const next = toggleCanvasAgentSkill(draft.skills || [], skill);
        if (next.limitReached) { message.warning(CANVAS_AGENT_SKILL_LIMIT_MESSAGE); return; }
        updateDraft((current) => ({ ...current, skills: toggleCanvasAgentSkill(current.skills || [], skill).selections }));
    }, [draft.skills, message, updateDraft]);

    const toggleExpanded = useCallback(() => {
        setPanelWidth(clampPanelWidth(isExpanded ? DEFAULT_PANEL_WIDTH : MAX_PANEL_WIDTH));
        setIsExpanded(!isExpanded);
    }, [isExpanded]);

    useEffect(() => {
        if (!onNodeDropRef) return;
        onNodeDropRef.current = (nodeId: string) => {
            setDroppedNodeIds((prev) => new Set(prev).add(nodeId));
        };
        return () => {
            onNodeDropRef.current = null;
        };
    }, [onNodeDropRef, setDroppedNodeIds]);

    // Follow new output only while the reader stays near the latest message.
    useEffect(() => {
        if (scrollRef.current && followBottomRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [activeThinking, completedThinkings, messages, isQueued, isStreaming]);

    const requestActive = isStreaming || isQueued || submissionPending || isReconnecting;
    const activeSession = sessions.find((session) => session.id === sessionId);
    const filmRun = readOneSentenceFilmRun((activeSession?.infiniteAgent as { film?: unknown } | undefined)?.film);

    useEffect(() => {
        if (showMobileDrawer) {
            stopResizeRef.current();
            return;
        }
        const handleWindowResize = () => setPanelWidth((current) => clampPanelWidth(current));
        handleWindowResize();
        window.addEventListener("resize", handleWindowResize);
        return () => {
            window.removeEventListener("resize", handleWindowResize);
            stopResizeRef.current();
        };
    }, [showMobileDrawer]);

    const startResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        stopResizeRef.current();
        const previousCursor = document.body.style.cursor;
        const previousUserSelect = document.body.style.userSelect;

        const move = (pointerEvent: PointerEvent) => {
            setPanelWidth(clampPanelWidth(window.innerWidth - pointerEvent.clientX));
        };
        const stop = () => {
            setIsResizing(false);
            document.body.style.cursor = previousCursor;
            document.body.style.userSelect = previousUserSelect;
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", stop);
            document.removeEventListener("pointercancel", stop);
            stopResizeRef.current = () => undefined;
        };

        setIsResizing(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", stop);
        document.addEventListener("pointercancel", stop);
        stopResizeRef.current = stop;
    }, []);

    const resizeWithKeyboard = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const delta = event.key === "ArrowLeft" ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP;
        setPanelWidth((current) => clampPanelWidth(current + delta));
    }, []);

    const finishCollapse = () => {
        if (collapseCompletedRef.current) return;
        collapseCompletedRef.current = true;
        onCollapse();
    };

    const closePanel = () => {
        if (showMobileDrawer) setMobilePanelOpen(false);
        else finishCollapse();
    };

    const headerActions = (
        <div className="canvas-agent-header-actions flex shrink-0 items-center gap-0.5">
            <button type="button" className="grid size-8 place-items-center rounded-lg opacity-70 transition hover:opacity-100 focus-visible:outline-2" onClick={() => setHistoryOpen(true)} title="历史对话" aria-label="历史对话"><History className="size-4" /></button>
            {isStreaming || isQueued || submissionPending ? (
                <button
                    type="button"
                    className="grid size-9 place-items-center rounded-lg opacity-70 transition hover:opacity-100 focus-visible:outline-2 focus-visible:outline-[var(--studio-action)]"
                    onClick={onStop}
                    title={isQueued ? "取消排队" : "停止生成"}
                    aria-label={isQueued ? "取消排队" : "停止生成"}
                >
                    <Square className="size-4" />
                </button>
            ) : null}
            <button
                type="button"
                className="grid size-9 place-items-center rounded-lg opacity-70 transition hover:opacity-100 focus-visible:outline-2 focus-visible:outline-[var(--studio-action)] disabled:cursor-not-allowed disabled:opacity-25"
                onClick={handleNewSession}
                disabled={requestActive}
                title="新对话"
                aria-label="新对话"
            >
                <Plus className="size-4" />
            </button>
            {!showMobileDrawer ? (
                <button
                    type="button"
                    className="grid size-9 place-items-center rounded-lg opacity-70 transition hover:opacity-100 focus-visible:outline-2 focus-visible:outline-[var(--studio-action)]"
                    onClick={toggleExpanded}
                    title={isExpanded ? "恢复助手宽度" : "展开助手"}
                    aria-label={isExpanded ? "恢复助手宽度" : "展开助手"}
                >
                    {isExpanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                </button>
            ) : null}
            <button
                type="button"
                className="grid size-9 place-items-center rounded-lg opacity-70 transition hover:opacity-100 focus-visible:outline-2 focus-visible:outline-[var(--studio-action)]"
                onClick={closePanel}
                title="关闭画布 Agent"
                aria-label="关闭画布 Agent"
            >
                <PanelRightClose className="size-4" />
            </button>
        </div>
    );

    const panelContent = (
        <div
            data-agent-panel
            className={`canvas-agent-panel relative flex min-h-0 shrink-0 flex-col overflow-hidden ${showMobileDrawer ? "h-full" : "mb-3 mr-3 mt-3 h-[calc(100%-24px)] rounded-2xl border"} ${isResizing ? "select-none" : "transition-[width] duration-150 ease-out motion-reduce:transition-none"}`}
            style={{ width: showMobileDrawer ? "100%" : panelWidth, background: theme.node.panel, borderColor: showMobileDrawer ? undefined : theme.toolbar.border, color: theme.node.text }}
        >
            {!showMobileDrawer ? (
                <button
                    type="button"
                    className="group absolute inset-y-0 left-0 z-40 w-3 -translate-x-1/2 cursor-col-resize touch-none outline-none"
                    onPointerDown={startResize}
                    onKeyDown={resizeWithKeyboard}
                    onDoubleClick={() => setPanelWidth(clampPanelWidth(DEFAULT_PANEL_WIDTH))}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="调整画布Agent宽度"
                    aria-valuemin={MIN_PANEL_WIDTH}
                    aria-valuemax={Math.round(getPanelMaximumWidth())}
                    aria-valuenow={Math.round(panelWidth)}
                    title="拖动调整宽度，双击恢复默认"
                >
                    <span
                        className="absolute left-1/2 top-1/2 h-12 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-80 group-active:opacity-100"
                        style={{ background: theme.node.muted }}
                    />
                </button>
            ) : null}
            {/* 标题栏 */}
            {!showMobileDrawer ? (
                <div className="canvas-agent-header flex h-14 shrink-0 items-center justify-between gap-2 px-4 text-[13px] font-semibold tracking-[-0.01em]" style={{ borderBottom: `1px solid ${theme.toolbar.border}` }}>
                    <AgentHeaderTitle theme={theme} />
                    {headerActions}
                </div>
            ) : null}

            {activeSession?.messages.length ? (
                <div className="canvas-agent-session-strip flex shrink-0 items-center gap-2 border-b px-4 py-1.5" style={{ borderColor: theme.toolbar.border, color: theme.node.muted }}>
                    <span className="size-1.5 shrink-0 rounded-full" style={{ background: theme.node.activeStroke }} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-[11px]" title={activeSession.title}>{activeSession.title}</span>
                    <button type="button" className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] hover:opacity-70 focus-visible:outline-2" onClick={() => setExportSession(activeSession)} aria-label="导出当前对话"><Download className="size-3" />导出</button>
                </div>
            ) : null}

            {selectedNodes.length ? (
                <div className="canvas-agent-selection flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2.5" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.activeBg }}>
                    <Layers3 className="size-4 shrink-0" style={{ color: theme.toolbar.activeText }} />
                    <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-semibold" style={{ color: theme.node.text }}>当前选中 {selectedNodes.length} 个节点</div>
                        <div className="truncate text-[10px]" style={{ color: theme.node.muted }} title={selectedNodes.map((node) => node.title).join("、")}>
                            {selectedNodes.slice(0, 3).map((node) => node.title).join("、")}{selectedNodes.length > 3 ? ` 等 ${selectedNodes.length} 个` : ""} · Agent 会读取当前选择
                        </div>
                    </div>
                    {unattachedSelectedNodes.length ? (
                        <button
                            type="button"
                            onClick={() => setDroppedNodeIds((current) => new Set([...current, ...unattachedSelectedNodes.map((node) => node.id)]))}
                            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border px-2 text-[11px] font-medium transition-colors hover:opacity-75 focus-visible:outline-2"
                            style={{ borderColor: theme.toolbar.border, color: theme.node.text, background: theme.toolbar.panel }}
                            title="将选中节点添加为这条消息的明确引用"
                        >
                            <Link2 className="size-3" />引用选中
                        </button>
                    ) : null}
                </div>
            ) : null}

            {/* 消息列表 */}
            <div ref={scrollRef} onScroll={() => {
                const element = scrollRef.current;
                if (!element) return;
                const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
                followBottomRef.current = atBottom;
                setShowScrollToBottom(!atBottom);
            }} className="canvas-agent-messages thin-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
                <div className="flex min-h-full flex-col gap-5">
                    {messages.length === 0 ? (
                        <div data-agent-empty className="canvas-agent-empty">
                            <div className="canvas-agent-intro">
                                <p className="canvas-agent-eyebrow"><Sparkles className="size-3.5" aria-hidden="true" />你的 AI 创作搭档</p>
                                <h2>把想法，变成作品</h2>
                                <p className="canvas-agent-intro-description">从灵感到成片，和你一起完成每一步。</p>
                            </div>
                            <button type="button" className="canvas-agent-film-starter" aria-label="开始一句话成片" disabled={requestActive}
                                onClick={() => { setOneSentenceFilmEnabled(true); scrollRef.current?.closest("[data-agent-panel]")?.querySelector<HTMLTextAreaElement>("textarea")?.focus(); }}>
                                <span className="canvas-agent-film-heading"><Clapperboard className="size-4" /><strong>一句话成片</strong><ArrowUpRight className="ml-auto size-4" /></span>
                                <span className="canvas-agent-film-description">说出故事，让 AI 编排完整影片</span>
                                <span className="canvas-agent-film-steps" aria-hidden="true"><span>剧本</span><ArrowRight /><span>分镜图</span><ArrowRight /><span>视频</span><ArrowRight /><span>成片</span></span>
                            </button>
                            <div className="canvas-agent-starter-label">也可以从这里开始</div>
                            <div className="canvas-agent-starter-grid" aria-label="创作快捷起点">
                                {STARTER_ACTIONS.map((action) => {
                                    const Icon = action.icon;
                                    return (
                                    <button
                                        key={action.label}
                                        type="button"
                                        className="canvas-agent-starter"
                                        disabled={requestActive}
                                        title={action.hint}
                                        onClick={() => {
                                            setOneSentenceFilmEnabled(false);
                                            setPrompt(action.prompt);
                                            scrollRef.current?.closest("[data-agent-panel]")?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
                                        }}
                                    >
                                        <Icon className="size-4" />
                                        <span>{action.label}</span>
                                    </button>
                                    );
                                })}
                            </div>
                        </div>
                    ) : (
                        messages.map((msg) => {
                            const userMessage = msg.role === "user";
                            return (
                                <div key={msg.id} className="space-y-1.5">
                                    {msg.role === "system" || msg.role === "tool" || msg.role === "error" ? (
                                        <AgentActivityCard message={msg} theme={theme} />
                                    ) : (
                                        <ChatBubble role={msg.role} text={msg.text} theme={theme} onCopy={() => copyText(formatGroupedGenerationStyleMessage(msg.text, msg.generationStyles), "消息已复制")} onAddToCanvas={msg.role === "assistant" && msg.text.trim() && !requestActive ? () => onAddTextToCanvas(msg.text) : undefined} />
                                    )}
                                    {msg.generationStyles?.length ? <div className={`flex ${userMessage ? "justify-end" : "justify-start pl-9"}`}><GenerationStyleChips styles={msg.generationStyles.map((style) => ({ ...style, coverUrl: "", category: "" }))} /></div> : null}
                                    {msg.skills?.length ? <div className={`flex ${userMessage ? "justify-end" : "justify-start pl-9"}`}><div className="max-w-full space-y-1.5"><p className={`text-[10px] ${userMessage ? "text-right" : "text-left"}`} style={{ color: theme.node.muted }}>{canvasAgentSkillSourceLabel(msg.skillSource)}</p><CanvasAgentSkillChips skills={msg.skills} theme={theme} /></div></div> : null}
                                    {msg.references?.length ? <MessageReferences references={msg.references} theme={theme} align={userMessage ? "right" : "left"} /> : null}
                                </div>
                            );
                        })
                    )}
                    {filmRun ? <OneSentenceFilmProgress run={filmRun} nodes={nodes} connections={connections} busy={requestActive} theme={theme} onContinue={() => void handleSend("继续成片", true)} onLocateNode={onLocateNode} /> : null}
                    {[...completedThinkings, ...(activeThinking ? [activeThinking] : [])]
                        .filter((thinking) => thinking.text)
                        .map((thinking) => (
                            <ThinkingBlock
                                key={thinking.id}
                                block={thinking}
                                streaming={activeThinking?.id === thinking.id}
                                appearance={{
                                    text: theme.node.text,
                                    muted: theme.node.muted,
                                    background: theme.toolbar.itemHover,
                                    border: theme.toolbar.border,
                                }}
                            />
                        ))}
                    {requestActive ? (
                        <div className="flex items-center gap-2 px-1 text-xs" style={{ color: theme.node.muted }}>
                            <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
                            <span role="status" aria-live="polite">{activity || (isReconnecting ? "正在恢复任务状态" : isQueued ? "正在排队" : "正在处理画布任务")}</span>
                        </div>
                    ) : null}
                </div>
            </div>

            {showScrollToBottom ? <div className="flex shrink-0 justify-center pb-2"><button type="button" className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[11px] shadow-sm focus-visible:outline-2" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel, color: theme.node.text }} onClick={() => { followBottomRef.current = true; setShowScrollToBottom(false); if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }}><ArrowDown className="size-3" />回到最新消息</button></div> : null}

            {/* 输入框 */}
            <div className="canvas-agent-input-area thin-scrollbar max-h-[65%] shrink-0 overflow-y-auto overscroll-contain" style={{ paddingBottom: showMobileDrawer ? "env(safe-area-inset-bottom, 0px)" : undefined }}>
                <div className="canvas-agent-mode-bar" role="group" aria-label="创作模式">
                    <button type="button" aria-pressed={!oneSentenceFilmEnabled} disabled={requestActive} onClick={() => setOneSentenceFilmEnabled(false)}><MessageSquare className="size-3.5" />自由创作</button>
                    <button type="button" aria-pressed={oneSentenceFilmEnabled} disabled={requestActive} onClick={() => setOneSentenceFilmEnabled(true)}><Clapperboard className="size-3.5" />一句话成片</button>
                </div>
                {failedDraftKey === draftKey ? <div className="flex items-center justify-between gap-2 px-4 pt-2 text-[11px]" role="status" style={{ color: theme.node.muted }}><span>{failedFilmContinuation ? "续作请求未发送，已有成果保留" : "发送失败，输入和引用已保留"}</span><button type="button" className="shrink-0 rounded-md px-2 py-1 font-medium focus-visible:outline-2 disabled:opacity-40" disabled={requestActive || (!failedFilmContinuation && !prompt.trim())} onClick={() => void handleSend(failedFilmContinuation ? "继续成片" : prompt, failedFilmContinuation)} style={{ color: theme.toolbar.activeText }}>重试发送</button></div> : null}
                <AgentChatComposer
                    prompt={prompt}
                    sending={requestActive}
                    placeholder={oneSentenceFilmEnabled ? "描述视频主题，例如：雨夜咖啡馆的 20 秒治愈短片…" : "描述你的想法，或引用画布中的节点…"}
                    theme={theme}
                    onPromptChange={setPrompt}
                    onSubmit={() => handleSend(prompt)}
                    styleOptions={styleCatalog.styles}
                    selectedStyles={selectedStyles}
                    selectedSkills={selectedSkills}
                    onSkillRemove={(id) => updateDraft((current) => ({ ...current, skills: (current.skills || []).filter((skill) => skill.id !== id) }))}
                    styleLoading={styleCatalog.loading}
                    styleError={styleCatalog.error}
                    onStyleSelect={(style) => setSelectedStyles([style])}
                    onStyleRemove={(id) => setSelectedStyles((current) => current.filter((style) => style.id !== id))}
                    onStyleLimit={() => message.warning(GENERATION_STYLE_SELECTION_LIMIT_MESSAGE)}
                    droppedNodes={droppedNodes}
                    onDroppedNodeRemove={(nodeId) => {
                        setDroppedNodeIds((prev) => {
                            const next = new Set(prev);
                            next.delete(nodeId);
                            return next;
                        });
                    }}
                    left={<div className="canvas-agent-model-tools flex min-w-0 items-center gap-1"><Tooltip title={selectedSkills.length ? "手动指定创作技能" : "自动匹配技能，也可手动指定"}><button type="button" className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[11px] focus-visible:outline-2" aria-label="选择创作技能" onClick={() => setSkillPickerOpen(true)} style={{ color: selectedSkills.length ? theme.toolbar.activeText : theme.node.muted }}><Sparkles className="size-3.5" />技能{selectedSkills.length ? <span className="tabular-nums">{selectedSkills.length}</span> : null}</button></Tooltip><Tooltip title="搜索并引用画布节点"><button type="button" className="canvas-agent-reference-button inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[11px] focus-visible:outline-2" aria-label="搜索并引用画布节点" onClick={() => setNodePickerOpen(true)}><Link2 className="size-3.5" />引用</button></Tooltip></div>}
                    modelPicker={<ModelPicker config={config} value={model} onChange={onModelChange} capability="text" className="h-8 min-w-0 flex-1" placeholder="选择文本模型" onMissingConfig={onMissingConfig} />}
                />
            </div>
            {historyOpen ? <CanvasAssistantHistory sessions={sessions} activeId={sessionId} busy={requestActive} onSelect={onSelectSession} onRename={onRenameSession} onClose={() => setHistoryOpen(false)} theme={theme} /> : null}
            {exportSession ? <CanvasAssistantExport session={exportSession} onClose={() => setExportSession(null)} onCopy={(text) => copyText(text, "对话 Markdown 已复制")} theme={theme} /> : null}
            <CanvasAgentSkillPicker open={skillPickerOpen} selected={selectedSkills} onToggle={toggleSkill} onClose={() => setSkillPickerOpen(false)} theme={theme} />
            {pendingFilm && pendingFilm.draftKey === draftKey ? <FilmModelDialog config={config} brief={pendingFilm.text}
                busy={submissionPending} onClose={() => setPendingFilm(null)}
                onConfirm={models => void handleSend(pendingFilm.text, false, models)} /> : null}
            {nodePickerOpen ? <CanvasAssistantNodePicker nodes={nodes} referencedIds={new Set(droppedNodes.map((node) => node.id))} onToggle={(nodeId) => updateDraft((current) => {
                const removing = current.nodeIds.includes(nodeId);
                return removing ? removeAssistantDraftNodes(current, new Set([nodeId])) : { ...current, nodeIds: [...current.nodeIds, nodeId] };
            })} onLocate={onLocateNode} onClose={() => setNodePickerOpen(false)} theme={theme} /> : null}
        </div>
    );

    if (showMobileDrawer) {
        return (
            <Drawer
                open={mobilePanelOpen}
                placement="right"
                size="min(100vw, 420px)"
                title={<AgentHeaderTitle theme={theme} />}
                closable={false}
                extra={headerActions}
                onClose={closePanel}
                afterOpenChange={(open) => {
                    if (!open) finishCollapse();
                    else if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                }}
                focusable={{ trap: true, focusTriggerAfterClose: true }}
                styles={{
                    root: { height: "100dvh" },
                    header: { minHeight: 56, padding: "8px 16px", borderColor: theme.toolbar.border, background: theme.node.panel, color: theme.node.text },
                    body: { minHeight: 0, padding: 0, overflow: "hidden" },
                }}
            >
                {panelContent}
            </Drawer>
        );
    }

    return panelContent;
}

function clampPanelWidth(width: number) {
    return Math.min(getPanelMaximumWidth(), Math.max(MIN_PANEL_WIDTH, width));
}

function getPanelMaximumWidth() {
    return typeof window === "undefined" ? MAX_PANEL_WIDTH : Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, window.innerWidth - MIN_CANVAS_WIDTH));
}

function AgentHeaderTitle({ theme }: { theme: CanvasTheme }) {
    return (
        <span className="flex min-w-0 items-center gap-2.5">
            <span className="canvas-agent-header-icon relative grid size-8 shrink-0 place-items-center rounded-xl">
                <Bot className="size-4" />
            </span>
            <span className="min-w-0 text-left leading-none">
                <span className="block truncate text-[13px] font-semibold" style={{ color: theme.node.text }}>创作助手</span>
                <span className="mt-1 block truncate text-[10px] font-normal tracking-normal" style={{ color: theme.node.muted }}>与你共创每个灵感</span>
            </span>
        </span>
    );
}

function MessageReferences({ references, theme, align }: { references: CanvasAssistantReference[]; theme: CanvasTheme; align: "left" | "right" }) {
    return (
        <div className={`flex max-w-full flex-wrap gap-1.5 ${align === "right" ? "ml-auto justify-end" : "pl-1"}`}>
            {references.map((item) => (
                <AssistantReferenceChip key={item.id} item={item} theme={theme} />
            ))}
        </div>
    );
}

function AssistantReferenceChip({ item, theme }: { item: CanvasAssistantReference; theme: CanvasTheme }) {
    const text = (item.text || item.title).replace(/\s+/g, " ").trim().slice(0, 1) || "文";
    return (
        <div className="inline-flex h-8 max-w-[150px] shrink-0 items-center gap-1.5 rounded-lg text-sm" style={{ color: theme.node.text }}>
            {item.dataUrl ? (
                <img src={item.dataUrl} alt="" className="size-8 rounded-lg object-cover" />
            ) : (
                <span className="grid size-8 place-items-center rounded-lg border text-sm font-medium" style={{ background: theme.node.panel, borderColor: theme.node.activeStroke }}>
                    {text}
                </span>
            )}
        </div>
    );
}

function nodeToReference(node: CanvasNode): CanvasAssistantReference | null {
    if (isImageNode(node)) {
        return { id: node.id, type: node.kind, title: node.title, dataUrl: node.content.source || undefined, storageKey: node.content.storageKey, objectStorage: node.content.objectStorage, text: node.generation.prompt.slice(0, 1600) };
    }
    if (isTextNode(node)) {
        return { id: node.id, type: node.kind, title: node.title, text: node.content.text.slice(0, 1600) };
    }
    if (isVideoNode(node)) {
        return { id: node.id, type: node.kind, title: node.title, text: node.generation.prompt || node.title };
    }
    if (node.kind === "storyboard") {
        const shots = node.storyboard.shots.slice(0, 6).map((shot) => `镜头 ${shot.shotNumber}：${shot.visualDescription}`).join("\n");
        return { id: node.id, type: node.kind, title: node.title, text: [node.content.instruction, node.content.visualStyle, shots].filter(Boolean).join("\n").slice(0, 1600) };
    }
    if (node.kind === "audio") return { id: node.id, type: node.kind, title: node.title, text: `音频节点：${node.title}` };
    if (node.kind === "videoComposition") return { id: node.id, type: node.kind, title: node.title, text: `视频合成节点；输入 ${node.composition.inputVideoNodeIds.length} 段视频` };
    return { id: node.id, type: node.kind, title: node.title, text: `背景板：${node.title}；包含 ${node.memberNodeIds.length} 个节点` };
}

function AgentActivityCard({ message, theme }: { message: CanvasAssistantMessage; theme: CanvasTheme }) {
    const error = message.role === "error" || message.meta?.startsWith("失败：");
    const Icon = error ? AlertTriangle : message.role === "tool" ? Wrench : ListTodo;
    const heading = message.title || (error ? "任务失败" : message.role === "tool" ? "工具执行" : "创作计划");
    const progress = message.role === "system" ? readCanvasAgentPlanProgress(message.detail) : null;
    const progressSummary = progress ? summarizeCanvasAgentProgress(progress) : null;
    const completed = progressSummary?.settled || 0;
    const tasks = progress ? Object.values(progress.tasks) : [];
    return (
        <section className={`canvas-agent-activity rounded-xl border p-3 ${error ? "canvas-agent-activity-error" : ""}`} style={{ borderColor: error ? "rgba(239,68,68,.20)" : theme.toolbar.border, background: error ? "rgba(239,68,68,.04)" : theme.toolbar.itemHover }} aria-label={heading}>
            <div className="flex items-center gap-2 text-xs font-semibold" style={{ color: error ? "#dc4848" : theme.node.text }}>
                <span className="grid size-6 shrink-0 place-items-center rounded-md" style={{ background: error ? "rgba(239,68,68,.09)" : theme.toolbar.activeBg }}><Icon className="size-3.5" /></span>
                <span className="min-w-0 break-words">{heading}</span>
            </div>
            {message.text ? <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5" style={{ color: theme.node.text }}>{message.text}</p> : null}
            {progress?.taskCount ? (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: theme.node.stroke }} role="progressbar" aria-valuemin={0} aria-valuemax={progress.taskCount} aria-valuenow={completed} aria-label="创作计划进度">
                    <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.min(100, completed / progress.taskCount * 100)}%`, background: error || progressSummary?.failed ? "#ef4444" : theme.toolbar.activeText }} />
                </div>
            ) : null}
            {message.meta ? <p className="mt-1.5 text-[11px]" style={{ color: error ? "#ef4444" : theme.node.muted }}>{message.meta}</p> : null}
            {tasks.length ? (
                <details className="mt-2 border-t pt-2 text-[11px]" style={{ borderColor: theme.node.stroke }}>
                    <summary className="cursor-pointer select-none font-medium" style={{ color: theme.node.muted }}>查看 {tasks.length} 个任务状态</summary>
                    <ol className="mt-2 space-y-1.5">
                        {tasks.map((task, index) => (
                            <li key={index} className="flex items-start gap-2" style={{ color: task.status === "failed" ? "#ef4444" : theme.node.muted }}>
                                <span className="shrink-0">{index + 1}. {canvasAgentTaskStatusLabel(task.status)}</span>
                                <span className="min-w-0 break-words">{task.message || task.status}</span>
                            </li>
                        ))}
                    </ol>
                </details>
            ) : null}
        </section>
    );
}

function ChatBubble({ role, text, theme, onCopy, onAddToCanvas }: { role: "user" | "assistant"; text: string; theme: CanvasTheme; onCopy: () => void; onAddToCanvas?: () => void }) {
    const isUser = role === "user";
    const isError = !isUser && /^(错误|失败)[:：]/.test(text.trim());
    const isStatus = !isUser && text.includes("画布计划已执行");
    const AssistantIcon = isError ? AlertTriangle : isStatus ? CheckCircle2 : Bot;
    return (
        <article className={`canvas-agent-message group flex min-w-0 flex-col ${isUser ? "items-end" : "items-start"}`} aria-label={isUser ? "我的消息" : "助手消息"}>
            {!isUser ? <div className="mb-2 flex items-center gap-2 text-[11px] font-medium" style={{ color: theme.node.muted }}>
                <span className="grid size-6 place-items-center rounded-lg" style={{ background: isError ? "rgba(239,68,68,.10)" : theme.toolbar.activeBg, color: isError ? "#dc4848" : theme.toolbar.activeText }}>
                    <AssistantIcon className="size-3.5" />
                </span>
                {isError ? "任务提醒" : isStatus ? "执行结果" : "画布助手"}
            </div> : null}
            <div className={`min-w-0 ${isUser ? "max-w-[92%]" : "w-full"}`}>
                <div
                    className={`canvas-agent-bubble cursor-text select-text text-[13px] leading-[1.75] break-words ${isUser ? "canvas-agent-bubble-user rounded-2xl rounded-br-md px-3.5 py-2.5" : `canvas-agent-bubble-assistant rounded-xl px-1 py-0.5 ${isError ? "canvas-agent-bubble-error" : isStatus ? "canvas-agent-bubble-status" : ""}`}`}
                    style={{
                        background: isUser ? theme.toolbar.activeBg : isError ? "rgba(239,68,68,.055)" : isStatus ? "rgba(16,185,129,.055)" : "transparent",
                        color: theme.node.text,
                        border: `1px solid ${isError ? "rgba(239,68,68,.22)" : isStatus ? "rgba(16,185,129,.22)" : isUser ? theme.toolbar.border : "transparent"}`,
                    }}
                >
                    {isUser ? <span className="whitespace-pre-wrap">{text}</span> : <AssistantMarkdownContent text={text} theme={theme} />}
                </div>
                <div className={`canvas-agent-message-actions mt-1 flex items-center gap-1 ${isUser ? "justify-end" : "justify-start"}`} style={{ color: theme.node.muted }}>
                    <Tooltip title="复制消息">
                        <button
                            type="button"
                            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] focus-visible:outline-2"
                            onClick={onCopy}
                            aria-label="复制消息"
                        >
                            <Copy className="size-3" />
                            {!isUser ? <span>复制</span> : null}
                        </button>
                    </Tooltip>
                    {onAddToCanvas ? <>
                        <span className="h-3 border-l" style={{ borderColor: theme.toolbar.border }} aria-hidden="true" />
                        <button type="button" className="inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[11px] focus-visible:outline-2" onClick={onAddToCanvas}><FilePlus2 className="size-3" />添加到画布</button>
                    </> : null}
                </div>
            </div>
        </article>
    );
}

function AssistantMarkdownContent({ text, theme }: { text: string; theme: CanvasTheme }) {
    return (
        <div className="canvas-agent-markdown min-w-0 text-left">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
                components={{
                    a: ({ href, children }) => (
                        <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2" style={{ color: theme.toolbar.activeText }}>
                            {children}
                        </a>
                    ),
                    blockquote: ({ children }) => (
                        <blockquote className="my-2 border-l-4 py-0.5 pl-3" style={{ borderColor: theme.node.muted, color: theme.node.muted }}>
                            {children}
                        </blockquote>
                    ),
                    code: ({ className, children, ...props }) => {
                        const isInline = !className;
                        const language = className?.replace("language-", "") || "";
                        if (isInline) {
                            return (
                                <code className="rounded px-1 py-0.5 text-[12px]" style={{ background: theme.toolbar.panel, color: theme.node.text }} {...props}>
                                    {children}
                                </code>
                            );
                        }
                        return (
                            <div className="my-2 overflow-hidden rounded-lg border text-[12px] leading-5" style={{ borderColor: theme.node.stroke }}>
                                {language ? (
                                    <div className="px-3 py-1 text-[11px]" style={{ background: theme.toolbar.panel, color: theme.node.muted, borderBottom: `1px solid ${theme.node.stroke}` }}>
                                        {language}
                                    </div>
                                ) : null}
                                <pre className="thin-scrollbar overflow-x-auto p-3" style={{ background: theme.toolbar.panel, color: theme.node.text, margin: 0 }}>
                                    <code className={className} {...props}>
                                        {children}
                                    </code>
                                </pre>
                            </div>
                        );
                    },
                    h1: ({ children }) => <h1 className="mb-2 mt-3 text-[15px] font-semibold">{children}</h1>,
                    h2: ({ children }) => <h2 className="mb-2 mt-3 text-sm font-semibold">{children}</h2>,
                    h3: ({ children }) => <h3 className="mb-1.5 mt-2 text-[13px] font-semibold">{children}</h3>,
                    hr: () => <hr className="my-3" style={{ borderColor: theme.node.stroke }} />,
                    li: ({ children }) => <li className="my-0.5 pl-1">{children}</li>,
                    ol: ({ children }) => <ol className="my-2 list-decimal pl-5">{children}</ol>,
                    p: ({ children }) => <p className="my-1.5 leading-[1.75]">{children}</p>,
                    pre: ({ children }) => <>{children}</>,
                    table: ({ children }) => (
                        <div className="thin-scrollbar my-2 overflow-x-auto">
                            <table className="w-full border-collapse text-left text-xs">{children}</table>
                        </div>
                    ),
                    td: ({ children }) => (
                        <td className="border px-2 py-1.5 align-top" style={{ borderColor: theme.node.stroke }}>
                            {children}
                        </td>
                    ),
                    th: ({ children }) => (
                        <th className="border px-2 py-1.5 align-top font-medium" style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel }}>
                            {children}
                        </th>
                    ),
                    ul: ({ children }) => <ul className="my-2 list-disc pl-5">{children}</ul>,
                }}
            >
                {text}
            </ReactMarkdown>
        </div>
    );
}
