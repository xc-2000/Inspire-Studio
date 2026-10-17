"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { ALL_PROMPTS_OPTION, fetchPrompts } from "@/features/prompts/api/prompts";
import { clampPage } from "@/shared/lib/pagination";

export const PROMPT_PAGE_SIZE = 20;

export type UsePromptListParams = {
    keyword: string;
    tags: string[];
    category: string;
    enabled?: boolean;
};

export function usePromptList({ keyword, tags, category, enabled = true }: UsePromptListParams) {
    const normalizedKeyword = keyword.trim();
    const normalizedTags = useMemo(() => [...new Set(tags.filter((tag) => tag && tag !== ALL_PROMPTS_OPTION))].sort(), [tags]);
    const filterKey = JSON.stringify([normalizedKeyword, normalizedTags, category]);
    const [pagination, setPagination] = useState({ filterKey, page: 1, pageSize: PROMPT_PAGE_SIZE });
    const page = pagination.filterKey === filterKey ? pagination.page : 1;
    const pageSize = pagination.pageSize;
    const query = useQuery({
        queryKey: ["prompts", normalizedKeyword, normalizedTags, category, page, pageSize],
        queryFn: () => fetchPrompts({ keyword: normalizedKeyword, tag: normalizedTags, category, page, pageSize }),
        enabled,
        staleTime: 5 * 60 * 1000,
    });
    const total = query.data?.total;
    useEffect(() => {
        const nextPage = total === undefined ? page : clampPage(page, total, pageSize);
        if (nextPage !== page || pagination.filterKey !== filterKey) {
            setPagination({ filterKey, page: nextPage, pageSize });
        }
    }, [filterKey, page, pageSize, pagination.filterKey, total]);
    const promptTags = useMemo(() => [ALL_PROMPTS_OPTION, ...(query.data?.tags || [])], [query.data?.tags]);
    const promptCategories = useMemo(() => [ALL_PROMPTS_OPTION, ...(query.data?.categories || [])], [query.data?.categories]);
    const changePage = (nextPage: number, nextPageSize: number) => {
        setPagination({ filterKey, page: nextPageSize === pageSize ? nextPage : 1, pageSize: nextPageSize });
    };

    return {
        query,
        items: query.data?.items || [],
        tags: promptTags,
        categories: promptCategories,
        total: total || 0,
        page,
        pageSize,
        changePage,
    };
}
