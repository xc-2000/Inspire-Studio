"use client";

import type { ReactNode } from "react";
import { Button, Tag } from "antd";
import { Copy } from "lucide-react";

import { formatPromptDate, type Prompt } from "../api/prompts";
import { createPromptExcerpt } from "../lib/prompt-query";

type PromptCardProps = {
    item: Prompt;
    onOpen: () => void;
    onCopy: () => void;
    actionLabel?: string;
    actionIcon?: ReactNode;
    actionType?: "text" | "primary";
    extraAction?: ReactNode;
};

export function PromptCard({ item, onOpen, onCopy, actionLabel = "复制", actionIcon = <Copy className="size-3.5" />, actionType = "text", extraAction }: PromptCardProps) {
    return (
        <article className="studio-library-card group flex min-w-0 flex-col overflow-hidden rounded-[20px] border border-[var(--studio-line)] bg-[var(--studio-glass)] backdrop-blur-[20px] transition-all duration-300 hover:-translate-y-1 hover:border-[var(--studio-primary-line)] hover:shadow-[0_8px_32px_rgba(125,211,216,0.13),0_0_0_1px_var(--studio-primary-soft)] motion-reduce:transform-none">
            <button type="button" className="block text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--studio-action)]" onClick={onOpen} aria-label={`查看提示词 ${item.title}`}>
                <div className="relative aspect-[16/10] overflow-hidden bg-[var(--studio-media)]">
                    {item.coverUrl ? (
                        <img src={item.coverUrl} alt={item.title} loading="lazy" className="size-full object-cover transition duration-500 group-hover:scale-[1.04] motion-reduce:transition-none" />
                    ) : (
                        <div className="studio-empty flex size-full items-center justify-center border-0 p-4 text-center text-sm">{createPromptExcerpt(item.prompt, 80)}</div>
                    )}
                </div>
                <div className="p-4">
                    <h2 className="studio-title line-clamp-2 text-sm font-semibold leading-6">{item.title}</h2>
                    <time className="studio-caption mt-1 block text-xs" dateTime={item.updatedAt}>
                        {formatPromptDate(item.updatedAt)}
                    </time>
                    <p className="studio-subtitle mt-3 line-clamp-3 break-words text-xs leading-5">{createPromptExcerpt(item.prompt, 120)}</p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        {item.tags.slice(0, 4).map((tag) => (
                            <Tag key={tag} className="m-0 text-[11px]">
                                {tag}
                            </Tag>
                        ))}
                    </div>
                </div>
            </button>
            <footer className="mt-auto flex flex-wrap items-center gap-2 border-t border-[var(--studio-line)] px-4 py-3">
                <Button block={actionType === "primary"} type={actionType} size="small" icon={actionIcon} onClick={onCopy}>
                    {actionLabel}
                </Button>
                {extraAction}
            </footer>
        </article>
    );
}
