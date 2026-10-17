"use client";

import { useCallback, useEffect, useState } from "react";
import { clampPage, paginateItems } from "@/shared/lib/pagination";

export function usePaginatedList<T>(items: readonly T[], initialPageSize = 10, resetKey?: string) {
    const [page, setPage] = useState(1);
    const [pageSize, updatePageSize] = useState(initialPageSize);

    useEffect(() => {
        setPage((current) => clampPage(current, items.length, pageSize));
    }, [items.length, page, pageSize]);

    const resetPage = useCallback(() => setPage(1), []);
    useEffect(resetPage, [resetKey, resetPage]);

    const setPageSize = useCallback((size: number) => {
        updatePageSize(size);
        setPage(1);
    }, []);

    const onChange = useCallback(
        (nextPage: number, nextPageSize: number) => {
            updatePageSize(nextPageSize);
            setPage(nextPageSize === pageSize ? nextPage : 1);
        },
        [pageSize],
    );

    return { ...paginateItems(items, page, pageSize), setPage, setPageSize, onChange, resetPage };
}
