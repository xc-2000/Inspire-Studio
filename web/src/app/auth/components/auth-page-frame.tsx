import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, Image, Layers3, Video } from "lucide-react";
import { BrandLogo } from "@/shared/components/brand-logo";

export function AuthPageFrame({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
    return (
        <main className="studio-auth studio-shell-bg flex min-h-dvh flex-col px-5 py-6 sm:px-8">
            <header className="mx-auto flex w-full max-w-[1080px] items-center justify-between gap-4">
                <Link href="/" className="inline-flex items-center" aria-label="Inspire Studio 首页">
                    <BrandLogo className="h-10" />
                </Link>
                <Link href="/" className="inline-flex min-h-11 items-center gap-2 text-sm text-[var(--studio-muted)] hover:text-[var(--studio-ink)]">
                    <ArrowLeft className="size-4" aria-hidden />
                    返回工作台
                </Link>
            </header>
            <div className={`mx-auto grid w-full flex-1 items-center gap-12 py-10 sm:py-16 ${compact ? "max-w-[440px]" : "max-w-[960px] lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-20"}`}>
                {!compact ? (
                    <aside className="hidden lg:block" aria-label="创作工作台介绍">
                        <p className="text-xs font-medium uppercase tracking-[0.2em] text-[var(--studio-primary)]">Your creative workspace</p>
                        <p className="mt-6 text-5xl font-semibold leading-[1.2] tracking-tight text-[var(--studio-ink)]">
                            让灵感，
                            <br />
                            成为作品。
                        </p>
                        <p className="mt-6 max-w-sm text-base leading-7 text-[var(--studio-muted)]">从一条提示词到完整的视觉表达，在同一个工作台中持续创作。</p>
                        <div className="mt-10 flex flex-wrap gap-3 border-t border-[var(--studio-line)] pt-6">
                            {[
                                { Icon: Image, label: "图片创作" },
                                { Icon: Video, label: "视频生成" },
                                { Icon: Layers3, label: "无限画布" },
                            ].map(({ Icon, label }) => (
                                <span key={label} className="inline-flex items-center gap-2 text-sm text-[var(--studio-muted)]">
                                    <Icon className="size-4" aria-hidden />
                                    {label}
                                </span>
                            ))}
                        </div>
                    </aside>
                ) : null}
                <div className={`studio-auth-panel w-full ${compact ? "" : "mx-auto max-w-[440px]"}`}>{children}</div>
            </div>
            <footer className="mx-auto w-full max-w-[1080px] border-t border-[var(--studio-line)] pt-5 text-xs text-[var(--studio-faint)]">Inspire Studio · AI 视觉创作工作台</footer>
        </main>
    );
}
