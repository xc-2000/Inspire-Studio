import { create } from "zustand";
import type { StoreApi } from "zustand";
import { reconcileHydration } from "../../../shared/lib/reconcile-hydration.ts";

import {
    createCanvasDocument,
    removeCanvasDocuments,
    renameCanvasDocument,
    replaceCanvasConversation,
    replaceCanvasScene,
    updateCanvasPreferences,
} from "../domain/canvas-document.ts";
import type { CanvasDocumentPersistence } from "../services/canvas-document-persistence.ts";
import type { CanvasDocumentSaveScheduler, CanvasDocumentSaveStatus } from "../services/canvas-document-save-scheduler.ts";
import type { CanvasConversation, CanvasDocument, CanvasPreferences, CanvasScene } from "../types.ts";

export interface CanvasStoreState {
    hydrated: boolean;
    documents: CanvasDocument[];
    deletedDocumentIds: string[];
    loadDocument: (documentId: string) => Promise<CanvasDocument>;
    resetDocuments: () => void;
    saveErrors: Record<string, string>;
    saveStatuses: Record<string, CanvasDocumentSaveStatus>;
    setSaveStatus: (documentId: string, status: CanvasDocumentSaveStatus) => void;
    flushDocument: (documentId: string) => Promise<void>;
    retryPendingSaves: () => Promise<void>;
    hasUnsavedChanges: (documentId?: string) => boolean;
    hydrateDocuments: () => Promise<void>;
    createDocument: (title?: string) => string;
    importDocument: (document: CanvasDocument) => string;
    saveSnapshot: (document: CanvasDocument) => Promise<void>;
    findDocument: (documentId: string) => CanvasDocument | null;
    renameDocument: (documentId: string, title: string) => void;
    replaceScene: (documentId: string, scene: CanvasScene) => void;
    replaceConversation: (documentId: string, conversation: CanvasConversation) => void;
    updatePreferences: (documentId: string, preferences: CanvasPreferences) => void;
    deleteDocuments: (documentIds: string[]) => Promise<void>;
    replaceDocuments: (documents: CanvasDocument[]) => void;
}

interface CreateCanvasStoreDependencies {
    createId: () => string;
    createTimestamp: () => string;
    persistence: CanvasDocumentPersistence;
    saveScheduler: CanvasDocumentSaveScheduler;
    onDeleteError: (documentIds: string[], error: unknown) => void;
}

const DEFAULT_DOCUMENT_TITLE = "未命名画布";

