import type { CanvasDocument } from "../types.ts";

export interface CanvasDocumentSaveScheduler {
    saveNow: (document: CanvasDocument) => Promise<void>;
    schedule: (document: CanvasDocument) => void;
    cancel: (documentId: string) => void;
    retryPending?: () => Promise<void>;
    hasPending?: (documentId?: string) => boolean;
}

export type CanvasDocumentSaveStatus = {
    phase: "pending" | "saving" | "saved" | "failed";
    error?: string;
    savedAt?: string;
};

interface CreateCanvasDocumentSaveSchedulerOptions {
    delayMilliseconds: number;
    saveDocument: (document: CanvasDocument) => Promise<void>;
    onError: (documentId: string, error: unknown) => void;
    onStatusChange?: (documentId: string, status: CanvasDocumentSaveStatus) => void;
    retryDelayMilliseconds?: number;
}

export function createCanvasDocumentSaveScheduler(options: CreateCanvasDocumentSaveSchedulerOptions): CanvasDocumentSaveScheduler {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const activeSaves = new Map<string, Promise<void>>();
    const pendingDocuments = new Map<string, CanvasDocument>();
    const retryCounts = new Map<string, number>();

    const cancelTimer = (documentId: string) => {
        const timer = timers.get(documentId);
        if (!timer) return;
        clearTimeout(timer);
        timers.delete(documentId);
    };

    const cancel = (documentId: string) => {
        cancelTimer(documentId);
        pendingDocuments.delete(documentId);
        retryCounts.delete(documentId);
    };

    const setTimer = (document: CanvasDocument, delay: number) => {
        const documentId = document.identity.id;
        cancelTimer(documentId);
        const timer = setTimeout(() => {
            timers.delete(documentId);
            const latest = pendingDocuments.get(documentId);
            if (latest) void saveNow(latest).catch(() => undefined);
        }, delay);
        // Retry timers should not keep node-based tests or CLI processes alive.
        if (typeof timer === "object" && "unref" in timer) timer.unref();
        timers.set(documentId, timer);
    };

    const saveNow = async (document: CanvasDocument) => {
        const documentId = document.identity.id;
        cancelTimer(documentId);
        pendingDocuments.set(documentId, document);
        options.onStatusChange?.(documentId, { phase: "pending" });
        const previousSave = activeSaves.get(documentId) || Promise.resolve();
        const currentSave = previousSave
            .catch(() => undefined)
            .then(async () => {
                if (pendingDocuments.get(documentId) === document) options.onStatusChange?.(documentId, { phase: "saving" });
                await options.saveDocument(document);
                if (pendingDocuments.get(documentId) === document) {
                    pendingDocuments.delete(documentId);
                    retryCounts.delete(documentId);
                    cancelTimer(documentId);
                    options.onStatusChange?.(documentId, { phase: "saved", savedAt: new Date().toISOString() });
                }
            })
            .catch((error) => {
                if (pendingDocuments.get(documentId) === document) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    options.onError(documentId, error);
                    options.onStatusChange?.(documentId, { phase: "failed", error: errorMessage });
                    const attempts = retryCounts.get(documentId) || 0;
                    retryCounts.set(documentId, attempts + 1);
                    setTimer(document, Math.min(30_000, (options.retryDelayMilliseconds ?? 1500) * 2 ** Math.min(attempts, 5)));
                }
                throw error;
            })
            .finally(() => {
                if (activeSaves.get(documentId) === currentSave) activeSaves.delete(documentId);
            });
        activeSaves.set(documentId, currentSave);
        await currentSave;
    };

    const schedule = (document: CanvasDocument) => {
        pendingDocuments.set(document.identity.id, document);
        retryCounts.delete(document.identity.id);
        options.onStatusChange?.(document.identity.id, { phase: "pending" });
        setTimer(document, options.delayMilliseconds);
    };

    const retryPending = async () => {
        await Promise.allSettled([...pendingDocuments.values()].map((document) => saveNow(document)));
    };

    return { saveNow, schedule, cancel, retryPending, hasPending: (documentId) => documentId ? pendingDocuments.has(documentId) : pendingDocuments.size > 0 };
}
