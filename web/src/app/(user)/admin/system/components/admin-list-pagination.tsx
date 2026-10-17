"use client";

import { useCallback, useEffect, useState, type Dispatch, type Key, type SetStateAction } from "react";
import { Button } from "antd";
import { clampPage } from "@/shared/lib/pagination";

export function useAdminPagination(initialPageSize = 20) {
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(initialPageSize);
    const onPaginationChange = useCallback(
        (nextPage: number, nextPageSize: number) => {
            setPage(nextPageSize === pageSize ? nextPage : 1);
            setPageSize(nextPageSize);
        },
        [pageSize],
    );
    return { page, setPage, pageSize, onPaginationChange };
}

export function useClampAdminPage(page: number, pageSize: number, total: number | undefined, setPage: Dispatch<SetStateAction<number>>) {
    useEffect(() => {
        if (total !== undefined) {
            const validPage = clampPage(page, total, pageSize);
            if (validPage !== page) setPage(validPage);
        }
    }, [page, pageSize, total, setPage]);
}

export function AdminSelectionSummary({ selectedKeys, visibleKeys, onClear }: { selectedKeys: Key[]; visibleKeys: Key[]; onClear: () => void }) {
    if (!selectedKeys.length) return null;
    const visible = new Set(visibleKeys);
    const hiddenCount = selectedKeys.filter((key) => !visible.has(key)).length;
    return (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-[var(--studio-muted)]" role="status">
            <span>
                已选择 {selectedKeys.length} 项{hiddenCount > 0 ? `（含其他页或筛选外的 ${hiddenCount} 项）` : ""}，翻页和筛选保留选择。
            </span>
            <Button size="small" type="link" onClick={onClear}>
                清空选择
            </Button>
        </div>
    );
}
