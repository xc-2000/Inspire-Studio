"use client";

import { AlertTriangle, ChevronDown, LoaderCircle, RotateCcw, WandSparkles } from "lucide-react";
import type { SyntheticEvent } from "react";
import { formatGenerationError } from "@/shared/lib/generation-error";
import { useCanvasTheme } from "../components/canvas-theme-provider";
import type { CanvasImageNode, CanvasVideoNode } from "../types";
import { useNodeActions } from "./node-action-context";

function describeGenerationFailure(message: string | null | undefined): { title: string; description: string } {
    const text = message?.trim() || "";
    if (/自动重试\s*3\s*次后仍失败/.test(text)) {
        return { title: "生成失败 · 已重试 3 次", description: formatGenerationError(text.replace(/^自动重试\s*3\s*次后仍失败[：:]?\s*/, "")) };
    }
    if (/task user quota exceed|上游账号生成配额/i.test(text)) {
        return { title: "上游账号配额不足", description: "视频渠道的账号额度已用尽，请检查渠道额度后重试。" };
    }
    if (/safety[_\s-]*(?:system|violation)|content[_\s-]*(?:policy|filter)|moderation|responsible[_\s-]*ai|安全审核|安全系统|内容审核|违规|敏感词/i.test(text)) {
        return { title: "提示词需要调整", description: "内容未通过生成服务的安全审核。可以改写歧义或不合规描述，再重新生成。" };
    }
    if (/timeout|timed\s*out|deadline exceeded|超时/i.test(text)) {
        return { title: "生成请求超时", description: "服务响应较慢，请稍后重试；也可以简化提示词后重新生成。" };
    }
    if (/rate.?limit|too many requests|\b429\b|限流|频率|并发|繁忙/i.test(text)) {
        return { title: "生成服务繁忙", description: "当前请求较多，请稍后重试。" };
    }
    if (/insufficient|balance|quota|credit|余额|积分|额度/i.test(text)) {
        return { title: "可用额度不足", description: "请检查积分或渠道额度，补充后再重试。" };
    }
    if (/unauthorized|forbidden|api.?key|\b40[13]\b|认证|鉴权|密钥/i.test(text)) {
        return { title: "生成服务认证失败", description: "请检查渠道的密钥和访问权限后重试。" };
    }
    const formatted = formatGenerationError(text);
    return {
        title: "这次生成未完成",
        description: formatted !== text && formatted !== "生成失败" ? formatted : "请检查错误详情后重试，或改写提示词再生成。",
    };
}

/** A failed media node keeps its recovery actions on the node, without opening the editor. */
export function NodeGenerationError({ node }: { node: CanvasImageNode | CanvasVideoNode }) {
    const theme = useCanvasTheme();
    const actions = useNodeActions();
    const rewriting = Boolean(actions.rewritingNodeIds?.has(node.id));
    const busy = rewriting || node.execution.phase === "running";
    const failure = describeGenerationFailure(node.execution.errorMessage);
    const canRewrite = Boolean(actions.onRewriteAndRetry) && !(node.kind === "image" && node.grouping.isRoot);
    const stopCanvasEvent = (event: SyntheticEvent) => event.stopPropagation();

    return (
        <div
            className="nodrag nopan nowheel flex h-full min-h-0 w-full flex-col items-center overflow-y-auto rounded-[inherit] px-3 py-3 text-center"
            style={{ color: theme.node.muted }}
            data-canvas-no-zoom
            aria-busy={rewriting}
            onPointerDown={stopCanvasEvent}
            onMouseDown={stopCanvasEvent}
            onClick={stopCanvasEvent}
            onDoubleClick={stopCanvasEvent}
            onKeyDown={stopCanvasEvent}
            onWheel={stopCanvasEvent}
        >
            <div className="my-auto flex w-full max-w-sm shrink-0 flex-col items-center gap-2">
                <div className="space-y-1.5">
                    <p className="flex items-center justify-center gap-1.5 text-[13px] font-medium leading-5" style={{ color: theme.node.text }}>
                        <AlertTriangle className="size-4 shrink-0 text-red-400" aria-hidden="true" />
                        {failure.title}
                    </p>
                    <p className="text-[11px] leading-[1.65]">{failure.description}</p>
                </div>
                <div className="flex w-full flex-wrap items-center justify-center gap-2">
                    {canRewrite ? (
                        <button
                            type="button"
                            className="nodrag nopan inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] font-medium transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-wait disabled:opacity-60"
                            style={{ borderColor: theme.node.activeStroke, background: theme.toolbar.activeBg, color: theme.node.activeStroke }}
                            disabled={busy}
                            onClick={(event) => {
                                event.stopPropagation();
                                if (!busy) actions.onRewriteAndRetry?.(node);
                            }}
                        >
                            {rewriting ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <WandSparkles className="size-3.5" aria-hidden="true" />}
                            <span aria-live="polite">{rewriting ? "正在改写提示词…" : "改写并重新生成"}</span>
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className="nodrag nopan inline-flex min-h-8 items-center justify-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-wait disabled:opacity-40"
                        style={{ borderColor: theme.node.stroke, color: theme.node.muted }}
                        disabled={busy}
                        onClick={(event) => {
                            event.stopPropagation();
                            if (!busy) actions.onRetry(node);
                        }}
                    >
                        <RotateCcw className="size-3" aria-hidden="true" />
                        直接重试
                    </button>
                </div>
                {node.execution.errorMessage ? (
                    <details className="nodrag nopan nowheel group/error w-full text-left text-[10px]">
                        <summary className="flex cursor-pointer list-none items-center justify-center gap-1 rounded py-1 focus-visible:outline-2 [&::-webkit-details-marker]:hidden">
                            查看原始错误
                            <ChevronDown className="size-3 transition-transform group-open/error:rotate-180" aria-hidden="true" />
                        </summary>
                        <p className="mt-1 max-h-28 select-text overflow-auto whitespace-pre-wrap break-words rounded-lg border p-2 leading-relaxed [overflow-wrap:anywhere]" style={{ background: theme.node.panel, borderColor: theme.node.stroke }}>
                            {node.execution.errorMessage}
                        </p>
                    </details>
                ) : null}
            </div>
        </div>
    );
}
