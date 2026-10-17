"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listCanvasProjectSummaries } from "@/services/api/server";
import { useUserStore } from "@/features/auth/stores/use-user-store";
import { useCanvasStore } from "../stores/use-canvas-store";
import { summarizeCanvasProject, type CanvasProjectSummary } from "../domain/canvas-project-summary";

export function useCanvasLibrary() {
    const userId = useUserStore(state => state.user?.id);
    const loadedDocuments = useCanvasStore(state => state.documents);
    const deletedDocumentIds = useCanvasStore(state => state.deletedDocumentIds);
    const query = useQuery({
        queryKey: ["canvas-library", userId],
        queryFn: ({ signal }) => listCanvasProjectSummaries<CanvasProjectSummary>(signal),
        enabled: Boolean(userId),
        staleTime: 60_000,
    });
    const documents = useMemo(() => {
        const entries = new Map((query.data || []).filter(item => !deletedDocumentIds.includes(item.identity.id)).map(item => [item.identity.id, item]));
        for (const document of loadedDocuments) {
            const summary = entries.get(document.identity.id);
            if (!summary || document.identity.updatedAt >= summary.identity.updatedAt) entries.set(document.identity.id, summarizeCanvasProject(document));
        }
        return [...entries.values()];
    }, [query.data, loadedDocuments, deletedDocumentIds]);
    return { documents, hydrated: Boolean(query.data), error: query.error, loading: query.isFetching, reload: query.refetch };
}