export function createCanvasStore(dependencies: CreateCanvasStoreDependencies) {
    let hydrationPromise: Promise<void> | null = null;
    const detailRequests = new Map<string, Promise<CanvasDocument>>();
    let sessionVersion = 0;

    return create<CanvasStoreState>()((set, get) => ({
        hydrated: false,
        documents: [],
        deletedDocumentIds: [],
        resetDocuments: () => {
            sessionVersion++;
            get().documents.forEach(document => dependencies.saveScheduler.cancel(document.identity.id));
            detailRequests.clear();
            hydrationPromise = null;
            set({ hydrated: false, documents: [], deletedDocumentIds: [], saveErrors: {}, saveStatuses: {} });
        },
        loadDocument: (documentId) => {
            const existing = get().findDocument(documentId);
            if (existing) return Promise.resolve(existing);
            const pending = detailRequests.get(documentId);
            if (pending) return pending;
            const version = sessionVersion;
            const request = (dependencies.persistence.loadDocument
                ? dependencies.persistence.loadDocument(documentId)
                : dependencies.persistence.loadDocuments().then(documents => {
                    const document = documents.find(item => item.identity.id === documentId);
                    if (!document) throw new Error("画布不存在");
                    return document;
                }))
                .then(document => {
                    if (version !== sessionVersion) throw new Error("登录账号已切换，请重新打开画布");
                    if (get().deletedDocumentIds.includes(documentId)) throw new Error("画布已删除");
                    if (document.identity.id !== documentId) throw new Error("画布数据不匹配，请重试");
                    const latest = get().findDocument(documentId);
                    if (latest) return latest;
                    set(state => ({ documents: [document, ...state.documents] }));
                    return document;
                }).finally(() => { if (detailRequests.get(documentId) === request) detailRequests.delete(documentId); });
            detailRequests.set(documentId, request);
            return request;
        },
        saveErrors: {},
        saveStatuses: {},
        setSaveStatus: (documentId, status) => set(state => ({
            saveStatuses: { ...state.saveStatuses, [documentId]: status },
            saveErrors: { ...state.saveErrors, [documentId]: status.phase === "failed" ? status.error || "保存失败" : "" },
        })),
        flushDocument: async (documentId) => {
            const document = get().findDocument(documentId);
            if (!document) throw new Error("画布不存在，无法保存");
            try {
                await dependencies.saveScheduler.saveNow(document);
            } catch (error) {
                get().setSaveStatus(documentId, { phase: "failed", error: error instanceof Error ? error.message : String(error) });
                throw error;
            }
        },
        retryPendingSaves: async () => { await dependencies.saveScheduler.retryPending?.(); },
        hasUnsavedChanges: (documentId) => dependencies.saveScheduler.hasPending?.(documentId) ??
            Object.entries(get().saveStatuses).some(([id, status]) => (!documentId || id === documentId) && status.phase !== "saved"),
        hydrateDocuments: () => {
            if (get().hydrated) return Promise.resolve();
            if (hydrationPromise) return hydrationPromise;
            const before = get().documents;
            hydrationPromise = dependencies.persistence
                .loadDocuments()
                .then((documents) => set(state => ({ hydrated: true,
                    documents: reconcileHydration(documents, before, state.documents, document => document.identity.id),
                })))
                .finally(() => {
                    hydrationPromise = null;
                });
            return hydrationPromise;
        },
        createDocument: (title = DEFAULT_DOCUMENT_TITLE) => {
            const document = createCanvasDocument({
                id: dependencies.createId(),
                title: title.trim() || DEFAULT_DOCUMENT_TITLE,
                now: dependencies.createTimestamp(),
            });
            set((state) => ({ documents: [document, ...state.documents] }));
            void dependencies.saveScheduler.saveNow(document).catch(() => undefined);
            return document.identity.id;
        },
        importDocument: (source) => {
            const now = dependencies.createTimestamp();
            const document: CanvasDocument = {
                ...source,
                identity: {
                    ...source.identity,
                    id: dependencies.createId(),
                    updatedAt: now,
                },
            };
            set((state) => ({ documents: [document, ...state.documents] }));
            void dependencies.saveScheduler.saveNow(document).catch(() => undefined);
            return document.identity.id;
        },
        saveSnapshot: async (source) => {
            const id = source.identity.id;
            if (!get().findDocument(id)) throw new Error("画布不存在，无法恢复版本");
            const document = { ...source, identity: { ...source.identity, updatedAt: dependencies.createTimestamp() } };
            set(state => ({ documents: state.documents.map(item => item.identity.id === id ? document : item), saveErrors: { ...state.saveErrors, [id]: "" } }));
            await dependencies.saveScheduler.saveNow(document);
            const error = get().saveErrors[id];
            if (error) throw new Error(error);
        },
        findDocument: (documentId) => get().documents.find((document) => document.identity.id === documentId) || null,
        renameDocument: (documentId, title) => {
            const updated = updateDocument(set, documentId, (document) => renameCanvasDocument(document, title, dependencies.createTimestamp()));
            if (updated) void dependencies.saveScheduler.saveNow(updated).catch(() => undefined);
        },
        replaceScene: (documentId, scene) => {
            const updated = updateDocument(set, documentId, (document) => replaceCanvasScene(document, scene, dependencies.createTimestamp()));
            if (updated) dependencies.saveScheduler.schedule(updated);
        },
        replaceConversation: (documentId, conversation) => {
            const updated = updateDocument(set, documentId, (document) => replaceCanvasConversation(document, conversation, dependencies.createTimestamp()));
            if (updated) dependencies.saveScheduler.schedule(updated);
        },
        updatePreferences: (documentId, preferences) => {
            const updated = updateDocument(set, documentId, (document) => updateCanvasPreferences(document, preferences, dependencies.createTimestamp()));
            if (updated) dependencies.saveScheduler.schedule(updated);
        },
        deleteDocuments: async (documentIds) => {
            if (!documentIds.length) return;
            try { await dependencies.persistence.deleteDocuments(documentIds); }
            catch (error) { dependencies.onDeleteError(documentIds, error); throw error; }
            documentIds.forEach(dependencies.saveScheduler.cancel);
            set((state) => ({
                documents: removeCanvasDocuments(state.documents, documentIds),
                deletedDocumentIds: [...new Set([...state.deletedDocumentIds, ...documentIds])],
                saveStatuses: Object.fromEntries(Object.entries(state.saveStatuses).filter(([id]) => !documentIds.includes(id))),
                saveErrors: Object.fromEntries(Object.entries(state.saveErrors).filter(([id]) => !documentIds.includes(id))),
            }));
        },
        replaceDocuments: (documents) => {
            set({ documents });
            documents.forEach((document) => void dependencies.saveScheduler.saveNow(document).catch(() => undefined));
        },
    }));
}

type CanvasStoreSetter = StoreApi<CanvasStoreState>["setState"];

function updateDocument(
    setState: CanvasStoreSetter,
    documentId: string,
    updater: (document: CanvasDocument) => CanvasDocument,
): CanvasDocument | null {
    let updatedDocument: CanvasDocument | null = null;
    setState((state) => ({
        documents: state.documents.map((document) => {
            if (document.identity.id !== documentId) return document;
            const nextDocument = updater(document);
            if (nextDocument === document) return document;
            updatedDocument = nextDocument;
            return nextDocument;
        }),
    }));
    return updatedDocument;
}
