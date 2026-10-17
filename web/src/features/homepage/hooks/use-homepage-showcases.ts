"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchHomepageShowcases, fetchHomepageShowcasePage } from "../api/homepage-showcases";
import type { HomepageShowcase } from "@/services/api/server";

export function useHomepageShowcases() {
    const [items, setItems] = useState<HomepageShowcase[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const remoteItems = await fetchHomepageShowcases();
            setItems(remoteItems);
        } catch (requestError) {
            setItems([]);
            setError(requestError instanceof Error ? requestError.message : "读取首页精选内容失败");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void reload();
    }, [reload]);

    return { items, loading, error, reload };
}

export function useHomepageDiscovery() {
    const [category, setCategory] = useState("全部");
    const pendingLoads = useRef(new Set<string>());
    const query = useInfiniteQuery({
        queryKey: ["homepage-discovery", "video", category],
        initialPageParam: 1,
        queryFn: ({ pageParam }) => fetchHomepageShowcasePage({
            page: pageParam,
            pageSize: 12,
            category: category === "全部" ? undefined : category,
        }),
        getNextPageParam: (lastPage, _pages, lastPageParam) => (
            lastPage.items.length > 0 && lastPageParam * 12 < lastPage.total
                ? lastPageParam + 1
                : undefined
        ),
        staleTime: 60_000,
    });
    const pages = query.data?.pages;
    const items = useMemo(() => {
        const seen = new Set<HomepageShowcase["id"]>();
        return (pages || []).flatMap((page) => page.items).filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
        });
    }, [pages]);
    const { hasNextPage, isFetching, fetchNextPage } = query;
    const loadMore = useCallback(async () => {
        if (!hasNextPage || isFetching || pendingLoads.current.has(category)) return;
        pendingLoads.current.add(category);
        try {
            await fetchNextPage({ cancelRefetch: false });
        } finally {
            pendingLoads.current.delete(category);
        }
    }, [category, hasNextPage, isFetching, fetchNextPage]);

    return {
        items,
        categories: pages?.[0]?.categories || [],
        total: pages?.[pages.length - 1]?.total || 0,
        loading: query.isPending,
        fetching: query.isFetching,
        error: query.data ? null : query.error,
        reload: query.refetch,
        category,
        changeCategory: setCategory,
        hasNextPage,
        fetchingMore: query.isFetchingNextPage,
        loadMore,
        loadMoreError: query.isFetchNextPageError ? query.error : null,
    };
}
