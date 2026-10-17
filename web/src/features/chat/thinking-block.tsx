"use client";

import { Brain, Check, ChevronDown, Clock3 } from "lucide-react";
import { useState, useEffect, useId } from "react";
import type { ThinkingBlockState } from "./types";

type Props = {
  block: ThinkingBlockState;
  streaming?: boolean;
  appearance?: ThinkingBlockAppearance;
};

export type ThinkingBlockAppearance = {
  text: string;
  muted: string;
  background: string;
  border: string;
};

/** Compact by default; the user can expand the streamed details without growing the conversation. */
export function ThinkingBlock({ block, streaming = false, appearance }: Props) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  useEffect(() => { setExpanded(false); }, [block.id, streaming]);

    return (
        <section
      className="relative my-4 min-w-0 overflow-hidden rounded-[20px] border border-[var(--studio-primary-line)] bg-[linear-gradient(135deg,var(--studio-panel-solid),var(--studio-surface-soft))] text-[var(--studio-ink)] shadow-[0_12px_32px_rgba(15,23,42,0.06)]"
      style={appearance ? { color: appearance.text, background: appearance.background, borderColor: appearance.border } : undefined}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded(value => !value)}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-[var(--studio-primary-soft)] focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-[var(--studio-action)] sm:px-5"
      >
        <span className="relative flex size-10 shrink-0 items-center justify-center rounded-[14px] bg-[var(--studio-action)] text-[var(--studio-action-foreground)] shadow-[0_8px_20px_var(--studio-primary-soft)]">
          {streaming ? <Brain aria-hidden="true" className="size-[18px] motion-safe:animate-pulse" /> : <Check aria-hidden="true" className="size-[18px]" />}
          {streaming ? <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-[var(--studio-panel-solid)] bg-emerald-400 motion-safe:animate-pulse" /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 text-[13px] font-semibold tracking-tight">
            {streaming ? "正在理解你的创作需求" : "创作思路"}
            {streaming ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--studio-primary-line)] bg-[var(--studio-primary-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--studio-action)]">
                <span className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" />
                分析中
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-[11px] text-[var(--studio-muted)]" style={appearance ? { color: appearance.muted } : undefined}>
            {expanded ? "点击收起分析详情" : streaming ? "正在梳理任务、素材与生成参数" : "查看本轮分析详情"}
          </span>
        </span>
        {!streaming && block.durationMs > 0 ? <span className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-[var(--studio-muted)]" style={appearance ? { color: appearance.muted } : undefined}><Clock3 aria-hidden="true" className="size-3" />{formatMs(block.durationMs)}</span> : null}
        <span className="grid size-8 shrink-0 place-items-center rounded-full border border-[var(--studio-line)] bg-[var(--studio-panel-solid)] text-[var(--studio-muted)]">
          <ChevronDown aria-hidden="true" className={`size-4 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} />
        </span>
      </button>
      {streaming ? <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-[linear-gradient(90deg,transparent,var(--studio-action),transparent)] motion-safe:animate-pulse" /> : null}
      <div id={contentId} hidden={!expanded}>
        <div className="mx-4 border-t border-[var(--studio-line)]" style={appearance ? { borderColor: appearance.border } : undefined} />
        <div tabIndex={0} aria-label="思考过程详情" className="max-h-64 overflow-y-auto overscroll-contain px-4 py-4 text-[13px] leading-6 sm:max-h-80 sm:px-5">
          <div className="whitespace-pre-wrap break-words font-sans opacity-80 [overflow-wrap:anywhere]">
            {block.text || "正在整理任务信息…"}
            {streaming ? <span aria-hidden="true" className="ml-1 inline-block h-3 w-1 rounded-full bg-teal-500 align-middle motion-safe:animate-pulse" /> : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, ms)} 毫秒`;
  return `${(ms / 1000).toFixed(1)} 秒`;
}
