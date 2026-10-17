import { nanoid } from "nanoid";
import { useUserStore } from "@/features/auth/stores/use-user-store";

import { createCanvasDocumentPersistence } from "../services/canvas-document-persistence";
import { createCanvasDocumentSaveScheduler } from "../services/canvas-document-save-scheduler";
import { createCanvasStore } from "./create-canvas-store";

const persistence = createCanvasDocumentPersistence();
let storeReference: ReturnType<typeof createCanvasStore>;

const saveScheduler = createCanvasDocumentSaveScheduler({
    delayMilliseconds: 400,
    saveDocument: persistence.saveDocument,
    onStatusChange: (documentId, status) => storeReference.getState().setSaveStatus(documentId, status),
    onError: (documentId, error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("保存画布文档失败", { documentId, error });
        storeReference.setState((state) => ({
            saveErrors: {
                ...state.saveErrors,
                [documentId]: message,
            },
        }));
    },
});

export const useCanvasStore = createCanvasStore({
    createId: nanoid,
    createTimestamp: () => new Date().toISOString(),
    persistence,
    saveScheduler,
    onDeleteError: (documentIds, error) => {
        console.error("删除画布文档失败", { documentIds, error });
    },
});

storeReference = useCanvasStore;

// Keep both full-document and library caches scoped to the signed-in account.
useUserStore.subscribe((state, previous) => {
    if (state.user?.id !== previous.user?.id) useCanvasStore.getState().resetDocuments();
});
