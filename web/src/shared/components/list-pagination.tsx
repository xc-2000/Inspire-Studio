"use client";

import { Grid, Pagination, Select } from "antd";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { clampPage } from "@/shared/lib/pagination";
import { cn } from "@/shared/lib/utils";

type ListPaginationProps = {
    current: number;
    pageSize: number;
    total: number;
    onChange: (page: number, pageSize: number) => void;
    pageSizeOptions?: number[];
    disabled?: boolean;
    compact?: boolean;
    label?: string;
    className?: string;
};

export function ListPagination({ current, pageSize, total, onChange, pageSizeOptions = [10, 20, 50, 100], disabled, compact = false, label = "列表分页", className }: ListPaginationProps) {
    const screens = Grid.useBreakpoint();
    const isCompact = compact || screens.md === false;
    const sizes = [...new Set([...pageSizeOptions, pageSize])].sort((left, right) => left - right);
    const safeCurrent = clampPage(current, total, pageSize);
    const pageCount = Math.max(1, Math.ceil(total / pageSize));

    if (isCompact) {
        return (
            <nav aria-label={label} className={cn("studio-pagination studio-pagination--compact mt-3 flex min-w-0 items-center justify-between gap-2", className)}>
                <span className="shrink-0 text-xs tabular-nums text-[var(--studio-muted)]" aria-live="polite">
                    共 <strong className="font-semibold text-[var(--studio-text)]">{total}</strong> 条
                </span>
                <div className="flex min-w-0 items-center justify-end gap-2">
                    {pageCount > 1 ? (
                        <div className="flex shrink-0 items-center gap-1" role="group" aria-label={`${label}翻页`}>
                            <button
                                type="button"
                                className="grid size-7 place-items-center rounded-md text-[var(--studio-muted)] transition-colors hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-ink)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                                aria-label="上一页"
                                disabled={disabled || safeCurrent <= 1}
                                onClick={() => onChange(safeCurrent - 1, pageSize)}
                            >
                                <ChevronLeft className="size-3.5" />
                            </button>
                            <span className="min-w-12 text-center text-xs tabular-nums text-[var(--studio-text)]" aria-current="page">
                                {safeCurrent} <span className="text-[var(--studio-faint)]">/</span> {pageCount}
                            </span>
                            <button
                                type="button"
                                className="grid size-7 place-items-center rounded-md text-[var(--studio-muted)] transition-colors hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-ink)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                                aria-label="下一页"
                                disabled={disabled || safeCurrent >= pageCount}
                                onClick={() => onChange(safeCurrent + 1, pageSize)}
                            >
                                <ChevronRight className="size-3.5" />
                            </button>
                        </div>
                    ) : null}
                    <Select
                        aria-label="每页条数"
                        size="small"
                        value={pageSize}
                        disabled={disabled}
                        popupMatchSelectWidth={false}
                        className="w-[84px] shrink-0"
                        options={sizes.map((size) => ({ value: size, label: `${size}条/页` }))}
                        onChange={(nextSize) => onChange(1, nextSize)}
                    />
                </div>
            </nav>
        );
    }

    return (
        <nav aria-label={label} className={cn("studio-pagination mt-4 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-[var(--studio-line)] pt-3", className)}>
            <span className="shrink-0 text-xs tabular-nums text-[var(--studio-muted)]" aria-live="polite">
                共 {total} 条
            </span>
            <Pagination
                className="flex max-w-full flex-wrap items-center gap-y-2 [&_.ant-pagination-options]:!inline-block"
                current={safeCurrent}
                pageSize={pageSize}
                total={total}
                pageSizeOptions={sizes}
                showSizeChanger
                showQuickJumper={total > pageSize * 5}
                responsive
                disabled={disabled}
                onChange={(nextPage, nextSize) => onChange(nextSize === pageSize ? nextPage : 1, nextSize)}
            />
        </nav>
    );
}
