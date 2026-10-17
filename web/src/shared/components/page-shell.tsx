"use client";

import { useEffect, useRef, type ReactNode, type UIEvent } from "react";

import { cn } from "@/shared/lib/utils";
import "./page-shell.css";
import "./page-details.css";

type PageShellProps = {
    /** 页面小标签，显示在标题上方 */
    eyebrow?: string;
    title: string;
    /** Decorative page icon. The visible title provides the accessible name. */
    icon?: ReactNode;
    description?: ReactNode;
    /** 页面标题右侧的操作区，小屏自动换行 */
    actions?: ReactNode;
    /** 标题下方的概览区（统计、提示等） */
    aside?: ReactNode;
    /** 固定在正文上方的筛选、分类和批量操作。 */
    toolbar?: ReactNode;
    /** 固定在正文下方的分页或操作。 */
    footer?: ReactNode;
    /** 标签页等工作区自行管理内部正文滚动。 */
    bodyScroll?: boolean;
    /** 翻页或筛选时只将正文滚回顶部。 */
    scrollKey?: string | number;
    /** 兼容既有调用；内容区统一随可用宽度伸展。 */
    width?: "default" | "wide" | "narrow";
    className?: string;
    /** 滚动回调，供无限加载等场景使用 */
    onScroll?: (event: UIEvent<HTMLElement>) => void;
    children: ReactNode;
};

/**
 * 页面标题、筛选和分页固定，仅正文区域滚动。
 *
 * @param props PageShellProps 页面信息与内容
 * @return JSX.Element
 */
export function PageShell({ eyebrow, title, icon, description, actions, aside, toolbar, footer, bodyScroll = true, scrollKey, className, onScroll, children }: PageShellProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }, [scrollKey]);
    return (
        <main className={cn("studio-page studio-content-page", className)}>
            <div className="studio-fluid-content studio-page-content">
                <header className="studio-page-heading">
                    <div className="studio-page-identity">
                        {icon ? <span className="studio-page-glyph" aria-hidden="true">{icon}</span> : null}
                        <div className="min-w-0 max-w-2xl">
                        {eyebrow ? <p className="studio-page-eyebrow">{eyebrow}</p> : null}
                        <h1 className="studio-page-title">{title}</h1>
                        {description ? <div className="studio-page-description">{description}</div> : null}
                        </div>
                    </div>
                    {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">{actions}</div> : null}
                </header>
                {toolbar ? <div className="studio-page-toolbar">{toolbar}</div> : null}
                <div ref={scrollRef} className={cn("studio-page-body", !bodyScroll && "studio-page-body-managed")} onScroll={onScroll} role="region" aria-label={title + "内容"} tabIndex={bodyScroll ? 0 : undefined}>
                    {aside ? <div className="studio-summary min-w-0 rounded-2xl border border-[var(--studio-line)] bg-[var(--studio-surface)] p-4 sm:p-5">{aside}</div> : null}
                    {children}
                </div>
                {footer ? <div className="studio-page-footer">{footer}</div> : null}
            </div>
        </main>
    );
}
