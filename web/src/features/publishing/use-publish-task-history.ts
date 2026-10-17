"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getPublishTaskStatuses, listPublishTasks, type PublishTask } from "@/services/api/server";
import { isPublishing, mergePublishTaskStatuses, watchPublishTaskStatuses } from "./task-status-sync";

export function usePublishTaskHistory(active: boolean) {
    const [tasks, setTasks] = useState<PublishTask[]>([]);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [syncError, setSyncError] = useState(false);
    const tasksRef = useRef(tasks);
    const requestVersion = useRef(0);
    const loadedPage = useRef("");
    const pageKey = `${page}:${pageSize}`;
    const commit = useCallback((items: PublishTask[]) => { tasksRef.current = items; setTasks(items); }, []);

    const reload = useCallback(async () => {
        const version = ++requestVersion.current;
        setLoading(true);
        setError("");
        try {
            const result = await listPublishTasks(page, pageSize);
            if (version !== requestVersion.current) return;
            commit(result.items);
            setTotal(result.total);
            loadedPage.current = pageKey;
        } catch (failure) {
            if (version === requestVersion.current) setError(failure instanceof Error ? failure.message : "记录加载失败，请重试");
        } finally {
            if (version === requestVersion.current) setLoading(false);
        }
    }, [page, pageSize, pageKey, commit]);

    useEffect(() => {
        if (active && loadedPage.current !== pageKey) void reload();
        else setLoading(false);
        return () => { requestVersion.current++; };
    }, [active, pageKey, reload]);

    const pendingKey = tasks.filter(isPublishing).map((task) => task.id).join(",");
    useEffect(() => {
        if (!active || !pendingKey || loading || loadedPage.current !== pageKey) return;
        const watcher = watchPublishTaskStatuses({
            getTasks: () => tasksRef.current,
            fetch: getPublishTaskStatuses,
            onUpdate: (updates) => {
                const next = mergePublishTaskStatuses(tasksRef.current, updates);
                if (next !== tasksRef.current) commit(next);
            },
            onError: setSyncError,
            isVisible: () => document.visibilityState !== "hidden",
        });
        document.addEventListener("visibilitychange", watcher.wake);
        return () => { watcher.dispose(); document.removeEventListener("visibilitychange", watcher.wake); };
    }, [active, pendingKey, pageKey, loading, commit]);

    const addSubmittedTask = useCallback((task: PublishTask) => {
        requestVersion.current++;
        setPage(1);
        if (loadedPage.current === `1:${pageSize}`) {
            commit([task, ...tasksRef.current.filter((item) => item.id !== task.id)].slice(0, pageSize));
        } else {
            commit([task]);
            loadedPage.current = "";
        }
        setTotal((current) => current + 1);
        setLoading(false);
        setError("");
    }, [commit, pageSize]);

    return { tasks, page, pageSize, total, loading, error, syncError, reload, addSubmittedTask,
        changePage: (next: number, size: number) => { setPage(size === pageSize ? next : 1); setPageSize(size); },
    };
}
